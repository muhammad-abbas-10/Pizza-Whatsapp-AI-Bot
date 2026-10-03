const DEFAULT_TIMEOUT_MS = 15000;

function safeError(value, fallback = "n8n webhook request failed") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim();
  return text.slice(0, 1000) || fallback;
}

function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    request_id: row.request_id,
    event_type: row.event_type,
    order_id: row.order_id,
    order_status: row.order_status,
    decision: row.decision,
    conversation_message_id: row.conversation_message_id || null,
    delivery_status: row.delivery_status,
    attempts: Number(row.attempts || 0),
    provider_message_id: row.provider_message_id || null,
    last_error: row.last_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sent_at: row.sent_at || null,
  };
}

async function loadCustomerNotificationEvent(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT id, request_id, event_type, order_id, order_status, decision, conversation_message_id,
            delivery_status, attempts, provider_message_id, last_error,
            created_at, updated_at, sent_at
     FROM customer_notification_events
     WHERE id = $1`,
    [eventId]
  );
  return rows[0] || null;
}

async function markDispatchFailure(pool, eventId, error) {
  await pool.query(
    `UPDATE customer_notification_events
     SET delivery_status = 'failed',
         last_error = CASE
           -- n8n may have already recorded the provider/node failure before
           -- its webhook response was replaced by a gateway error. Preserve
           -- that more useful error instead of overwriting it with HTML.
           WHEN delivery_status = 'failed' AND NULLIF(BTRIM(last_error), '') IS NOT NULL
             THEN last_error
           ELSE $2
         END,
         claim_token = NULL,
         claimed_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND delivery_status IN ('pending', 'failed')`,
    [eventId, safeError(error)]
  );
}

/**
 * Ask n8n to deliver one already-persisted event.  The payload intentionally
 * contains no phone number or customer-supplied message.  n8n must claim the
 * row and load the authoritative order/customer relationship from Postgres.
 */
async function dispatchCustomerNotificationEvent(
  pool,
  eventId,
  {
    fetchImpl = global.fetch,
    webhookUrl = process.env.N8N_ADMIN_WEBHOOK_URL,
    timeoutMs = Number(process.env.N8N_ADMIN_WEBHOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const event = await loadCustomerNotificationEvent(pool, eventId);
  if (!event) return { accepted: false, lifecycle: "not_found", event: null };
  if (event.delivery_status === "sent") {
    return { accepted: true, lifecycle: "duplicate", event: publicEvent(event) };
  }
  if (event.delivery_status === "superseded") {
    return { accepted: true, lifecycle: "superseded", event: publicEvent(event) };
  }

  if (!webhookUrl) {
    await markDispatchFailure(pool, eventId, "N8N_ADMIN_WEBHOOK_URL is not configured");
    return {
      accepted: false,
      lifecycle: "failed",
      event: publicEvent(await loadCustomerNotificationEvent(pool, eventId)),
    };
  }

  let response;
  let responseBody = {};
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event: "customer_notification",
        source: "admin_dashboard",
        event_id: event.id,
        request_id: event.request_id,
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 30000))),
    });
    const raw = await response.text();
    if (raw) {
      try {
        responseBody = JSON.parse(raw);
      } catch {
        responseBody = {
          message: /^\s*<!doctype html|^\s*<html/i.test(raw)
            ? `n8n webhook returned HTTP ${response.status}`
            : raw.slice(0, 1000),
        };
      }
    }
  } catch (error) {
    // A timeout can be ambiguous: n8n may already have claimed the event.  Do
    // not overwrite processing/sent state; mark only rows that are still safe
    // to retry.  The persistent lease in n8n handles a crashed execution.
    await markDispatchFailure(pool, eventId, error?.name === "TimeoutError" ? "n8n webhook timed out" : error?.message);
    const current = await loadCustomerNotificationEvent(pool, eventId);
    return {
      accepted: current?.delivery_status === "processing" || current?.delivery_status === "sent",
      lifecycle: current?.delivery_status || "failed",
      event: publicEvent(current),
    };
  }

  if (!response.ok) {
    await markDispatchFailure(
      pool,
      eventId,
      responseBody.message || responseBody.error || `n8n webhook returned HTTP ${response.status}`
    );
  }

  let current = await loadCustomerNotificationEvent(pool, eventId);
  if (response.ok && current?.delivery_status === "pending") {
    await markDispatchFailure(
      pool,
      eventId,
      responseBody.message || responseBody.error || "n8n did not claim the persisted notification event"
    );
    current = await loadCustomerNotificationEvent(pool, eventId);
  }
  const lifecycle = current?.delivery_status || responseBody.lifecycle || "failed";
  return {
    accepted: response.ok && ["processing", "sent", "superseded"].includes(lifecycle),
    lifecycle,
    webhook_status: response.status,
    event: publicEvent(current),
  };
}

module.exports = {
  dispatchCustomerNotificationEvent,
  loadCustomerNotificationEvent,
  markDispatchFailure,
  publicEvent,
  safeError,
};
