const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { parseFeedback } = require("../src/feedback-parser");
const { classifyPendingFeedback } = require("../src/feedback-intent");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const migration = fs.readFileSync(path.join(root, "database/migration/020_post_delivery_feedback.sql"), "utf8");
const routes = fs.readFileSync(path.join(root, "backend/src/admin-routes.js"), "utf8");
const frontend = fs.readFileSync(path.join(root, "frontend/src/main.js"), "utf8");

const node = (name) => {
  const result = workflow.nodes.find((entry) => entry.name === name);
  assert(result, `Missing workflow node: ${name}`);
  return result;
};

const cases = [
  ["5", { rating: 5, message: null }],
  ["Pizza was amazing!", { rating: null, message: "Pizza was amazing!" }],
  ["5 - Pizza was amazing!", { rating: 5, message: "Pizza was amazing!" }],
  ["I would give it 4/5, pizza was really good.", { rating: 4, message: "pizza was really good." }],
  ["8", { rating: 5, message: null }],
  ["10/10, amazing pizza!", { rating: 5, message: "amazing pizza!" }],
  ["-2", { rating: 0, message: null }],
  ["-2, pizza was cold", { rating: 0, message: "pizza was cold" }],
  ["0", { rating: 0, message: null }],
  ["5 Pizza was excellent", { rating: 5, message: "Pizza was excellent" }],
  ["I'd give it 4 out of 5", { rating: 4, message: null }],
  ["⭐⭐⭐⭐⭐", { rating: 5, message: null }],
];

for (const [input, expected] of cases) assert.deepEqual(parseFeedback(input), expected, input);

const parseNode = node("Parse Feedback Response");
const classifyNode = node("Classify Pending Feedback Intent");
assert(parseNode.parameters.jsCode.includes(parseFeedback.toString()), "Workflow parser differs from tested parser");
assert.equal(
  workflow.connections["Awaiting Feedback Response?"].main[0][0].node,
  "Classify Pending Feedback Intent"
);
assert.equal(
  workflow.connections["Awaiting Feedback Response?"].main[1][0].node,
  "Route Simple Messages"
);
assert(classifyNode.parameters.jsCode.includes(classifyPendingFeedback.toString()));
assert.equal(workflow.connections["Classify Pending Feedback Intent"].main[0][0].node, "Feedback Submission?");
assert.equal(workflow.connections["Feedback Submission?"].main[0][0].node, "Parse Feedback Response");
assert.equal(workflow.connections["Feedback Submission?"].main[1][0].node, "Feedback Complaint?");
assert.equal(workflow.connections["Feedback Complaint?"].main[0][0].node, "Escalate Post-Delivery Complaint");
assert.equal(workflow.connections["Feedback Complaint?"].main[1][0].node, "Dismiss Pending Feedback Request");
assert.equal(workflow.connections["Dismiss Pending Feedback Request"].main[0][0].node, "Route Simple Messages");
assert.equal(workflow.connections["Save Customer Feedback"].main[0][0].node, "Saved Feedback Is Complaint?");
assert.equal(workflow.connections["Saved Feedback Is Complaint?"].main[0][0].node, "Escalate Post-Delivery Complaint");
assert.equal(workflow.connections["Saved Feedback Is Complaint?"].main[1][0].node, "Build Feedback Thank You");

const recent = "2026-09-29T11:30:00Z";
const now = Date.parse("2026-09-29T12:00:00Z");
assert.equal(classifyPendingFeedback("I want small chicken tikka pizza place my order", { requestedAt: recent, now }).intent, "normal");
assert.equal(classifyPendingFeedback("We did not receive the order", { requestedAt: recent, now }).intent, "complaint");
assert.equal(classifyPendingFeedback("1/5, the pizza was cold", { requestedAt: recent, now }).intent, "feedback_complaint");
assert.equal(classifyPendingFeedback("Pizza was amazing!", { requestedAt: recent, now }).intent, "feedback");

function classifyWithWorkflow(message, requestedAt = recent) {
  return vm.runInNewContext(`(function () { ${classifyNode.parameters.jsCode} })()`, {
    $: (name) => {
      if (name === "Upsert Customer and Session") {
        return { item: { json: { awaiting_feedback_requested_at: requestedAt } } };
      }
      if (name === "Claim Latest Customer Turn") return { item: { json: { combined_text: message } } };
      throw new Error(`Unexpected node lookup: ${name}`);
    },
    $input: { first: () => ({ json: {} }) },
  })[0].json.feedback_intent;
}

assert.equal(classifyWithWorkflow("I want small chicken tikka pizza place my order"), "normal");
assert.equal(classifyWithWorkflow("We did not receive the order"), "complaint");
assert.equal(classifyWithWorkflow("1/5, the pizza was cold"), "feedback_complaint");

const safeMessageCode = node("Build Safe Admin Customer Message").parameters.jsCode;
function buildStatusMessage(orderStatus) {
  const event = {
    event_type: "order_status_update",
    order_status: orderStatus,
    order_id: 1024,
    customer_phone: "03000000000",
    preferred_language: "english",
    recent_messages: [],
  };
  return vm.runInNewContext(`(function () { ${safeMessageCode} })()`, {
    $: (name) => {
      assert.equal(name, "Claim Admin Customer Event");
      return { item: { json: event } };
    },
    $input: { first: () => ({ json: { output: `Order #1024 is ${orderStatus}.` } }) },
  })[0].json.customer_message;
}

assert.match(buildStatusMessage("completed"), /Rate your experience out of 5/);
assert.doesNotMatch(buildStatusMessage("cancelled"), /Rate your experience out of 5/);

const claimSql = node("Claim Admin Customer Event").parameters.query;
const recordSql = node("Record Admin Event Result").parameters.query;
const saveSql = node("Save Customer Feedback").parameters.query;
const finalizeSql = node("Finalize Customer Turn").parameters.query;
const dismissSql = node("Dismiss Pending Feedback Request").parameters.query;
const complaintSql = node("Escalate Post-Delivery Complaint").parameters.query;

assert.match(claimSql, /feedback_requested_at IS NOT NULL/);
assert.match(recordSql, /e\.order_status = 'completed'/);
assert.match(recordSql, /e\.lifecycle = 'sent'/);
assert.match(recordSql, /awaiting_feedback_order_id = e\.order_id/);
assert.match(saveSql, /o\.status = 'completed'/);
assert.match(saveSql, /ON CONFLICT \(order_id\)/);
assert.match(finalizeSql, /THEN NULL\s+ELSE cs\.awaiting_feedback_order_id/);
assert.match(dismissSql, /awaiting_feedback_order_id = NULL/);
assert.match(complaintSql, /o\.status = 'completed'/);
assert.match(complaintSql, /admin_requests/);
assert.match(complaintSql, /awaiting_human = TRUE/);
assert.match(complaintSql, /Post-delivery customer issue for order #/);

assert.match(migration, /ALTER COLUMN rating DROP NOT NULL/);
assert.match(migration, /rating BETWEEN 0 AND 5/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_order_once/);
assert.match(migration, /awaiting_feedback_order_id/);
assert.match(routes, /app\.get\("\/admin\/feedback"/);
assert.match(routes, /JOIN customers c ON c\.id = f\.customer_id/);
assert.match(frontend, /function renderFeedbackList/);
assert.match(frontend, /Order #\$\{escapeHtml\(item\.order_id\)\}/);
assert.match(frontend, /No rating provided/);

console.log("Post-delivery feedback parsing, completion gating, idempotency, session reset, and admin-page wiring: PASS");
