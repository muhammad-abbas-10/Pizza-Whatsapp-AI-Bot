require("dotenv").config();

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { registerAdminRoutes } = require("../src/admin-routes");
const { publicEvent } = require("../src/customer-notification-events");
const workflow = require("../../admin request.json");

const migrationPath = path.resolve(__dirname, "../../database/migration/016_dashboard_customer_status_events.sql");
const migration = fs.readFileSync(migrationPath, "utf8")
  .replace(/^\s*BEGIN;\s*/i, "")
  .replace(/\s*COMMIT;\s*$/i, "");

function workflowQuery(name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  assert(node?.parameters?.query, `Missing workflow SQL node: ${name}`);
  return node.parameters.query;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function jsonRequest(baseUrl, method, route, body, key = process.env.ADMIN_API_KEY) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-admin-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(migration);

    const statuses = (await client.query("SELECT canonical_order_statuses() AS statuses")).rows[0].statuses;
    assert.deepEqual(statuses, ["received", "preparing", "oven", "out_for_delivery", "completed", "cancelled"]);
    assert.equal((await client.query("SELECT can_transition_order_status('received', 'preparing') AS ok")).rows[0].ok, true);
    assert.equal((await client.query("SELECT can_transition_order_status('completed', 'preparing') AS ok")).rows[0].ok, false);
    assert.equal((await client.query("SELECT can_transition_order_status_for_order('oven', 'completed', 'delivery') AS ok")).rows[0].ok, false);
    assert.equal((await client.query("SELECT can_transition_order_status_for_order('oven', 'completed', 'pickup') AS ok")).rows[0].ok, true);
    assert.equal((await client.query("SELECT order_is_cancellable('oven') AS ok")).rows[0].ok, false);

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const customer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Status Migration Test') RETURNING id",
      [`status-migration-${suffix}`]
    )).rows[0];
    const otherCustomer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Wrong Owner') RETURNING id",
      [`status-migration-other-${suffix}`]
    )).rows[0];
    const order = (await client.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
       VALUES ($1, '[]'::jsonb, 'pickup', 100, 0, 100) RETURNING id`,
      [customer.id]
    )).rows[0];
    const initialHistory = (await client.query(
      "SELECT status, source FROM order_status_history WHERE order_id = $1 ORDER BY id",
      [order.id]
    )).rows[0];
    assert.deepEqual(initialHistory, { status: "received", source: "customer_order" });
    assert.equal(Number((await client.query(
      "SELECT COUNT(*) FROM admin_notifications WHERE source_key = $1", [`order:${order.id}`]
    )).rows[0].count), 1, "New order was not exposed to the dashboard");

    const requestId = crypto.randomUUID();
    await client.query("SELECT set_config('app.order_status_source', 'admin_dashboard', TRUE)");
    await client.query("SELECT set_config('app.order_status_request_id', $1, TRUE)", [requestId]);
    await client.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [order.id]);
    const history = (await client.query(
      "SELECT id, source FROM order_status_history WHERE request_id = $1", [requestId]
    )).rows[0];
    assert.equal(history.source, "admin_dashboard");

    const event = (await client.query(
      `INSERT INTO customer_notification_events
       (request_id, idempotency_key, event_type, order_id, customer_id, status_history_id, order_status)
       VALUES ($1, $2, 'order_status_update', $3, $4, $5, 'preparing') RETURNING id`,
      [requestId, `test:${suffix}`, order.id, customer.id, history.id]
    )).rows[0];

    await client.query("SAVEPOINT invalid_transition");
    await assert.rejects(
      client.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.id]),
      /Invalid order status transition/i,
      "The database accepted a preparing-to-completed jump"
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_transition");

    await client.query("SAVEPOINT wrong_owner_event");
    await assert.rejects(
      client.query(
        `INSERT INTO customer_notification_events
         (request_id, idempotency_key, event_type, order_id, customer_id, order_status)
         VALUES ($1, $2, 'order_status_update', $3, $4, 'preparing')`,
        [crypto.randomUUID(), `wrong:${suffix}`, order.id, otherCustomer.id]
      ),
      /foreign key/i,
      "A mismatched order/customer event was accepted"
    );
    await client.query("ROLLBACK TO SAVEPOINT wrong_owner_event");

    // Exercise the real Express routes against the uncommitted migration. Route
    // BEGIN/COMMIT calls are scoped to a savepoint so the entire suite remains
    // rollback-only and cannot alter the configured database.
    let routeTransactionOpen = false;
    const routePool = {
      query: (...args) => client.query(...args),
      async connect() {
        return {
          async query(sql, params) {
            if (sql === "BEGIN") {
              assert.equal(routeTransactionOpen, false, "Nested route transaction in test harness");
              routeTransactionOpen = true;
              return client.query("SAVEPOINT admin_route");
            }
            if (sql === "COMMIT") {
              routeTransactionOpen = false;
              return client.query("RELEASE SAVEPOINT admin_route");
            }
            if (sql === "ROLLBACK") {
              routeTransactionOpen = false;
              await client.query("ROLLBACK TO SAVEPOINT admin_route");
              return client.query("RELEASE SAVEPOINT admin_route");
            }
            return client.query(sql, params);
          },
          release() {},
        };
      },
    };
    let deliveryCount = 0;
    let deliveryFailureMode = false;
    const dispatchEvent = async (eventId) => {
      const current = (await client.query("SELECT * FROM customer_notification_events WHERE id = $1", [eventId])).rows[0];
      if (current.delivery_status === "sent") {
        return { accepted: true, lifecycle: "duplicate", event: publicEvent(current) };
      }
      deliveryCount += 1;
      if (deliveryFailureMode) {
        const failed = (await client.query(
          `UPDATE customer_notification_events
           SET delivery_status = 'failed', attempts = attempts + 1,
               last_error = 'simulated provider failure', updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [eventId]
        )).rows[0];
        return { accepted: false, lifecycle: "failed", event: publicEvent(failed) };
      }
      const delivered = (await client.query(
        `UPDATE customer_notification_events
         SET delivery_status = 'sent', attempts = attempts + 1,
             provider_message_id = $2, sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [eventId, `wamid.route.${deliveryCount}`]
      )).rows[0];
      return { accepted: true, lifecycle: "sent", event: publicEvent(delivered) };
    };

    const previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = "migration-route-test-key";
    const app = express();
    app.use(express.json());
    registerAdminRoutes(app, routePool, { dispatchEvent });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const unauthorized = await jsonRequest(baseUrl, "GET", "/admin/orders", undefined, "wrong-key");
      assert.equal(unauthorized.status, 401, "Invalid admin key was accepted");

      const routeCustomer = (await client.query(
        "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Route Status Test') RETURNING id",
        [`route-status-${suffix}`]
      )).rows[0];
      const routeOrder = (await client.query(
        `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
         VALUES ($1, '[]'::jsonb, 'delivery', 200, 0, 200) RETURNING id`, [routeCustomer.id]
      )).rows[0];

      const preparingRequest = crypto.randomUUID();
      const preparing = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "preparing", expected_status: "received", request_id: preparingRequest,
      });
      assert.equal(preparing.status, 200);
      assert.equal(preparing.body.order.status, "preparing");
      assert.equal(preparing.body.notification.delivery_status, "sent");

      const duplicate = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "preparing", expected_status: "received", request_id: preparingRequest,
      });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.already_applied, true);
      assert.equal(deliveryCount, 1, "Duplicate status request dispatched twice");

      const staleSecondAdmin = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "cancelled", expected_status: "received", request_id: crypto.randomUUID(),
      });
      assert.equal(staleSecondAdmin.status, 409, "A second admin's stale action was accepted");

      const oven = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "oven", expected_status: "preparing", request_id: crypto.randomUUID(),
      });
      assert.equal(oven.status, 200);
      assert.equal(oven.body.order.status, "oven");
      const cancelFromOven = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "cancelled", expected_status: "oven", request_id: crypto.randomUUID(),
      });
      assert.equal(cancelFromOven.status, 409, "Oven order was cancellable");

      assert.equal((await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "out_for_delivery", expected_status: "oven", request_id: crypto.randomUUID(),
      })).status, 200);
      assert.equal((await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "completed", expected_status: "out_for_delivery", request_id: crypto.randomUUID(),
      })).status, 200);
      const backwards = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${routeOrder.id}/status`, {
        status: "preparing", expected_status: "completed", request_id: crypto.randomUUID(),
      });
      assert.equal(backwards.status, 409, "Completed order moved backwards");

      const retryOrder = (await client.query(
        `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
         VALUES ($1, '[]'::jsonb, 'pickup', 250, 0, 250) RETURNING id`, [routeCustomer.id]
      )).rows[0];
      deliveryFailureMode = true;
      const failedStatus = await jsonRequest(baseUrl, "PATCH", `/admin/orders/${retryOrder.id}/status`, {
        status: "preparing", expected_status: "received", request_id: crypto.randomUUID(),
      });
      assert.equal(failedStatus.status, 200, "A committed status was hidden by a notification failure");
      assert.equal(failedStatus.body.order.status, "preparing");
      assert.equal(failedStatus.body.notification.delivery_status, "failed");
      const failedEventId = failedStatus.body.notification.id;
      assert.equal((await client.query("SELECT status FROM orders WHERE id = $1", [retryOrder.id])).rows[0].status, "preparing");
      assert.equal(Number((await client.query(
        "SELECT COUNT(*) FROM admin_notifications WHERE source_key = $1", [`customer-event-failed:${failedEventId}`]
      )).rows[0].count), 1, "Notification failure was not visible to the dashboard");

      deliveryFailureMode = false;
      const retried = await jsonRequest(
        baseUrl, "POST", `/admin/orders/${retryOrder.id}/notifications/${failedEventId}/retry`
      );
      assert.equal(retried.status, 200);
      assert.equal(retried.body.notification.delivery_status, "sent");
      assert.equal(retried.body.notification.attempts, 2);
      const countAfterRetry = deliveryCount;
      const duplicateRetry = await jsonRequest(
        baseUrl, "POST", `/admin/orders/${retryOrder.id}/notifications/${failedEventId}/retry`
      );
      assert.equal(duplicateRetry.status, 200);
      assert.equal(duplicateRetry.body.notification_lifecycle, "duplicate");
      assert.equal(deliveryCount, countAfterRetry, "Retrying a sent event dispatched it again");

      const approvalOrder = (await client.query(
        `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
         VALUES ($1, '[]'::jsonb, 'pickup', 300, 0, 300) RETURNING id`, [routeCustomer.id]
      )).rows[0];
      const approvalRequest = (await client.query(
        `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
         VALUES ($1, $2, 'cancel_order', 'Please cancel') RETURNING id`, [routeCustomer.id, approvalOrder.id]
      )).rows[0];
      const approved = await jsonRequest(baseUrl, "POST", `/admin/requests/${approvalRequest.id}/approve`, {
        admin_note: "Customer requested cancellation",
      });
      assert.equal(approved.status, 200);
      assert.equal((await client.query("SELECT status FROM orders WHERE id = $1", [approvalOrder.id])).rows[0].status, "cancelled");
      assert.equal((await client.query("SELECT status FROM admin_requests WHERE id = $1", [approvalRequest.id])).rows[0].status, "approved");
      const deliveryCountAfterApproval = deliveryCount;
      const repeatApproval = await jsonRequest(baseUrl, "POST", `/admin/requests/${approvalRequest.id}/approve`, {});
      assert.equal(repeatApproval.status, 200);
      assert.equal(repeatApproval.body.already_resolved, true);
      assert.equal(deliveryCount, deliveryCountAfterApproval, "Repeated cancellation approval dispatched twice");

      const denialOrder = (await client.query(
        `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
         VALUES ($1, '[]'::jsonb, 'pickup', 400, 0, 400) RETURNING id`, [routeCustomer.id]
      )).rows[0];
      const denialRequest = (await client.query(
        `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
         VALUES ($1, $2, 'cancel_order', 'Please cancel too') RETURNING id`, [routeCustomer.id, denialOrder.id]
      )).rows[0];
      const denied = await jsonRequest(baseUrl, "POST", `/admin/requests/${denialRequest.id}/deny`, {
        admin_note: "Kitchen already started",
      });
      assert.equal(denied.status, 200);
      assert.equal((await client.query("SELECT status FROM orders WHERE id = $1", [denialOrder.id])).rows[0].status, "received");
      assert.equal((await client.query("SELECT status FROM admin_requests WHERE id = $1", [denialRequest.id])).rows[0].status, "denied");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = previousAdminKey;
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }

  // Repeat the event-result checks in a fresh rollback-only transaction because
  // PostgreSQL aborts a transaction after an expected constraint violation.
  const client2 = await pool.connect();
  try {
    await client2.query("BEGIN");
    await client2.query(migration);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const customer = (await client2.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Event Failure Test') RETURNING id",
      [`event-failure-${suffix}`]
    )).rows[0];
    const order = (await client2.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
       VALUES ($1, '[]'::jsonb, 'pickup', 100, 0, 100) RETURNING id`, [customer.id]
    )).rows[0];
    const requestId = crypto.randomUUID();
    await client2.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [order.id]);
    const event = (await client2.query(
      `INSERT INTO customer_notification_events
       (request_id, idempotency_key, event_type, order_id, customer_id, order_status)
       VALUES ($1, $2, 'order_status_update', $3, $4, 'preparing') RETURNING id`,
      [requestId, `failure:${suffix}`, order.id, customer.id]
    )).rows[0];

    const claimSql = workflowQuery("Claim Admin Customer Event");
    const recordSql = workflowQuery("Record Admin Event Result");
    const firstClaim = (await client2.query(claimSql, [event.id, requestId, "execution-1"])).rows[0];
    assert.equal(firstClaim.should_send, true);
    assert.equal(firstClaim.lifecycle, "processing");
    assert.equal((await client2.query(
      "SELECT attempts FROM customer_notification_events WHERE id = $1", [event.id]
    )).rows[0].attempts, 1);
    assert.equal(firstClaim.customer_phone, `event-failure-${suffix}`);

    const activeLeaseDuplicate = (await client2.query(claimSql, [event.id, requestId, "execution-2"])).rows[0];
    assert.equal(activeLeaseDuplicate.should_send, false, "An active n8n lease was claimed twice");
    assert.equal(activeLeaseDuplicate.lifecycle, "processing");

    await client2.query(
      "UPDATE customer_notification_events SET claimed_at = NOW() - INTERVAL '3 minutes' WHERE id = $1",
      [event.id]
    );
    const recoveredClaim = (await client2.query(claimSql, [event.id, requestId, "execution-3"])).rows[0];
    assert.equal(recoveredClaim.should_send, true, "A crashed n8n execution lease was not recoverable");
    assert.equal((await client2.query(
      "SELECT attempts FROM customer_notification_events WHERE id = $1", [event.id]
    )).rows[0].attempts, 2);
    const recordedFailure = (await client2.query(
      recordSql, [event.id, "execution-3", false, null, "provider down"]
    )).rows[0];
    assert.equal(recordedFailure.lifecycle, "failed");
    assert.equal(Number((await client2.query(
      "SELECT COUNT(*) FROM admin_notifications WHERE source_key = $1", [`customer-event-failed:${event.id}`]
    )).rows[0].count), 1, "Failure was not visible in the dashboard");

    const retryClaim = (await client2.query(claimSql, [event.id, requestId, "execution-4"])).rows[0];
    assert.equal(retryClaim.should_send, true);
    assert.equal((await client2.query(
      "SELECT attempts FROM customer_notification_events WHERE id = $1", [event.id]
    )).rows[0].attempts, 3);
    const recordedSuccess = (await client2.query(
      recordSql, [event.id, "execution-4", true, "wamid.test", null]
    )).rows[0];
    assert.equal(recordedSuccess.lifecycle, "sent");
    const sentDuplicate = (await client2.query(claimSql, [event.id, requestId, "execution-5"])).rows[0];
    assert.equal(sentDuplicate.should_send, false, "A sent event was claimed again");
    assert.equal(sentDuplicate.lifecycle, "duplicate");
    assert.equal(Number((await client2.query(
      "SELECT COUNT(*) FROM admin_notifications WHERE source_key = $1", [`customer-event-failed:${event.id}`]
    )).rows[0].count), 0, "Resolved failure notification was not cleared");

    const staleRequestId = crypto.randomUUID();
    const staleEvent = (await client2.query(
      `INSERT INTO customer_notification_events
       (request_id, idempotency_key, event_type, order_id, customer_id, order_status)
       VALUES ($1, $2, 'order_status_update', $3, $4, 'received') RETURNING id`,
      [staleRequestId, `stale:${suffix}`, order.id, customer.id]
    )).rows[0];
    const staleClaim = (await client2.query(
      claimSql, [staleEvent.id, staleRequestId, "execution-stale"]
    )).rows[0];
    assert.equal(staleClaim.should_send, false);
    assert.equal(staleClaim.lifecycle, "superseded", "An obsolete status notification was not suppressed");
    console.log("Dashboard status migration, canonical transitions, ownership FK, history, and failure triggers: PASS");
  } finally {
    await client2.query("ROLLBACK").catch(() => {});
    client2.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
