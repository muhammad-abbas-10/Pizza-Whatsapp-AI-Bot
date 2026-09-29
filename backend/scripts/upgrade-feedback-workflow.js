const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseFeedback } = require("../src/feedback-parser");
const { FEEDBACK_WINDOW_MS, classifyPendingFeedback, hasRecentFeedbackRequest } = require("../src/feedback-intent");
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

if (!upsertSession.parameters.query.includes("awaiting_feedback_requested_at")) {
  upsertSession.parameters.query = upsertSession.parameters.query
    .replace(
      "  session.awaiting_feedback_order_id,\n  active_order.status AS active_order_status,",
      "  session.awaiting_feedback_order_id,\n  feedback_order.feedback_requested_at AS awaiting_feedback_requested_at,\n  active_order.status AS active_order_status,"
    )
    .replace(
      "LEFT JOIN orders active_order ON active_order.id = session.active_order_id;",
      "LEFT JOIN orders active_order ON active_order.id = session.active_order_id\nLEFT JOIN orders feedback_order ON feedback_order.id = session.awaiting_feedback_order_id;"
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
    jsCode: `const FEEDBACK_WINDOW_MS = ${FEEDBACK_WINDOW_MS};
${hasRecentFeedbackRequest.toString()}
${parseFeedback.toString()}
${classifyPendingFeedback.toString()}
const session = $('Upsert Customer and Session').item.json || {};
const source = String($('Claim Latest Customer Turn').item.json.combined_text || '');
const classification = classifyPendingFeedback(source, {
  requestedAt: session.awaiting_feedback_requested_at,
});
return [{ json: {
  ...$input.first().json,
  feedback_intent: classification.intent,
  feedback_window_open: classification.feedbackWindowOpen,
  feedback_is_complaint: classification.isComplaint,
} }];`,
  },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [1120, 1088],
  id: crypto.randomUUID(),
  name: "Classify Pending Feedback Intent",
  notes: "A feedback invitation is non-blocking. Only a clear rating/review is saved; orders, questions, and delivery problems keep their normal paths.",
});

upsert({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ ['feedback', 'feedback_complaint'].includes($json.feedback_intent) }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
  type: "n8n-nodes-base.if",
  typeVersion: 2.3,
  position: [1360, 1088],
  id: crypto.randomUUID(),
  name: "Feedback Submission?",
});

upsert({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ ['complaint', 'feedback_complaint'].includes($('Classify Pending Feedback Intent').item.json.feedback_intent) }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
  type: "n8n-nodes-base.if",
  typeVersion: 2.3,
  position: [1840, 1088],
  id: crypto.randomUUID(),
  name: "Feedback Complaint?",
});

upsert({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
      conditions: [{
        id: crypto.randomUUID(),
        leftValue: "={{ $('Classify Pending Feedback Intent').item.json.feedback_intent === 'feedback_complaint' }}",
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
      combinator: "and",
    },
    options: {},
  },
  type: "n8n-nodes-base.if",
  typeVersion: 2.3,
  position: [1840, 896],
  id: crypto.randomUUID(),
  name: "Saved Feedback Is Complaint?",
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
    operation: "executeQuery",
    query: `WITH cleared AS (
  UPDATE conversation_sessions
  SET awaiting_feedback_order_id = NULL,
      updated_at = NOW()
  WHERE customer_id = $1::bigint
    AND awaiting_feedback_order_id = $2::bigint
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM cleared) AS feedback_prompt_dismissed;`,
    options: {
      queryReplacement: "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Upsert Customer and Session').item.json.awaiting_feedback_order_id ] }}",
    },
  },
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.7,
  position: [2080, 1184],
  id: crypto.randomUUID(),
  name: "Dismiss Pending Feedback Request",
  credentials: postgresCredentials,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 1000,
  notes: "A normal customer request dismisses the optional feedback prompt so it cannot capture future messages.",
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
),
escalated AS (
  UPDATE conversation_sessions cs
  SET awaiting_human = TRUE,
      awaiting_feedback_order_id = NULL,
      updated_at = NOW()
  FROM locked_session ls
  WHERE cs.customer_id = ls.customer_id
  RETURNING cs.customer_id, ls.order_id
),
created AS (
  INSERT INTO admin_requests (customer_id, order_id, request_type, question)
  SELECT e.customer_id, e.order_id, 'human_handoff',
         'Post-delivery customer issue for order #' || e.order_id || ': ' ||
         LEFT(COALESCE(NULLIF(BTRIM($3::text), ''), 'Customer reported a delivery or service issue.'), 1500)
  FROM escalated e
  ON CONFLICT (customer_id) WHERE request_type = 'human_handoff' AND status = 'pending' DO NOTHING
  RETURNING id, customer_id, order_id
),
request_record AS (
  SELECT id, customer_id, order_id FROM created
  UNION ALL
  SELECT r.id, r.customer_id, r.order_id
  FROM admin_requests r
  WHERE r.customer_id = $1::bigint
    AND r.request_type = 'human_handoff'
    AND r.status = 'pending'
  ORDER BY id DESC
  LIMIT 1
),
notified AS (
  INSERT INTO admin_notifications (
    notification_type, title, source_key, request_id, order_id, customer_id, message, created_at
  )
  SELECT 'customer_request', 'Post-delivery customer issue #' || rr.id,
         'human_handoff:' || rr.id, rr.id, rr.order_id, rr.customer_id,
         LEFT(COALESCE(NULLIF(BTRIM($3::text), ''), 'Customer reported a delivery or service issue.'), 1500), NOW()
  FROM request_record rr
  ON CONFLICT (source_key) DO UPDATE
    SET message = EXCLUDED.message, read_at = NULL
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM escalated) AS awaiting_human,
       (SELECT id FROM request_record) AS request_id,
       EXISTS (SELECT 1 FROM created) AS request_created,
       EXISTS (SELECT 1 FROM request_record) AS dashboard_request_visible,
       (SELECT order_id FROM request_record) AS order_id,
       (SELECT id FROM notified) AS admin_notification_id;`,
    options: {
      queryReplacement: "={{ [ $('Upsert Customer and Session').item.json.customer_id, $('Upsert Customer and Session').item.json.awaiting_feedback_order_id, $('Claim Latest Customer Turn').item.json.combined_text || '' ] }}",
    },
  },
  type: "n8n-nodes-base.postgres",
  typeVersion: 2.7,
  position: [2080, 976],
  id: crypto.randomUUID(),
  name: "Escalate Post-Delivery Complaint",
  credentials: postgresCredentials,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 1000,
  notes: "Creates or reuses a visible staff handoff linked to the completed order, then closes the optional feedback prompt.",
});

upsert({
  parameters: {
    jsCode: `${detectMessageLanguage.toString()}
const session = $('Upsert Customer and Session').item.json || {};
const source = String($('Claim Latest Customer Turn').item.json.latest_text || $('Claim Latest Customer Turn').item.json.combined_text || '');
const language = detectMessageLanguage(source, session.recent_messages);
const created = $input.first().json || {};
const replies = {
  english: created.dashboard_request_visible
    ? 'I’m sorry this happened. I’ve shared your issue with our restaurant team. They will review it and contact you directly.'
    : 'I’m sorry this happened. I could not send your issue to our restaurant team yet. Please try again in a moment.',
  roman_urdu: created.dashboard_request_visible
    ? 'Mujhe afsos hai yeh hua. Main ne aap ka masla restaurant team ko bhej diya hai. Woh review karke aap se seedha rabta karegi.'
    : 'Mujhe afsos hai yeh hua. Main abhi aap ka masla restaurant team ko nahi bhej saka. Barah-e-karam thori dair baad dobara try karein.',
  urdu: created.dashboard_request_visible
    ? 'مجھے افسوس ہے کہ یہ ہوا۔ میں نے آپ کا مسئلہ ریسٹورنٹ ٹیم کو بھیج دیا ہے۔ وہ جائزہ لے کر آپ سے براہِ راست رابطہ کرے گی۔'
    : 'مجھے افسوس ہے کہ یہ ہوا۔ میں ابھی آپ کا مسئلہ ریسٹورنٹ ٹیم کو نہیں بھیج سکا۔ براہِ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔',
  pashto: created.dashboard_request_visible
    ? 'بخښنه غواړم چې دا پېښ شول. ستاسو ستونزه مې د رستورانت ټيم ته ولېږله. هغوی به يې وڅېړي او له تاسو سره به نېغ په نېغه اړيکه ونيسي.'
    : 'بخښنه غواړم چې دا پېښ شول. زه اوس ستاسو ستونزه د رستورانت ټيم ته نه شم لېږلی. مهرباني وکړئ لږ وروسته بيا هڅه وکړئ.',
};
return [{ json: { ...created, reply_text: replies[language] || replies.english, response_language: language } }];`,
  },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position: [2320, 976],
  id: crypto.randomUUID(),
  name: "Build Post-Delivery Complaint Reply",
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
  main: [[edge("Classify Pending Feedback Intent")], [edge("Route Simple Messages")]],
};
workflow.connections["Classify Pending Feedback Intent"] = { main: [[edge("Feedback Submission?")]] };
workflow.connections["Feedback Submission?"] = {
  main: [[edge("Parse Feedback Response")], [edge("Feedback Complaint?")]],
};
workflow.connections["Parse Feedback Response"] = { main: [[edge("Save Customer Feedback")]] };
workflow.connections["Save Customer Feedback"] = { main: [[edge("Saved Feedback Is Complaint?")]] };
workflow.connections["Feedback Complaint?"] = {
  main: [[edge("Escalate Post-Delivery Complaint")], [edge("Dismiss Pending Feedback Request")]],
};
workflow.connections["Saved Feedback Is Complaint?"] = {
  main: [[edge("Escalate Post-Delivery Complaint")], [edge("Build Feedback Thank You")]],
};
workflow.connections["Dismiss Pending Feedback Request"] = { main: [[edge("Route Simple Messages")]] };
workflow.connections["Escalate Post-Delivery Complaint"] = { main: [[edge("Build Post-Delivery Complaint Reply")]] };
workflow.connections["Build Post-Delivery Complaint Reply"] = { main: [[edge("Reply Text")]] };
workflow.connections["Build Feedback Thank You"] = { main: [[edge("Reply Text")]] };

workflow.versionId = crypto.randomUUID();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Updated ${path.basename(workflowPath)} for post-delivery feedback (${workflow.nodes.length} nodes).`);
