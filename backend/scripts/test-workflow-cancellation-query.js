require("dotenv").config();

const { Pool } = require("pg");
const workflow = require("../../admin request.json");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function workflowQuery(name) {
  const node = workflow.nodes.find((item) => item.name === name);
  if (!node?.parameters?.query) throw new Error(`Workflow node ${name} has no SQL query`);
  return node.parameters.query;
}

async function createCustomer(client, suffix) {
  const customer = await client.query(
    `INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Workflow Cancellation Test') RETURNING id`,
    [`workflow-cancel-test-${suffix}-${Date.now()}`]
  );
  await client.query(
    `INSERT INTO conversation_sessions (customer_id, cart, order_type)
     VALUES ($1, $2::jsonb, 'pickup')`,
    [customer.rows[0].id, JSON.stringify({ items: [{ item_name: "Test Pizza", quantity: 1, price: 100, line_total: 100 }] })]
  );
  return customer.rows[0].id;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const placeOrder = workflowQuery("Place Order");
    const requestCancellation = workflowQuery("Request Cancellation Approval");

    const customerId = await createCustomer(client, "single");
    const noOrder = await client.query(requestCancellation, [customerId, null, null, "Cancel"]);
    if (noOrder.rows[0].error !== "no_cancellable_order" || noOrder.rows[0].admin_notification_allowed) {
      throw new Error("No-order cancellation guard failed");
    }

    const placed = await client.query(placeOrder, [customerId]);
    if (!placed.rows[0].order_created || !placed.rows[0].id) throw new Error("Workflow Place Order did not create an order");
    const orderId = placed.rows[0].id;

    const created = await client.query(requestCancellation, [customerId, null, orderId, "Cancel my order"]);
    if (!created.rows[0].request_created || !created.rows[0].admin_notification_allowed || String(created.rows[0].order_id) !== String(orderId)) {
      throw new Error("Single-order cancellation request was not linked correctly");
    }
    if (!created.rows[0].admin_message?.includes(`APPROVE ${created.rows[0].request_id}`)
      || !created.rows[0].admin_message?.includes(`DENY ${created.rows[0].request_id}`)) {
      throw new Error("Cancellation alert is missing deterministic admin commands");
    }
    const repeated = await client.query(requestCancellation, [customerId, null, orderId, "Cancel again"]);
    if (repeated.rows[0].error !== "request_already_pending" || !repeated.rows[0].admin_notification_allowed || repeated.rows[0].request_created) {
      throw new Error("Duplicate pending request was not reused");
    }

    const multiCustomerId = await createCustomer(client, "multiple");
    const first = await client.query(placeOrder, [multiCustomerId]);
    await client.query(
      `UPDATE conversation_sessions SET cart = $2::jsonb, order_type = 'pickup' WHERE customer_id = $1`,
      [multiCustomerId, JSON.stringify({ items: [{ item_name: "Second Pizza", quantity: 1, price: 200, line_total: 200 }] })]
    );
    const second = await client.query(placeOrder, [multiCustomerId]);
    const ambiguous = await client.query(requestCancellation, [multiCustomerId, null, second.rows[0].id, "Cancel my order"]);
    if (ambiguous.rows[0].error !== "multiple_cancellable_orders" || ambiguous.rows[0].admin_notification_allowed || ambiguous.rows[0].order_options.length !== 2) {
      throw new Error("Multiple-order ambiguity was not returned safely");
    }
    const explicit = await client.query(requestCancellation, [multiCustomerId, first.rows[0].id, second.rows[0].id, "Cancel the first order"]);
    if (!explicit.rows[0].request_created || String(explicit.rows[0].order_id) !== String(first.rows[0].id)) {
      throw new Error("Explicit order selection failed");
    }
    const invalid = await client.query(requestCancellation, [multiCustomerId, 999999999, second.rows[0].id, "Cancel unknown order"]);
    if (invalid.rows[0].error !== "requested_order_not_found_or_not_cancellable" || invalid.rows[0].admin_notification_allowed) {
      throw new Error("Invalid explicit order was not rejected");
    }

    await client.query("ROLLBACK");
    console.log("Workflow order creation: passed");
    console.log("Cancellation INSERT and order linkage: passed");
    console.log("No-order and invalid-order guards: passed");
    console.log("Multiple active order clarification: passed");
    console.log("Duplicate request reuse: passed");
    console.log("Actionable admin APPROVE/DENY message: passed");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
