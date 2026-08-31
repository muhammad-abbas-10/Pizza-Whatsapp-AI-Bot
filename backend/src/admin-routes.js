// Admin dashboard API: order list + structured approve/deny decisions.
//
// These routes are shared between local dev (server.js) and the Vercel
// deployment (api/index.js) so the logic only lives in one place.
//
// Required env vars:
//   ADMIN_API_KEY            - shared secret the dashboard sends as x-admin-key
//   WHATSAPP_TOKEN            - permanent/system-user token for the Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  - the sending number's phone_number_id

const crypto = require("crypto");
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

  try {
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
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("WhatsApp send failed:", response.status, errText);
      return { sent: false, reason: `whatsapp_http_${response.status}` };
    }

    return { sent: true };
  } catch (error) {
    console.error("WhatsApp send error:", error.message);
    return { sent: false, reason: error.name === "TimeoutError" ? "whatsapp_timeout" : "whatsapp_unavailable" };
  }
}

const failedAdminAttempts = new Map();

function requireAdminKey(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;

  if (!configuredKey) {
    console.error("ADMIN_API_KEY is not configured on the server");
    return res.status(500).json({ success: false, message: "Admin API not configured" });
  }

  const providedKey = req.header("x-admin-key");
  const attemptKey = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = (failedAdminAttempts.get(attemptKey) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (attempts.length >= 10) {
    return res.status(429).json({ success: false, message: "Too many authentication attempts; try again later" });
  }

  const configured = Buffer.from(configuredKey);
  const provided = Buffer.from(providedKey || "");
  if (configured.length !== provided.length || !crypto.timingSafeEqual(configured, provided)) {
    attempts.push(now);
    failedAdminAttempts.set(attemptKey, attempts);
    return res.status(401).json({ success: false, message: "Invalid or missing admin key" });
  }

  failedAdminAttempts.delete(attemptKey);
  return next();
}

function parsePagination(query, defaultLimit = 20, maxLimit = 100) {
  const limit = Math.max(1, Math.min(Number.parseInt(query.limit, 10) || defaultLimit, maxLimit));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

function isIsoDate(value) {
  if (!value) return true;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === text;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const ORDER_STATUSES = ["received", "preparing", "out_for_delivery", "completed", "cancelled"];
const ALLOWED_STATUS_TRANSITIONS = {
  received: ["preparing", "cancelled"],
  preparing: ["out_for_delivery", "completed", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

function registerAdminRoutes(app, pool) {
  app.use("/admin", requireAdminKey);

  // --------------------------------------------------
  // ORDERS
  // --------------------------------------------------

  // GET /admin/orders?status=received&order_type=delivery&search=...&page=1&limit=50
  app.get("/admin/orders", async (req, res) => {
    try {
      const { status, order_type: orderType, search, date_from: dateFrom, date_to: dateTo, scope } = req.query;
      const { limit: safeLimit, page: safePage, offset } = parsePagination(req.query, 50, 200);
      const params = [];
      const conditions = [];

      if (status) {
        if (!ORDER_STATUSES.includes(status)) {
          return res.status(400).json({ success: false, message: "Invalid order status" });
        }
        params.push(status);
        conditions.push(`o.status = $${params.length}`);
      }
      if (scope) {
        if (!["active", "history"].includes(scope)) {
          return res.status(400).json({ success: false, message: "Invalid order scope" });
        }
        conditions.push(scope === "active"
          ? `o.status NOT IN ('completed', 'cancelled')`
          : `o.status IN ('completed', 'cancelled')`);
      }
      if (orderType) {
        if (!["delivery", "pickup"].includes(orderType)) {
          return res.status(400).json({ success: false, message: "Invalid order type" });
        }
        params.push(orderType);
        conditions.push(`o.order_type = $${params.length}`);
      }
      if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`(CAST(o.id AS TEXT) ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.whatsapp_phone ILIKE $${params.length})`);
      }
      if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
        return res.status(400).json({ success: false, message: "Dates must use YYYY-MM-DD" });
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        return res.status(400).json({ success: false, message: "From date cannot be after to date" });
      }
      if (dateFrom) {
        params.push(dateFrom);
        conditions.push(`(o.created_at AT TIME ZONE 'Asia/Karachi')::date >= $${params.length}::date`);
      }
      if (dateTo) {
        params.push(dateTo);
        conditions.push(`(o.created_at AT TIME ZONE 'Asia/Karachi')::date <= $${params.length}::date`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(safeLimit, offset);

      const result = await pool.query(
        `
        SELECT
          o.id, o.items, o.order_type, o.delivery_address, o.delivery_name,
          o.subtotal, o.delivery_charge, o.total, o.status,
          o.created_at, o.updated_at,
          c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          COUNT(*) OVER() AS total_count
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        ${where}
        ORDER BY o.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );

      const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
      const orders = result.rows.map(({ total_count, ...order }) => order);
      return res.json({ success: true, orders, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } });
    } catch (error) {
      console.error("List orders error:", error);
      return res.status(500).json({ success: false, message: "Failed to load orders" });
    }
  });

  app.get("/admin/orders/:id", async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    try {
      const [result, history] = await Promise.all([
        pool.query(`
          SELECT o.*, c.name AS customer_name, c.whatsapp_phone AS customer_phone
          FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [orderId]),
        pool.query(`SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at`, [orderId]),
      ]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Order not found" });
      return res.json({ success: true, order: result.rows[0], history: history.rows });
    } catch (error) {
      console.error("Get order error:", error);
      return res.status(500).json({ success: false, message: "Failed to load order" });
    }
  });

  // PATCH /admin/orders/:id/status  { status }
  app.patch("/admin/orders/:id/status", async (req, res) => {
    try {
      const orderId = Number(req.params.id);
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

      const current = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);

      if (current.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      const currentStatus = current.rows[0].status;
      if (status !== currentStatus && !ALLOWED_STATUS_TRANSITIONS[currentStatus]?.includes(status)) {
        return res.status(409).json({
          success: false,
          message: `Cannot change order from ${currentStatus} to ${status}`,
        });
      }

      const result = await pool.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND status = $3 RETURNING *`,
        [status, orderId, currentStatus]
      );

      if (result.rows.length === 0) {
        return res.status(409).json({ success: false, message: "Order changed; refresh and try again" });
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
      const { status, type, search } = req.query;
      const { limit, page, offset } = parsePagination(req.query);
      const params = [];
      const conditions = [];

      if (status) {
        if (!["pending", "approved", "denied"].includes(status)) {
          return res.status(400).json({ success: false, message: "Invalid request status" });
        }
        params.push(status);
        conditions.push(`r.status = $${params.length}`);
      }
      if (type) {
        if (type === "other") {
          conditions.push(`r.request_type NOT IN ('cancel_order', 'modification', 'delivery')`);
        } else {
          params.push(type);
          conditions.push(`r.request_type = $${params.length}`);
        }
      }
      if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`(c.name ILIKE $${params.length} OR c.whatsapp_phone ILIKE $${params.length} OR r.question ILIKE $${params.length} OR CAST(r.id AS TEXT) ILIKE $${params.length})`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit, offset);

      const result = await pool.query(
        `
        SELECT
          r.id, r.request_type, r.question, r.status, r.admin_note,
          r.created_at, r.resolved_at, r.notification_sent, r.notification_error,
          c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          o.id AS order_id, o.status AS order_status, o.total AS order_total,
          o.items AS order_items, o.delivery_address, o.order_type,
          COUNT(*) OVER() AS total_count
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        LEFT JOIN orders o ON o.id = r.order_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params
      );

      const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
      const requests = result.rows.map(({ total_count, ...request }) => request);
      return res.json({ success: true, requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) {
      console.error("List admin requests error:", error);
      return res.status(500).json({ success: false, message: "Failed to load requests" });
    }
  });

  async function resolveRequest(req, res, decision) {
    const client = await pool.connect();

    try {
      const requestId = Number(req.params.id);
      const { admin_note } = req.body || {};

      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid request id" });
      }
      if (admin_note !== undefined && (typeof admin_note !== "string" || admin_note.length > 2000)) {
        return res.status(400).json({ success: false, message: "Admin note must be 2,000 characters or fewer" });
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
          const cancelledOrder = await client.query(
            `
            UPDATE orders
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1 AND status IN ('received', 'preparing', 'out_for_delivery')
            RETURNING id
            `,
            [requestRow.order_id]
          );
          if (cancelledOrder.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({
              success: false,
              message: "This order can no longer be cancelled",
            });
          }
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

      await pool.query(
        `
        UPDATE admin_requests
        SET notification_sent = $1, notification_error = $2
        WHERE id = $3
        `,
        [whatsappResult.sent, whatsappResult.sent ? null : String(whatsappResult.reason || "unknown error"), requestId]
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

  app.post("/admin/requests/:id/notify", async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    try {
      const { rows } = await pool.query(
        `
        SELECT r.status, r.admin_note, r.notification_sent, c.whatsapp_phone
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        WHERE r.id = $1 AND r.status IN ('approved', 'denied')
        `,
        [requestId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: "Resolved request not found" });
      }
      if (rows[0].notification_sent) {
        return res.json({ success: true, whatsapp: { sent: true, alreadySent: true } });
      }

      const approved = rows[0].status === "approved";
      const defaultMessage = approved
        ? "Update on your request: it's been approved. ✅"
        : "Update on your request: unfortunately we're not able to do that this time.";
      const message = rows[0].admin_note
        ? `${defaultMessage}\n\n${rows[0].admin_note}`
        : defaultMessage;
      const whatsapp = await sendWhatsAppMessage(rows[0].whatsapp_phone, message);
      await pool.query(
        `UPDATE admin_requests SET notification_sent = $1, notification_error = $2 WHERE id = $3`,
        [whatsapp.sent, whatsapp.sent ? null : String(whatsapp.reason || "unknown error"), requestId]
      );
      return res.status(whatsapp.sent ? 200 : 502).json({
        success: whatsapp.sent,
        message: whatsapp.sent ? "Customer notified" : "Notification failed; you can retry",
        whatsapp,
      });
    } catch (error) {
      console.error("Retry notification error:", error);
      return res.status(500).json({ success: false, message: "Failed to notify customer" });
    }
  });

  // --------------------------------------------------
  // DASHBOARD / SESSION
  // --------------------------------------------------

  app.get("/admin/session", async (req, res) => {
    try {
      const [settingsResult, profileResult, unreadResult] = await Promise.all([
        pool.query(`SELECT restaurant_name, currency, delivery_charge, opening_hours, updated_at FROM restaurant_settings WHERE id = 1`),
        pool.query(`SELECT display_name, updated_at FROM admin_profile WHERE id = 1`),
        pool.query(`SELECT COUNT(*)::int AS count FROM admin_notifications WHERE read_at IS NULL`),
      ]);
      return res.json({
        success: true,
        restaurant: settingsResult.rows[0] || null,
        admin: profileResult.rows[0] || null,
        unread_notifications: unreadResult.rows[0]?.count || 0,
        integrations: {
          whatsapp_configured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
          database_connected: true,
        },
      });
    } catch (error) {
      console.error("Admin session error:", error);
      return res.status(500).json({ success: false, message: "Failed to load admin session" });
    }
  });

  app.get("/admin/dashboard", async (req, res) => {
    const range = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    try {
      const [stats, statuses, activity, recentOrders, recentRequests, recentFeedback] = await Promise.all([
        pool.query(`
          WITH today AS (
            SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0) AS revenue
            FROM orders
            WHERE (created_at AT TIME ZONE 'Asia/Karachi')::date = (NOW() AT TIME ZONE 'Asia/Karachi')::date
          ), yesterday AS (
            SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0) AS revenue
            FROM orders
            WHERE (created_at AT TIME ZONE 'Asia/Karachi')::date = (NOW() AT TIME ZONE 'Asia/Karachi')::date - 1
          )
          SELECT today.orders AS today_orders, today.revenue AS today_revenue,
            yesterday.orders AS previous_orders, yesterday.revenue AS previous_revenue,
            (SELECT COUNT(*)::int FROM admin_requests WHERE status = 'pending') AS pending_requests,
            (SELECT COUNT(DISTINCT customer_id)::int FROM conversation_sessions WHERE updated_at >= NOW() - INTERVAL '24 hours') AS active_customers
          FROM today, yesterday
        `),
        pool.query(`SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`),
        pool.query(`
          WITH days AS (
            SELECT generate_series(
              (NOW() AT TIME ZONE 'Asia/Karachi')::date - ($1::int - 1),
              (NOW() AT TIME ZONE 'Asia/Karachi')::date,
              INTERVAL '1 day'
            )::date AS day
          )
          SELECT d.day, COUNT(o.id)::int AS orders,
            COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue
          FROM days d
          LEFT JOIN orders o ON (o.created_at AT TIME ZONE 'Asia/Karachi')::date = d.day
          GROUP BY d.day ORDER BY d.day
        `, [range]),
        pool.query(`
          SELECT o.id, o.items, o.order_type, o.total, o.status, o.created_at,
            c.name AS customer_name, c.whatsapp_phone AS customer_phone
          FROM orders o JOIN customers c ON c.id = o.customer_id
          ORDER BY o.created_at DESC LIMIT 6
        `),
        pool.query(`
          SELECT r.id, r.request_type, r.question, r.status, r.created_at,
            c.name AS customer_name, c.whatsapp_phone AS customer_phone, r.order_id
          FROM admin_requests r JOIN customers c ON c.id = r.customer_id
          WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 4
        `),
        pool.query(`
          SELECT f.id, f.rating, f.message, f.created_at, f.order_id,
            c.name AS customer_name, c.whatsapp_phone AS customer_phone
          FROM feedback f JOIN customers c ON c.id = f.customer_id
          ORDER BY f.created_at DESC LIMIT 4
        `),
      ]);
      return res.json({
        success: true,
        stats: stats.rows[0],
        status_counts: statuses.rows,
        activity: activity.rows,
        recent_orders: recentOrders.rows,
        pending_requests: recentRequests.rows,
        recent_feedback: recentFeedback.rows,
      });
    } catch (error) {
      console.error("Dashboard error:", error);
      return res.status(500).json({ success: false, message: "Failed to load dashboard" });
    }
  });

  app.get("/admin/order-history/export.csv", async (req, res) => {
    const { date_from: dateFrom, date_to: dateTo } = req.query;
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      return res.status(400).json({ success: false, message: "Dates must use YYYY-MM-DD" });
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({ success: false, message: "From date cannot be after to date" });
    }
    try {
      const params = [];
      const conditions = [`o.status IN ('completed', 'cancelled')`];
      if (dateFrom) {
        params.push(dateFrom);
        conditions.push(`(o.created_at AT TIME ZONE 'Asia/Karachi')::date >= $${params.length}::date`);
      }
      if (dateTo) {
        params.push(dateTo);
        conditions.push(`(o.created_at AT TIME ZONE 'Asia/Karachi')::date <= $${params.length}::date`);
      }
      const { rows } = await pool.query(`
        SELECT o.id, c.name AS customer, c.whatsapp_phone AS phone, o.order_type,
          o.status, o.subtotal, o.delivery_charge, o.total, o.created_at
        FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE ${conditions.join(" AND ")} ORDER BY o.created_at DESC LIMIT 10000
      `, params);
      const columns = ["Order ID", "Customer", "Phone", "Type", "Status", "Subtotal", "Delivery Fee", "Total", "Created At"];
      const csv = [columns.map(csvCell).join(","), ...rows.map((row) => [
        row.id, row.customer, row.phone, row.order_type, row.status, row.subtotal,
        row.delivery_charge, row.total, row.created_at.toISOString(),
      ].map(csvCell).join(","))].join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="pizza-bar-order-history-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(`\uFEFF${csv}`);
    } catch (error) {
      console.error("Export order history error:", error);
      return res.status(500).json({ success: false, message: "Failed to export order history" });
    }
  });

  // --------------------------------------------------
  // CUSTOMERS / FEEDBACK
  // --------------------------------------------------

  app.get("/admin/customers", async (req, res) => {
    const { limit, page, offset } = parsePagination(req.query);
    const search = String(req.query.search || "").trim();
    try {
      const params = [];
      let where = "";
      if (search) {
        params.push(`%${search}%`);
        where = `WHERE c.name ILIKE $1 OR c.whatsapp_phone ILIKE $1`;
      }
      params.push(limit, offset);
      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.whatsapp_phone, c.preferred_language, c.created_at,
          COUNT(o.id)::int AS total_orders,
          COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS total_spending,
          MAX(o.created_at) AS last_order,
          CASE WHEN MAX(o.created_at) >= NOW() - INTERVAL '90 days' THEN 'active' ELSE 'inactive' END AS status,
          COUNT(*) OVER() AS total_count
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        ${where}
        GROUP BY c.id ORDER BY MAX(o.created_at) DESC NULLS LAST, c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      const total = rows.length ? Number(rows[0].total_count) : 0;
      const customers = rows.map(({ total_count, ...customer }) => customer);
      return res.json({ success: true, customers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) {
      console.error("List customers error:", error);
      return res.status(500).json({ success: false, message: "Failed to load customers" });
    }
  });

  app.get("/admin/customers/:id", async (req, res) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid customer id" });
    }
    try {
      const [customer, orders, feedbackResult, session] = await Promise.all([
        pool.query(`
          SELECT c.id, c.name, c.whatsapp_phone, c.preferred_language, c.created_at, c.updated_at,
            COUNT(o.id)::int AS total_orders,
            COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS total_spending,
            MAX(o.created_at) AS last_order
          FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
          WHERE c.id = $1 GROUP BY c.id
        `, [customerId]),
        pool.query(`SELECT id, items, order_type, total, status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [customerId]),
        pool.query(`SELECT id, order_id, rating, message, created_at FROM feedback WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`, [customerId]),
        pool.query(`SELECT human_handoff, awaiting_human, order_status, recent_messages, updated_at FROM conversation_sessions WHERE customer_id = $1`, [customerId]),
      ]);
      if (!customer.rows.length) return res.status(404).json({ success: false, message: "Customer not found" });
      return res.json({ success: true, customer: customer.rows[0], orders: orders.rows, feedback: feedbackResult.rows, session: session.rows[0] || null });
    } catch (error) {
      console.error("Get customer error:", error);
      return res.status(500).json({ success: false, message: "Failed to load customer" });
    }
  });

  app.get("/admin/feedback", async (req, res) => {
    const { limit, page, offset } = parsePagination(req.query);
    const rating = req.query.rating ? Number(req.query.rating) : null;
    if (rating !== null && ![1, 2, 3, 4, 5].includes(rating)) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5" });
    }
    try {
      const params = [];
      const where = rating ? (params.push(rating), `WHERE f.rating = $1`) : "";
      params.push(limit, offset);
      const [list, summary] = await Promise.all([
        pool.query(`
          SELECT f.id, f.rating, f.message, f.order_id, f.created_at,
            c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
            COUNT(*) OVER() AS total_count
          FROM feedback f JOIN customers c ON c.id = f.customer_id
          ${where} ORDER BY f.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params),
        pool.query(`SELECT COUNT(*)::int AS total, COALESCE(AVG(rating), 0) AS average_rating,
          COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE rating = 5) / NULLIF(COUNT(*), 0), 1), 0) AS five_star_percentage
          FROM feedback`),
      ]);
      const total = list.rows.length ? Number(list.rows[0].total_count) : 0;
      const feedback = list.rows.map(({ total_count, ...item }) => item);
      return res.json({ success: true, feedback, summary: summary.rows[0], pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) {
      console.error("List feedback error:", error);
      return res.status(500).json({ success: false, message: "Failed to load feedback" });
    }
  });

  app.post("/admin/feedback", async (req, res) => {
    const { customer_id: customerIdValue, customer_phone: customerPhone, order_id: orderIdValue, rating: ratingValue, message } = req.body || {};
    const customerId = customerIdValue === undefined ? null : Number(customerIdValue);
    const orderId = orderIdValue === undefined || orderIdValue === null ? null : Number(orderIdValue);
    const rating = Number(ratingValue);
    if ((!customerId && !customerPhone) || ![1, 2, 3, 4, 5].includes(rating)) {
      return res.status(400).json({ success: false, message: "Customer and a rating from 1 to 5 are required" });
    }
    if (orderId !== null && (!Number.isInteger(orderId) || orderId <= 0)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    if (message !== undefined && (typeof message !== "string" || message.length > 2000)) {
      return res.status(400).json({ success: false, message: "Feedback message must be 2,000 characters or fewer" });
    }
    try {
      const customer = await pool.query(
        customerId
          ? `SELECT id FROM customers WHERE id = $1`
          : `SELECT id FROM customers WHERE whatsapp_phone = $1`,
        [customerId || String(customerPhone)]
      );
      if (!customer.rows.length) return res.status(404).json({ success: false, message: "Customer not found" });
      const resolvedCustomerId = customer.rows[0].id;
      if (orderId !== null) {
        const order = await pool.query(`SELECT id FROM orders WHERE id = $1 AND customer_id = $2`, [orderId, resolvedCustomerId]);
        if (!order.rows.length) return res.status(400).json({ success: false, message: "Order does not belong to this customer" });
      }
      const result = await pool.query(`
        INSERT INTO feedback (customer_id, order_id, rating, message)
        VALUES ($1, $2, $3, $4) RETURNING *
      `, [resolvedCustomerId, orderId, rating, message?.trim() || null]);
      return res.status(201).json({ success: true, feedback: result.rows[0] });
    } catch (error) {
      console.error("Create feedback error:", error);
      return res.status(500).json({ success: false, message: "Failed to save feedback" });
    }
  });

  // --------------------------------------------------
  // MENU
  // --------------------------------------------------

  app.get("/admin/menu", async (req, res) => {
    try {
      const [items, deals, images] = await Promise.all([
        pool.query(`
          SELECT i.id, i.category, i.item_type, i.name, i.description, i.active,
            i.is_popular, i.is_featured, i.sort_order,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id', v.id, 'label', v.variant_label, 'price', v.price, 'quantity', v.quantity,
              'unit', v.unit, 'active', v.active, 'sort_order', v.sort_order
            ) ORDER BY v.sort_order) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
          FROM restaurant_menu_items i
          LEFT JOIN restaurant_menu_variants v ON v.menu_item_id = i.id
          GROUP BY i.id ORDER BY i.sort_order, i.name
        `),
        pool.query(`SELECT id, category, name, description, price, unit, active, is_popular, is_featured, availability, sort_order FROM restaurant_deals ORDER BY sort_order, name`),
        pool.query(`SELECT id, name, mime_type, active, display_order, created_at FROM menu_images WHERE active = TRUE ORDER BY display_order, created_at DESC`),
      ]);
      return res.json({
        success: true,
        items: items.rows,
        deals: deals.rows,
        images: images.rows.map((image) => ({ ...image, url: `/images/${image.id}` })),
      });
    } catch (error) {
      console.error("List menu error:", error);
      return res.status(500).json({ success: false, message: "Failed to load menu" });
    }
  });

  app.post("/admin/menu/items", async (req, res) => {
    const { category, item_type: itemType, name, description, variants } = req.body || {};
    if (![category, itemType, name].every((value) => typeof value === "string" && value.trim())) {
      return res.status(400).json({ success: false, message: "Category, item type, and name are required" });
    }
    if (!Array.isArray(variants) || !variants.length || variants.some((variant) => !Number.isInteger(Number(variant.price)) || Number(variant.price) < 0)) {
      return res.status(400).json({ success: false, message: "At least one valid price variant is required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const item = await client.query(`
        INSERT INTO restaurant_menu_items (category, item_type, name, description, sort_order)
        VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM restaurant_menu_items), 1))
        RETURNING *
      `, [category.trim(), itemType.trim(), name.trim(), description?.trim() || null]);
      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index];
        await client.query(`
          INSERT INTO restaurant_menu_variants (menu_item_id, variant_label, price, quantity, unit, price_text, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [item.rows[0].id, variant.label?.trim() || null, Number(variant.price), variant.quantity || 1, variant.unit?.trim() || "serving", `Rs. ${Number(variant.price)}`, index + 1]);
      }
      await client.query(`INSERT INTO restaurant_menu_aliases (menu_item_id, alias) VALUES ($1, LOWER($2)) ON CONFLICT DO NOTHING`, [item.rows[0].id, name.trim()]);
      await client.query("COMMIT");
      return res.status(201).json({ success: true, item: item.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Create menu item error:", error);
      if (error.code === "23505") return res.status(409).json({ success: false, message: "A menu item with that name already exists" });
      return res.status(500).json({ success: false, message: "Failed to create menu item" });
    } finally {
      client.release();
    }
  });

  app.patch("/admin/menu/:kind/:id", async (req, res) => {
    const id = Number(req.params.id);
    const kind = req.params.kind;
    if (!Number.isInteger(id) || id <= 0 || !["items", "deals"].includes(kind)) {
      return res.status(400).json({ success: false, message: "Invalid menu record" });
    }
    const table = kind === "items" ? "restaurant_menu_items" : "restaurant_deals";
    const fields = [];
    const values = [];
    for (const key of ["name", "description", "active", "is_popular", "is_featured"]) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        if (["name", "description"].includes(key) && typeof req.body[key] !== "string") {
          return res.status(400).json({ success: false, message: `${key} must be text` });
        }
        if (key === "name" && !req.body[key].trim()) {
          return res.status(400).json({ success: false, message: "name cannot be empty" });
        }
        if (["active", "is_popular", "is_featured"].includes(key) && typeof req.body[key] !== "boolean") {
          return res.status(400).json({ success: false, message: `${key} must be true or false` });
        }
        values.push(typeof req.body[key] === "string" ? req.body[key].trim() : req.body[key]);
        fields.push(`${key} = $${values.length}`);
      }
    }
    if (kind === "deals" && Object.prototype.hasOwnProperty.call(req.body || {}, "price")) {
      const price = Number(req.body.price);
      if (!Number.isInteger(price) || price < 0) return res.status(400).json({ success: false, message: "Price must be a non-negative integer" });
      values.push(price);
      fields.push(`price = $${values.length}`);
    }
    if (!fields.length) return res.status(400).json({ success: false, message: "No supported fields supplied" });
    values.push(id);
    try {
      const result = await pool.query(`UPDATE ${table} SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Menu record not found" });
      return res.json({ success: true, record: result.rows[0] });
    } catch (error) {
      console.error("Update menu record error:", error);
      return res.status(500).json({ success: false, message: "Failed to update menu record" });
    }
  });

  app.patch("/admin/menu/items/:itemId/variants/:variantId", async (req, res) => {
    const itemId = Number(req.params.itemId);
    const variantId = Number(req.params.variantId);
    const price = Number(req.body?.price);
    if (![itemId, variantId].every((value) => Number.isInteger(value) && value > 0) || !Number.isInteger(price) || price < 0) {
      return res.status(400).json({ success: false, message: "Invalid item, variant, or price" });
    }
    try {
      const result = await pool.query(`
        UPDATE restaurant_menu_variants SET price = $1, price_text = $2
        WHERE id = $3 AND menu_item_id = $4 RETURNING *
      `, [price, `Rs. ${price}`, variantId, itemId]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Menu variant not found" });
      return res.json({ success: true, variant: result.rows[0] });
    } catch (error) {
      console.error("Update menu price error:", error);
      return res.status(500).json({ success: false, message: "Failed to update menu price" });
    }
  });

  app.delete("/admin/menu/:kind/:id", async (req, res) => {
    const id = Number(req.params.id);
    const kind = req.params.kind;
    if (!Number.isInteger(id) || id <= 0 || !["items", "deals"].includes(kind)) {
      return res.status(400).json({ success: false, message: "Invalid menu record" });
    }
    const table = kind === "items" ? "restaurant_menu_items" : "restaurant_deals";
    try {
      const result = await pool.query(`UPDATE ${table} SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id`, [id]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Menu record not found" });
      return res.json({ success: true });
    } catch (error) {
      console.error("Deactivate menu record error:", error);
      return res.status(500).json({ success: false, message: "Failed to deactivate menu record" });
    }
  });

  // --------------------------------------------------
  // NOTIFICATIONS / SETTINGS
  // --------------------------------------------------

  app.get("/admin/notifications", async (req, res) => {
    const { limit, page, offset } = parsePagination(req.query);
    const conditions = [];
    const params = [];
    if (req.query.unread === "true") conditions.push("n.read_at IS NULL");
    if (req.query.unread && !["true", "false"].includes(req.query.unread)) {
      return res.status(400).json({ success: false, message: "unread must be true or false" });
    }
    if (req.query.type) {
      if (!["new_order", "customer_request", "notification_failure", "system"].includes(req.query.type)) {
        return res.status(400).json({ success: false, message: "Invalid notification type" });
      }
      params.push(req.query.type);
      conditions.push(`n.notification_type = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);
    try {
      const { rows } = await pool.query(`
        SELECT n.*, COUNT(*) OVER() AS total_count
        FROM admin_notifications n ${where}
        ORDER BY n.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      const total = rows.length ? Number(rows[0].total_count) : 0;
      const notifications = rows.map(({ total_count, ...notification }) => notification);
      return res.json({ success: true, notifications, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) {
      console.error("List notifications error:", error);
      return res.status(500).json({ success: false, message: "Failed to load notifications" });
    }
  });

  app.patch("/admin/notifications/:id/read", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: "Invalid notification id" });
    try {
      const result = await pool.query(`UPDATE admin_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 RETURNING *`, [id]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Notification not found" });
      return res.json({ success: true, notification: result.rows[0] });
    } catch (error) {
      console.error("Read notification error:", error);
      return res.status(500).json({ success: false, message: "Failed to update notification" });
    }
  });

  app.post("/admin/notifications/read-all", async (req, res) => {
    try {
      const result = await pool.query(`UPDATE admin_notifications SET read_at = NOW() WHERE read_at IS NULL`);
      return res.json({ success: true, updated: result.rowCount });
    } catch (error) {
      console.error("Read all notifications error:", error);
      return res.status(500).json({ success: false, message: "Failed to update notifications" });
    }
  });

  app.get("/admin/settings", async (req, res) => {
    try {
      const [restaurant, profile] = await Promise.all([
        pool.query(`SELECT restaurant_name, currency, delivery_charge, opening_hours, updated_at FROM restaurant_settings WHERE id = 1`),
        pool.query(`SELECT display_name, updated_at FROM admin_profile WHERE id = 1`),
      ]);
      return res.json({
        success: true,
        restaurant: restaurant.rows[0] || null,
        admin: profile.rows[0] || null,
        integrations: {
          whatsapp_configured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
          polling_seconds: 15,
        },
      });
    } catch (error) {
      console.error("Get settings error:", error);
      return res.status(500).json({ success: false, message: "Failed to load settings" });
    }
  });

  app.patch("/admin/settings", async (req, res) => {
    const { restaurant_name: restaurantName, currency, delivery_charge: deliveryCharge, opening_hours: openingHours, display_name: displayName } = req.body || {};
    if (restaurantName !== undefined && (typeof restaurantName !== "string" || !restaurantName.trim())) {
      return res.status(400).json({ success: false, message: "Restaurant name is required" });
    }
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ success: false, message: "Currency must be a three-letter code" });
    }
    if (deliveryCharge !== undefined && (!Number.isFinite(Number(deliveryCharge)) || Number(deliveryCharge) < 0)) {
      return res.status(400).json({ success: false, message: "Delivery charge must be zero or greater" });
    }
    if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim())) {
      return res.status(400).json({ success: false, message: "Admin display name is required" });
    }
    if (openingHours !== undefined && (openingHours === null || typeof openingHours !== "object" || Array.isArray(openingHours))) {
      return res.status(400).json({ success: false, message: "Opening hours must be a JSON object" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const restaurant = await client.query(`
        UPDATE restaurant_settings SET
          restaurant_name = COALESCE($1, restaurant_name),
          currency = COALESCE($2, currency),
          delivery_charge = COALESCE($3, delivery_charge),
          opening_hours = COALESCE($4, opening_hours),
          updated_at = NOW()
        WHERE id = 1 RETURNING restaurant_name, currency, delivery_charge, opening_hours, updated_at
      `, [restaurantName?.trim() || null, currency || null, deliveryCharge === undefined ? null : Number(deliveryCharge), openingHours || null]);
      const profile = await client.query(`
        UPDATE admin_profile SET display_name = COALESCE($1, display_name), updated_at = NOW()
        WHERE id = 1 RETURNING display_name, updated_at
      `, [displayName?.trim() || null]);
      await client.query("COMMIT");
      return res.json({ success: true, restaurant: restaurant.rows[0], admin: profile.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Update settings error:", error);
      return res.status(500).json({ success: false, message: "Failed to update settings" });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerAdminRoutes, sendWhatsAppMessage, requireAdminKey };
