// Admin dashboard API: order list + structured approve/deny decisions.
//
// These routes are shared between local dev (server.js) and the Vercel
// deployment (api/index.js) so the logic only lives in one place.
//
// Required env vars for the initial admin account:
//   ADMIN_USERNAME
//   ADMIN_PASSWORD
//   N8N_ADMIN_WEBHOOK_URL     - private dashboard-event webhook

const crypto = require("crypto");
const { createRequireAdminSession, registerAdminAuthRoutes } = require("./admin-auth");
const {
  dispatchCustomerNotificationEvent,
  loadCustomerNotificationEvent,
  publicEvent,
} = require("./customer-notification-events");
const { deleteCanonicalMenuData, deleteMenuImage } = require("./menu-management");

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

const ORDER_STATUSES = ["received", "preparing", "oven", "out_for_delivery", "completed", "cancelled"];
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS_CLARIFICATION_EVENT = "admin_address_clarification";
const ADDRESS_CLARIFICATION_STATUSES = ["received", "preparing"];
const MAX_ADMIN_MESSAGE_LENGTH = 500;

function setPrivateCache(res, maxAgeSeconds, staleWhileRevalidateSeconds = 0) {
  const stale = staleWhileRevalidateSeconds > 0
    ? `, stale-while-revalidate=${staleWhileRevalidateSeconds}`
    : "";
  res.setHeader("Cache-Control", `private, max-age=${maxAgeSeconds}${stale}`);
  res.vary("Authorization");
}

function latestTimestamp(...values) {
  const timestamps = values.filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function registerAdminRoutes(app, pool, { dispatchEvent } = {}) {
  const deliverEvent = dispatchEvent || ((eventId) => dispatchCustomerNotificationEvent(pool, eventId));
  const requireAdminSession = registerAdminAuthRoutes(app, pool);
  app.use("/admin", requireAdminSession);

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
          allowed_order_status_transitions_for_order(o.status, o.order_type) AS allowed_transitions,
          o.created_at, o.updated_at,
          c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          latest_event.id AS notification_event_id,
          latest_event.delivery_status AS notification_status,
          latest_event.last_error AS notification_error,
          COUNT(*) OVER() AS total_count
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN LATERAL (
          SELECT e.id, e.delivery_status, e.last_error
          FROM customer_notification_events e
          WHERE e.order_id = o.id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
        ) latest_event ON TRUE
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
      const [result, history, notifications] = await Promise.all([
        pool.query(`
          SELECT o.*, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
                 allowed_order_status_transitions_for_order(o.status, o.order_type) AS allowed_transitions,
                 order_is_cancellable(o.status) AS cancellable
          FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [orderId]),
        pool.query(`SELECT id, status, source, request_id, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at`, [orderId]),
        pool.query(`
          SELECT id, request_id, event_type, order_status, decision, delivery_status,
                 attempts, provider_message_id, last_error, created_at, updated_at, sent_at
          FROM customer_notification_events
          WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`, [orderId]),
      ]);
      if (!result.rows.length) return res.status(404).json({ success: false, message: "Order not found" });
      return res.json({ success: true, order: result.rows[0], history: history.rows, notifications: notifications.rows.map(publicEvent) });
    } catch (error) {
      console.error("Get order error:", error);
      return res.status(500).json({ success: false, message: "Failed to load order" });
    }
  });

  // PATCH /admin/orders/:id/status  { status, expected_status?, request_id? }
  app.patch("/admin/orders/:id/status", async (req, res) => {
    const orderId = Number(req.params.id);
    const { status } = req.body || {};
    const expectedStatus = req.body?.expected_status;
    const suppliedRequestId = req.body?.request_id;
    const requestId = suppliedRequestId || crypto.randomUUID();

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${ORDER_STATUSES.join(", ")}`,
      });
    }
    if (expectedStatus !== undefined && !ORDER_STATUSES.includes(expectedStatus)) {
      return res.status(400).json({ success: false, message: "expected_status is invalid" });
    }
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return res.status(400).json({ success: false, message: "request_id must be a UUID" });
    }

    const client = await pool.connect();
    let clientReleased = false;
    let committed = false;
    let event;
    let order;
    try {
      await client.query("BEGIN");
      const existingRequest = await client.query(
        `SELECT * FROM customer_notification_events WHERE request_id = $1 FOR UPDATE`,
        [requestId]
      );
      if (existingRequest.rows.length) {
        event = existingRequest.rows[0];
        if (String(event.order_id) !== String(orderId) || event.order_status !== status) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "request_id was already used for a different action" });
        }
        order = (await client.query(
          `SELECT o.*, allowed_order_status_transitions_for_order(o.status, o.order_type) AS allowed_transitions
           FROM orders o WHERE id = $1`, [orderId]
        )).rows[0];
        await client.query("COMMIT");
        committed = true;
        return res.json({ success: true, already_applied: true, order, notification: publicEvent(event) });
      }

      const current = await client.query(
        `SELECT o.*, allowed_order_status_transitions_for_order(o.status, o.order_type) AS allowed_transitions
         FROM orders o WHERE id = $1 FOR UPDATE`, [orderId]
      );
      if (!current.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      const currentStatus = current.rows[0].status;
      if (expectedStatus !== undefined && currentStatus !== expectedStatus) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Order changed from ${expectedStatus} to ${currentStatus}; refresh before taking another action`,
        });
      }
      if (status === currentStatus) {
        event = (await client.query(
          `SELECT * FROM customer_notification_events
           WHERE order_id = $1 AND order_status = $2
           ORDER BY created_at DESC, id DESC LIMIT 1`, [orderId, status]
        )).rows[0] || null;
        await client.query("COMMIT");
        committed = true;
        return res.json({ success: true, already_applied: true, order: current.rows[0], notification: publicEvent(event) });
      }

      const allowed = await client.query(
        `SELECT can_transition_order_status_for_order($1, $2, $3) AS allowed`,
        [currentStatus, status, current.rows[0].order_type]
      );
      if (!allowed.rows[0]?.allowed) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: `Cannot change order from ${currentStatus} to ${status}` });
      }

      await client.query(`SELECT set_config('app.order_status_source', 'admin_dashboard', TRUE)`);
      await client.query(`SELECT set_config('app.order_status_request_id', $1, TRUE)`, [requestId]);
      const updated = await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW()
         WHERE id = $2 AND status = $3
         RETURNING *, allowed_order_status_transitions_for_order(status, order_type) AS allowed_transitions`,
        [status, orderId, currentStatus]
      );
      if (!updated.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Order changed; refresh and try again" });
      }
      order = updated.rows[0];

      const history = await client.query(
        `SELECT id FROM order_status_history WHERE request_id = $1 AND order_id = $2`,
        [requestId, orderId]
      );
      if (!history.rows.length) throw new Error("Status history was not recorded");

      const inserted = await client.query(
        `INSERT INTO customer_notification_events (
           request_id, idempotency_key, event_type, order_id, customer_id,
           status_history_id, order_status
         ) VALUES ($1, $2, 'order_status_update', $3, $4, $5, $6)
         RETURNING *`,
        [requestId, `order_status:${orderId}:${history.rows[0].id}`, orderId, order.customer_id, history.rows[0].id, status]
      );
      event = inserted.rows[0];
      await client.query("COMMIT");
      committed = true;

      client.release();
      clientReleased = true;
      const delivery = await deliverEvent(event.id);
      return res.json({
        success: true,
        already_applied: false,
        order,
        notification: delivery.event || publicEvent(event),
        notification_lifecycle: delivery.lifecycle,
      });
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      console.error("Update order status error:", error);
      return res.status(500).json({ success: false, message: "Failed to update order" });
    } finally {
      if (!clientReleased) client.release();
    }
  });

  // POST /admin/orders/:id/address-clarification
  // The authenticated dashboard supplies only an order id, an idempotency id,
  // and the admin-approved wording. The server resolves and persists the
  // authoritative customer relationship; n8n resolves the phone from this row.
  app.post("/admin/orders/:id/address-clarification", async (req, res) => {
    const orderId = Number(req.params.id);
    const messageValue = req.body?.admin_message;
    const adminMessage = typeof messageValue === "string" ? messageValue.replace(/\r\n/g, "\n").trim() : "";
    const requestId = String(req.body?.request_id || "");

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return res.status(400).json({ success: false, message: "request_id must be a UUID" });
    }
    if (!adminMessage || adminMessage.length > MAX_ADMIN_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Message must be between 1 and ${MAX_ADMIN_MESSAGE_LENGTH} characters`,
      });
    }

    const client = await pool.connect();
    let clientReleased = false;
    let committed = false;
    let event;
    let alreadyApplied = false;
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT * FROM customer_notification_events WHERE request_id = $1 FOR UPDATE`,
        [requestId]
      );
      if (existing.rows.length) {
        event = existing.rows[0];
        if (
          String(event.order_id) !== String(orderId)
          || event.event_type !== ADDRESS_CLARIFICATION_EVENT
          || event.admin_note !== adminMessage
        ) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "request_id was already used for a different action" });
        }
        alreadyApplied = true;
      } else {
        const order = await client.query(
          `SELECT id, customer_id, order_type, status FROM orders WHERE id = $1 FOR UPDATE`,
          [orderId]
        );
        if (!order.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ success: false, message: "Order not found" });
        }
        if (order.rows[0].order_type !== "delivery") {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "Address clarification is only available for delivery orders" });
        }
        if (!ADDRESS_CLARIFICATION_STATUSES.includes(order.rows[0].status)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "This order has progressed too far to change its delivery address" });
        }

        const active = await client.query(
          `SELECT id FROM customer_notification_events
           WHERE order_id = $1
             AND event_type = $2
             AND delivery_status IN ('pending', 'processing')
           ORDER BY created_at DESC, id DESC LIMIT 1
           FOR UPDATE`,
          [orderId, ADDRESS_CLARIFICATION_EVENT]
        );
        if (active.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "An address clarification request is already being sent for this order" });
        }

        event = (await client.query(
          `INSERT INTO customer_notification_events (
             request_id, idempotency_key, event_type, order_id, customer_id, admin_note
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            requestId,
            `admin_address_clarification:${orderId}:${requestId}`,
            ADDRESS_CLARIFICATION_EVENT,
            orderId,
            order.rows[0].customer_id,
            adminMessage,
          ]
        )).rows[0];
      }

      await client.query("COMMIT");
      committed = true;
      client.release();
      clientReleased = true;

      let notification = publicEvent(event);
      let lifecycle = event.delivery_status;
      if (["pending", "failed"].includes(event.delivery_status)) {
        const delivery = await deliverEvent(event.id);
        notification = delivery.event || notification;
        lifecycle = delivery.lifecycle;
      }

      const failed = lifecycle === "failed";
      return res.status(failed ? 502 : 200).json({
        success: !failed,
        already_applied: alreadyApplied,
        notification,
        notification_lifecycle: lifecycle,
        message: failed
          ? "Address clarification could not be sent. Please retry."
          : lifecycle === "sent" || lifecycle === "duplicate"
            ? "Address clarification requested"
            : "Address clarification request is processing",
      });
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      if (error?.code === "23505") {
        return res.status(409).json({ success: false, message: "An address clarification request is already being sent for this order" });
      }
      console.error("Address clarification error:", error);
      return res.status(500).json({ success: false, message: "Failed to request address clarification" });
    } finally {
      if (!clientReleased) client.release();
    }
  });

  app.post("/admin/orders/:id/notifications/:eventId/retry", async (req, res) => {
    const orderId = Number(req.params.id);
    const eventId = Number(req.params.eventId);
    if (![orderId, eventId].every((value) => Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ success: false, message: "Invalid order or notification id" });
    }
    try {
      const event = await loadCustomerNotificationEvent(pool, eventId);
      if (!event || String(event.order_id) !== String(orderId)) {
        return res.status(404).json({ success: false, message: "Notification event not found for this order" });
      }
      const delivery = await deliverEvent(eventId);
      return res.status(delivery.lifecycle === "failed" ? 502 : 200).json({
        success: delivery.lifecycle !== "failed",
        notification: delivery.event,
        notification_lifecycle: delivery.lifecycle,
        message: delivery.lifecycle === "sent" || delivery.lifecycle === "duplicate"
          ? "Customer notification delivered"
          : delivery.lifecycle === "processing"
            ? "Customer notification is processing"
            : delivery.lifecycle === "superseded"
              ? "A newer status superseded this notification"
            : "Customer notification failed",
      });
    } catch (error) {
      console.error("Retry order notification error:", error);
      return res.status(500).json({ success: false, message: "Failed to retry customer notification" });
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
          r.notification_attempts, r.last_notification_attempt_at,
          c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          o.id AS order_id, o.status AS order_status, o.total AS order_total,
          o.items AS order_items, o.delivery_address, o.order_type,
          order_is_cancellable(o.status) AS order_cancellable,
          latest_event.id AS notification_event_id,
          latest_event.delivery_status AS notification_delivery_status,
          latest_event.last_error AS event_notification_error,
          COUNT(*) OVER() AS total_count
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        LEFT JOIN orders o ON o.id = r.order_id
        LEFT JOIN LATERAL (
          SELECT e.id, e.delivery_status, e.last_error
          FROM customer_notification_events e
          WHERE e.admin_request_id = r.id
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1
        ) latest_event ON TRUE
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

  app.get("/admin/requests/:id", async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }
    try {
      const { rows } = await pool.query(
        `
        SELECT
          r.id, r.request_type, r.question, r.status, r.admin_note,
          r.created_at, r.resolved_at, r.notification_sent, r.notification_error,
          r.notification_attempts, r.last_notification_attempt_at,
          c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
          o.id AS order_id, o.status AS order_status, o.total AS order_total,
          o.items AS order_items, o.delivery_address, o.delivery_name, o.order_type,
          order_is_cancellable(o.status) AS order_cancellable,
          latest_event.id AS notification_event_id,
          latest_event.delivery_status AS notification_delivery_status,
          latest_event.last_error AS event_notification_error
        FROM admin_requests r
        JOIN customers c ON c.id = r.customer_id
        LEFT JOIN orders o ON o.id = r.order_id
        LEFT JOIN LATERAL (
          SELECT e.id, e.delivery_status, e.last_error
          FROM customer_notification_events e
          WHERE e.admin_request_id = r.id
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1
        ) latest_event ON TRUE
        WHERE r.id = $1
        `,
        [requestId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: "Request not found" });
      }
      return res.json({ success: true, request: rows[0] });
    } catch (error) {
      console.error("Get admin request error:", error);
      return res.status(500).json({ success: false, message: "Failed to load request" });
    }
  });

  async function resolveRequest(req, res, decision) {
    const requestId = Number(req.params.id);
    const { admin_note } = req.body || {};
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }
    if (admin_note !== undefined && (typeof admin_note !== "string" || admin_note.length > 2000)) {
      return res.status(400).json({ success: false, message: "Admin note must be 2,000 characters or fewer" });
    }

    const eventRequestId = crypto.randomUUID();
    const client = await pool.connect();
    let clientReleased = false;
    let committed = false;
    let event;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM admin_requests WHERE id = $1 FOR UPDATE`,
        [requestId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Request not found" });
      }

      const requestRow = rows[0];
      if (requestRow.status !== "pending") {
        event = (await client.query(
          `SELECT * FROM customer_notification_events
           WHERE admin_request_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [requestId]
        )).rows[0] || null;
        await client.query("COMMIT");
        committed = true;
        if (requestRow.status !== decision) {
          return res.status(409).json({ success: false, message: `Request is already ${requestRow.status}` });
        }
        return res.json({
          success: true,
          decision,
          already_resolved: true,
          notification: publicEvent(event),
        });
      }

      if (requestRow.request_type !== "cancel_order") {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Only cancellation decisions are supported by this workflow" });
      }
      if (!requestRow.order_id) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "This cancellation request is not linked to an order" });
      }

      const orderResult = await client.query(
        `SELECT o.*, order_is_cancellable(o.status) AS cancellable
         FROM orders o WHERE o.id = $1 FOR UPDATE`,
        [requestRow.order_id]
      );
      if (!orderResult.rows.length || String(orderResult.rows[0].customer_id) !== String(requestRow.customer_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "The linked order does not belong to this customer" });
      }
      const order = orderResult.rows[0];

      if (decision === "approved" && !order.cancellable && order.status !== "cancelled") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: `Order #${order.id} can no longer be cancelled because it is ${order.status}`,
        });
      }

      let historyId = null;
      if (decision === "approved" && order.status !== "cancelled") {
        await client.query(`SELECT set_config('app.order_status_source', 'customer_cancellation', TRUE)`);
        await client.query(`SELECT set_config('app.order_status_request_id', $1, TRUE)`, [eventRequestId]);
        const cancelled = await client.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW()
           WHERE id = $1 AND order_is_cancellable(status)
           RETURNING id`,
          [requestRow.order_id]
        );
        if (!cancelled.rows.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({ success: false, message: "This order can no longer be cancelled" });
        }
        historyId = (await client.query(
          `SELECT id FROM order_status_history WHERE request_id = $1 AND order_id = $2`,
          [eventRequestId, requestRow.order_id]
        )).rows[0]?.id;
        if (!historyId) throw new Error("Cancellation status history was not recorded");
      }

      await client.query(
        `UPDATE admin_requests
         SET status = $1, admin_note = $2, resolved_at = NOW(),
             notification_sent = FALSE, notification_error = NULL,
             notification_claim_token = NULL, notification_claimed_at = NULL,
             resolved_by_phone = NULL, resolved_by_message_id = $3
         WHERE id = $4`,
        [decision, admin_note?.trim() || null, `dashboard:${eventRequestId}`, requestId]
      );
      await client.query(
        `UPDATE conversation_sessions
         SET awaiting_human = EXISTS (
               SELECT 1 FROM admin_requests pending
               WHERE pending.customer_id = $1 AND pending.status = 'pending'
             ),
             order_status = CASE
               WHEN $2 = 'approved' AND active_order_id = $3 THEN 'cancelled'
               ELSE order_status
             END,
             updated_at = NOW()
         WHERE customer_id = $1`,
        [requestRow.customer_id, decision, requestRow.order_id]
      );

      if (decision === "approved" && order.status === "cancelled") {
        event = (await client.query(
          `SELECT * FROM customer_notification_events
           WHERE order_id = $1 AND order_status = 'cancelled'
           ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
          [requestRow.order_id]
        )).rows[0] || null;
        if (event && !event.admin_request_id) {
          event = (await client.query(
            `UPDATE customer_notification_events SET admin_request_id = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`, [requestId, event.id]
          )).rows[0];
        }
      }

      if (!event) {
        const eventType = decision === "approved" ? "order_status_update" : "cancellation_denied";
        const inserted = await client.query(
          `INSERT INTO customer_notification_events (
             request_id, idempotency_key, event_type, order_id, customer_id,
             status_history_id, admin_request_id, order_status, decision, admin_note
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (idempotency_key) DO UPDATE SET admin_request_id = EXCLUDED.admin_request_id
           RETURNING *`,
          [
            eventRequestId,
            `cancel_request:${requestId}:${decision}`,
            eventType,
            requestRow.order_id,
            requestRow.customer_id,
            historyId,
            requestId,
            decision === "approved" ? "cancelled" : order.status,
            decision,
            admin_note?.trim() || null,
          ]
        );
        event = inserted.rows[0];
      }

      await client.query("COMMIT");
      committed = true;

      client.release();
      clientReleased = true;
      const delivery = await deliverEvent(event.id);
      return res.json({
        success: true,
        decision,
        notification: delivery.event || publicEvent(event),
        notification_lifecycle: delivery.lifecycle,
      });
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      console.error("Resolve admin request error:", error);
      return res.status(500).json({ success: false, message: "Failed to resolve request" });
    } finally {
      if (!clientReleased) client.release();
    }
  }

  app.post("/admin/requests/:id/approve", (req, res) => resolveRequest(req, res, "approved"));
  app.post("/admin/requests/:id/deny", (req, res) => resolveRequest(req, res, "denied"));
  app.post("/admin/requests/:id/reject", (req, res) => resolveRequest(req, res, "denied"));

  app.post("/admin/requests/:id/notify", async (req, res) => {
    const requestId = Number(req.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    try {
      const event = (await pool.query(
        `SELECT * FROM customer_notification_events
         WHERE admin_request_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [requestId]
      )).rows[0];
      if (!event) return res.status(404).json({ success: false, message: "Resolved request notification not found" });
      const delivery = await deliverEvent(event.id);
      return res.status(delivery.lifecycle === "failed" ? 502 : 200).json({
        success: delivery.lifecycle !== "failed",
        message: delivery.lifecycle === "sent" || delivery.lifecycle === "duplicate"
          ? "Customer notification delivered"
          : delivery.lifecycle === "processing"
            ? "Customer notification is processing"
            : delivery.lifecycle === "superseded"
              ? "A newer status superseded this notification"
            : "Customer notification failed",
        notification: delivery.event,
        notification_lifecycle: delivery.lifecycle,
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
      const { rows } = await pool.query(`
        SELECT
          (SELECT restaurant_name FROM restaurant_settings WHERE id = 1) AS restaurant_name,
          (SELECT currency FROM restaurant_settings WHERE id = 1) AS currency,
          (SELECT delivery_charge FROM restaurant_settings WHERE id = 1) AS delivery_charge,
          (SELECT opening_hours FROM restaurant_settings WHERE id = 1) AS opening_hours,
          (SELECT updated_at FROM restaurant_settings WHERE id = 1) AS restaurant_updated_at,
          (SELECT display_name FROM admin_profile WHERE id = 1) AS display_name,
          (SELECT updated_at FROM admin_profile WHERE id = 1) AS profile_updated_at,
          (SELECT COUNT(*)::int FROM admin_notifications WHERE read_at IS NULL) AS unread_notifications
      `);
      const row = rows[0] || {};
      setPrivateCache(res, 60, 300);
      return res.json({
        success: true,
        restaurant: row.restaurant_name == null ? null : {
          restaurant_name: row.restaurant_name,
          currency: row.currency,
          delivery_charge: row.delivery_charge,
          opening_hours: row.opening_hours,
          updated_at: row.restaurant_updated_at,
        },
        admin: row.display_name == null ? null : {
          display_name: row.display_name,
          username: req.admin.username,
          updated_at: row.profile_updated_at,
        },
        unread_notifications: row.unread_notifications || 0,
        integrations: {
          n8n_status_webhook_configured: Boolean(process.env.N8N_ADMIN_WEBHOOK_URL),
          database_connected: true,
        },
      });
    } catch (error) {
      console.error("Admin session error:", error);
      return res.status(500).json({ success: false, message: "Failed to load admin session" });
    }
  });

  app.get("/admin/activity", async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM admin_notifications WHERE read_at IS NULL) AS unread_notifications,
          (SELECT MAX(updated_at) FROM orders) AS orders_version,
          (SELECT MAX(GREATEST(created_at, COALESCE(resolved_at, created_at), COALESCE(last_notification_attempt_at, created_at))) FROM admin_requests) AS requests_version,
          (SELECT MAX(created_at) FROM feedback) AS feedback_version,
          (SELECT MAX(GREATEST(created_at, COALESCE(read_at, created_at))) FROM admin_notifications) AS notifications_version,
          (SELECT MAX(updated_at) FROM conversation_sessions) AS customers_version
      `);
      const activity = rows[0] || {};
      res.setHeader("Cache-Control", "private, no-store");
      res.vary("Authorization");
      return res.json({
        success: true,
        unread_notifications: activity.unread_notifications || 0,
        orders_version: activity.orders_version || null,
        requests_version: activity.requests_version || null,
        feedback_version: activity.feedback_version || null,
        notifications_version: activity.notifications_version || null,
        customers_version: activity.customers_version || null,
        dashboard_version: latestTimestamp(
          activity.orders_version,
          activity.requests_version,
          activity.feedback_version,
          activity.customers_version
        ),
      });
    } catch (error) {
      console.error("Admin activity error:", error);
      return res.status(500).json({ success: false, message: "Failed to load admin activity" });
    }
  });

  app.get("/admin/dashboard", async (req, res) => {
    const range = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const includeDetails = req.query.details === "true";
    try {
      const { rows } = await pool.query(`
          WITH bounds AS (
            SELECT
              (NOW() AT TIME ZONE 'Asia/Karachi')::date AS local_today,
              ((NOW() AT TIME ZONE 'Asia/Karachi')::date::timestamp AT TIME ZONE 'Asia/Karachi') AS today_start,
              (((NOW() AT TIME ZONE 'Asia/Karachi')::date - 1)::timestamp AT TIME ZONE 'Asia/Karachi') AS yesterday_start,
              (((NOW() AT TIME ZONE 'Asia/Karachi')::date + 1)::timestamp AT TIME ZONE 'Asia/Karachi') AS tomorrow_start,
              (((NOW() AT TIME ZONE 'Asia/Karachi')::date - ($1::int - 1))::timestamp AT TIME ZONE 'Asia/Karachi') AS activity_start
          ), stats AS (
            SELECT
              COUNT(*) FILTER (WHERE o.created_at >= b.today_start)::int AS today_orders,
              COALESCE(SUM(o.total) FILTER (WHERE o.created_at >= b.today_start AND o.status <> 'cancelled'), 0) AS today_revenue,
              COUNT(*) FILTER (WHERE o.created_at < b.today_start)::int AS previous_orders,
              COALESCE(SUM(o.total) FILTER (WHERE o.created_at < b.today_start AND o.status <> 'cancelled'), 0) AS previous_revenue
            FROM orders o CROSS JOIN bounds b
            WHERE o.created_at >= b.yesterday_start AND o.created_at < b.tomorrow_start
          ), statuses AS (
            SELECT status, COUNT(*)::int AS count
            FROM orders
            GROUP BY status
          ), days AS (
            SELECT generate_series(
              (SELECT local_today - ($1::int - 1) FROM bounds),
              (SELECT local_today FROM bounds),
              INTERVAL '1 day'
            )::date AS day
          ), activity AS (
            SELECT (o.created_at AT TIME ZONE 'Asia/Karachi')::date AS day,
              COUNT(*)::int AS orders,
              COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue
            FROM orders o CROSS JOIN bounds b
            WHERE o.created_at >= b.activity_start AND o.created_at < b.tomorrow_start
            GROUP BY (o.created_at AT TIME ZONE 'Asia/Karachi')::date
          )
          SELECT s.today_orders, s.today_revenue, s.previous_orders, s.previous_revenue,
            (SELECT COUNT(*)::int FROM admin_requests WHERE status = 'pending') AS pending_requests,
            (SELECT COUNT(DISTINCT customer_id)::int FROM conversation_sessions WHERE updated_at >= NOW() - INTERVAL '24 hours') AS active_customers,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('status', status, 'count', count) ORDER BY status) FROM statuses), '[]'::jsonb) AS status_counts,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'day', d.day,
                'orders', COALESCE(a.orders, 0),
                'revenue', COALESCE(a.revenue, 0)::text
              ) ORDER BY d.day)
              FROM days d LEFT JOIN activity a ON a.day = d.day
            ), '[]'::jsonb) AS activity,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(recent_order))
              FROM (
                SELECT o.id, o.items, o.order_type, o.total::text AS total, o.status, o.created_at,
                  c.name AS customer_name, c.whatsapp_phone AS customer_phone
                FROM orders o JOIN customers c ON c.id = o.customer_id
                ORDER BY o.created_at DESC LIMIT 6
              ) recent_order
            ), '[]'::jsonb) AS recent_orders,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(recent_request))
              FROM (
                SELECT r.id, r.request_type, r.question, r.status, r.created_at,
                  c.name AS customer_name, c.whatsapp_phone AS customer_phone, r.order_id
                FROM admin_requests r JOIN customers c ON c.id = r.customer_id
                WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 4
              ) recent_request
            ), '[]'::jsonb) AS recent_requests,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(recent_feedback))
              FROM (
                SELECT f.id, f.rating, f.message, f.created_at, f.order_id,
                  c.name AS customer_name, c.whatsapp_phone AS customer_phone
                FROM feedback f JOIN customers c ON c.id = f.customer_id
                ORDER BY f.created_at DESC LIMIT 4
              ) recent_feedback
            ), '[]'::jsonb) AS recent_feedback,
            CASE WHEN $2::boolean THEN COALESCE((
              SELECT jsonb_agg(to_jsonb(today_order) ORDER BY today_order.created_at DESC)
              FROM (
                SELECT o.id, o.items, o.order_type, o.delivery_address, o.total::text AS total,
                  o.status, o.created_at, c.id AS customer_id,
                  c.name AS customer_name, c.whatsapp_phone AS customer_phone
                FROM orders o
                JOIN customers c ON c.id = o.customer_id
                CROSS JOIN bounds b
                WHERE o.created_at >= b.today_start AND o.created_at < b.tomorrow_start
              ) today_order
            ), '[]'::jsonb) ELSE '[]'::jsonb END AS today_orders_detail,
            CASE WHEN $2::boolean THEN COALESCE((
              SELECT jsonb_agg(to_jsonb(pending_request) ORDER BY pending_request.created_at DESC)
              FROM (
                SELECT r.id, r.request_type, r.question, r.status, r.admin_note,
                  r.created_at, r.resolved_at, r.notification_sent, r.notification_error,
                  r.notification_attempts, r.last_notification_attempt_at,
                  c.id AS customer_id, c.name AS customer_name, c.whatsapp_phone AS customer_phone,
                  o.id AS order_id, o.status AS order_status, o.total AS order_total,
                  o.items AS order_items, o.delivery_address, o.order_type,
                  order_is_cancellable(o.status) AS order_cancellable,
                  latest_event.id AS notification_event_id,
                  latest_event.delivery_status AS notification_delivery_status,
                  latest_event.last_error AS event_notification_error
                FROM admin_requests r
                JOIN customers c ON c.id = r.customer_id
                LEFT JOIN orders o ON o.id = r.order_id
                LEFT JOIN LATERAL (
                  SELECT e.id, e.delivery_status, e.last_error
                  FROM customer_notification_events e
                  WHERE e.admin_request_id = r.id
                  ORDER BY e.created_at DESC, e.id DESC
                  LIMIT 1
                ) latest_event ON TRUE
                WHERE r.status = 'pending'
              ) pending_request
            ), '[]'::jsonb) ELSE '[]'::jsonb END AS pending_requests_detail,
            CASE WHEN $2::boolean THEN COALESCE((
              SELECT jsonb_agg(to_jsonb(active_customer) ORDER BY active_customer.last_activity DESC)
              FROM (
                SELECT c.id, c.name, c.whatsapp_phone, cs.updated_at AS last_activity,
                  cs.order_status AS conversation_status, cs.human_handoff, cs.awaiting_human,
                  COALESCE(order_stats.total_orders, 0)::int AS total_orders,
                  latest_order.id AS recent_order_id,
                  latest_order.status AS recent_order_status,
                  latest_order.created_at AS recent_order_at
                FROM conversation_sessions cs
                JOIN customers c ON c.id = cs.customer_id
                LEFT JOIN LATERAL (
                  SELECT COUNT(*)::int AS total_orders
                  FROM orders customer_order
                  WHERE customer_order.customer_id = c.id
                ) order_stats ON TRUE
                LEFT JOIN LATERAL (
                  SELECT customer_order.id, customer_order.status, customer_order.created_at
                  FROM orders customer_order
                  WHERE customer_order.customer_id = c.id
                  ORDER BY customer_order.created_at DESC
                  LIMIT 1
                ) latest_order ON TRUE
                WHERE cs.updated_at >= NOW() - INTERVAL '24 hours'
              ) active_customer
            ), '[]'::jsonb) ELSE '[]'::jsonb END AS active_customers_detail
          FROM stats s
        `, [range, includeDetails]);
      const aggregate = rows[0] || {};
      setPrivateCache(res, 5, 10);
      return res.json({
        success: true,
        stats: {
          today_orders: aggregate.today_orders || 0,
          today_revenue: String(aggregate.today_revenue || 0),
          previous_orders: aggregate.previous_orders || 0,
          previous_revenue: String(aggregate.previous_revenue || 0),
          pending_requests: aggregate.pending_requests || 0,
          active_customers: aggregate.active_customers || 0,
        },
        status_counts: aggregate.status_counts || [],
        activity: (aggregate.activity || []).map((point) => ({
          ...point,
          day: new Date(`${point.day}T00:00:00.000Z`).toISOString(),
          revenue: String(point.revenue || 0),
        })),
        recent_orders: (aggregate.recent_orders || []).map((order) => ({
          ...order,
          id: String(order.id),
          created_at: new Date(order.created_at).toISOString(),
        })),
        pending_requests: (aggregate.recent_requests || []).map((request) => ({
          ...request,
          id: String(request.id),
          order_id: request.order_id == null ? null : String(request.order_id),
          created_at: new Date(request.created_at).toISOString(),
        })),
        recent_feedback: (aggregate.recent_feedback || []).map((feedbackItem) => ({
          ...feedbackItem,
          id: String(feedbackItem.id),
          order_id: feedbackItem.order_id == null ? null : String(feedbackItem.order_id),
          created_at: new Date(feedbackItem.created_at).toISOString(),
        })),
        details: includeDetails ? {
          today_orders: (aggregate.today_orders_detail || []).map((order) => ({
            ...order,
            id: String(order.id),
            customer_id: String(order.customer_id),
            created_at: new Date(order.created_at).toISOString(),
          })),
          pending_requests: (aggregate.pending_requests_detail || []).map((request) => ({
            ...request,
            id: String(request.id),
            customer_id: String(request.customer_id),
            order_id: request.order_id == null ? null : String(request.order_id),
            notification_event_id: request.notification_event_id == null ? null : String(request.notification_event_id),
            created_at: new Date(request.created_at).toISOString(),
          })),
          active_customers: (aggregate.active_customers_detail || []).map((customer) => ({
            ...customer,
            id: String(customer.id),
            recent_order_id: customer.recent_order_id == null ? null : String(customer.recent_order_id),
            last_activity: new Date(customer.last_activity).toISOString(),
            recent_order_at: customer.recent_order_at ? new Date(customer.recent_order_at).toISOString() : null,
          })),
        } : undefined,
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
        WITH paged_customers AS MATERIALIZED (
          SELECT c.id, c.name, c.whatsapp_phone, c.preferred_language, c.created_at,
            latest.last_order, COUNT(*) OVER() AS total_count
          FROM customers c
          LEFT JOIN LATERAL (
            SELECT MAX(o.created_at) AS last_order
            FROM orders o
            WHERE o.customer_id = c.id
          ) latest ON TRUE
          ${where}
          ORDER BY latest.last_order DESC NULLS LAST, c.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        )
        SELECT c.id, c.name, c.whatsapp_phone, c.preferred_language, c.created_at,
          COALESCE(order_stats.total_orders, 0)::int AS total_orders,
          COALESCE(order_stats.total_spending, 0) AS total_spending,
          c.last_order,
          CASE WHEN c.last_order >= NOW() - INTERVAL '90 days' THEN 'active' ELSE 'inactive' END AS status,
          c.total_count
        FROM paged_customers c
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS total_orders,
            COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS total_spending
          FROM orders o
          WHERE o.customer_id = c.id
        ) order_stats ON TRUE
        ORDER BY c.last_order DESC NULLS LAST, c.created_at DESC
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
    const rating = req.query.rating === undefined || req.query.rating === "" ? null : Number(req.query.rating);
    if (rating !== null && ![0, 1, 2, 3, 4, 5].includes(rating)) {
      return res.status(400).json({ success: false, message: "Rating must be between 0 and 5" });
    }
    try {
      const params = [];
      const where = rating !== null ? (params.push(rating), `WHERE f.rating = $1`) : "";
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
          COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE rating = 5) / NULLIF(COUNT(rating), 0), 1), 0) AS five_star_percentage
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
    const hasRating = ratingValue !== undefined && ratingValue !== null && String(ratingValue).trim() !== "";
    const numericRating = hasRating ? Number(ratingValue) : null;
    const rating = hasRating && Number.isFinite(numericRating)
      ? Math.max(0, Math.min(5, Math.trunc(numericRating)))
      : null;
    const feedbackMessage = typeof message === "string" ? message.trim() : "";
    if (!customerId && !customerPhone) {
      return res.status(400).json({ success: false, message: "Customer is required" });
    }
    if (hasRating && !Number.isFinite(numericRating)) {
      return res.status(400).json({ success: false, message: "Rating must be numeric" });
    }
    if (rating === null && !feedbackMessage) {
      return res.status(400).json({ success: false, message: "A rating, feedback message, or both are required" });
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
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (order_id) WHERE order_id IS NOT NULL
        DO UPDATE SET
          rating = COALESCE(EXCLUDED.rating, feedback.rating),
          message = COALESCE(EXCLUDED.message, feedback.message)
        RETURNING *
      `, [resolvedCustomerId, orderId, rating, feedbackMessage || null]);
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
      const { rows } = await pool.query(`
        SELECT
          COALESCE((
            SELECT jsonb_agg(to_jsonb(menu_item) ORDER BY menu_item.sort_order, menu_item.name)
            FROM (
              SELECT i.id, i.category, i.item_type, i.name, i.description, i.active,
                i.is_popular, i.is_featured, i.sort_order,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'id', v.id, 'label', v.variant_label, 'price', v.price, 'quantity', v.quantity,
                  'unit', v.unit, 'active', v.active, 'sort_order', v.sort_order
                ) ORDER BY v.sort_order) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
              FROM restaurant_menu_items i
              LEFT JOIN restaurant_menu_variants v ON v.menu_item_id = i.id
              GROUP BY i.id
            ) menu_item
          ), '[]'::jsonb) AS items,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(deal) ORDER BY deal.sort_order, deal.name)
            FROM (
              SELECT id, category, name, description, price, unit, active,
                is_popular, is_featured, availability, sort_order
              FROM restaurant_deals
            ) deal
          ), '[]'::jsonb) AS deals,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(image) ORDER BY image.display_order, image.created_at DESC)
            FROM (
              SELECT id, name, mime_type, active, display_order, created_at
              FROM menu_images WHERE active = TRUE
            ) image
          ), '[]'::jsonb) AS images
      `);
      const menu = rows[0] || { items: [], deals: [], images: [] };
      setPrivateCache(res, 300, 600);
      return res.json({
        success: true,
        items: (menu.items || []).map((item) => ({ ...item, id: String(item.id) })),
        deals: (menu.deals || []).map((deal) => ({ ...deal, id: String(deal.id) })),
        images: (menu.images || []).map((image) => ({
          ...image,
          created_at: new Date(image.created_at).toISOString(),
          url: `/images/${image.id}`,
        })),
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

  app.delete("/admin/menu/images/:id", async (req, res) => {
    const imageId = Number(req.params.id);
    if (!Number.isInteger(imageId) || imageId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid image id" });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({ success: false, message: "Image deletion must be confirmed" });
    }
    try {
      const deletedImage = await deleteMenuImage(pool, imageId);
      if (!deletedImage) return res.status(404).json({ success: false, message: "Menu image not found" });
      return res.json({ success: true, deleted_image_id: String(deletedImage.id) });
    } catch (error) {
      console.error("Delete menu image error:", error);
      return res.status(500).json({ success: false, message: "Failed to delete menu image" });
    }
  });

  app.delete("/admin/menu", async (req, res) => {
    if (req.body?.confirmation !== "DELETE ENTIRE MENU") {
      return res.status(400).json({ success: false, message: "Enter DELETE ENTIRE MENU to confirm" });
    }
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const deleted = await deleteCanonicalMenuData(client);
      await client.query("COMMIT");
      return res.json({ success: true, deleted });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error("Delete entire menu error:", error);
      return res.status(500).json({ success: false, message: "Failed to delete the menu" });
    } finally {
      client?.release();
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
      setPrivateCache(res, 2, 5);
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
      const { rows } = await pool.query(`
        SELECT r.restaurant_name, r.currency, r.delivery_charge, r.opening_hours,
          r.updated_at AS restaurant_updated_at, p.display_name,
          p.updated_at AS profile_updated_at
        FROM restaurant_settings r
        CROSS JOIN admin_profile p
        WHERE r.id = 1 AND p.id = 1
      `);
      const row = rows[0] || {};
      setPrivateCache(res, 300, 600);
      return res.json({
        success: true,
        restaurant: row.restaurant_name == null ? null : {
          restaurant_name: row.restaurant_name,
          currency: row.currency,
          delivery_charge: row.delivery_charge,
          opening_hours: row.opening_hours,
          updated_at: row.restaurant_updated_at,
        },
        admin: row.display_name == null ? null : {
          display_name: row.display_name,
          username: req.admin.username,
          updated_at: row.profile_updated_at,
        },
        integrations: {
          n8n_status_webhook_configured: Boolean(process.env.N8N_ADMIN_WEBHOOK_URL),
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

module.exports = {
  createRequireAdminSession,
  registerAdminRoutes,
  ORDER_STATUSES,
};
