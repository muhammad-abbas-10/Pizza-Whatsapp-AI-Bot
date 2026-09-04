require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { CUSTOMER_NOTIFICATION_CLAIM_SQL } = require("../src/admin-routes");

const workflowPath = path.resolve(__dirname, "../../admin request.json");
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const nodeByName = new Map(workflow.nodes.map((node) => [node.name, node]));

function node(name) {
  const value = nodeByName.get(name);
  assert(value, `Missing workflow node: ${name}`);
  return value;
}

function reachableFrom(start, outputIndex) {
  const seen = new Set();
  const queue = [];
  const first = workflow.connections[start]?.main?.[outputIndex] || [];
  queue.push(...first.map((edge) => edge.node));
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const outputs = workflow.connections[name]?.main || [];
    for (const output of outputs) {
      for (const edge of output || []) queue.push(edge.node);
    }
  }
  return seen;
}

function structuralChecks() {
  const serialized = JSON.stringify(workflow);
  assert(!/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(serialized), "Live workflow still contains DDL");
  assert(!nodeByName.has("Ensure Schema"), "Ensure Schema must not run per message");
  assert(!nodeByName.has("Combine and Mark Processed"), "Old premature buffer finalizer still exists");
  assert(!serialized.includes("923135928082"), "Workflow contains a fallback admin phone");
  assert(!serialized.includes("1328729090313034"), "Workflow contains a fallback phone-number id");
  assert(node("WhatsApp Trigger").notes.includes("native HMAC-SHA256"), "Native webhook-signature verification is not documented");

  for (const match of serialized.matchAll(/\$\('([^']+)'\)/g)) {
    assert(nodeByName.has(match[1]), `Expression references missing node: ${match[1]}`);
  }

  const adminPath = reachableFrom("Is Authorized Admin", 0);
  const customerPath = reachableFrom("Is Authorized Admin", 1);
  assert(adminPath.has("Resolve Admin Request"));
  assert(adminPath.has("Finalize Admin Message"));
  assert(!adminPath.has("Upsert Customer and Session"));
  assert(!adminPath.has("Pizza Ordering Agent"));
  assert(customerPath.has("Pizza Ordering Agent"));
  assert(customerPath.has("Finalize Customer Turn"));
  assert(!customerPath.has("Resolve Admin Request"));

  const statusOnlyPath = reachableFrom("Has Message", 1);
  assert.equal(statusOnlyPath.size, 0, "Status-only webhook events must stop immediately");
  const unsupportedPath = reachableFrom("Is Supported Text Message", 1);
  assert(unsupportedPath.has("Send Unsupported Message"));
  assert(!unsupportedPath.has("Insert Message to Buffer"));
  assert(!unsupportedPath.has("Upsert Customer and Session"));
  assert(!unsupportedPath.has("Pizza Ordering Agent"));
  const recoveryPath = reachableFrom("Reply Already Sent For This Batch", 0);
  assert(recoveryPath.has("Finalize Customer Turn"));
  assert(!recoveryPath.has("Pizza Ordering Agent"));
  assert(!recoveryPath.has("Send message"));
  const fallbackPath = reachableFrom("Agent Output Valid", 1);
  assert(fallbackPath.has("Send message") && fallbackPath.has("Record Reply Sent"));
  assert.equal(node("Pizza Ordering Agent").continueOnFail, true);
  assert(node("Upsert Customer and Session").parameters.query.includes("active_order.status AS active_order_status"));
  assert(nodeByName.has("Update Placed Order Delivery Info"));
  assert(node("Escalate To Human").parameters.query.includes("INSERT INTO admin_notifications"));

  const normalizeSql = (sql) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
  assert.equal(
    normalizeSql(node("Claim Customer Notification").parameters.query),
    normalizeSql(CUSTOMER_NOTIFICATION_CLAIM_SQL),
    "Express and n8n notification claim SQL diverged",
  );

  const code = node("Parse Admin Command").parameters.jsCode;
  const parse = new Function("$input", code);
  const parsed = parse({ all: () => [{ json: { message_text: "APPROVE 27 customer called" } }] });
  assert.equal(parsed[0].json.command_valid, true);
  assert.equal(parsed[0].json.decision, "approved");
  assert.equal(parsed[0].json.request_id, "27");
  assert.equal(parsed[0].json.admin_note, "customer called");
  const denied = parse({ all: () => [{ json: { message_text: "deny 81 out of stock" } }] });
  assert.equal(denied[0].json.decision, "denied");
  const invalid = parse({ all: () => [{ json: { message_text: "yes cancel it" } }] });
  assert.equal(invalid[0].json.command_valid, false);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

async function sqlChecks() {
  const client = await pool.connect();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const customerPhone = `runtime-customer-${suffix}`;
  const adminPhone = `runtime-admin-${suffix}`;
  const message1 = `wamid-runtime-1-${suffix}`;
  const message2 = `wamid-runtime-2-${suffix}`;
  const message3 = `wamid-runtime-3-${suffix}`;
  const adminMessage = `wamid-runtime-admin-${suffix}`;

  const acceptSql = node("Insert Message to Buffer").parameters.query;
  const claimTurnSql = node("Claim Latest Customer Turn").parameters.query;
  const finalizeCustomerSql = node("Finalize Customer Turn").parameters.query;
  const claimAdminSql = node("Claim Admin Message").parameters.query;
  const resolveAdminSql = node("Resolve Admin Request").parameters.query;
  const recordNotificationSql = node("Record Customer Decision Notification").parameters.query;
  const claimNotificationSql = node("Claim Customer Notification").parameters.query;
  const recordReplySql = node("Record Reply Sent").parameters.query;
  const finalizeAdminSql = node("Finalize Admin Message").parameters.query;

  try {
    await client.query("BEGIN");

    const first = (await client.query(acceptSql, [message1, customerPhone, "one pizza", "text"])).rows[0];
    assert.equal(first.accepted, true);
    const duplicate = (await client.query(acceptSql, [message1, customerPhone, "one pizza", "text"])).rows[0];
    assert.equal(duplicate.accepted, false);

    const second = (await client.query(acceptSql, [message2, customerPhone, "large please", "text"])).rows[0];
    assert.equal(second.accepted, true);
    const superseded = (await client.query(claimTurnSql, [customerPhone, first.buffer_id, message1])).rows[0];
    assert.equal(superseded.mode, "superseded");
    const ready = (await client.query(claimTurnSql, [customerPhone, second.buffer_id, message2])).rows[0];
    assert.equal(ready.mode, "ready");
    assert.equal(ready.message_count, 2);
    assert.equal(ready.combined_text, "one pizza\nlarge please");

    const third = (await client.query(acceptSql, [message3, customerPhone, "pickup", "text"])).rows[0];
    assert.equal(third.accepted, true);
    const busy = (await client.query(claimTurnSql, [customerPhone, third.buffer_id, message3])).rows[0];
    assert.equal(busy.mode, "busy");

    const customer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Runtime Test') RETURNING id",
      [customerPhone],
    )).rows[0];
    await client.query("INSERT INTO conversation_sessions (customer_id) VALUES ($1)", [customer.id]);
    const finalized = (await client.query(finalizeCustomerSql, [customer.id, ready.combined_text, "Got it", message2, customerPhone])).rows[0];
    assert.equal(finalized.buffered_messages_finalized, 2);
    assert.equal(finalized.message_ids_recorded, 2);

    const thirdReady = (await client.query(claimTurnSql, [customerPhone, third.buffer_id, message3])).rows[0];
    assert.equal(thirdReady.mode, "ready");
    const replyMarked = (await client.query(recordReplySql, [message3, "Pickup selected", customerPhone])).rows[0];
    assert.equal(replyMarked.replies_recorded, 1, "Outbound reply state was not recorded");
    await client.query(`UPDATE message_buffer SET received_at = NOW() - INTERVAL '6 minutes', batch_claimed_at = NOW() - INTERVAL '6 minutes' WHERE message_id = $1`, [message3]);
    const retryAccepted = (await client.query(acceptSql, [message3, customerPhone, "pickup", "text"])).rows[0];
    assert.equal(retryAccepted.accepted, true, "Stale unfinalized delivery was not recoverable");
    const recovered = (await client.query(claimTurnSql, [customerPhone, retryAccepted.buffer_id, message3])).rows[0];
    assert.equal(recovered.reply_already_sent, true, "Recovered batch did not detect its previously sent reply");
    assert.equal(recovered.stored_reply_text, "Pickup selected");
    const thirdFinalized = (await client.query(finalizeCustomerSql, [customer.id, recovered.combined_text, recovered.stored_reply_text, message3, customerPhone])).rows[0];
    assert.equal(thirdFinalized.buffered_messages_finalized, 1);
    const finalDuplicate = (await client.query(acceptSql, [message1, customerPhone, "one pizza", "text"])).rows[0];
    assert.equal(finalDuplicate.accepted, false);

    const customerCountBeforeAdmin = Number((await client.query("SELECT count(*) FROM customers")).rows[0].count);
    const adminClaim = (await client.query(claimAdminSql, [adminMessage, adminPhone, "APPROVE 1"])).rows[0];
    assert.equal(adminClaim.should_process, true);
    const adminDuplicate = (await client.query(claimAdminSql, [adminMessage, adminPhone, "APPROVE 1"])).rows[0];
    assert.equal(adminDuplicate.should_process, false);
    const customerCountAfterAdmin = Number((await client.query("SELECT count(*) FROM customers")).rows[0].count);
    assert.equal(customerCountAfterAdmin, customerCountBeforeAdmin, "Admin claim created a customer row");

    const order = (await client.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total, status)
       VALUES ($1, '[]'::jsonb, 'pickup', 1000, 0, 1000, 'received') RETURNING id`,
      [customer.id],
    )).rows[0];
    const request = (await client.query(
      `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
       VALUES ($1, $2, 'cancel_order', 'Please cancel') RETURNING id`,
      [customer.id, order.id],
    )).rows[0];

    const approved = (await client.query(resolveAdminSql, [request.id, "approved", "Approved in runtime test", adminPhone, adminMessage])).rows[0];
    assert.equal(approved.outcome, "approved");
    assert.equal(approved.final_status, "approved");
    assert.equal(approved.notify_customer, true);
    assert.equal((await client.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status, "cancelled");

    const repeated = (await client.query(resolveAdminSql, [request.id, "approved", "duplicate", adminPhone, `${adminMessage}-repeat`])).rows[0];
    assert.equal(repeated.outcome, "already_approved");
    assert.equal(repeated.notify_customer, true, "Resolved request should remain eligible until the shared claim runs");
    const notificationClaim = await client.query(claimNotificationSql, [request.id, adminMessage]);
    assert.equal(notificationClaim.rows.length, 1, "First notification claim failed");
    const competingClaim = await client.query(claimNotificationSql, [request.id, `${adminMessage}-competing`]);
    assert.equal(competingClaim.rows.length, 0, "Concurrent notification claimant acquired the same lease");
    const recorded = (await client.query(recordNotificationSql, [request.id, "wamid-outbound-test", adminMessage])).rows[0];
    assert.equal(recorded.notification_recorded, true);
    const afterNotification = (await client.query(resolveAdminSql, [request.id, "approved", "duplicate", adminPhone, `${adminMessage}-repeat-2`])).rows[0];
    assert.equal(afterNotification.notify_customer, false);

    const denyOrder = (await client.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total, status)
       VALUES ($1, '[]'::jsonb, 'pickup', 900, 0, 900, 'received') RETURNING id`,
      [customer.id],
    )).rows[0];
    const denyRequest = (await client.query(
      `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
       VALUES ($1, $2, 'cancel_order', 'Cancel another') RETURNING id`,
      [customer.id, denyOrder.id],
    )).rows[0];
    const denied = (await client.query(resolveAdminSql, [denyRequest.id, "denied", "Kitchen started", adminPhone, `${adminMessage}-deny`])).rows[0];
    assert.equal(denied.outcome, "denied");
    assert.equal((await client.query("SELECT status FROM orders WHERE id = $1", [denyOrder.id])).rows[0].status, "received");

    const completedOrder = (await client.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total, status)
       VALUES ($1, '[]'::jsonb, 'pickup', 700, 0, 700, 'completed') RETURNING id`,
      [customer.id],
    )).rows[0];
    const completedRequest = (await client.query(
      `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
       VALUES ($1, $2, 'cancel_order', 'Cancel completed') RETURNING id`,
      [customer.id, completedOrder.id],
    )).rows[0];
    const nonCancellable = (await client.query(resolveAdminSql, [completedRequest.id, "approved", "", adminPhone, `${adminMessage}-completed`])).rows[0];
    assert.equal(nonCancellable.outcome, "order_not_cancellable");
    assert.equal(nonCancellable.notify_customer, false);
    assert.equal((await client.query("SELECT status FROM admin_requests WHERE id = $1", [completedRequest.id])).rows[0].status, "pending");

    const missing = (await client.query(resolveAdminSql, ["9223372036854775806", "approved", "", adminPhone, `${adminMessage}-missing`])).rows[0];
    assert.equal(missing.outcome, "not_found");
    assert.equal(missing.notify_customer, false);

    const adminFinalized = (await client.query(finalizeAdminSql, [adminMessage, adminPhone])).rows[0];
    assert.equal(adminFinalized.claim_finalized, true);
    assert.equal(adminFinalized.message_recorded, true);

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  structuralChecks();
  await sqlChecks();
  console.log("Workflow runtime structural and SQL scenarios: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
