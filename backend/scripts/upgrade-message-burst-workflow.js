const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const workflowPath = path.resolve(__dirname, "../../workflow.json");

function upgradeMessageBurstWorkflow() {
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
    if (existing.webhookId && node.webhookId) node.webhookId = existing.webhookId;
    const prior = existing.parameters?.conditions?.conditions;
    const next = node.parameters?.conditions?.conditions;
    if (Array.isArray(prior) && Array.isArray(next)) {
      next.forEach((condition, conditionIndex) => {
        if (prior[conditionIndex]?.id) condition.id = prior[conditionIndex].id;
      });
    }
    workflow.nodes[index] = node;
  }

  const postgresCredentials = find("Insert Message to Buffer").credentials;

  find("Insert Message to Buffer").parameters.query = `WITH accepted AS (
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
    AND message_buffer.replied_at IS NULL
    AND message_buffer.received_at < NOW() - INTERVAL '10 minutes'
    AND (message_buffer.batch_claimed_at IS NULL
         OR message_buffer.batch_claimed_at < NOW() - INTERVAL '10 minutes')
  RETURNING id, message_id, received_at
)
SELECT
  EXISTS (SELECT 1 FROM accepted) AS accepted,
  (SELECT id::text FROM accepted) AS buffer_id,
  (SELECT message_id FROM accepted) AS message_id,
  (SELECT received_at FROM accepted) AS received_at;`;

  find("Claim Latest Customer Turn").parameters.query = `WITH serialized AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('customer-turn:' || $1::text, 0))
),
current_row AS MATERIALIZED (
  SELECT mb.*
  FROM message_buffer mb
  CROSS JOIN serialized
  WHERE mb.id = $2::bigint
    AND mb.customer_phone = $1::text
),
active_batch AS MATERIALIZED (
  SELECT EXISTS (
    SELECT 1
    FROM message_buffer mb
    CROSS JOIN serialized
    WHERE mb.customer_phone = $1::text
      AND mb.processed = FALSE
      AND mb.batch_key IS NOT NULL
      AND mb.batch_claimed_at >= NOW() - INTERVAL '10 minutes'
  ) AS present
),
pending AS MATERIALIZED (
  SELECT mb.*
  FROM message_buffer mb
  CROSS JOIN serialized
  WHERE mb.customer_phone = $1::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND (mb.batch_key IS NULL
         OR mb.batch_claimed_at < NOW() - INTERVAL '10 minutes')
),
latest_available AS (
  SELECT MAX(id) AS id FROM pending
),
quiet_state AS (
  SELECT COALESCE(MAX(received_at) <= NOW() - INTERVAL '2 seconds', FALSE) AS quiet
  FROM pending
),
decision AS (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM current_row WHERE processed = FALSE)
      THEN 'superseded'
    WHEN EXISTS (
      SELECT 1 FROM current_row
      WHERE batch_key IS NOT NULL
        AND batch_claimed_at >= NOW() - INTERVAL '10 minutes'
    )
      THEN 'superseded'
    WHEN (SELECT id FROM latest_available) IS DISTINCT FROM (SELECT id FROM current_row)
      THEN 'superseded'
    WHEN (SELECT present FROM active_batch)
      THEN 'busy'
    WHEN NOT (SELECT quiet FROM quiet_state)
      THEN 'busy'
    ELSE 'ready'
  END AS mode
),
recovery_anchor AS (
  SELECT COALESCE(batch_key, 'reply-row:' || id::text) AS recovery_key
  FROM pending
  WHERE replied_at IS NOT NULL
  ORDER BY replied_at, id
  LIMIT 1
),
candidate_messages AS MATERIALIZED (
  SELECT p.*
  FROM pending p
  WHERE (
      EXISTS (SELECT 1 FROM recovery_anchor)
      AND p.replied_at IS NOT NULL
      AND COALESCE(p.batch_key, 'reply-row:' || p.id::text) =
          (SELECT recovery_key FROM recovery_anchor)
    )
    OR (
      NOT EXISTS (SELECT 1 FROM recovery_anchor)
      AND p.replied_at IS NULL
    )
),
ranked_candidates AS (
  SELECT c.*,
         ROW_NUMBER() OVER (ORDER BY c.id) AS message_number,
         SUM(LEAST(CHAR_LENGTH(COALESCE(c.message_text, '')), 4096))
           OVER (ORDER BY c.id ROWS UNBOUNDED PRECEDING)
         + ROW_NUMBER() OVER (ORDER BY c.id) - 1 AS cumulative_characters
  FROM candidate_messages c
),
claimable AS MATERIALIZED (
  SELECT r.id
  FROM ranked_candidates r
  WHERE r.message_number <= 20
    AND (r.cumulative_characters <= 8192 OR r.message_number = 1)
),
claimed AS (
  UPDATE message_buffer mb
  SET batch_key = $3::text,
      batch_claimed_at = NOW()
  FROM claimable c
  WHERE mb.id = c.id
    AND (SELECT mode FROM decision) = 'ready'
  RETURNING mb.id, mb.message_id, mb.message_text, mb.received_at,
            mb.reply_text, mb.replied_at
),
safe_claimed AS (
  SELECT c.*,
         CASE
           WHEN CHAR_LENGTH(COALESCE(c.message_text, '')) > 4096
             THEN LEFT(COALESCE(c.message_text, ''), 4000)
                  || E'\\n[Message shortened for AI safety]'
           ELSE COALESCE(c.message_text, '')
         END AS safe_message_text
  FROM claimed c
)
SELECT d.mode,
       $3::text AS batch_key,
       (SELECT string_agg(c.safe_message_text, E'\\n' ORDER BY c.id) FROM safe_claimed c)
         AS combined_text,
       (SELECT COUNT(*)::int FROM safe_claimed) AS message_count,
       COALESCE((SELECT SUM(CHAR_LENGTH(c.safe_message_text))::int FROM safe_claimed c), 0)
         AS combined_character_count,
       (SELECT jsonb_agg(c.message_id ORDER BY c.id) FROM safe_claimed c) AS message_ids,
       COALESCE((
         SELECT COUNT(*) > 0 AND BOOL_AND(c.replied_at IS NOT NULL)
         FROM safe_claimed c
       ), FALSE) AS reply_already_sent,
       (SELECT c.reply_text
        FROM safe_claimed c
        WHERE c.replied_at IS NOT NULL
        ORDER BY c.id DESC
        LIMIT 1) AS stored_reply_text,
       (SELECT c.safe_message_text FROM safe_claimed c ORDER BY c.id DESC LIMIT 1)
         AS latest_text,
       (SELECT EXTRACT(EPOCH FROM (MAX(c.received_at) - MIN(c.received_at)))
        FROM safe_claimed c) AS batch_span_seconds,
       (SELECT COUNT(*)::int
        FROM pending p
        WHERE NOT EXISTS (SELECT 1 FROM claimable c WHERE c.id = p.id))
         AS queued_message_count,
       COALESCE((SELECT COUNT(*) FROM pending), 0)::int AS pending_message_count,
       COALESCE((SELECT COUNT(*) FROM pending), 0) > 20
         OR COALESCE((SELECT SUM(LEAST(CHAR_LENGTH(COALESCE(message_text, '')), 4096))
                      FROM pending), 0) > 8192 AS burst_limit_reached
FROM decision d;`;

  find("Finalize Customer Turn").parameters.query = `WITH appended AS (
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
  RETURNING mb.id, mb.message_id
),
messages_recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT bf.message_id, $5::text, NOW()
  FROM buffer_finalized bf
  WHERE bf.message_id IS NOT NULL
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
),
queue_state AS (
  SELECT COUNT(*)::int AS remaining
  FROM message_buffer mb
  WHERE mb.customer_phone = $5::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM buffer_finalized bf WHERE bf.id = mb.id)
)
SELECT
  EXISTS (SELECT 1 FROM session_updated) AS session_updated,
  (SELECT COUNT(*)::int FROM handoff_messages) AS handoff_messages_recorded,
  (SELECT COUNT(*)::int FROM buffer_finalized) AS buffered_messages_finalized,
  (SELECT COUNT(*)::int FROM messages_recorded) AS message_ids_recorded,
  (SELECT remaining FROM queue_state) AS queued_messages_remaining,
  CASE
    WHEN (SELECT remaining FROM queue_state) > 100 THEN 15
    WHEN (SELECT remaining FROM queue_state) > 20 THEN 5
    ELSE 2
  END AS queue_wait_seconds;`;

  find("Finalize Simple Reply").parameters.query = `WITH customer AS (
  INSERT INTO customers (whatsapp_phone, name, updated_at)
  VALUES ($1::text, NULLIF(BTRIM($2::text), ''), NOW())
  ON CONFLICT (whatsapp_phone) DO UPDATE SET
    name = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name), updated_at = NOW()
  RETURNING id
), session_updated AS (
  INSERT INTO conversation_sessions (customer_id, recent_messages, updated_at)
  SELECT id, jsonb_build_array(
    jsonb_build_object('role', 'customer', 'text', $3::text),
    jsonb_build_object('role', 'bot', 'text', $4::text)
  ), NOW()
  FROM customer
  ON CONFLICT (customer_id) DO UPDATE SET
  recent_messages = (
    SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb)
    FROM jsonb_array_elements(
      COALESCE(conversation_sessions.recent_messages, '[]'::jsonb)
      || EXCLUDED.recent_messages
    ) WITH ORDINALITY AS history(elem, idx)
    WHERE idx > jsonb_array_length(
      COALESCE(conversation_sessions.recent_messages, '[]'::jsonb)
      || EXCLUDED.recent_messages
    ) - 12
  ), updated_at = NOW()
  RETURNING id
), finalized AS (
  UPDATE message_buffer
  SET reply_text = $4::text, replied_at = NOW(), processed = TRUE, processed_at = NOW()
  WHERE customer_phone = $1::text AND batch_key = $5::text AND processed = FALSE
    AND EXISTS (SELECT 1 FROM session_updated)
  RETURNING id, message_id
), recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT message_id, $1::text, NOW() FROM finalized WHERE message_id IS NOT NULL
  ON CONFLICT (message_id) DO NOTHING RETURNING message_id
), queue_state AS (
  SELECT COUNT(*)::int AS remaining
  FROM message_buffer mb
  WHERE mb.customer_phone = $1::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM finalized f WHERE f.id = mb.id)
)
SELECT EXISTS (SELECT 1 FROM session_updated) AS session_updated,
       (SELECT COUNT(*)::int FROM finalized) AS messages_finalized,
       (SELECT COUNT(*)::int FROM recorded) AS ids_recorded,
       (SELECT remaining FROM queue_state) AS queued_messages_remaining,
       CASE
         WHEN (SELECT remaining FROM queue_state) > 100 THEN 15
         WHEN (SELECT remaining FROM queue_state) > 20 THEN 5
         ELSE 2
       END AS queue_wait_seconds;`;

  find("Record Active Human Handoff Turn").parameters.query = `WITH active_handoff AS (
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
  RETURNING mb.id, mb.message_id
),
messages_recorded AS (
  INSERT INTO processed_messages (message_id, customer_phone, processed_at)
  SELECT bf.message_id, $2::text, NOW()
  FROM buffer_finalized bf
  WHERE bf.message_id IS NOT NULL
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
),
queue_state AS (
  SELECT COUNT(*)::int AS remaining
  FROM message_buffer mb
  WHERE mb.customer_phone = $2::text
    AND mb.processed = FALSE
    AND mb.message_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM buffer_finalized bf WHERE bf.id = mb.id)
)
SELECT EXISTS (SELECT 1 FROM active_handoff)
         AND EXISTS (SELECT 1 FROM session_updated) AS handoff_active,
       (SELECT COUNT(*)::int FROM recorded) AS customer_messages_recorded,
       (SELECT COUNT(*)::int FROM buffer_finalized) AS buffered_messages_finalized,
       (SELECT COUNT(*)::int FROM messages_recorded) AS message_ids_recorded,
       (SELECT remaining FROM queue_state) AS queued_messages_remaining,
       CASE
         WHEN (SELECT remaining FROM queue_state) > 100 THEN 15
         WHEN (SELECT remaining FROM queue_state) > 20 THEN 5
         ELSE 2
       END AS queue_wait_seconds;`;

  upsert({
    id: crypto.randomUUID(),
    name: "Queued Customer Messages?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [3290, 1220],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
        conditions: [{
          id: crypto.randomUUID(),
          leftValue: "={{ Number($json.queued_messages_remaining || 0) > 0 }}",
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
    name: "Throttle Queued Customer Messages",
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position: [3510, 1160],
    parameters: {
      amount: "={{ Math.max(2, Number($json.queue_wait_seconds || 2)) }}",
    },
    webhookId: crypto.randomUUID(),
  });

  workflow.connections["Finalize Customer Turn"] = {
    main: [[edge("Queued Customer Messages?")]],
  };
  workflow.connections["Finalize Simple Reply"] = {
    main: [[edge("Queued Customer Messages?")]],
  };
  workflow.connections["Human Handoff Turn Recorded?"] = {
    main: [[edge("Queued Customer Messages?")], [edge("Awaiting Feedback Response?")]],
  };
  workflow.connections["Queued Customer Messages?"] = {
    main: [[edge("Throttle Queued Customer Messages")], []],
  };
  workflow.connections["Throttle Queued Customer Messages"] = {
    main: [[edge("Claim Latest Customer Turn")]],
  };

  workflow.versionId = crypto.randomUUID();
  fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  console.log(
    `Updated ${path.basename(workflowPath)} with customer-specific burst limits, queue draining, and safer turn recovery.`,
  );
}

if (require.main === module) {
  upgradeMessageBurstWorkflow();
}

module.exports = { upgradeMessageBurstWorkflow };
