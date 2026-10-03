const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const workflowPath = path.resolve(__dirname, "../../workflow.json");
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

function find(name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  if (!node) throw new Error(`Missing workflow node: ${name}`);
  return node;
}

function edge(node, index = 0) {
  return { node, type: "main", index };
}

function upsert(node) {
  const index = workflow.nodes.findIndex((entry) => entry.name === node.name);
  if (index === -1) {
    workflow.nodes.push(node);
    return;
  }
  const existing = workflow.nodes[index];
  node.id = existing.id;
  const prior = existing.parameters?.conditions?.conditions;
  const next = node.parameters?.conditions?.conditions;
  if (Array.isArray(prior) && Array.isArray(next)) {
    next.forEach((condition, conditionIndex) => {
      if (prior[conditionIndex]?.id) condition.id = prior[conditionIndex].id;
    });
  }
  workflow.nodes[index] = node;
}

const postgresCredentials = find("Upsert Customer and Session").credentials;

const finalize = find("Finalize Customer Turn");
finalize.parameters.query = `WITH appended AS (
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
      awaiting_feedback_order_id = CASE
        WHEN EXISTS (
          SELECT 1 FROM feedback f
          WHERE f.order_id = cs.awaiting_feedback_order_id
            AND f.customer_id = cs.customer_id
        ) THEN NULL
        ELSE cs.awaiting_feedback_order_id
      END,
      updated_at = NOW()
  WHERE cs.customer_id = $1::bigint
  RETURNING cs.id
),
active_handoff AS (
  SELECT r.id AS handoff_request_id, cs.customer_id
  FROM conversation_sessions cs
  JOIN admin_requests r
    ON r.customer_id = cs.customer_id
   AND r.request_type = 'human_handoff'
   AND r.status = 'pending'
  WHERE cs.customer_id = $1::bigint
    AND cs.awaiting_human = TRUE
  ORDER BY r.id DESC
  LIMIT 1
),
handoff_messages AS (
  INSERT INTO conversation_messages (
    customer_id, handoff_request_id, direction, message_text,
    source_message_id, delivery_status, sent_at
  )
  SELECT h.customer_id, h.handoff_request_id, 'customer', mb.message_text,
         mb.message_id, 'received', NULL
  FROM message_buffer mb
  CROSS JOIN active_handoff h
  WHERE mb.customer_phone = $5::text
    AND mb.batch_key = $4::text
    AND mb.processed = FALSE
  UNION ALL
  SELECT h.customer_id, h.handoff_request_id, 'bot', $3::text,
         'bot:' || $4::text, 'sent', NOW()
  FROM active_handoff h
  WHERE NULLIF(BTRIM($3::text), '') IS NOT NULL
  ON CONFLICT (source_message_id) DO NOTHING
  RETURNING id
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
  (SELECT COUNT(*)::int FROM handoff_messages) AS handoff_messages_recorded,
  (SELECT COUNT(*)::int FROM buffer_finalized) AS buffered_messages_finalized,
  (SELECT COUNT(*)::int FROM messages_recorded) AS message_ids_recorded;`;

upsert({
  id: crypto.randomUUID(),
  name: "Human Handoff Active?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [1150, 480],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ Boolean($('Upsert Customer and Session').item.json.awaiting_human) }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
});

upsert({
  id: crypto.randomUUID(),
  name: "Record Active Human Handoff Turn",
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.6,
  position: [1370, 410],
  parameters: {
    operation: "executeQuery",
    query: `WITH active_handoff AS (
  SELECT r.id AS handoff_request_id, cs.customer_id
  FROM conversation_sessions cs
  JOIN admin_requests r
    ON r.customer_id = cs.customer_id
   AND r.request_type = 'human_handoff'
   AND r.status = 'pending'
  WHERE cs.customer_id = $1::bigint
    AND cs.awaiting_human = TRUE
  ORDER BY r.id DESC
  LIMIT 1
  FOR UPDATE OF cs, r
),
incoming AS (
  SELECT mb.id, mb.message_id, mb.message_text
  FROM message_buffer mb
  WHERE mb.customer_phone = $2::text
    AND mb.batch_key = $3::text
    AND mb.processed = FALSE
  ORDER BY mb.id
),
recorded AS (
  INSERT INTO conversation_messages (
    customer_id, handoff_request_id, direction, message_text,
    source_message_id, delivery_status
  )
  SELECT h.customer_id, h.handoff_request_id, 'customer', i.message_text,
         i.message_id, 'received'
  FROM incoming i
  CROSS JOIN active_handoff h
  ON CONFLICT (source_message_id) DO NOTHING
  RETURNING id
),
session_updated AS (
  UPDATE conversation_sessions cs
  SET recent_messages = (
        SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb)
        FROM jsonb_array_elements(
          COALESCE(cs.recent_messages, '[]'::jsonb)
          || COALESCE((
            SELECT jsonb_agg(jsonb_build_object('role', 'customer', 'text', i.message_text) ORDER BY i.id)
            FROM incoming i
          ), '[]'::jsonb)
        ) WITH ORDINALITY AS history(elem, idx)
        WHERE idx > jsonb_array_length(
          COALESCE(cs.recent_messages, '[]'::jsonb)
          || COALESCE((
            SELECT jsonb_agg(jsonb_build_object('role', 'customer', 'text', i.message_text) ORDER BY i.id)
            FROM incoming i
          ), '[]'::jsonb)
        ) - 12
      ),
      updated_at = NOW()
  FROM active_handoff h
  WHERE cs.customer_id = h.customer_id
  RETURNING cs.id
),
buffer_finalized AS (
  UPDATE message_buffer mb
  SET processed = TRUE, processed_at = NOW()
  WHERE mb.customer_phone = $2::text
    AND mb.batch_key = $3::text
    AND mb.processed = FALSE
    AND EXISTS (SELECT 1 FROM session_updated)
  RETURNING mb.message_id
),
messages_recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT bf.message_id, $2::text, NOW()
  FROM buffer_finalized bf
  WHERE bf.message_id IS NOT NULL
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT EXISTS (SELECT 1 FROM active_handoff)
         AND EXISTS (SELECT 1 FROM session_updated) AS handoff_active,
       (SELECT COUNT(*)::int FROM recorded) AS customer_messages_recorded,
       (SELECT COUNT(*)::int FROM buffer_finalized) AS buffered_messages_finalized,
       (SELECT COUNT(*)::int FROM messages_recorded) AS message_ids_recorded;`,
    options: {
      queryReplacement: "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Normalize Incoming Message').item.json.customer_phone, $('Claim Latest Customer Turn').item.json.batch_key ] }}",
    },
  },
  credentials: postgresCredentials,
});

upsert({
  id: crypto.randomUUID(),
  name: "Human Handoff Turn Recorded?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [1600, 410],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ $json.handoff_active }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
});

const claim = find("Claim Admin Customer Event");
claim.parameters.query = `WITH candidate AS MATERIALIZED (
  SELECT e.*, o.items, o.order_type, o.total, o.status AS current_order_status, o.feedback_requested_at,
         c.name AS customer_name, c.whatsapp_phone AS customer_phone,
         c.preferred_language,
         COALESCE(cs.recent_messages, '[]'::jsonb) AS recent_messages,
         cm.message_text AS staff_message
  FROM customer_notification_events e
  LEFT JOIN orders o ON o.id = e.order_id AND o.customer_id = e.customer_id
  JOIN customers c ON c.id = e.customer_id
  LEFT JOIN conversation_sessions cs ON cs.customer_id = e.customer_id
  LEFT JOIN conversation_messages cm ON cm.id = e.conversation_message_id
  WHERE e.id = $1::bigint AND e.request_id = $2::text
  FOR UPDATE OF e
),
superseded AS (
  UPDATE customer_notification_events e
  SET delivery_status = 'superseded',
      last_error = NULL,
      claim_token = NULL,
      claimed_at = NULL,
      updated_at = NOW()
  FROM candidate c
  WHERE e.id = c.id
    AND (
      (c.event_type = 'order_status_update' AND c.order_status IS DISTINCT FROM c.current_order_status)
      OR (c.event_type = 'order_status_update' AND c.order_status = 'completed' AND c.feedback_requested_at IS NOT NULL)
    )
    AND (
      c.delivery_status IN ('pending', 'failed')
      OR (c.delivery_status = 'processing' AND c.claimed_at < NOW() - INTERVAL '2 minutes')
    )
  RETURNING e.id
),
claimed AS (
  UPDATE customer_notification_events e
  SET delivery_status = 'processing',
      attempts = e.attempts + 1,
      claim_token = $3::text,
      claimed_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  FROM candidate c
  WHERE e.id = c.id
    AND NOT EXISTS (SELECT 1 FROM superseded)
    AND (
      c.delivery_status IN ('pending', 'failed')
      OR (c.delivery_status = 'processing' AND c.claimed_at < NOW() - INTERVAL '2 minutes')
    )
  RETURNING e.id, e.claim_token, e.attempts
)
SELECT
  c.id AS event_id,
  c.request_id,
  c.event_type,
  c.order_id,
  c.customer_id,
  c.order_status,
  c.decision,
  c.admin_note,
  c.items,
  c.order_type,
  c.total,
  c.customer_name,
  c.customer_phone,
  c.preferred_language,
  c.recent_messages,
  c.staff_message,
  COALESCE(claimed.claim_token, c.claim_token) AS claim_token,
  claimed.id IS NOT NULL AS should_send,
  CASE
    WHEN c.id IS NULL THEN 'not_found'
    WHEN superseded.id IS NOT NULL THEN 'superseded'
    WHEN claimed.id IS NOT NULL THEN 'processing'
    WHEN c.delivery_status = 'sent' THEN 'duplicate'
    WHEN c.delivery_status = 'superseded' THEN 'superseded'
    ELSE 'processing'
  END AS lifecycle
FROM (SELECT 1) seed
LEFT JOIN candidate c ON TRUE
LEFT JOIN superseded ON superseded.id = c.id
LEFT JOIN claimed ON claimed.id = c.id;`;

upsert({
  id: crypto.randomUUID(),
  name: "Staff Message Event?",
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [1260, 1110],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ $json.event_type === 'staff_message' }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
});

const safeAdminMessage = find("Build Safe Admin Customer Message");
safeAdminMessage.parameters.jsCode = `const event = $('Claim Admin Customer Event').item.json;
if (event.event_type === 'staff_message') {
  // This text was validated by the authenticated dashboard and is loaded back
  // from PostgreSQL. Do not run it through an AI model or alter its meaning.
  const customerMessage = String(event.staff_message || '').trim();
  return [{ json: { ...event, customer_message: customerMessage, ai_fallback_used: false } }];
}

${safeAdminMessage.parameters.jsCode.replace("const event = $('Claim Admin Customer Event').item.json;\n", "")}`;

workflow.connections["Recover Reply Before Routing"] = {
  main: [[edge("Reply Already Sent For This Batch")], [edge("Human Handoff Active?")]],
};
workflow.connections["Human Handoff Active?"] = {
  main: [[edge("Record Active Human Handoff Turn")], [edge("Awaiting Feedback Response?")]],
};
workflow.connections["Record Active Human Handoff Turn"] = {
  main: [[edge("Human Handoff Turn Recorded?")]],
};
workflow.connections["Human Handoff Turn Recorded?"] = {
  main: [[], [edge("Awaiting Feedback Response?")]],
};
workflow.connections["Admin Event Claimed"] = {
  main: [[edge("Staff Message Event?")], [edge("Respond Admin Event Not Claimed")]],
};
workflow.connections["Staff Message Event?"] = {
  main: [[edge("Build Safe Admin Customer Message")], [edge("Admin Customer Message Agent")]],
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Updated ${path.basename(workflowPath)} with durable two-way human handoff handling.`);

// Human-handoff upgrades replace turn-finalization SQL. Re-apply the burst
// hardening so running this older feature upgrader cannot remove queue draining.
require("./upgrade-message-burst-workflow").upgradeMessageBurstWorkflow();
