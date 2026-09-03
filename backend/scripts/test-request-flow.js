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
let deniedOrderId;

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
  const deniedOrder = await pool.query(`
    INSERT INTO orders (customer_id, items, order_type, subtotal, delivery_charge, total)
    VALUES ($1, '[]'::jsonb, 'pickup', 0, 0, 0) RETURNING id
  `, [customerId]);
  deniedOrderId = deniedOrder.rows[0].id;
  await pool.query(`UPDATE conversation_sessions SET active_order_id = $1, order_status = 'received' WHERE customer_id = $2`, [orderId, customerId]);

  const requests = await pool.query(`
    INSERT INTO admin_requests (customer_id, order_id, request_type, question)
    VALUES
      ($1, $2, 'cancel_order', 'Automated cancellation approval test'),
      ($1, $3, 'cancel_order', 'Automated cancellation denial test')
    RETURNING id, request_type
  `, [customerId, orderId, deniedOrderId]);
  const approveId = requests.rows[0].id;
  const denyId = requests.rows[1].id;

  await post(`/admin/requests/${approveId}/approve`, 200);
  await post(`/admin/requests/${denyId}/deny`, 200);
  const repeated = await post(`/admin/requests/${approveId}/approve`, 200);
  if (!repeated.alreadyResolved) throw new Error("Repeated approval was not idempotent");
  await post(`/admin/requests/${approveId}/deny`, 409);
  await post(`/admin/requests/${approveId}/notify`, 502);

  const verified = await pool.query(`
    SELECT
      (SELECT status FROM orders WHERE id = $1) AS order_status,
      (SELECT status FROM orders WHERE id = $5) AS denied_order_status,
      (SELECT status FROM admin_requests WHERE id = $2) AS approval_status,
      (SELECT status FROM admin_requests WHERE id = $3) AS denial_status,
      (SELECT awaiting_human FROM conversation_sessions WHERE customer_id = $4) AS awaiting_human,
      (SELECT notification_sent FROM admin_requests WHERE id = $2) AS notification_sent,
      (SELECT notification_error FROM admin_requests WHERE id = $2) AS notification_error,
      (SELECT notification_attempts FROM admin_requests WHERE id = $2) AS notification_attempts,
      (SELECT order_id FROM admin_requests WHERE id = $2) AS linked_order_id
  `, [orderId, approveId, denyId, customerId, deniedOrderId]);
  const row = verified.rows[0];
  if (
    row.order_status !== "cancelled" ||
    row.denied_order_status !== "received" ||
    row.approval_status !== "approved" ||
    row.denial_status !== "denied" ||
    row.awaiting_human !== false ||
    row.notification_sent !== false ||
    !row.notification_error ||
    Number(row.notification_attempts) < 2 ||
    String(row.linked_order_id) !== String(orderId)
  ) {
    throw new Error(`Request flow verification failed: ${JSON.stringify(row)}`);
  }
  console.log("Request approve: passed");
  console.log("Request deny: passed");
  console.log("Cancellation side effect: passed");
  console.log("Cancellation denial leaves order unchanged: passed");
  console.log("Repeated/conflicting decision safety: passed");
  console.log("Request/order linkage: passed");
  console.log("Notification failure recorded and retry endpoint verified: passed");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (orderId || deniedOrderId) await pool.query(`DELETE FROM orders WHERE id = ANY($1::bigint[])`, [[orderId, deniedOrderId].filter(Boolean)]);
      if (customerId) await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    } finally {
      clearInterval(keepAlive);
      await pool.end();
    }
  });
