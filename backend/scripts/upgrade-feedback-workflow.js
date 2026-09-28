const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseFeedback } = require("../src/feedback-parser");
const { detectMessageLanguage } = require("../src/message-language");

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
  if (index === -1) workflow.nodes.push(node);
  else {
    const existing = workflow.nodes[index];
    node.id = existing.id;
    const existingConditions = existing.parameters?.conditions?.conditions;
    const nextConditions = node.parameters?.conditions?.conditions;
    if (Array.isArray(existingConditions) && Array.isArray(nextConditions)) {
      nextConditions.forEach((condition, conditionIndex) => {
        if (existingConditions[conditionIndex]?.id) condition.id = existingConditions[conditionIndex].id;
      });
    }
    workflow.nodes[index] = node;
  }
}

const postgresCredentials = find("Upsert Customer and Session").credentials;

const upsertSession = find("Upsert Customer and Session");
if (!upsertSession.parameters.query.includes("session.awaiting_feedback_order_id")) {
  upsertSession.parameters.query = upsertSession.parameters.query
    .replace(
      "    session.active_order_id,\n    active_order.status AS active_order_status,",
      "    session.active_order_id,\n    session.awaiting_feedback_order_id,\n    active_order.status AS active_order_status,"
    );
}

upsert({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ Boolean($('Upsert Customer and Session').item.json.awaiting_feedback_order_id) }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
  type: "n8n-nodes-base.if",
  typeVersion: 2.3,
  position: [880, 1024],
  id: crypto.randomUUID(),
  name: "Awaiting Feedback Response?",
});

upsert({
  parameters: {
    jsCode: `${parseFeedback.toString()}\nconst parsed = parseFeedback($('Claim Latest Customer Turn').item.json.combined_text);\nreturn [{ json: { ...$input.first().json, feedback_rating: parsed.rating, feedback_message: parsed.message } }];`,
  },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [1120, 976],
  id: crypto.randomUUID(),
  name: "Parse Feedback Response",
});

upsert({
  parameters: {
    operation: "executeQuery",
    query: `WITH locked_session AS (
  SELECT cs.customer_id, cs.awaiting_feedback_order_id AS order_id
  FROM conversation_sessions cs
  JOIN orders o
    ON o.id = cs.awaiting_feedback_order_id
   AND o.customer_id = cs.customer_id
   AND o.status = 'completed'
  WHERE cs.customer_id = $1::bigint
    AND cs.awaiting_feedback_order_id = $2::bigint
  FOR UPDATE OF cs
), saved AS (
  INSERT INTO feedback (customer_id, order_id, rating, message)
  SELECT customer_id, order_id, $3::smallint, NULLIF(BTRIM($4::text), '')
  FROM locked_session
  WHERE $3::smallint IS NOT NULL OR NULLIF(BTRIM($4::text), '') IS NOT NULL
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL
  DO UPDATE SET
    rating = COALESCE(EXCLUDED.rating, feedback.rating),
    message = COALESCE(EXCLUDED.message, feedback.message)
  RETURNING id, customer_id, order_id, rating, message, created_at
)
SELECT *, TRUE AS feedback_saved FROM saved;`,
    options: {
      queryReplacement: "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Upsert Customer and Session').item.json.awaiting_feedback_order_id, $('Parse Feedback Response').item.json.feedback_rating, $('Parse Feedback Response').item.json.feedback_message ] }}",
    },
  },
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.7,
  position: [1360, 976],
  id: crypto.randomUUID(),
  name: "Save Customer Feedback",
  credentials: postgresCredentials,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 1000,
  notes: "Parameterized, idempotent upsert against the existing feedback table. A database failure stops the branch before any thank-you is sent.",
});

upsert({
  parameters: {
    jsCode: `${detectMessageLanguage.toString()}
const session = $('Upsert Customer and Session').item.json || {};
const source = String($('Claim Latest Customer Turn').item.json.latest_text || $('Claim Latest Customer Turn').item.json.combined_text || '');
const language = detectMessageLanguage(source, session.recent_messages);
const replies = {
  english: 'Thank you for your feedback! ❤️🍕 We really appreciate it.',
  roman_urdu: 'Aap ke feedback ka bohat shukriya! ❤️🍕 Hum iski bohat qadar karte hain.',
  urdu: 'آپ کی رائے کا بہت شکریہ! ❤️🍕 ہم واقعی اس کی قدر کرتے ہیں۔',
  pashto: 'ستاسو د نظر څخه مننه! ❤️🍕 موږ یې ډېر قدر کوو.',
};
return [{ json: { ...$input.first().json, reply_text: replies[language] || replies.english, response_language: language } }];`,
  },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [1600, 976],
  id: crypto.randomUUID(),
  name: "Build Feedback Thank You",
});

const safeMessage = find("Build Safe Admin Customer Message");
if (!safeMessage.parameters.jsCode.includes("const feedbackRequests =")) {
  safeMessage.parameters.jsCode = safeMessage.parameters.jsCode.replace(
  "const fallback = messages[meaning] || english[meaning];",
  `const fallback = messages[meaning] || english[meaning];
const feedbackRequests = {
  english: '⭐ Rate your experience out of 5, and if you like, tell us what you enjoyed or how we can improve. You can send a rating, feedback, or both.',
  roman_urdu: '⭐ Apna experience 5 mein se rate karein. Agar chahein to batayein kya acha laga ya hum kya behtar kar sakte hain. Rating, feedback, ya dono bhej sakte hain.',
  urdu: '⭐ اپنے تجربے کو 5 میں سے ریٹ کریں۔ اگر چاہیں تو بتائیں کیا اچھا لگا یا ہم کیا بہتر کر سکتے ہیں۔ آپ ریٹنگ، رائے، یا دونوں بھیج سکتے ہیں۔',
  pashto: '⭐ خپله تجربه له 5 څخه درجه کړئ. که وغواړئ، راته ووایئ څه مو خوښ شول یا موږ څه ښه کولی شو. درجه، نظر، یا دواړه رالېږلی شئ.',
};`
).replace(
  "return [{ json: { ...event, customer_message: safe ? raw : fallback, ai_fallback_used: !safe } }];",
  `const statusMessage = safe ? raw : fallback;
const customerMessage = meaning === 'completed'
  ? statusMessage + '\\n\\n' + feedbackRequests[language]
  : statusMessage;
return [{ json: { ...event, customer_message: customerMessage, ai_fallback_used: !safe } }];`
  );
}

const claimEvent = find("Claim Admin Customer Event");
if (!claimEvent.parameters.query.includes("c.feedback_requested_at IS NOT NULL")) {
  claimEvent.parameters.query = claimEvent.parameters.query
    .replace(
      "o.status AS current_order_status,",
      "o.status AS current_order_status, o.feedback_requested_at,"
    )
    .replace(
      "    AND c.event_type = 'order_status_update'\n    AND c.order_status IS DISTINCT FROM c.current_order_status",
      `    AND (
      (c.event_type = 'order_status_update' AND c.order_status IS DISTINCT FROM c.current_order_status)
      OR (c.event_type = 'order_status_update' AND c.order_status = 'completed' AND c.feedback_requested_at IS NOT NULL)
    )`
    );
}

const recordEvent = find("Record Admin Event Result");
recordEvent.parameters.query = `WITH event_updated AS (
  UPDATE customer_notification_events
  SET delivery_status = CASE WHEN $3::boolean THEN 'sent' ELSE 'failed' END,
      provider_message_id = CASE WHEN $3::boolean THEN $4::text ELSE provider_message_id END,
      last_error = CASE WHEN $3::boolean THEN NULL ELSE LEFT(COALESCE(NULLIF($5::text, ''), 'Evolution API send failed'), 1000) END,
      sent_at = CASE WHEN $3::boolean THEN NOW() ELSE sent_at END,
      claim_token = NULL,
      claimed_at = NULL,
      updated_at = NOW()
  WHERE id = $1::bigint
    AND delivery_status = 'processing'
    AND claim_token = $2::text
  RETURNING id AS event_id, request_id, event_type, order_id, customer_id,
            order_status, delivery_status AS lifecycle, attempts,
            provider_message_id, last_error, sent_at
), order_marked AS (
  UPDATE orders o
  SET feedback_requested_at = COALESCE(o.feedback_requested_at, NOW()),
      updated_at = NOW()
  FROM event_updated e
  WHERE o.id = e.order_id
    AND o.customer_id = e.customer_id
    AND e.event_type = 'order_status_update'
    AND e.order_status = 'completed'
    AND e.lifecycle = 'sent'
  RETURNING o.id
), feedback_state AS (
  UPDATE conversation_sessions cs
  SET awaiting_feedback_order_id = e.order_id,
      updated_at = NOW()
  FROM event_updated e
  WHERE cs.customer_id = e.customer_id
    AND e.event_type = 'order_status_update'
    AND e.order_status = 'completed'
    AND e.lifecycle = 'sent'
    AND EXISTS (SELECT 1 FROM order_marked WHERE id = e.order_id)
    AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.order_id = e.order_id)
  RETURNING cs.id
)
SELECT event_id, request_id, lifecycle, attempts, provider_message_id,
       last_error, sent_at,
       EXISTS (SELECT 1 FROM feedback_state) AS awaiting_feedback
FROM event_updated;`;

const finalizeTurn = find("Finalize Customer Turn");
if (!finalizeTurn.parameters.query.includes("awaiting_feedback_order_id = CASE")) {
  finalizeTurn.parameters.query = finalizeTurn.parameters.query.replace(
    "  SET recent_messages = (SELECT msgs FROM trimmed),\n      updated_at = NOW()",
    `  SET recent_messages = (SELECT msgs FROM trimmed),
      awaiting_feedback_order_id = CASE
        WHEN EXISTS (
          SELECT 1 FROM feedback f
          WHERE f.order_id = cs.awaiting_feedback_order_id
            AND f.customer_id = cs.customer_id
        ) THEN NULL
        ELSE cs.awaiting_feedback_order_id
      END,
      updated_at = NOW()`
  );
}

workflow.connections["Recover Reply Before Routing"].main[1] = [edge("Awaiting Feedback Response?")];
workflow.connections["Awaiting Feedback Response?"] = {
  main: [[edge("Parse Feedback Response")], [edge("Route Simple Messages")]],
};
workflow.connections["Parse Feedback Response"] = { main: [[edge("Save Customer Feedback")]] };
workflow.connections["Save Customer Feedback"] = { main: [[edge("Build Feedback Thank You")]] };
workflow.connections["Build Feedback Thank You"] = { main: [[edge("Reply Text")]] };

workflow.versionId = crypto.randomUUID();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Updated ${path.basename(workflowPath)} for post-delivery feedback (${workflow.nodes.length} nodes).`);
