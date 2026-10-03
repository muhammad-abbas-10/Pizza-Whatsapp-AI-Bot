require("dotenv").config();

const assert = require("assert");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { registerAdminRoutes } = require("../src/admin-routes");
const { publicEvent } = require("../src/customer-notification-events");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const migration = fs.readFileSync(path.join(root, "database/migration/024_human_handoff_conversations.sql"), "utf8");

function node(name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert(found, `Missing workflow node: ${name}`);
  return found;
}

function reachableFrom(start) {
  const found = new Set();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (found.has(current)) continue;
    found.add(current);
    for (const outputs of Object.values(workflow.connections[current] || {})) {
      for (const branch of outputs) for (const next of branch || []) queue.push(next.node);
    }
  }
  found.delete(start);
  return found;
}

function staticTests() {
  assert(migration.includes("CREATE TABLE IF NOT EXISTS conversation_messages"));
  assert(migration.includes("'staff_message'"));
  assert(migration.includes("sync_handoff_message_delivery"));

  const customerPath = reachableFrom("Evolution API Webhook");
  assert(customerPath.has("Human Handoff Active?"));
  assert(customerPath.has("Record Active Human Handoff Turn"));
  assert(customerPath.has("Human Handoff Turn Recorded?"));
  const record = node("Record Active Human Handoff Turn").parameters.query;
  assert(record.includes("conversation_messages"));
  assert(record.includes("processed = TRUE"));
  assert.deepEqual(workflow.connections["Human Handoff Turn Recorded?"].main[0], []);

  const finalized = node("Finalize Customer Turn").parameters.query;
  assert(finalized.includes("active_handoff"));
  assert(finalized.includes("handoff_messages"));

  const adminPath = reachableFrom("Admin Order Status Webhook");
  assert(adminPath.has("Staff Message Event?"));
  assert(adminPath.has("Evolution API Send Admin Status"));
  const claim = node("Claim Admin Customer Event").parameters.query;
  assert(claim.includes("LEFT JOIN conversation_messages cm"));
  assert(claim.includes("c.staff_message"));
  const safeCode = node("Build Safe Admin Customer Message").parameters.jsCode;
  const build = new Function("$", "$input", safeCode);
  const exact = build(
    (name) => {
      assert.equal(name, "Claim Admin Customer Event");
      return { item: { json: { event_type: "staff_message", staff_message: "Aoa Ali, I am checking this now." } } };
    },
    { first: () => ({ json: { output: "must not be used" } }) }
  )[0].json;
  assert.equal(exact.customer_message, "Aoa Ali, I am checking this now.");
  assert.equal(exact.ai_fallback_used, false);
}

async function jsonRequest(baseUrl, method, route, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  staticTests();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  let server;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const username = `handoff-admin-${suffix}`;
    const password = "handoff-test-password";
    const admin = (await client.query(
      "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) RETURNING id",
      [username, await bcrypt.hash(password, 12)]
    )).rows[0];
    const customer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Handoff Customer') RETURNING id, whatsapp_phone",
      [`handoff-customer-${suffix}`]
    )).rows[0];
    await client.query(
      "INSERT INTO conversation_sessions (customer_id, awaiting_human, recent_messages) VALUES ($1, TRUE, '[]'::jsonb)",
      [customer.id]
    );
    const handoff = (await client.query(
      `INSERT INTO admin_requests (customer_id, request_type, question)
       VALUES ($1, 'human_handoff', 'Customer says the order is wrong') RETURNING id`,
      [customer.id]
    )).rows[0];

    // The handoff-triggering customer message and the bot promise are both
    // retained in the handoff history once their existing reply is finalized.
    const initialKey = `handoff-initial-${suffix}`;
    await client.query(
      `INSERT INTO message_buffer (message_id, customer_phone, message_text, message_type, batch_key, processed)
       VALUES ($1, $2, 'My order is wrong.', 'text', $3, FALSE)`,
      [initialKey, customer.whatsapp_phone, initialKey]
    );
    const finalizeSql = node("Finalize Customer Turn").parameters.query;
    await client.query(finalizeSql, [
      customer.id,
      "My order is wrong.",
      "I have shared your issue with the restaurant team for review.",
      initialKey,
      customer.whatsapp_phone,
    ]);
    const firstHistory = (await client.query(
      "SELECT direction, message_text FROM conversation_messages WHERE handoff_request_id = $1 ORDER BY id",
      [handoff.id]
    )).rows;
    assert.deepEqual(firstHistory.map((row) => row.direction), ["customer", "bot"]);

    // A later customer message is persisted and the message-buffer turn is
    // finalized without entering an AI reply path.
    const inboundKey = `handoff-reply-${suffix}`;
    await client.query(
      `INSERT INTO message_buffer (message_id, customer_phone, message_text, message_type, batch_key, processed)
       VALUES ($1, $2, 'The pizza should have had extra cheese.', 'text', $3, FALSE)`,
      [inboundKey, customer.whatsapp_phone, inboundKey]
    );
    const recordSql = node("Record Active Human Handoff Turn").parameters.query;
    const recorded = (await client.query(recordSql, [customer.id, customer.whatsapp_phone, inboundKey])).rows[0];
    assert.equal(recorded.handoff_active, true);
    assert.equal((await client.query("SELECT processed FROM message_buffer WHERE message_id = $1", [inboundKey])).rows[0].processed, true);
    assert.equal((await client.query(
      "SELECT message_text FROM conversation_messages WHERE source_message_id = $1", [inboundKey]
    )).rows[0].message_text, "The pizza should have had extra cheese.");

    // Exercise the real n8n claim/result SQL for a staff reply. This proves the
    // existing Evolution send node receives the exact staff text and the result
    // trigger records sent/failed state on the visible conversation message.
    const workflowStaffMessage = (await client.query(
      `INSERT INTO conversation_messages (
         customer_id, handoff_request_id, direction, message_text,
         client_message_id, staff_admin_user_id, delivery_status
       ) VALUES ($1, $2, 'staff', 'I am checking your order now.', $3, $4, 'pending') RETURNING id`,
      [customer.id, handoff.id, crypto.randomUUID(), admin.id]
    )).rows[0];
    const workflowEventRequestId = crypto.randomUUID();
    const workflowEvent = (await client.query(
      `INSERT INTO customer_notification_events (
         request_id, idempotency_key, event_type, source, customer_id,
         conversation_message_id, admin_user_id
       ) VALUES ($1, $2, 'staff_message', 'admin_dashboard', $3, $4, $5) RETURNING id`,
      [workflowEventRequestId, `handoff-workflow:${suffix}`, customer.id, workflowStaffMessage.id, admin.id]
    )).rows[0];
    const claimSql = node("Claim Admin Customer Event").parameters.query;
    const claimed = (await client.query(claimSql, [workflowEvent.id, workflowEventRequestId, `test-execution-${suffix}`])).rows[0];
    assert.equal(claimed.should_send, true);
    assert.equal(claimed.staff_message, "I am checking your order now.");
    const resultSql = node("Record Admin Event Result").parameters.query;
    await client.query(resultSql, [workflowEvent.id, `test-execution-${suffix}`, true, "wamid.workflow.test", null]);
    assert.equal((await client.query(
      "SELECT delivery_status, provider_message_id FROM conversation_messages WHERE id = $1", [workflowStaffMessage.id]
    )).rows[0].delivery_status, "sent");

    let routeTransactionOpen = false;
    const routePool = {
      query: (...args) => client.query(...args),
      async connect() {
        return {
          async query(sql, params) {
            if (sql === "BEGIN") {
              assert.equal(routeTransactionOpen, false, "Unexpected nested route transaction");
              routeTransactionOpen = true;
              return client.query("SAVEPOINT handoff_route");
            }
            if (sql === "COMMIT") {
              routeTransactionOpen = false;
              return client.query("RELEASE SAVEPOINT handoff_route");
            }
            if (sql === "ROLLBACK") {
              routeTransactionOpen = false;
              await client.query("ROLLBACK TO SAVEPOINT handoff_route");
              return client.query("RELEASE SAVEPOINT handoff_route");
            }
            return client.query(sql, params);
          },
          release() {},
        };
      },
    };
    let dispatches = 0;
    let failDelivery = false;
    const dispatchEvent = async (eventId) => {
      const current = (await client.query("SELECT * FROM customer_notification_events WHERE id = $1", [eventId])).rows[0];
      if (current.delivery_status === "sent") return { accepted: true, lifecycle: "duplicate", event: publicEvent(current) };
      dispatches += 1;
      const event = (await client.query(
        `UPDATE customer_notification_events
         SET delivery_status = $2, attempts = attempts + 1,
             provider_message_id = CASE WHEN $2 = 'sent' THEN $3 ELSE NULL END,
             last_error = CASE WHEN $2 = 'failed' THEN 'simulated provider failure' ELSE NULL END,
             sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [eventId, failDelivery ? "failed" : "sent", `wamid.route.${dispatches}`]
      )).rows[0];
      return { accepted: !failDelivery, lifecycle: event.delivery_status, event: publicEvent(event) };
    };

    const app = express();
    app.use(express.json());
    registerAdminRoutes(app, routePool, { dispatchEvent });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages`, {
      message: "This must not send", client_message_id: crypto.randomUUID(),
    });
    assert.equal(unauthorized.status, 401);
    const login = await jsonRequest(baseUrl, "POST", "/admin/login", { username, password });
    assert.equal(login.status, 200);
    const token = login.body.token;

    const firstClientMessageId = crypto.randomUUID();
    const sent = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages`, {
      message: "Assalam o Alaikum, I am checking your order. What was incorrect?",
      client_message_id: firstClientMessageId,
    }, token);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.delivery_status, "sent");
    assert.equal((await client.query(
      "SELECT delivery_status, staff_admin_user_id FROM conversation_messages WHERE client_message_id = $1", [firstClientMessageId]
    )).rows[0].delivery_status, "sent");
    assert.equal(String((await client.query(
      "SELECT staff_admin_user_id FROM conversation_messages WHERE client_message_id = $1", [firstClientMessageId]
    )).rows[0].staff_admin_user_id), String(admin.id));
    const countBeforeDuplicate = dispatches;
    const duplicate = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages`, {
      message: "Assalam o Alaikum, I am checking your order. What was incorrect?",
      client_message_id: firstClientMessageId,
    }, token);
    assert.equal(duplicate.status, 200);
    assert.equal(dispatches, countBeforeDuplicate, "Duplicate browser submission dispatched again");

    failDelivery = true;
    const failedClientMessageId = crypto.randomUUID();
    const failed = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages`, {
      message: "Please confirm your address.", client_message_id: failedClientMessageId,
    }, token);
    assert.equal(failed.status, 502);
    const failedMessage = (await client.query(
      "SELECT id, delivery_status, last_error FROM conversation_messages WHERE client_message_id = $1", [failedClientMessageId]
    )).rows[0];
    assert.equal(failedMessage.delivery_status, "failed");
    assert.match(failedMessage.last_error, /simulated provider failure/i);
    failDelivery = false;
    const retried = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages/${failedMessage.id}/retry`, {}, token);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.delivery_status, "sent");

    const requestDetail = await jsonRequest(baseUrl, "GET", `/admin/requests/${handoff.id}`, undefined, token);
    assert.equal(requestDetail.status, 200);
    assert(requestDetail.body.conversation.messages.every((message) => String(message.id) !== "-1"));
    assert(requestDetail.body.conversation.messages.some((message) => message.direction === "staff" && message.delivery_status === "sent"));

    const otherCustomer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Other Handoff Customer') RETURNING id",
      [`handoff-other-${suffix}`]
    )).rows[0];
    await client.query("INSERT INTO conversation_sessions (customer_id, awaiting_human) VALUES ($1, TRUE)", [otherCustomer.id]);
    const otherHandoff = (await client.query(
      `INSERT INTO admin_requests (customer_id, request_type, question)
       VALUES ($1, 'human_handoff', 'Other customer issue') RETURNING id`,
      [otherCustomer.id]
    )).rows[0];
    await client.query(
      `INSERT INTO conversation_messages (customer_id, handoff_request_id, direction, message_text, delivery_status)
       VALUES ($1, $2, 'customer', 'This must stay in the other customer conversation.', 'received')`,
      [otherCustomer.id, otherHandoff.id]
    );
    const isolatedDetail = await jsonRequest(baseUrl, "GET", `/admin/requests/${handoff.id}`, undefined, token);
    assert(!isolatedDetail.body.conversation.messages.some(
      (message) => message.message_text === "This must stay in the other customer conversation."
    ), "A different customer's handoff message leaked into this conversation");

    const ended = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/end-handoff`, {}, token);
    assert.equal(ended.status, 200);
    assert.equal((await client.query(
      "SELECT awaiting_human FROM conversation_sessions WHERE customer_id = $1", [customer.id]
    )).rows[0].awaiting_human, false);
    const afterEnd = await jsonRequest(baseUrl, "POST", `/admin/requests/${handoff.id}/messages`, {
      message: "This must not send after ending", client_message_id: crypto.randomUUID(),
    }, token);
    assert.equal(afterEnd.status, 409);

    console.log("Human handoff API, outbox delivery state, n8n claim/result, AI suppression route, auth, retry, and return-to-AI tests: PASS");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
