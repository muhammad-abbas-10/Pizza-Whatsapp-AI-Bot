require("dotenv").config();

const assert = require("assert");
const { performance } = require("perf_hooks");
const { Pool } = require("pg");
const workflow = require("../../admin request.json");

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
  assert(workflow.connections["Use Simple Reply"].main[0][0].node === "Send Simple Reply", "Greeting does not bypass Gemini and session preload");
  assert(workflow.connections["Menu Lookup"]?.ai_tool, "Menu Lookup is not connected to the agent");

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
    const phone = `journey-${Date.now()}`;

    const greetingMessageId = `journey-hi-${Date.now()}`;
    await client.query(`
      INSERT INTO message_buffer (message_id, customer_phone, message_text, message_type, processed, batch_key, batch_claimed_at)
      VALUES ($1, $2, 'hi', 'text', FALSE, $1, NOW())`, [greetingMessageId, phone]);
    let step = await timed(client, "finalize hi after send", query("Finalize Simple Reply"), [
      phone, "Journey Test", "hi",
      "Hi! Welcome to Pizza Bar. You can ask for the menu, order, or cancel.",
      greetingMessageId,
    ]);
    timings.push(step);
    assert.equal(step.result.rows[0].messages_finalized, 1, "Simple greeting was not finalized");
    assert.equal((await client.query("SELECT processed FROM message_buffer WHERE message_id = $1", [greetingMessageId])).rows[0].processed, true);

    step = await timed(client, "load customer/session", query("Upsert Customer and Session"), [phone, "Journey Test"]);
    timings.push(step);
    const customerId = step.result.rows[0].customer_id;

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

    step = await timed(client, "request cancellation", query("Request Cancellation Approval"), [customerId, placed.id, placed.id, "Customer asked to cancel the placed order"]);
    timings.push(step);
    const request = step.result.rows[0];
    assert(request.request_id && request.admin_notification_allowed, "Cancellation request was not created");

    step = await timed(client, "approve cancellation", query("Resolve Admin Request"), [request.request_id, "approved", "Approved by journey test", "923000000000", `journey-admin-${Date.now()}`]);
    timings.push(step);
    assert.equal(step.result.rows[0].outcome, "approved", "Cancellation approval failed");

    const finalState = await client.query(`
      SELECT o.status AS order_status, cs.order_status AS session_status
      FROM orders o JOIN conversation_sessions cs ON cs.customer_id = o.customer_id
      WHERE o.id = $1`, [placed.id]);
    assert.equal(finalState.rows[0].order_status, "cancelled");
    assert.equal(finalState.rows[0].session_status, "cancelled");

    await client.query("ROLLBACK");
    console.log("Customer journey PASS: hi route -> menu lookup -> add -> pickup -> place -> request cancellation -> approve/cancel");
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
