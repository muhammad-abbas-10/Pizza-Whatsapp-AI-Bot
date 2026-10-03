require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));

function node(name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert(found, `Missing workflow node: ${name}`);
  return found;
}

function query(name) {
  const sql = node(name).parameters?.query;
  assert(sql, `Missing SQL for workflow node: ${name}`);
  return sql;
}

function staticTests() {
  assert.equal(node("Debounce Customer Messages").parameters.amount, 2);
  assert.equal(node("Wait For Active Customer Turn").parameters.amount, 2);

  const insertSql = query("Insert Message to Buffer");
  assert.match(insertSql, /processed_messages/i);
  assert.match(insertSql, /ON CONFLICT \(message_id\)/i);
  assert.match(insertSql, /replied_at IS NULL/i);
  assert.match(insertSql, /10 minutes/i);

  const claimSql = query("Claim Latest Customer Turn");
  assert.match(claimSql, /pg_advisory_xact_lock/i);
  assert.match(claimSql, /serialized AS MATERIALIZED/i);
  assert.match(claimSql, /customer-turn:/i);
  assert.match(claimSql, /INTERVAL '2 seconds'/i);
  assert.match(claimSql, /message_number <= 20/i);
  assert.match(claimSql, /cumulative_characters <= 8192/i);
  assert.match(claimSql, /recovery_anchor/i);
  assert.match(claimSql, /queued_message_count/i);

  assert.equal(
    workflow.connections["Finalize Customer Turn"].main[0][0].node,
    "Queued Customer Messages?",
  );
  assert.equal(
    workflow.connections["Finalize Simple Reply"].main[0][0].node,
    "Queued Customer Messages?",
  );
  assert.equal(
    workflow.connections["Human Handoff Turn Recorded?"].main[0][0].node,
    "Queued Customer Messages?",
  );
  assert.equal(
    workflow.connections["Throttle Queued Customer Messages"].main[0][0].node,
    "Claim Latest Customer Turn",
  );

  const routerCode = node("Route Simple Messages").parameters.jsCode;
  const runRouter = (claim) => new Function("$", "$input", routerCode)(
    (name) => {
      if (name === "Claim Latest Customer Turn") return { item: { json: claim } };
      if (name === "Upsert Customer and Session") {
        return { item: { json: { recent_messages: [] } } };
      }
      throw new Error(`Unexpected router dependency: ${name}`);
    },
    { all: () => [{ json: {} }] },
  )[0].json;

  assert.equal(
    runRouter({ combined_text: "Hi", latest_text: "Hi", batch_span_seconds: 0 }).fast_reply,
    true,
    "The existing deterministic greeting route changed unexpectedly",
  );
  assert.equal(
    runRouter({
      combined_text: "Hi\nI want a large Chicken Fajita pizza",
      latest_text: "I want a large Chicken Fajita pizza",
      batch_span_seconds: 3,
    }).fast_reply,
    false,
    "An actionable burst must reach the ordering agent",
  );
}

async function insertMessages(client, phone, texts, label) {
  const rows = [];
  for (let index = 0; index < texts.length; index += 1) {
    const messageId = `${label}-${index + 1}`;
    const result = await client.query(
      `INSERT INTO message_buffer (
         message_id, customer_phone, message_text, message_type,
         received_at, processed, batch_key, batch_claimed_at, processed_at
       ) VALUES ($1, $2, $3, 'text', NOW() - INTERVAL '3 seconds', FALSE, NULL, NULL, NULL)
       RETURNING id, message_id`,
      [messageId, phone, texts[index]],
    );
    rows.push(result.rows[0]);
  }
  return rows;
}

async function claim(client, phone, bufferId, batchKey) {
  return (await client.query(query("Claim Latest Customer Turn"), [phone, bufferId, batchKey])).rows[0];
}

async function markBatchProcessed(client, phone, batchKey) {
  await client.query(
    `UPDATE message_buffer
     SET processed = TRUE, processed_at = NOW()
     WHERE customer_phone = $1 AND batch_key = $2 AND processed = FALSE`,
    [phone, batchKey],
  );
}

async function drainActionableBurst(client, phone, rows, label) {
  const driverId = rows.at(-1).id;
  const claimedIds = [];
  let orderingAgentInvocations = 0;

  for (let chunk = 1; chunk <= 100; chunk += 1) {
    const pending = Number((await client.query(
      "SELECT COUNT(*) FROM message_buffer WHERE customer_phone = $1 AND processed = FALSE",
      [phone],
    )).rows[0].count);
    if (pending === 0) break;

    const batchKey = `${label}-batch-${chunk}`;
    const result = await claim(client, phone, driverId, batchKey);
    assert.equal(result.mode, "ready", `${label} chunk ${chunk} was not ready`);
    assert(Number(result.message_count) >= 1 && Number(result.message_count) <= 20);
    assert(Number(result.combined_character_count) <= 8192);
    assert.equal(result.reply_already_sent, false);
    orderingAgentInvocations += 1;
    claimedIds.push(...result.message_ids);
    await markBatchProcessed(client, phone, batchKey);
  }

  assert.equal(
    new Set(claimedIds).size,
    rows.length,
    `${label} did not process every logical message exactly once`,
  );
  assert.deepEqual(
    claimedIds,
    rows.map((row) => row.message_id),
    `${label} changed message order`,
  );
  return orderingAgentInvocations;
}

async function createHandoff(client, phone, suffix) {
  const customer = (await client.query(
    "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Burst Handoff Test') RETURNING id",
    [phone],
  )).rows[0];
  await client.query(
    `INSERT INTO conversation_sessions (customer_id, awaiting_human, recent_messages)
     VALUES ($1, TRUE, '[]'::jsonb)`,
    [customer.id],
  );
  const request = (await client.query(
    `INSERT INTO admin_requests (customer_id, request_type, question)
     VALUES ($1, 'human_handoff', $2) RETURNING id`,
    [customer.id, `Burst handoff ${suffix}`],
  )).rows[0];
  return { customer, request };
}

async function databaseTests() {
  assert(process.env.DATABASE_URL, "DATABASE_URL is required for the burst integration tests");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  const client = await pool.connect();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const results = [];

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const onePhone = `burst-one-${suffix}`;
    const oneRows = await insertMessages(client, onePhone, ["Show me the pizza menu"], `one-${suffix}`);
    results.push({ scenario: "1 actionable message", ai_turns: await drainActionableBurst(client, onePhone, oneRows, `one-${suffix}`), replies: 1 });

    const fivePhone = `burst-five-${suffix}`;
    const fiveTexts = ["Hi", "I want pizza", "Large", "Chicken Fajita", "Delivery"];
    const fiveRows = await insertMessages(client, fivePhone, fiveTexts, `five-${suffix}`);
    results.push({ scenario: "5 rapid actionable messages", ai_turns: await drainActionableBurst(client, fivePhone, fiveRows, `five-${suffix}`), replies: 1 });

    const tenPhone = `burst-ten-${suffix}`;
    const tenTexts = Array.from({ length: 10 }, (_, index) => `Order detail ${index + 1}`);
    const tenRows = await insertMessages(client, tenPhone, tenTexts, `ten-${suffix}`);
    results.push({ scenario: "10 rapid actionable messages", ai_turns: await drainActionableBurst(client, tenPhone, tenRows, `ten-${suffix}`), replies: 1 });

    const twentyPhone = `burst-twenty-${suffix}`;
    const twentyTexts = Array.from({ length: 20 }, (_, index) => `Order detail ${index + 1}`);
    const twentyRows = await insertMessages(client, twentyPhone, twentyTexts, `twenty-${suffix}`);
    results.push({ scenario: "20-message maximum batch", ai_turns: await drainActionableBurst(client, twentyPhone, twentyRows, `twenty-${suffix}`), replies: 1 });

    const overflowPhone = `burst-overflow-${suffix}`;
    const overflowTexts = Array.from({ length: 45 }, (_, index) => `Queued order detail ${index + 1}`);
    const overflowRows = await insertMessages(client, overflowPhone, overflowTexts, `overflow-${suffix}`);
    results.push({ scenario: "45-message throttled overflow", ai_turns: await drainActionableBurst(client, overflowPhone, overflowRows, `overflow-${suffix}`), replies: 3 });

    const characterPhone = `burst-characters-${suffix}`;
    const characterRows = await insertMessages(
      client,
      characterPhone,
      ["A".repeat(4096), "B".repeat(4096), "C".repeat(256)],
      `characters-${suffix}`,
    );
    assert.equal(await drainActionableBurst(client, characterPhone, characterRows, `characters-${suffix}`), 2);

    const finalizerPhone = `burst-finalizer-${suffix}`;
    const finalizerCustomer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Burst Finalizer Test') RETURNING id",
      [finalizerPhone],
    )).rows[0];
    await client.query(
      "INSERT INTO conversation_sessions (customer_id, recent_messages) VALUES ($1, '[]'::jsonb)",
      [finalizerCustomer.id],
    );
    const finalizerRows = await insertMessages(
      client,
      finalizerPhone,
      Array.from({ length: 25 }, (_, index) => `Finalizer detail ${index + 1}`),
      `finalizer-${suffix}`,
    );
    const firstFinalizerBatch = `finalizer-batch-1-${suffix}`;
    const firstFinalizerClaim = await claim(
      client,
      finalizerPhone,
      finalizerRows.at(-1).id,
      firstFinalizerBatch,
    );
    assert.equal(Number(firstFinalizerClaim.message_count), 20);
    const firstFinalized = (await client.query(query("Finalize Customer Turn"), [
      finalizerCustomer.id,
      firstFinalizerClaim.combined_text,
      "First queued-chunk reply",
      firstFinalizerBatch,
      finalizerPhone,
    ])).rows[0];
    assert.equal(Number(firstFinalized.buffered_messages_finalized), 20);
    assert.equal(Number(firstFinalized.queued_messages_remaining), 5);
    assert.equal(Number(firstFinalized.queue_wait_seconds), 2);
    const secondFinalizerBatch = `finalizer-batch-2-${suffix}`;
    const secondFinalizerClaim = await claim(
      client,
      finalizerPhone,
      finalizerRows.at(-1).id,
      secondFinalizerBatch,
    );
    assert.equal(Number(secondFinalizerClaim.message_count), 5);
    const secondFinalized = (await client.query(query("Finalize Customer Turn"), [
      finalizerCustomer.id,
      secondFinalizerClaim.combined_text,
      "Second queued-chunk reply",
      secondFinalizerBatch,
      finalizerPhone,
    ])).rows[0];
    assert.equal(Number(secondFinalized.queued_messages_remaining), 0);

    const simplePhone = `burst-simple-${suffix}`;
    const simpleRows = await insertMessages(client, simplePhone, ["Hi"], `simple-${suffix}`);
    const simpleBatch = `simple-batch-${suffix}`;
    const simpleClaim = await claim(client, simplePhone, simpleRows[0].id, simpleBatch);
    const simpleFinalized = (await client.query(query("Finalize Simple Reply"), [
      simplePhone,
      "Simple Burst Test",
      simpleClaim.combined_text,
      "Hi! What would you like to order?",
      simpleBatch,
    ])).rows[0];
    assert.equal(Number(simpleFinalized.messages_finalized), 1);
    assert.equal(Number(simpleFinalized.queued_messages_remaining), 0);

    const customerAPhone = `burst-a-${suffix}`;
    const customerBPhone = `burst-b-${suffix}`;
    const customerARows = [];
    const customerBRows = [];
    for (let index = 0; index < 5; index += 1) {
      customerARows.push(...await insertMessages(client, customerAPhone, [`A-only-${index}`], `a-${suffix}-${index}`));
      customerBRows.push(...await insertMessages(client, customerBPhone, [`B-only-${index}`], `b-${suffix}-${index}`));
    }
    const aClaim = await claim(client, customerAPhone, customerARows.at(-1).id, `a-batch-${suffix}`);
    const bClaim = await claim(client, customerBPhone, customerBRows.at(-1).id, `b-batch-${suffix}`);
    assert.equal(aClaim.mode, "ready");
    assert.equal(bClaim.mode, "ready");
    assert(!aClaim.combined_text.includes("B-only"));
    assert(!bClaim.combined_text.includes("A-only"));
    results.push({ scenario: "2 simultaneous customers", ai_turns: 2, replies: 2 });

    const duplicatePhone = `burst-duplicate-${suffix}`;
    const duplicateId = `duplicate-${suffix}`;
    const insertSql = query("Insert Message to Buffer");
    const firstDuplicate = (await client.query(insertSql, [duplicateId, duplicatePhone, "Add one large pizza", "text"])).rows[0];
    const secondDuplicate = (await client.query(insertSql, [duplicateId, duplicatePhone, "Add one large pizza", "text"])).rows[0];
    assert.equal(firstDuplicate.accepted, true);
    assert.equal(secondDuplicate.accepted, false);
    await client.query("UPDATE message_buffer SET received_at = NOW() - INTERVAL '3 seconds' WHERE id = $1", [firstDuplicate.buffer_id]);
    const duplicateClaim = await claim(client, duplicatePhone, firstDuplicate.buffer_id, `duplicate-batch-${suffix}`);
    assert.equal(duplicateClaim.mode, "ready");
    assert.equal(Number(duplicateClaim.message_count), 1);
    results.push({ scenario: "duplicate webhook event", ai_turns: 1, replies: 1 });

    const duringPhone = `burst-during-${suffix}`;
    const initialRows = await insertMessages(client, duringPhone, ["Start my order"], `during-initial-${suffix}`);
    const initialBatch = `during-active-${suffix}`;
    const initialClaim = await claim(client, duringPhone, initialRows[0].id, initialBatch);
    assert.equal(initialClaim.mode, "ready");
    const queuedRows = await insertMessages(
      client,
      duringPhone,
      ["Large", "Chicken Fajita", "Extra cheese", "Delivery", "Use this address"],
      `during-queued-${suffix}`,
    );
    for (const row of queuedRows.slice(0, -1)) {
      assert.equal((await claim(client, duringPhone, row.id, `during-probe-${row.id}`)).mode, "superseded");
    }
    assert.equal(
      (await claim(client, duringPhone, queuedRows.at(-1).id, `during-busy-${suffix}`)).mode,
      "busy",
    );
    await markBatchProcessed(client, duringPhone, initialBatch);
    const queuedClaim = await claim(client, duringPhone, queuedRows.at(-1).id, `during-next-${suffix}`);
    assert.equal(queuedClaim.mode, "ready");
    assert.equal(Number(queuedClaim.message_count), 5);
    results.push({ scenario: "message burst during AI", ai_turns: 2, replies: 2 });

    const leasePhone = `burst-lease-${suffix}`;
    const leaseRows = await insertMessages(client, leasePhone, ["First active turn"], `lease-first-${suffix}`);
    const leaseBatch = `lease-active-${suffix}`;
    assert.equal((await claim(client, leasePhone, leaseRows[0].id, leaseBatch)).mode, "ready");
    await client.query(
      "UPDATE message_buffer SET batch_claimed_at = NOW() - INTERVAL '2 minutes' WHERE batch_key = $1",
      [leaseBatch],
    );
    const leaseNewRows = await insertMessages(client, leasePhone, ["Queued while slow"], `lease-new-${suffix}`);
    assert.equal((await claim(client, leasePhone, leaseNewRows[0].id, `lease-probe-${suffix}`)).mode, "busy");
    await client.query(
      "UPDATE message_buffer SET batch_claimed_at = NOW() - INTERVAL '11 minutes' WHERE batch_key = $1",
      [leaseBatch],
    );
    assert.equal((await claim(client, leasePhone, leaseNewRows[0].id, `lease-recovered-${suffix}`)).mode, "ready");

    const recoveryPhone = `burst-recovery-${suffix}`;
    const recoveryOldRows = await insertMessages(client, recoveryPhone, ["Old cart mutation"], `recovery-old-${suffix}`);
    await client.query(
      `UPDATE message_buffer
       SET batch_key = $2, batch_claimed_at = NOW() - INTERVAL '11 minutes',
           reply_text = 'Old reply already delivered', replied_at = NOW() - INTERVAL '10 minutes'
       WHERE id = $1`,
      [recoveryOldRows[0].id, `recovery-old-batch-${suffix}`],
    );
    const recoveryNewRows = await insertMessages(client, recoveryPhone, ["New order request"], `recovery-new-${suffix}`);
    const recoveredReply = await claim(client, recoveryPhone, recoveryNewRows[0].id, `recovery-pass-${suffix}`);
    assert.equal(recoveredReply.mode, "ready");
    assert.equal(recoveredReply.reply_already_sent, true);
    assert.equal(Number(recoveredReply.message_count), 1);
    assert.equal(recoveredReply.combined_text, "Old cart mutation");
    await markBatchProcessed(client, recoveryPhone, `recovery-pass-${suffix}`);
    const freshAfterRecovery = await claim(client, recoveryPhone, recoveryNewRows[0].id, `recovery-fresh-${suffix}`);
    assert.equal(freshAfterRecovery.mode, "ready");
    assert.equal(freshAfterRecovery.reply_already_sent, false);
    assert.equal(freshAfterRecovery.combined_text, "New order request");

    const handoffPhone = `burst-handoff-${suffix}`;
    const { customer, request } = await createHandoff(client, handoffPhone, suffix);
    const handoffTexts = ["Hello", "My order", "has an issue", "with one pizza", "Please help"];
    const handoffRows = await insertMessages(client, handoffPhone, handoffTexts, `handoff-${suffix}`);
    const handoffBatch = `handoff-batch-${suffix}`;
    const handoffClaim = await claim(client, handoffPhone, handoffRows.at(-1).id, handoffBatch);
    assert.equal(handoffClaim.mode, "ready");
    const handoffResult = (await client.query(
      query("Record Active Human Handoff Turn"),
      [customer.id, handoffPhone, handoffBatch],
    )).rows[0];
    assert.equal(handoffResult.handoff_active, true);
    assert.equal(Number(handoffResult.customer_messages_recorded), 5);
    assert.equal(Number(handoffResult.queued_messages_remaining), 0);
    assert.equal(Number((await client.query(
      "SELECT COUNT(*) FROM conversation_messages WHERE handoff_request_id = $1 AND direction = 'customer'",
      [request.id],
    )).rows[0].count), 5);
    results.push({ scenario: "5 messages during human handoff", ai_turns: 0, replies: 0 });

    assert.deepEqual(
      results.map((row) => row.ai_turns),
      [1, 1, 1, 1, 3, 2, 1, 2, 0],
    );

    await client.query("ROLLBACK");

    // Run the actual claim statement from separate autocommit connections.
    // The per-phone advisory lock must yield exactly one winner even when all
    // webhook executions reach the claim node together.
    const concurrentPhone = `burst-concurrent-${suffix}`;
    try {
      const concurrentRows = await insertMessages(
        client,
        concurrentPhone,
        ["Concurrent 1", "Concurrent 2", "Concurrent 3", "Concurrent 4", "Concurrent 5"],
        `concurrent-${suffix}`,
      );
      // Establish the two TLS connections before contention so this test
      // measures the advisory lock rather than concurrent connection setup.
      const contenderA = await pool.connect();
      const contenderB = await pool.connect();
      let concurrentClaims;
      try {
        await contenderA.query("SET statement_timeout = '30s'");
        await contenderB.query("SET statement_timeout = '30s'");
        concurrentClaims = await Promise.all([
          contenderA.query(
            query("Claim Latest Customer Turn"),
            [concurrentPhone, concurrentRows[0].id, `concurrent-batch-${suffix}-first`],
          ).then((result) => result.rows[0]),
          contenderB.query(
            query("Claim Latest Customer Turn"),
            [concurrentPhone, concurrentRows.at(-1).id, `concurrent-batch-${suffix}-latest`],
          ).then((result) => result.rows[0]),
        ]);
      } finally {
        contenderA.release();
        contenderB.release();
      }
      const winners = concurrentClaims.filter((result) => result.mode === "ready");
      assert.equal(winners.length, 1, "Concurrent claims produced more than one AI-eligible owner");
      assert.equal(Number(winners[0].message_count), 5);
      assert.equal(concurrentClaims.filter((result) => result.mode === "busy").length, 0);
    } finally {
      await client.query("DELETE FROM message_buffer WHERE customer_phone = $1", [concurrentPhone]);
      await client.query("DELETE FROM processed_messages WHERE customer_phone = $1", [concurrentPhone]);
    }

    return results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  staticTests();
  const results = await databaseTests();
  console.log("Message burst protection PASS");
  console.table(results);
  console.log("Greeting-only 'Hi': 0 ordering-agent invocations, 1 deterministic WhatsApp reply.");
  console.log("Counts are n8n ordering-agent turns; one tool-using agent turn may make multiple internal LLM requests.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
