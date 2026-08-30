// Admin dashboard API: order list + structured approve/deny decisions.
//
// These routes are shared between local dev (server.js) and the Vercel
// deployment (api/index.js) so the logic only lives in one place.
//
// Required env vars:
//   ADMIN_API_KEY            - shared secret the dashboard sends as x-admin-key
//   WHATSAPP_TOKEN            - permanent/system-user token for the Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  - the sending number's phone_number_id

const WHATSAPP_API_VERSION = "v20.0";

async function sendWhatsAppMessage(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error(
      "WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not configured — skipping customer notification"
    );
    return { sent: false, reason: "not_configured" };
  }

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("WhatsApp send failed:", response.status, errText);
    return { sent: false, reason: errText };
  }

  return { sent: true };
}

function requireAdminKey(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;

  if (!configuredKey) {
    console.error("ADMIN_API_KEY is not configured on the server");
    return res.status(500).json({ success: false, message: "Admin API not configured" });
  }

  const providedKey = req.header("x-admin-key");

  if (providedKey !== configuredKey) {
    return res.status(401).json({ success: false, message: "Invalid or missing admin key" });
  }

  return next();
}

const ORDER_STATUSES = ["received", "preparing", "out_for_delivery", "completed", "cancelled"];

function registerAdminRoutes(app, pool) {
  app.use("/admin", requireAdminKey);

  // --------------------------------------------------
  // ORDERS
  // --------------------------------------------------

  // GET /admin/orders?status=received&limit=50
  app.get("/admin/orders", async (req, res) => {
    try {
      const { status, limit } = req.query;
      const params = [];
      let where = "";

      if (status) {
        params.push(status);
        where = `WHERE o.status = $${params.length}`;
      }

      params.push(Math.min(Number.parseInt(limit, 10) || 50, 200));

      const result = await pool.query(
        `
        SELECT
          o.id, o.items, o.order_type, o.delivery_address, o.delivery_name,
          o.subtotal, o.delivery_charge, o.total, o.status,
          o.created_at, o.updated_at,
          c.name AS customer_name, c.whatsapp_phone AS customer_phone
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}
        `,
        params
      );

      return res.json({ success: true, orders: result.rows });
    } catch (error) {
      console.error("List orders error:", error);
      return res.status(500).json({ success: false, message: "Failed to load orders" });
    }
  });

  // PATCH /admin/orders/:id/status  { status }
  app.patch("/admin/orders/:id/status", async (req, res) => {
    try {
      const orderId = Number.parseInt(req.params.id, 10);
      const { status } = req.body || {};

      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid order id" });
      }

      if (!ORDER_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${ORDER_STATUSES.join(", ")}`,
        });
      }

      const result = await pool.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      return res.json({ success: true, order: result.rows[0] });
    } catch (error) {
      console.error("Update order status error:", error);
      return res.status(500).json({ success: false, message: "Failed to update order" });
    }
  });

  // --------------------------------------------------
  // ADMIN DECISION REQUESTS
  // --------------------------------------------------

  // GET /admin/requests?status=pending
  app.get("/admin/requests", async (req, res) => {
    try {
      const { status } = req.query;
      const params = [];
      let where = "";

      if (status) {
        params.push(status);
        where = `WHERE r.status = $${params.length}`;
      }

      const result = await pool.query(
        `
        SELECT
          r.id, r.request_type, r.question, r.status, r.admin_note,
          r.created_at, r.resolved_at,
          c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          o.id AS order_id, o.status AS order_status, o.total AS order_total
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        LEFT JOIN orders o ON o.id = r.order_id
        ${where}
        ORDER BY r.created_at DESC
        `,
        params
      );

      return res.json({ success: true, requests: result.rows });
    } catch (error) {
      console.error("List admin requests error:", error);
      return res.status(500).json({ success: false, message: "Failed to load requests" });
    }
  });

  async function resolveRequest(req, res, decision) {
    const client = await pool.connect();

    try {
      const requestId = Number.parseInt(req.params.id, 10);
      const { admin_note } = req.body || {};

      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid request id" });
      }

      await client.query("BEGIN");

      const { rows } = await client.query(
        `
        SELECT r.*, c.whatsapp_phone
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        WHERE r.id = $1 AND r.status = 'pending'
        FOR UPDATE
        `,
        [requestId]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "Request not found or already resolved",
        });
      }

      const requestRow = rows[0];

      // Apply the actual side-effect for known request types.
      if (requestRow.request_type === "cancel_order" && requestRow.order_id) {
        if (decision === "approved") {
          await client.query(
            `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
            [requestRow.order_id]
          );
          await client.query(
            `
            UPDATE conversation_sessions
            SET order_status = 'cancelled'
            WHERE customer_id = $1 AND active_order_id = $2
            `,
            [requestRow.customer_id, requestRow.order_id]
          );
        }
        // On denial, the order is left exactly as it was.
      }

      await client.query(
        `
        UPDATE admin_requests
        SET status = $1, admin_note = $2, resolved_at = NOW()
        WHERE id = $3
        `,
        [decision, admin_note || null, requestId]
      );

      // Clear the "bot is waiting on admin" flag so the agent resumes normally
      // on this customer's next message.
      await client.query(
        `UPDATE conversation_sessions SET awaiting_human = FALSE WHERE customer_id = $1`,
        [requestRow.customer_id]
      );

      await client.query("COMMIT");

      const defaultMessage =
        decision === "approved"
          ? "Update on your request: it's been approved. ✅"
          : "Update on your request: unfortunately we're not able to do that this time.";

      const messageToSend = admin_note
        ? `${defaultMessage}\n\n${admin_note}`
        : defaultMessage;

      const whatsappResult = await sendWhatsAppMessage(
        requestRow.whatsapp_phone,
        messageToSend
      );

      return res.json({ success: true, decision, whatsapp: whatsappResult });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Resolve admin request error:", error);
      return res.status(500).json({ success: false, message: "Failed to resolve request" });
    } finally {
      client.release();
    }
  }

  app.post("/admin/requests/:id/approve", (req, res) => resolveRequest(req, res, "approved"));
  app.post("/admin/requests/:id/deny", (req, res) => resolveRequest(req, res, "denied"));
}

module.exports = { registerAdminRoutes, sendWhatsAppMessage };
