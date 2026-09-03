const fs = require("fs");
const path = require("path");

const workflowPath = path.resolve(__dirname, "../../admin request.json");
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

const postgresCredentials = workflow.nodes.find((node) => node.credentials?.postgres)?.credentials;
const whatsappCredentials = workflow.nodes.find((node) => node.credentials?.whatsAppApi)?.credentials;

function findNode(name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  if (!node) throw new Error(`Workflow node not found: ${name}`);
  return node;
}

function findNodeAny(...names) {
  const node = workflow.nodes.find((entry) => names.includes(entry.name));
  if (!node) throw new Error(`Workflow node not found: ${names.join(" or ")}`);
  return node;
}

function upsertNode(node) {
  const index = workflow.nodes.findIndex((entry) => entry.name === node.name);
  if (index === -1) workflow.nodes.push(node);
  else workflow.nodes[index] = node;
}

function postgresNode(name, id, position, query, queryReplacement) {
  return {
    parameters: {
      operation: "executeQuery",
      query,
      options: queryReplacement ? { queryReplacement } : {},
    },
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.7,
    position,
    id,
    name,
    credentials: postgresCredentials,
  };
}

function ifNode(name, id, position, leftValue, type = "boolean", operation = "true") {
  const operator = type === "boolean"
    ? { type, operation, singleValue: true }
    : { type, operation };
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
        conditions: [{ id, leftValue, rightValue: "", operator }],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.3,
    position,
    id,
    name,
  };
}

function setNode(name, id, position, assignments) {
  return {
    parameters: { assignments: { assignments }, options: {} },
    type: "n8n-nodes-base.set",
    typeVersion: 3.5,
    position,
    id,
    name,
  };
}

function whatsappNode(name, id, position, recipientPhoneNumber, textBody) {
  return {
    parameters: {
      operation: "send",
      phoneNumberId: "={{ $('Workflow Configuration').item.json.whatsapp_phone_number_id }}",
      recipientPhoneNumber,
      textBody,
      additionalFields: {},
    },
    type: "n8n-nodes-base.whatsApp",
    typeVersion: 1.1,
    position,
    id,
    name,
    credentials: whatsappCredentials,
  };
}

const acceptCustomerSql = `WITH accepted AS (
  INSERT INTO message_buffer (
    message_id, customer_phone, message_text, message_type, received_at,
    processed, batch_key, batch_claimed_at, processed_at
  )
  SELECT $1::text, $2::text, $3::text, $4::text, NOW(), FALSE, NULL, NULL, NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM processed_messages WHERE message_id = $1::text
  )
  ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO UPDATE
  SET received_at = NOW(),
      message_text = EXCLUDED.message_text,
      message_type = EXCLUDED.message_type,
      batch_key = NULL,
      batch_claimed_at = NULL
  WHERE message_buffer.processed = FALSE
    AND message_buffer.received_at < NOW() - INTERVAL '5 minutes'
    AND (message_buffer.batch_claimed_at IS NULL
         OR message_buffer.batch_claimed_at < NOW() - INTERVAL '5 minutes')
  RETURNING id, message_id, received_at
)
SELECT
  EXISTS (SELECT 1 FROM accepted) AS accepted,
  (SELECT id::text FROM accepted) AS buffer_id,
  (SELECT message_id FROM accepted) AS message_id,
  (SELECT received_at FROM accepted) AS received_at;`;

const claimCustomerTurnSql = `WITH serialized AS (
  SELECT pg_advisory_xact_lock(hashtextextended('customer-turn:' || $1::text, 0))
),
current_row AS (
  SELECT mb.*
  FROM message_buffer mb
  CROSS JOIN serialized
  WHERE mb.id = $2::bigint
    AND mb.customer_phone = $1::text
),
active_batch AS (
  SELECT EXISTS (
    SELECT 1
    FROM message_buffer mb
    WHERE mb.customer_phone = $1::text
      AND mb.processed = FALSE
      AND mb.batch_key IS NOT NULL
      AND mb.batch_claimed_at >= NOW() - INTERVAL '5 minutes'
  ) AS present
),
latest_available AS (
  SELECT MAX(mb.id) AS id
  FROM message_buffer mb
  WHERE mb.customer_phone = $1::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND (mb.batch_key IS NULL
         OR mb.batch_claimed_at < NOW() - INTERVAL '5 minutes')
),
decision AS (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM current_row WHERE processed = FALSE) THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM current_row WHERE batch_key IS NOT NULL) THEN 'superseded'
    WHEN (SELECT present FROM active_batch) THEN 'busy'
    WHEN (SELECT id FROM latest_available) IS DISTINCT FROM (SELECT id FROM current_row) THEN 'superseded'
    ELSE 'ready'
  END AS mode
),
claimed AS (
  UPDATE message_buffer mb
  SET batch_key = $3::text,
      batch_claimed_at = NOW()
  WHERE mb.customer_phone = $1::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND (mb.batch_key IS NULL
         OR mb.batch_claimed_at < NOW() - INTERVAL '5 minutes')
    AND (SELECT mode FROM decision) = 'ready'
  RETURNING mb.id, mb.message_id, mb.message_text, mb.received_at
)
SELECT
  d.mode,
  $3::text AS batch_key,
  (SELECT string_agg(c.message_text, E'\\n' ORDER BY c.id) FROM claimed c) AS combined_text,
  (SELECT COUNT(*)::int FROM claimed) AS message_count,
  (SELECT jsonb_agg(c.message_id ORDER BY c.id) FROM claimed c) AS message_ids
FROM decision d;`;

const finalizeCustomerSql = `WITH appended AS (
  SELECT COALESCE(recent_messages, '[]'::jsonb)
         || jsonb_build_array(
              jsonb_build_object('role', 'customer', 'text', $2::text),
              jsonb_build_object('role', 'bot', 'text', $3::text)
            ) AS msgs
  FROM conversation_sessions
  WHERE customer_id = $1::bigint
  FOR UPDATE
),
trimmed AS (
  SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb) AS msgs
  FROM appended,
       LATERAL jsonb_array_elements(appended.msgs) WITH ORDINALITY AS t(elem, idx)
  WHERE idx > (SELECT jsonb_array_length(msgs) FROM appended) - 12
),
session_updated AS (
  UPDATE conversation_sessions cs
  SET recent_messages = (SELECT msgs FROM trimmed),
      updated_at = NOW()
  WHERE cs.customer_id = $1::bigint
  RETURNING cs.id
),
buffer_finalized AS (
  UPDATE message_buffer mb
  SET processed = TRUE,
      processed_at = NOW()
  WHERE mb.customer_phone = $5::text
    AND mb.batch_key = $4::text
    AND mb.processed = FALSE
    AND EXISTS (SELECT 1 FROM session_updated)
  RETURNING mb.message_id
),
messages_recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT bf.message_id, $5::text, NOW()
  FROM buffer_finalized bf
  WHERE bf.message_id IS NOT NULL
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT
  EXISTS (SELECT 1 FROM session_updated) AS session_updated,
  (SELECT COUNT(*)::int FROM buffer_finalized) AS buffered_messages_finalized,
  (SELECT COUNT(*)::int FROM messages_recorded) AS message_ids_recorded;`;

const claimAdminSql = `WITH claimed AS (
  INSERT INTO admin_message_claims (message_id, admin_phone, message_text, status, claimed_at)
  SELECT $1::text, $2::text, $3::text, 'processing', NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM processed_messages WHERE message_id = $1::text
  )
  ON CONFLICT (message_id) DO UPDATE
  SET claimed_at = NOW(),
      admin_phone = EXCLUDED.admin_phone,
      message_text = EXCLUDED.message_text,
      status = 'processing',
      processed_at = NULL
  WHERE admin_message_claims.status <> 'processed'
    AND admin_message_claims.claimed_at < NOW() - INTERVAL '5 minutes'
  RETURNING message_id, admin_phone, message_text
)
SELECT
  EXISTS (SELECT 1 FROM claimed) AS should_process,
  COALESCE((SELECT message_id FROM claimed), $1::text) AS message_id,
  COALESCE((SELECT admin_phone FROM claimed), $2::text) AS admin_phone,
  COALESCE((SELECT message_text FROM claimed), $3::text) AS message_text;`;

const resolveAdminSql = `WITH input AS (
  SELECT
    $1::bigint AS request_id,
    $2::text AS decision,
    NULLIF(BTRIM($3::text), '') AS admin_note,
    $4::text AS admin_phone,
    $5::text AS admin_message_id
),
locked_request AS MATERIALIZED (
  SELECT r.*
  FROM admin_requests r
  JOIN input i ON i.request_id = r.id
  FOR UPDATE OF r
),
locked_order AS MATERIALIZED (
  SELECT o.*
  FROM orders o
  JOIN locked_request r ON r.order_id = o.id
  FOR UPDATE OF o
),
request_context AS (
  SELECT
    r.id, r.customer_id, r.order_id, r.request_type,
    r.status AS request_status, r.admin_note AS existing_admin_note,
    r.notification_sent, r.notification_message_id,
    r.notification_claim_token, r.notification_claimed_at,
    o.status AS order_status, o.customer_id AS order_customer_id,
    c.whatsapp_phone AS customer_phone,
    c.preferred_language,
    i.decision, i.admin_note, i.admin_phone, i.admin_message_id
  FROM locked_request r
  JOIN input i ON TRUE
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN locked_order o ON o.id = r.order_id
),
eligibility AS (
  SELECT rc.*,
    CASE
      WHEN rc.request_status <> 'pending' THEN 'already_' || rc.request_status
      WHEN rc.decision NOT IN ('approved', 'denied') THEN 'invalid_decision'
      WHEN rc.request_type <> 'cancel_order' THEN 'unsupported_request_type'
      WHEN rc.decision = 'denied' THEN 'denied'
      WHEN rc.order_id IS NULL OR rc.order_status IS NULL
        OR rc.order_customer_id IS DISTINCT FROM rc.customer_id THEN 'invalid_order_link'
      WHEN rc.order_status NOT IN ('received', 'preparing', 'out_for_delivery', 'cancelled')
        THEN 'order_not_cancellable'
      ELSE 'approved'
    END AS outcome
  FROM request_context rc
),
order_cancelled AS (
  UPDATE orders o
  SET status = 'cancelled', updated_at = NOW()
  FROM eligibility e
  WHERE e.outcome = 'approved'
    AND o.id = e.order_id
    AND o.status IN ('received', 'preparing', 'out_for_delivery')
  RETURNING o.id
),
request_resolved AS (
  UPDATE admin_requests r
  SET status = e.decision,
      admin_note = e.admin_note,
      resolved_at = NOW(),
      resolved_by_phone = e.admin_phone,
      resolved_by_message_id = e.admin_message_id,
      notification_claim_token = CASE WHEN e.notification_sent THEN NULL ELSE e.admin_message_id END,
      notification_claimed_at = CASE WHEN e.notification_sent THEN NULL ELSE NOW() END
  FROM eligibility e
  WHERE r.id = e.id
    AND e.request_status = 'pending'
    AND (
      e.outcome = 'denied'
      OR (e.outcome = 'approved'
          AND (e.order_status = 'cancelled' OR EXISTS (SELECT 1 FROM order_cancelled)))
    )
  RETURNING r.id, r.status, r.customer_id, r.order_id, r.admin_note,
            r.notification_claim_token, r.notification_claimed_at
),
notification_reclaimed AS (
  UPDATE admin_requests r
  SET notification_claim_token = e.admin_message_id,
      notification_claimed_at = NOW()
  FROM eligibility e
  WHERE r.id = e.id
    AND e.request_status IN ('approved', 'denied')
    AND e.notification_sent = FALSE
    AND (e.notification_claim_token IS NULL
         OR e.notification_claimed_at < NOW() - INTERVAL '5 minutes')
  RETURNING r.id, r.notification_claim_token, r.notification_claimed_at
),
session_updated AS (
  UPDATE conversation_sessions cs
  SET awaiting_human = EXISTS (
        SELECT 1 FROM admin_requests pending
        WHERE pending.customer_id = rr.customer_id
          AND pending.status = 'pending'
          AND pending.id <> rr.id
      ),
      order_status = CASE
        WHEN rr.status = 'approved' AND cs.active_order_id = rr.order_id THEN 'cancelled'
        ELSE cs.order_status
      END,
      updated_at = NOW()
  FROM request_resolved rr
  WHERE cs.customer_id = rr.customer_id
  RETURNING cs.id
),
result AS (
  SELECT
    i.request_id,
    COALESCE(e.id, 0) AS matched_request_id,
    COALESCE(rr.status, e.request_status) AS final_status,
    COALESCE(
      CASE WHEN rr.id IS NOT NULL THEN rr.status END,
      e.outcome,
      'not_found'
    ) AS outcome,
    e.order_id,
    e.customer_phone,
    e.preferred_language,
    COALESCE(rr.admin_note, e.existing_admin_note) AS admin_note,
    COALESCE(e.notification_sent, FALSE) AS notification_sent,
    COALESCE(rr.notification_claim_token, nr.notification_claim_token, e.notification_claim_token) AS notification_claim_token,
    i.admin_message_id
  FROM input i
  LEFT JOIN eligibility e ON TRUE
  LEFT JOIN request_resolved rr ON rr.id = e.id
  LEFT JOIN notification_reclaimed nr ON nr.id = e.id
)
SELECT
  request_id::text AS request_id,
  NULLIF(matched_request_id, 0)::text AS matched_request_id,
  order_id::text AS order_id,
  outcome,
  final_status,
  customer_phone,
  notification_sent,
  (final_status IN ('approved', 'denied')
    AND customer_phone IS NOT NULL
    AND notification_sent = FALSE
    AND notification_claim_token = admin_message_id) AS notify_customer,
  CASE
    WHEN final_status = 'approved' AND lower(COALESCE(preferred_language, '')) IN ('ur', 'urdu', 'roman_urdu')
      THEN 'Aap ki cancellation request #' || request_id || ' approve ho gayi hai. Order #' || order_id || ' cancel kar diya gaya hai. ✅'
    WHEN final_status = 'approved'
      THEN 'Your cancellation request #' || request_id || ' has been approved. Order #' || order_id || ' is cancelled. ✅'
    WHEN final_status = 'denied' AND lower(COALESCE(preferred_language, '')) IN ('ur', 'urdu', 'roman_urdu')
      THEN 'Aap ki cancellation request #' || request_id || ' approve nahi ho saki. Order #' || order_id || ' active rahega.'
    WHEN final_status = 'denied'
      THEN 'Your cancellation request #' || request_id || ' was denied. Order #' || order_id || ' remains active.'
    ELSE NULL
  END || CASE WHEN admin_note IS NOT NULL THEN E'\\n\\nAdmin note: ' || admin_note ELSE '' END AS customer_reply,
  CASE outcome
    WHEN 'approved' THEN 'Request #' || request_id || ' approved; order #' || order_id || ' cancelled.'
    WHEN 'denied' THEN 'Request #' || request_id || ' denied; order #' || order_id || ' was not changed.'
    WHEN 'already_approved' THEN 'Request #' || request_id || ' was already approved. No duplicate update was made.'
    WHEN 'already_denied' THEN 'Request #' || request_id || ' was already denied. No duplicate update was made.'
    WHEN 'not_found' THEN 'Request #' || request_id || ' was not found.'
    WHEN 'invalid_order_link' THEN 'Request #' || request_id || ' has no valid linked order and was not changed.'
    WHEN 'order_not_cancellable' THEN 'Order #' || COALESCE(order_id::text, '?') || ' can no longer be cancelled; request #' || request_id || ' was not changed.'
    WHEN 'unsupported_request_type' THEN 'Request #' || request_id || ' is not a supported cancellation request.'
    ELSE 'Request #' || request_id || ' could not be resolved (' || outcome || ').'
  END AS admin_reply
FROM result;`;

const recordNotificationSql = `WITH updated AS (
  UPDATE admin_requests
  SET notification_sent = TRUE,
      notification_error = NULL,
      notification_attempts = notification_attempts + 1,
      last_notification_attempt_at = NOW(),
      notification_message_id = $2::text,
      notification_claim_token = NULL,
      notification_claimed_at = NULL
  WHERE id = $1::bigint
    AND status IN ('approved', 'denied')
    AND notification_sent = FALSE
    AND notification_claim_token = $3::text
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM updated) AS notification_recorded;`;

const finalizeAdminSql = `WITH claim_updated AS (
  UPDATE admin_message_claims
  SET status = 'processed', processed_at = NOW()
  WHERE message_id = $1::text
    AND admin_phone = $2::text
  RETURNING message_id
),
recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT message_id, $2::text, NOW() FROM claim_updated
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT
  EXISTS (SELECT 1 FROM claim_updated) AS claim_finalized,
  EXISTS (SELECT 1 FROM recorded) AS message_recorded;`;

upsertNode(postgresNode(
  "Insert Message to Buffer",
  "5ab781d5-5c17-4e68-9503-fa4c760c07fb",
  [256, 304],
  acceptCustomerSql,
  "={{ [ $('Normalize Incoming Message').item.json.message_id, $('Normalize Incoming Message').item.json.customer_phone, $('Normalize Incoming Message').item.json.message_text, $('Normalize Incoming Message').item.json.message_type ] }}",
));

const debounce = findNodeAny("Debounce Customer Messages", "Wait");
debounce.name = "Debounce Customer Messages";
debounce.position = [512, 304];

upsertNode(postgresNode(
  "Claim Latest Customer Turn",
  "139e86c5-f308-4489-89a5-3a0832dd699b",
  [704, 304],
  claimCustomerTurnSql,
  "={{ [ $('Normalize Incoming Message').item.json.customer_phone, $('Insert Message to Buffer').item.json.buffer_id, $('Normalize Incoming Message').item.json.message_id ] }}",
));

upsertNode(ifNode(
  "Customer Turn Ready",
  "65867f6f-3f7b-424f-bec6-7d58c0175bf0",
  [928, 304],
  "={{ $json.mode === 'ready' }}",
));

upsertNode(ifNode(
  "Customer Message Accepted",
  "3f311593-acde-482d-9175-5bb50fa69eca",
  [384, 304],
  "={{ $json.accepted }}",
));

upsertNode(ifNode(
  "Customer Turn Busy",
  "53f8b8f3-67f7-4dba-9079-4570a18686df",
  [1120, 432],
  "={{ $json.mode === 'busy' }}",
));

upsertNode({
  parameters: { amount: 10 },
  type: "n8n-nodes-base.wait",
  typeVersion: 1.1,
  position: [1312, 432],
  id: "18a00c42-b438-4f73-bbea-f7e12c39fd9b",
  name: "Wait For Active Customer Turn",
  webhookId: "68ed6f0c-bc8c-433f-9405-66dc994a56f8",
});

const upsertCustomer = findNode("Upsert Customer and Session");
upsertCustomer.position = [1120, 160];

const agent = findNode("Pizza Ordering Agent");
agent.parameters.text = "=Customer's new message: \"{{ $('Claim Latest Customer Turn').item.json.combined_text }}\"";
agent.parameters.options.systemMessage = agent.parameters.options.systemMessage.replace(
  "Customer's new message: \"{{ $('Normalize Incoming Message').item.json.message_text }}\"",
  "Customer's new message(s), combined oldest-first: \"{{ $('Claim Latest Customer Turn').item.json.combined_text }}\"",
);

const persist = findNodeAny("Finalize Customer Turn", "Persist Conversation Turn");
persist.parameters.query = finalizeCustomerSql;
persist.parameters.options.queryReplacement = "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Claim Latest Customer Turn').item.json.combined_text || '', $('Reply Text').item.json.reply_text || '', $('Claim Latest Customer Turn').item.json.batch_key, $('Normalize Incoming Message').item.json.customer_phone ] }}";
persist.name = "Finalize Customer Turn";

const notifyAdmin = findNode("Notify Admin");
notifyAdmin.parameters.phoneNumberId = "={{ $('Workflow Configuration').item.json.whatsapp_phone_number_id }}";
notifyAdmin.parameters.recipientPhoneNumber = "={{ $('Workflow Configuration').item.json.admin_phone }}";
notifyAdmin.parameters.toolDescription = "Send a WhatsApp alert to the configured restaurant admin. For a cancellation, call Request Cancellation Approval first and only continue when admin_notification_allowed=true. Pass its returned admin_message verbatim so the alert always contains request/order ids and the exact APPROVE <request_id> or DENY <request_id> command format. Never alert the admin when validation failed or the customer must clarify which order.";

for (const name of ["Send message", "Send Menu Image 1", "Send Menu Image 2"]) {
  findNode(name).parameters.phoneNumberId = "={{ $('Workflow Configuration').item.json.whatsapp_phone_number_id }}";
}

const cancellationTool = findNode("Request Cancellation Approval");
cancellationTool.parameters.query = cancellationTool.parameters.query.replace(
  "    ELSE NULL\n  END AS error;",
  "    ELSE NULL\n  END AS error,\n  CASE\n    WHEN COALESCE((SELECT id FROM ins), (SELECT id FROM existing)) IS NOT NULL THEN\n      'Cancellation request #' || COALESCE((SELECT id FROM ins), (SELECT id FROM existing)) ||\n      ' for order #' || (SELECT id FROM candidate_order) || '. ' || $4::text || E'\\nReply exactly: APPROVE ' ||\n      COALESCE((SELECT id FROM ins), (SELECT id FROM existing)) || ' [optional note] or DENY ' ||\n      COALESCE((SELECT id FROM ins), (SELECT id FROM existing)) || ' [optional reason].'\n    ELSE NULL\n  END AS admin_message;",
);
cancellationTool.parameters.toolDescription = "Create or reuse a pending cancellation request before notifying the admin. Use an exact order_id only when the customer stated it. If admin_notification_allowed=true, call Notify Admin and pass the returned admin_message verbatim. If multiple_cancellable_orders is returned, ask which order and do not notify. For any other error, explain it without claiming a request was created.";

upsertNode(postgresNode(
  "Claim Admin Message",
  "1a0ba7e7-3275-4f5a-ab7b-ea37f86c3a82",
  [256, -224],
  claimAdminSql,
  "={{ [ $('Normalize Incoming Message').item.json.message_id, $('Normalize Incoming Message').item.json.customer_phone, $('Normalize Incoming Message').item.json.message_text ] }}",
));

upsertNode(ifNode(
  "Admin Message Claimed",
  "a8a52f29-a246-4215-b5f6-c9a41b8694c5",
  [464, -224],
  "={{ $json.should_process }}",
));

upsertNode({
  parameters: {
    mode: "runOnceForAllItems",
    jsCode: `return $input.all().map((item) => {
  const text = String(item.json.message_text || '').trim();
  const match = /^(APPROVE|DENY)\\s+([1-9]\\d{0,17})(?:\\s+([\\s\\S]{1,2000}))?$/i.exec(text);
  return {
    json: {
      ...item.json,
      command_valid: Boolean(match),
      decision: match ? (match[1].toUpperCase() === 'APPROVE' ? 'approved' : 'denied') : null,
      request_id: match ? match[2] : null,
      admin_note: match && match[3] ? match[3].trim() : '',
    },
  };
});`,
  },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [672, -224],
  id: "a4381daf-a0b3-4f96-bf8a-91e08c236bbe",
  name: "Parse Admin Command",
});

upsertNode(ifNode(
  "Admin Command Valid",
  "9866284a-e780-417c-99c8-3db8dd37d950",
  [880, -224],
  "={{ $json.command_valid }}",
));

upsertNode(postgresNode(
  "Resolve Admin Request",
  "bc14aa96-a1fb-4342-bd2c-66757d488123",
  [1088, -352],
  resolveAdminSql,
  "={{ [ $('Parse Admin Command').item.json.request_id, $('Parse Admin Command').item.json.decision, $('Parse Admin Command').item.json.admin_note, $('Normalize Incoming Message').item.json.customer_phone, $('Normalize Incoming Message').item.json.message_id ] }}",
));

upsertNode(ifNode(
  "Customer Notification Required",
  "cb0e43c9-f011-4489-bb0f-8a181b5df5b8",
  [1296, -352],
  "={{ $json.notify_customer }}",
));

upsertNode(whatsappNode(
  "Send Admin Decision to Customer",
  "a684a82e-1128-4379-8f0f-df2e5ae1cd2a",
  [1504, -464],
  "={{ $('Resolve Admin Request').item.json.customer_phone }}",
  "={{ $('Resolve Admin Request').item.json.customer_reply }}",
));

upsertNode(postgresNode(
  "Record Customer Decision Notification",
  "c5853bf2-fc41-4f4c-9706-8361358822e6",
  [1712, -464],
  recordNotificationSql,
  "={{ [ $('Resolve Admin Request').item.json.request_id, $json.messages?.[0]?.id || null, $('Normalize Incoming Message').item.json.message_id ] }}",
));

upsertNode(setNode(
  "Build Admin Decision Reply",
  "e2b39971-bb52-4472-a9e5-b08b96b20caa",
  [1920, -352],
  [{ id: "4eb49387-eb17-45ca-90af-41baf6106b0b", name: "admin_reply", value: "={{ $('Resolve Admin Request').item.json.admin_reply }}", type: "string" }],
));

upsertNode(setNode(
  "Build Admin Help Reply",
  "16047f57-6f86-4511-a3fe-52c4886a00fd",
  [1088, -96],
  [{ id: "53e479cb-0545-46f0-bef8-4b8ac3e535f0", name: "admin_reply", value: "Admin command not recognized. Use APPROVE <request_id> [optional note] or DENY <request_id> [optional reason]. Example: APPROVE 27", type: "string" }],
));

upsertNode(whatsappNode(
  "Send Admin Reply",
  "dd7cd148-a0de-42c5-8865-e4f3217c64e1",
  [2128, -224],
  "={{ $('Normalize Incoming Message').item.json.customer_phone }}",
  "={{ $json.admin_reply }}",
));

upsertNode(postgresNode(
  "Finalize Admin Message",
  "287b74ea-fb92-4d75-ae17-860799bd94fe",
  [2336, -224],
  finalizeAdminSql,
  "={{ [ $('Normalize Incoming Message').item.json.message_id, $('Normalize Incoming Message').item.json.customer_phone ] }}",
));

workflow.nodes = workflow.nodes.filter((node) => ![
  "Combine and Mark Processed",
  "Check If Latest",
  "If",
].includes(node.name));

function edge(node, index = 0) {
  return { node, type: "main", index };
}

const aiConnections = Object.fromEntries(
  Object.entries(workflow.connections).filter(([, value]) => value.ai_tool || value.ai_languageModel),
);

workflow.connections = {
  ...aiConnections,
  "WhatsApp Trigger": { main: [[edge("Normalize Incoming Message")]] },
  "Normalize Incoming Message": { main: [[edge("Is Supported Text Message")]] },
  "Is Supported Text Message": { main: [[edge("Workflow Configuration")], []] },
  "Workflow Configuration": { main: [[edge("Is Authorized Admin")]] },
  "Is Authorized Admin": { main: [[edge("Claim Admin Message")], [edge("Insert Message to Buffer")]] },

  "Insert Message to Buffer": { main: [[edge("Customer Message Accepted")]] },
  "Customer Message Accepted": { main: [[edge("Debounce Customer Messages")], []] },
  "Debounce Customer Messages": { main: [[edge("Claim Latest Customer Turn")]] },
  "Claim Latest Customer Turn": { main: [[edge("Customer Turn Ready")]] },
  "Customer Turn Ready": { main: [[edge("Upsert Customer and Session")], [edge("Customer Turn Busy")]] },
  "Customer Turn Busy": { main: [[edge("Wait For Active Customer Turn")], []] },
  "Wait For Active Customer Turn": { main: [[edge("Claim Latest Customer Turn")]] },
  "Upsert Customer and Session": { main: [[edge("Load Active Menu")]] },
  "Load Active Menu": { main: [[edge("Get Restaurant Settings")]] },
  "Get Restaurant Settings": { main: [[edge("Pizza Ordering Agent")]] },
  "Pizza Ordering Agent": { main: [[edge("Reply Text")]] },
  "Reply Text": { main: [[edge("Send message")]] },
  "Send message": { main: [[edge("Finalize Customer Turn")]] },

  "Claim Admin Message": { main: [[edge("Admin Message Claimed")]] },
  "Admin Message Claimed": { main: [[edge("Parse Admin Command")], []] },
  "Parse Admin Command": { main: [[edge("Admin Command Valid")]] },
  "Admin Command Valid": { main: [[edge("Resolve Admin Request")], [edge("Build Admin Help Reply")]] },
  "Resolve Admin Request": { main: [[edge("Customer Notification Required")]] },
  "Customer Notification Required": { main: [[edge("Send Admin Decision to Customer")], [edge("Build Admin Decision Reply")]] },
  "Send Admin Decision to Customer": { main: [[edge("Record Customer Decision Notification")]] },
  "Record Customer Decision Notification": { main: [[edge("Build Admin Decision Reply")]] },
  "Build Admin Decision Reply": { main: [[edge("Send Admin Reply")]] },
  "Build Admin Help Reply": { main: [[edge("Send Admin Reply")]] },
  "Send Admin Reply": { main: [[edge("Finalize Admin Message")]] },
};

workflow.name = "Pizza WhatsApp - Customer and Admin Router";
workflow.active = false;
workflow.versionId = "a703d8d3-bfb1-41d4-86e8-8f3fb55bec23";
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Upgraded ${workflowPath} (${workflow.nodes.length} nodes).`);
