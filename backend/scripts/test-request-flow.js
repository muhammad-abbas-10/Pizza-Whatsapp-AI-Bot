require("dotenv").config();

const { Pool } = require("pg");

const baseUrl = process.env.SMOKE_API_URL || "http://localhost:3000";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});
const keepAlive = setInterval(() => {}, 1000);

let customerId;
let orderId;

async function post(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": process.env.ADMIN_API_KEY },
    body: JSON.stringify({ admin_note: "Automated dashboard flow test" }),
  });
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`${path}: expected ${expectedStatus}, received ${response.status}: ${body}`);
  }
  return response.json();
}

async function main() {
  const customer = await pool.query(`
    INSERT INTO customers (whatsapp_phone, name)
    VALUES ($1, 'Dashboard Integration Test') RETURNING id
  `, [`dashboard-test-${Date.now()}`]);
  customerId = customer.rows[0].id;

  await pool.query(`INSERT INTO conversation_sessions (customer_id, awaiting_human) VALUES ($1, TRUE)`, [customerId]);
  const order = await pool.query(`
    INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
    VALUES ($1, '[]'::jsonb, 'pickup', 0, 0, 0) RETURNING id
  `, [customerId]);
  orderId = order.rows[0].id;
  await pool.query(`UPDATE conversation_sessions SET active_order_id = $1, order_status = 'received' WHERE customer_id = $2`, [orderId, customerId]);

  const requests = await pool.query(`
    INSERT INTO admin_requests (customer_id, order_id, request_type, question)
    VALUES
      ($1, $2, 'cancel_order', 'Automated cancellation approval test'),
      ($1, $2, 'other', 'Automated denial test')
    RETURNING id, request_type
  `, [customerId, orderId]);
  const approveId = requests.rows.find((row) => row.request_type === "cancel_order").id;
  const denyId = requests.rows.find((row) => row.request_type === "other").id;

  await post(`/admin/requests/${approveId}/approve`, 200);
  await post(`/admin/requests/${denyId}/deny`, 200);
  await post(`/admin/requests/${approveId}/notify`, 502);

  const verified = await pool.query(`
    SELECT
      (SELECT status FROM orders WHERE id = $1) AS order_status,
      (SELECT status FROM admin_requests WHERE id = $2) AS approval_status,
      (SELECT status FROM admin_requests WHERE id = $3) AS denial_status,
      (SELECT awaiting_human FROM conversation_sessions WHERE customer_id = $4) AS awaiting_human,
      (SELECT notification_sent FROM admin_requests WHERE id = $2) AS notification_sent,
      (SELECT notification_error FROM admin_requests WHERE id = $2) AS notification_error
  `, [orderId, approveId, denyId, customerId]);
  const row = verified.rows[0];
  if (
    row.order_status !== "cancelled" ||
    row.approval_status !== "approved" ||
    row.denial_status !== "denied" ||
    row.awaiting_human !== false ||
    row.notification_sent !== false ||
    !row.notification_error
  ) {
    throw new Error(`Request flow verification failed: ${JSON.stringify(row)}`);
  }
  console.log("Request approve: passed");
  console.log("Request deny: passed");
  console.log("Cancellation side effect: passed");
  console.log("Notification failure recorded and retry endpoint verified: passed");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (orderId) await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      if (customerId) await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    } finally {
      clearInterval(keepAlive);
      await pool.end();
    }
  });
