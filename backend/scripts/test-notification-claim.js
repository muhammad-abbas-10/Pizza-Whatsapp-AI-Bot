require("dotenv").config();

const assert = require("assert");
const express = require("express");
const { Pool } = require("pg");
const { registerAdminRoutes, CUSTOMER_NOTIFICATION_CLAIM_SQL } = require("../src/admin-routes");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });

async function main() {
  let customerId;
  let orderId;
  let requestId;
  let sendCount = 0;
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, pool, {
    sendMessage: async () => {
      sendCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { sent: true, messageId: `mock-outbound-${Date.now()}` };
    },
  });
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });

  try {
    const customer = await pool.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Notification Claim Test') RETURNING id",
      [`claim-test-${Date.now()}`],
    );
    customerId = customer.rows[0].id;
    const order = await pool.query(
      `INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total, status)
       VALUES ($1, '[]'::jsonb, 'pickup', 0, 0, 0, 'received') RETURNING id`,
      [customerId],
    );
    orderId = order.rows[0].id;
    const request = await pool.query(
      `INSERT INTO admin_requests (customer_id, order_id, request_type, question)
       VALUES ($1, $2, 'cancel_order', 'Cross-channel claim test') RETURNING id`,
      [customerId, orderId],
    );
    requestId = request.rows[0].id;
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
    await pool.query("UPDATE admin_requests SET status = 'approved', resolved_at = NOW() WHERE id = $1", [requestId]);

    const port = server.address().port;
    const sendNotify = () => fetch(`http://127.0.0.1:${port}/admin/requests/${requestId}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": process.env.ADMIN_API_KEY },
      body: "{}",
    });
    const responses = await Promise.all([sendNotify(), sendNotify()]);
    assert(responses.every((response) => response.status === 200), "Concurrent notify endpoint did not return success");
    assert.equal(sendCount, 1, "Concurrent Express requests sent more than one WhatsApp message");

    const n8nClaim = await pool.query(CUSTOMER_NOTIFICATION_CLAIM_SQL, [requestId, "n8n-competing-token"]);
    assert.equal(n8nClaim.rows.length, 0, "n8n acquired a claim after Express already delivered the message");
    const state = (await pool.query("SELECT notification_sent, notification_attempts FROM admin_requests WHERE id = $1", [requestId])).rows[0];
    assert.equal(state.notification_sent, true);
    assert.equal(Number(state.notification_attempts), 1);
    console.log("Cross-channel notification claim and duplicate-send prevention: PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (requestId) await pool.query("DELETE FROM admin_requests WHERE id = $1", [requestId]);
    if (orderId) await pool.query("DELETE FROM orders WHERE id = $1", [orderId]);
    if (customerId) await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
