require("dotenv").config();

const fs = require("fs");
const path = require("path");
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

function workflowNode(name) {
  const node = workflow.nodes.find((item) => item.name === name);
  if (!node) throw new Error(`Workflow node not found: ${name}`);
  return node;
}

function workflowQuery(name) {
  const node = workflowNode(name);
  if (!node.parameters?.query) throw new Error(`Workflow node ${name} has no SQL query`);
  return node.parameters.query;
}

async function runCancellationGuard(agentJson, customerMessage, session = { order_status: "placed" }) {
  const code = workflowNode("Guard Cancellation Reply").parameters.jsCode;
  const execute = new Function(
    "$input",
    "$",
    `return (async () => { ${code} })();`
  );
  const result = await execute(
    { first: () => ({ json: agentJson }) },
    (name) => ({
      item: {
        json: name === "Upsert Customer and Session"
          ? session
          : { combined_text: customerMessage },
      },
    })
  );
  return result[0].json;
}

function agentOutputValid(json) {
  if (json?.cancellation_reply_safe !== true) return false;
  if (!json?.cancellation_success_claimed) return true;
  return json.cancellation_submission_confirmed === true
    && json.request_created === true
    && json.dashboard_request_visible === true
    && json.request_id !== null
    && json.request_id !== ""
    && json.cancellation_error === null;
}

async function createCustomer(client, suffix) {
  const menuLine = (await client.query(`
    SELECT mi.id AS menu_item_id, mi.name AS item_name, mv.id AS variant_id,
           mv.variant_label AS size, mv.price
    FROM restaurant_menu_items mi
    JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id
    WHERE mi.active = TRUE AND mv.active = TRUE
    ORDER BY mi.id, mv.id LIMIT 1
  `)).rows[0];
  if (!menuLine) throw new Error("Cancellation test needs one active menu variant");
  const cartLine = {
    record_type: "menu_item",
    menu_item_id: Number(menuLine.menu_item_id),
    variant_id: Number(menuLine.variant_id),
    item_name: menuLine.item_name,
    size: menuLine.size,
    quantity: 1,
    price: Number(menuLine.price),
    line_total: Number(menuLine.price),
    selected_components: [],
  };
  const customer = await client.query(
    `INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Workflow Cancellation Test') RETURNING id`,
    [`workflow-cancel-test-${suffix}-${Date.now()}`]
  );
  await client.query(
    `INSERT INTO conversation_sessions (customer_id, cart, order_type)
     VALUES ($1, $2::jsonb, 'pickup')`,
    [customer.rows[0].id, JSON.stringify({ items: [cartLine] })]
  );
  return { customerId: customer.rows[0].id, cartLine };
}

async function refillCart(client, customerId, cartLine, quantity) {
  await client.query(
    `UPDATE conversation_sessions
     SET cart = $2::jsonb, order_type = 'pickup'
     WHERE customer_id = $1`,
    [
      customerId,
      JSON.stringify({
        items: [{
          ...cartLine,
          quantity,
          line_total: Number(cartLine.price) * quantity,
        }],
      }),
    ]
  );
}

function toolStep(row) {
  return {
    action: { tool: "Request_Cancellation_Approval" },
    observation: JSON.stringify([row]),
  };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration);
    const placeOrder = workflowQuery("Place Order");
    const requestCancellation = workflowQuery("Request Cancellation Approval");

    const { customerId } = await createCustomer(client, "single");
    const noOrder = await client.query(requestCancellation, [customerId, null, null, "Cancel"]);
    if (
      noOrder.rows[0].error !== "no_cancellable_order"
      || noOrder.rows[0].request_created
      || noOrder.rows[0].dashboard_request_visible
    ) throw new Error("No-order cancellation guard failed");
    const draftGuard = await runCancellationGuard(
      {
        output: "Your draft order has been cleared.",
        intermediateSteps: [{
          action: { tool: "Cancel_Order" },
          observation: JSON.stringify([{ cart_cleared: true }]),
        }],
      },
      "Cancel my order",
      { order_status: "draft", active_order_id: null }
    );
    if (
      draftGuard.output !== "Your draft order has been cleared."
      || draftGuard.cancellation_intent
      || !agentOutputValid(draftGuard)
    ) throw new Error("Placed-order guard interfered with draft cart cancellation");

    const placed = await client.query(placeOrder, [customerId]);
    if (!placed.rows[0].order_created || !placed.rows[0].id) {
      throw new Error("Workflow Place Order did not create an order");
    }
    const orderId = placed.rows[0].id;
    await client.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [orderId]);

    const created = await client.query(
      requestCancellation,
      [customerId, null, orderId, "Cancel my order"]
    );
    const createdRow = created.rows[0];
    if (
      !createdRow.request_created
      || !createdRow.dashboard_request_visible
      || !createdRow.request_id
      || createdRow.error !== null
      || String(createdRow.order_id) !== String(orderId)
    ) throw new Error("Preparing-order cancellation request was not confirmed correctly");
    const pending = await client.query(
      `SELECT id, status FROM admin_requests
       WHERE id = $1 AND order_id = $2 AND request_type = 'cancel_order'`,
      [createdRow.request_id, orderId]
    );
    if (pending.rows[0]?.status !== "pending") {
      throw new Error("Cancellation request is not visible in Pending Requests");
    }
    const successGuard = await runCancellationGuard(
      { output: "Request sent.", intermediateSteps: [toolStep(createdRow)] },
      "I want to cancel my order"
    );
    if (
      !successGuard.cancellation_submission_confirmed
      || !successGuard.cancellation_success_claimed
      || !agentOutputValid(successGuard)
      || !/sent.+admin/i.test(successGuard.output)
    ) throw new Error("Confirmed INSERT did not produce a validated customer confirmation");

    const repeated = await client.query(
      requestCancellation,
      [customerId, null, orderId, "Cancel again"]
    );
    if (
      repeated.rows[0].error !== "request_already_pending"
      || !repeated.rows[0].dashboard_request_visible
      || repeated.rows[0].request_created
    ) throw new Error("Duplicate pending request was not identified safely");
    const repeatedGuard = await runCancellationGuard(
      { output: "Request sent to admin.", intermediateSteps: [toolStep(repeated.rows[0])] },
      "Cancel again"
    );
    if (
      repeatedGuard.cancellation_success_claimed
      || !/already awaiting admin review/i.test(repeatedGuard.output)
    ) throw new Error("Existing request was incorrectly described as newly submitted");

    const { customerId: ovenCustomerId } = await createCustomer(client, "oven");
    const ovenPlaced = await client.query(placeOrder, [ovenCustomerId]);
    const ovenOrderId = ovenPlaced.rows[0].id;
    await client.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [ovenOrderId]);
    await client.query("UPDATE orders SET status = 'oven' WHERE id = $1", [ovenOrderId]);
    const oven = await client.query(
      requestCancellation,
      [ovenCustomerId, null, ovenOrderId, "Cancel my order"]
    );
    const ovenRow = oven.rows[0];
    if (
      ovenRow.error !== "order_not_cancellable"
      || ovenRow.request_created
      || ovenRow.dashboard_request_visible
      || String(ovenRow.order_id) !== String(ovenOrderId)
      || ovenRow.order_status !== "oven"
    ) throw new Error("Oven order was not rejected unambiguously");
    const ovenRequests = await client.query(
      "SELECT COUNT(*)::int AS count FROM admin_requests WHERE order_id = $1",
      [ovenOrderId]
    );
    if (ovenRequests.rows[0].count !== 0) throw new Error("Oven order created a pending request");
    const ovenGuard = await runCancellationGuard(
      { output: "I've sent your request to admin.", intermediateSteps: [toolStep(ovenRow)] },
      "I want to cancel my order"
    );
    if (
      ovenGuard.cancellation_success_claimed
      || !/progressed too far/i.test(ovenGuard.output)
      || !agentOutputValid(ovenGuard)
    ) throw new Error("Oven-order false success was not replaced with the policy response");

    const { customerId: multiCustomerId, cartLine } = await createCustomer(client, "multiple");
    const orderIds = [];
    for (let index = 0; index < 4; index += 1) {
      if (index > 0) await refillCart(client, multiCustomerId, cartLine, index + 1);
      const result = await client.query(placeOrder, [multiCustomerId]);
      orderIds.push(result.rows[0].id);
    }
    const ambiguous = await client.query(
      requestCancellation,
      [multiCustomerId, null, orderIds[3], "Cancel my order"]
    );
    const ambiguousRow = ambiguous.rows[0];
    if (
      ambiguousRow.error !== "multiple_cancellable_orders"
      || ambiguousRow.request_created
      || ambiguousRow.dashboard_request_visible
      || ambiguousRow.order_id !== null
      || ambiguousRow.eligible_count !== 4
      || ambiguousRow.order_options.length !== 4
    ) throw new Error("Four-order ambiguity was not returned safely");
    const multipleGuard = await runCancellationGuard(
      { output: "Request sent to admin.", intermediateSteps: [toolStep(ambiguousRow)] },
      "Cancel my order"
    );
    if (
      multipleGuard.cancellation_success_claimed
      || !/order number/i.test(multipleGuard.output)
      || !agentOutputValid(multipleGuard)
    ) throw new Error("Multiple-order reply did not ask for an order number");

    const selectedOrderId = orderIds[2];
    const explicit = await client.query(
      requestCancellation,
      [multiCustomerId, selectedOrderId, orderIds[3], `Cancel order #${selectedOrderId}`]
    );
    if (
      !explicit.rows[0].request_created
      || String(explicit.rows[0].order_id) !== String(selectedOrderId)
    ) throw new Error("Explicit order selection failed");
    const multiRequests = await client.query(
      `SELECT order_id FROM admin_requests
       WHERE customer_id = $1 AND request_type = 'cancel_order'`,
      [multiCustomerId]
    );
    if (
      multiRequests.rows.length !== 1
      || String(multiRequests.rows[0].order_id) !== String(selectedOrderId)
    ) throw new Error("Explicit selection created a request for the wrong order");

    const invalid = await client.query(
      requestCancellation,
      [multiCustomerId, 999999999, orderIds[3], "Cancel unknown order"]
    );
    if (
      invalid.rows[0].error !== "requested_order_not_found"
      || invalid.rows[0].request_created
      || invalid.rows[0].dashboard_request_visible
    ) throw new Error("Invalid explicit order was not rejected");

    const { customerId: failureCustomerId } = await createCustomer(client, "failure");
    const failurePlaced = await client.query(placeOrder, [failureCustomerId]);
    const failureOrderId = failurePlaced.rows[0].id;
    await client.query("SAVEPOINT cancellation_insert_failure");
    let databaseRejectedInsert = false;
    try {
      await client.query(
        requestCancellation,
        [failureCustomerId, null, failureOrderId, null]
      );
    } catch {
      databaseRejectedInsert = true;
      await client.query("ROLLBACK TO SAVEPOINT cancellation_insert_failure");
    }
    if (!databaseRejectedInsert) {
      await client.query("ROLLBACK TO SAVEPOINT cancellation_insert_failure");
      throw new Error("Failed-insertion scenario did not produce a database error");
    }
    await client.query("RELEASE SAVEPOINT cancellation_insert_failure");
    const failedRequests = await client.query(
      "SELECT COUNT(*)::int AS count FROM admin_requests WHERE order_id = $1",
      [failureOrderId]
    );
    if (failedRequests.rows[0].count !== 0) {
      throw new Error("Database failure left a cancellation request behind");
    }
    const failedGuard = await runCancellationGuard(
      {
        output: "I've sent your cancellation request to the admin.",
        intermediateSteps: [{
          action: { tool: "Request_Cancellation_Approval" },
          observation: "Error: database insert failed",
        }],
      },
      "I want to cancel my order"
    );
    if (
      failedGuard.request_created
      || failedGuard.dashboard_request_visible
      || failedGuard.request_id !== null
      || failedGuard.cancellation_success_claimed
      || !/couldn't submit/i.test(failedGuard.output)
      || !agentOutputValid(failedGuard)
    ) throw new Error("Tool/database failure could still produce a false success");
    const missingToolResultGuard = await runCancellationGuard(
      {
        output: "I've sent your cancellation request to the admin.",
        intermediateSteps: [],
      },
      "I want to cancel my order",
      { order_status: "placed", active_order_id: failureOrderId }
    );
    if (
      missingToolResultGuard.cancellation_error !== "tool_result_missing"
      || missingToolResultGuard.cancellation_success_claimed
      || !/couldn't submit/i.test(missingToolResultGuard.output)
    ) throw new Error("Missing tool result could still produce a false success");
    const forgedSuccess = {
      ...failedGuard,
      output: "I've sent your cancellation request to the admin.",
      cancellation_success_claimed: true,
    };
    if (agentOutputValid(forgedSuccess)) {
      throw new Error("Cancellation reply guard accepted an unconfirmed success claim");
    }

    await client.query("ROLLBACK");
    console.log("One preparing order: pending request created and confirmation validated");
    console.log("Oven order: rejected with no pending request and no false success");
    console.log("Four cancellable orders: clarification requested; explicit ID alone evaluated");
    console.log("Database failure: no request persisted and no false success allowed");
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
