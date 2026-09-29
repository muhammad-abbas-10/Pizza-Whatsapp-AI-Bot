require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { Pool } = require("pg");
const workflow = require("../../workflow.json");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../database/migration/016_dashboard_customer_status_events.sql"),
  "utf8"
).replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function query(name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  assert(node?.parameters?.query, `Missing SQL node: ${name}`);
  return node.parameters.query;
}

async function timed(client, label, sql, params) {
  const start = performance.now();
  const result = await client.query(sql, params);
  return { result, label, ms: Math.round(performance.now() - start) };
}

async function main() {
  assert.equal(workflow.active, false, "Export must stay inactive until imported deliberately");
  assert.equal(workflow.nodes.find((node) => node.name === "Debounce Customer Messages").parameters.amount, 2);
  assert.equal(workflow.nodes.find((node) => node.name === "Wait For Active Customer Turn").parameters.amount, 2);
  assert.equal(workflow.connections["Customer Turn Ready"].main[0][0].node, "Upsert Customer and Session");
  assert.equal(workflow.connections["Upsert Customer and Session"].main[0][0].node, "Recover Reply Before Routing");
  assert.equal(workflow.connections["Recover Reply Before Routing"].main[1][0].node, "Awaiting Feedback Response?");
  assert.equal(workflow.connections["Awaiting Feedback Response?"].main[1][0].node, "Route Simple Messages");
  assert.equal(workflow.connections["Use Simple Reply"].main[0][0].node, "Evolution API Send Simple Reply");
  assert.equal(workflow.connections["Use Simple Reply"].main[1][0].node, "Load Active Menu");
  assert.equal(workflow.connections["Load Active Menu"].main[0][0].node, "Get Restaurant Settings");
  assert.equal(workflow.connections["Get Restaurant Settings"].main[0][0].node, "Pizza Ordering Agent");
  assert(workflow.connections["Menu Lookup"]?.ai_tool, "Menu Lookup is not connected to the agent");
  assert(/ON CONFLICT \(whatsapp_phone\)/i.test(query("Upsert Customer and Session")));
  assert(/customer\.id AS customer_id/i.test(query("Upsert Customer and Session")));

  const routerCode = workflow.nodes.find((node) => node.name === "Route Simple Messages")?.parameters?.jsCode || "";
  const runRouter = (claim) => new Function("$", "$input", routerCode)(
    () => ({ item: { json: claim } }),
    { all: () => [{ json: {} }] },
  )[0].json;
  assert.equal(runRouter({ combined_text: "Hy", latest_text: "Hy", batch_span_seconds: 0 }).fast_reply, true, "Hy greeting is not fast-routed");
  assert.equal(runRouter({ combined_text: "old failed text\nHy", latest_text: "Hy", batch_span_seconds: 90 }).fast_reply, true, "Stale greeting backlog is not recovered");
  assert.equal(runRouter({ combined_text: "add pizza\nHy", latest_text: "Hy", batch_span_seconds: 2 }).fast_reply, false, "A real rapid order burst was incorrectly discarded as greeting-only");
  assert(!workflow.nodes.find((node) => node.name === "Pizza Ordering Agent").parameters.options.systemMessage.includes("MENU_DATA (source"), "Full menu is still injected into the prompt");

  const client = await pool.connect();
  const timings = [];
  try {
    await client.query("BEGIN");
    await client.query(migration);
    const phone = `journey-${Date.now()}`;

    let step = await timed(client, "create customer/session", query("Upsert Customer and Session"), [phone, "Journey Test"]);
    timings.push(step);
    const customerId = step.result.rows[0].customer_id;
    assert(Number(customerId) > 0, "New WhatsApp customer did not receive a customer_id");

    step = await timed(client, "reuse customer/session", query("Upsert Customer and Session"), [phone, "Journey Test"]);
    timings.push(step);
    assert.equal(String(step.result.rows[0].customer_id), String(customerId), "Repeat message changed customer_id");
    assert.equal(Number((await client.query(
      "SELECT COUNT(*) FROM customers WHERE whatsapp_phone = $1", [phone]
    )).rows[0].count), 1, "Repeat/concurrent-safe upsert created a duplicate customer");
    assert.equal(Number((await client.query(
      "SELECT COUNT(*) FROM conversation_sessions WHERE customer_id = $1", [customerId]
    )).rows[0].count), 1, "Repeat upsert created a duplicate session");
    const phoneIsUnique = (await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_attribute attr
          ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
        WHERE con.conrelid = 'customers'::regclass
          AND con.contype = 'u'
          AND attr.attname = 'whatsapp_phone'
      ) AS unique_phone`)).rows[0].unique_phone;
    assert.equal(phoneIsUnique, true, "customers.whatsapp_phone is not concurrency-safe unique");

    const existingPhone = `journey-existing-${Date.now()}`;
    const existingId = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Existing Customer') RETURNING id",
      [existingPhone]
    )).rows[0].id;
    const existingResult = (await client.query(
      query("Upsert Customer and Session"), [existingPhone, "Existing Customer Updated"]
    )).rows[0];
    assert.equal(String(existingResult.customer_id), String(existingId), "Existing customer was duplicated or replaced");

    const greetingMessageId = `journey-hi-${Date.now()}`;
    await client.query(`
      INSERT INTO message_buffer (message_id, customer_phone, message_text, message_type, processed, batch_key, batch_claimed_at)
      VALUES ($1, $2, 'hi', 'text', FALSE, $1, NOW())`, [greetingMessageId, phone]);
    step = await timed(client, "finalize hi after send", query("Finalize Simple Reply"), [
      phone, "Journey Test", "hi",
      "Hi! Welcome to Pizza Bar. You can ask for the menu, order, or cancel.",
      greetingMessageId,
    ]);
    timings.push(step);
    assert.equal(step.result.rows[0].messages_finalized, 1, "Simple greeting was not finalized");
    assert.equal((await client.query("SELECT processed FROM message_buffer WHERE message_id = $1", [greetingMessageId])).rows[0].processed, true);

    step = await timed(client, "lookup Chicken Fajita", query("Menu Lookup"), ["Chicken Fajita", ""]);
    timings.push(step);
    const matches = step.result.rows[0].matches;
    const chosen = matches.find((item) => item.record_type === "menu_item" && item.name === "Chicken Fajita" && String(item.size_or_variant).toLowerCase() === "large")
      || matches.find((item) => item.record_type === "menu_item" && item.name === "Chicken Fajita");
    assert(chosen, "Chicken Fajita was not found in the live menu");

    step = await timed(client, "add item", query("Update Menu Item Cart"), [
      customerId, chosen.id, chosen.variant_id, "add", 1, null,
    ]);
    timings.push(step);
    assert.equal(step.result.rows[0].updated, true, "Cart rejected the selected item");

    step = await timed(client, "set pickup", query("Set Order Type"), [customerId, "pickup"]);
    timings.push(step);
    assert.equal(step.result.rows[0].order_type, "pickup");

    // Change the live price after the cart update. Placement must snapshot this
    // new value rather than trusting the stale cart line_total.
    const originalPrice = Number(chosen.price);
    const livePrice = originalPrice + 37;
    await client.query("UPDATE restaurant_menu_variants SET price = $1 WHERE id = $2", [livePrice, chosen.variant_id]);

    step = await timed(client, "place order", query("Place Order"), [customerId]);
    timings.push(step);
    const placed = step.result.rows[0];
    assert.equal(placed.order_created, true, "Order was not created");
    assert.equal(Number(placed.subtotal), livePrice, "Order used a stale cart price");
    assert.equal(Number(placed.items[0].price), livePrice, "Order item snapshot used a stale price");
    assert.equal(placed.status, "received");
    assert.equal(String((await client.query(
      "SELECT customer_id FROM orders WHERE id = $1", [placed.id]
    )).rows[0].customer_id), String(customerId), "Placed order belongs to the wrong customer_id");

    step = await timed(client, "request cancellation", query("Request Cancellation Approval"), [customerId, placed.id, placed.id, "Customer asked to cancel the placed order"]);
    timings.push(step);
    const request = step.result.rows[0];
    assert(request.request_id && request.dashboard_request_visible, "Cancellation request was not created for the dashboard");
    const dashboardRequest = await client.query(`
      SELECT r.order_id, r.status, n.id AS notification_id
      FROM admin_requests r
      LEFT JOIN admin_notifications n ON n.source_key = 'request:' || r.id
      WHERE r.id = $1`, [request.request_id]);
    assert.equal(String(dashboardRequest.rows[0].order_id), String(placed.id));
    assert.equal(dashboardRequest.rows[0].status, "pending");
    assert(dashboardRequest.rows[0].notification_id, "Cancellation request was not visible in admin notifications");

    await client.query("ROLLBACK");
    console.log("Customer journey PASS: hi route -> menu lookup -> add -> pickup -> committed order -> dashboard cancellation request");
    console.table(timings.map(({ label, ms }) => ({ step: label, database_ms: ms })));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
