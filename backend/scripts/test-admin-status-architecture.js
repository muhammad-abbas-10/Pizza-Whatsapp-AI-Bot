const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { root, loadWorkflow } = require("./workflow-fixture");

const {
  dispatchCustomerNotificationEvent,
} = require("../src/customer-notification-events");

const workflow = loadWorkflow();
const migration = fs.readFileSync(path.join(root, "database/migration/016_dashboard_customer_status_events.sql"), "utf8");
const backend = fs.readFileSync(path.join(root, "backend/src/admin-routes.js"), "utf8");
const frontend = fs.readFileSync(path.join(root, "frontend/src/main.js"), "utf8");

function reachableFrom(start) {
  const found = new Set();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    if (found.has(current)) continue;
    found.add(current);
    const connection = workflow.connections[current];
    if (!connection) continue;
    for (const outputs of Object.values(connection)) {
      for (const branch of outputs) {
        for (const edge of branch || []) queue.push(edge.node);
      }
    }
  }
  found.delete(start);
  return found;
}

function staticArchitectureTests() {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const required = [
    "Admin Order Status Webhook",
    "Validate Admin Status Payload",
    "Claim Admin Customer Event",
    "Admin Customer Message Agent",
    "Build Safe Admin Customer Message",
    "Evolution API Send Admin Status",
    "Record Admin Event Result",
  ];
  required.forEach((name) => assert(names.has(name), `Missing workflow node: ${name}`));
  for (const [source, channels] of Object.entries(workflow.connections)) {
    assert(names.has(source), `Connection source does not exist: ${source}`);
    for (const outputs of Object.values(channels)) {
      for (const branch of outputs) {
        for (const edge of branch || []) assert(names.has(edge.node), `Connection target does not exist: ${edge.node}`);
      }
    }
  }

  const removed = [
    "Is Authorized Admin",
    "Claim Admin Message",
    "Parse Admin Command",
    "Resolve Admin Request",
    "Send Admin Decision to Customer",
    "Send Admin Reply",
    "Notify Admin",
  ];
  removed.forEach((name) => assert(!names.has(name), `Legacy admin WhatsApp node remains: ${name}`));

  const serialized = JSON.stringify(workflow);
  const removedSecretVariable = ["N8N", "ADMIN", "WEBHOOK", "SECRET"].join("_");
  const removedSecretHeader = ["x", "n8n", "admin", "secret"].join("-");
  assert(!/ADMIN_WHATSAPP_PHONE|APPROVE <request_id>|DENY <request_id>/.test(serialized));
  assert(!serialized.includes(removedSecretVariable), "removed n8n webhook secret remains in workflow");
  assert(!serialized.toLowerCase().includes(removedSecretHeader), "removed webhook secret header remains in workflow");
  assert(serialized.includes("source=admin_dashboard"), "AI prompt does not distinguish admin events");
  assert(serialized.includes("order_is_cancellable(o.status)"), "Cancellation tool does not use the canonical DB policy");
  assert(!serialized.includes("admin_notification_allowed"), "Cancellation still expects an admin WhatsApp alert");
  const claimSql = workflow.nodes.find((node) => node.name === "Claim Admin Customer Event").parameters.query;
  assert(claimSql.includes("o.id = e.order_id AND o.customer_id = e.customer_id"));
  assert(claimSql.includes("c.whatsapp_phone AS customer_phone"));
  const rejectedBranch = workflow.connections["Admin Status Payload Valid"].main[1][0].node;
  assert.equal(rejectedBranch, "Reject Invalid Admin Status Payload");
  assert.equal(workflow.nodes.find((node) => node.name === rejectedBranch).parameters.options.responseCode, 400);
  assert(String(workflow.nodes.find((node) => node.name === "Respond Admin Event Not Claimed").parameters.options.responseCode).includes("404"));
  assert(String(workflow.nodes.find((node) => node.name === "Respond Admin Event Processed").parameters.options.responseCode).includes("502"));

  const customerPath = reachableFrom("Evolution API Webhook");
  const adminPath = reachableFrom("Admin Order Status Webhook");
  assert(customerPath.has("Pizza Ordering Agent") && customerPath.has("Evolution API Send Message"));
  assert(!customerPath.has("Claim Admin Customer Event"), "Customer input can enter the admin-event claim path");
  assert(adminPath.has("Admin Customer Message Agent") && adminPath.has("Evolution API Send Admin Status"));
  assert(!adminPath.has("Pizza Ordering Agent"), "Admin event can enter customer ordering logic");
  assert(!adminPath.has("Update Cart") && !adminPath.has("Place Order"));

  const validationCode = workflow.nodes.find((node) => node.name === "Validate Admin Status Payload").parameters.jsCode;
  const runValidation = new Function("$input", validationCode);
  const webhookInput = () => ({ all: () => [{ json: {
    body: {
      source: "admin_dashboard",
      event: "customer_notification",
      event_id: 41,
      request_id: "4a2b2445-6ea4-4397-bd67-bd12c278e370",
    },
  } }] });
  assert.equal(runValidation(webhookInput())[0].json.valid_payload, true);
  const wrongSourceItem = webhookInput().all()[0];
  wrongSourceItem.json.body.source = "customer";
  assert.equal(runValidation({ all: () => [wrongSourceItem] })[0].json.valid_payload, false);
  const malformedItem = webhookInput().all()[0];
  malformedItem.json.body.request_id = "------------------------------------";
  const malformedInput = { all: () => [malformedItem] };
  assert.equal(runValidation(malformedInput)[0].json.valid_payload, false);

  const safeMessageCode = workflow.nodes.find((node) => node.name === "Build Safe Admin Customer Message").parameters.jsCode;
  const runSafeMessage = new Function("$", "$input", safeMessageCode);
  const buildMessage = (event, output) => runSafeMessage(
    (name) => {
      assert.equal(name, "Claim Admin Customer Event");
      return { item: { json: event } };
    },
    { first: () => ({ json: { output } }) }
  )[0].json;
  const ovenEvent = {
    event_type: "order_status_update",
    order_id: 123,
    order_status: "oven",
    preferred_language: "english",
    recent_messages: [],
  };
  const validOven = buildMessage(ovenEvent, "Your Order #123 is now in the oven. 🔥🍕");
  assert.equal(validOven.ai_fallback_used, false);
  const contradictoryOven = buildMessage(ovenEvent, "Order #123 is in the oven and has been delivered.");
  assert.equal(contradictoryOven.ai_fallback_used, true);
  assert.equal(contradictoryOven.customer_message, "Your Order #123 is now in the oven. 🔥🍕");
  const romanFallback = buildMessage(
    { ...ovenEvent, preferred_language: "roman_urdu", recent_messages: ["mera order kahan hai"] },
    ""
  );
  assert(romanFallback.customer_message.includes("oven mein hai"));
  const deniedFallback = buildMessage(
    { ...ovenEvent, event_type: "cancellation_denied", order_status: "preparing" },
    "Order #123 has been cancelled."
  );
  assert.equal(deniedFallback.ai_fallback_used, true);
  assert(deniedFallback.customer_message.includes("was not approved"));

  assert(/'oven'/.test(migration), "Migration does not add oven");
  assert(migration.includes("allowed_order_status_transitions"));
  assert(migration.includes("order_is_cancellable"));
  assert(migration.includes("trg_enforce_order_status_transition"));
  assert(migration.includes("customer_notification_events_order_customer_fk"));
  assert(migration.includes("delivery_status IN ('pending', 'processing', 'sent', 'failed', 'superseded')"));
  assert(migration.includes("notification_failure"));

  assert(backend.includes('"received", "preparing", "oven", "out_for_delivery", "completed", "cancelled"'));
  assert(backend.includes("can_transition_order_status_for_order($1, $2, $3)"), "Backend does not defer transitions to PostgreSQL");
  assert(backend.includes("FOR UPDATE"), "Backend actions do not lock mutable records");
  assert(backend.includes("customer_notification_events"), "Backend does not persist notification events");
  assert(!backend.includes("graph.facebook.com"), "Backend still sends WhatsApp directly");
  assert(!backend.includes("WHATSAPP_TOKEN"), "Backend still depends on a WhatsApp token");
  assert(frontend.includes('oven: "Move to oven"'));
  assert(frontend.includes("data-retry-order-event"));
  assert(!frontend.includes("wa.me"), "Dashboard still offers direct WhatsApp communication");
}

function fakePool(initialEvent) {
  const state = { event: { ...initialEvent }, updates: [] };
  return {
    state,
    async query(sql, params) {
      if (/^\s*SELECT id, request_id, event_type/m.test(sql)) {
        return { rows: String(params[0]) === String(state.event.id) ? [{ ...state.event }] : [] };
      }
      if (/^\s*UPDATE customer_notification_events/m.test(sql)) {
        state.updates.push({ sql, params });
        if (["pending", "failed"].includes(state.event.delivery_status)) {
          state.event.delivery_status = "failed";
          state.event.last_error = params[1];
          state.event.updated_at = new Date().toISOString();
        }
        return { rows: [{ ...state.event }] };
      }
      throw new Error(`Unexpected fake query: ${sql.slice(0, 80)}`);
    },
  };
}

async function dispatcherTests() {
  const baseEvent = {
    id: 41,
    request_id: "4a2b2445-6ea4-4397-bd67-bd12c278e370",
    event_type: "order_status_update",
    order_id: 123,
    order_status: "preparing",
    decision: null,
    delivery_status: "pending",
    attempts: 0,
    provider_message_id: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sent_at: null,
  };

  const pool = fakePool(baseEvent);
  let calls = 0;
  let outbound;
  const fetchImpl = async (url, options) => {
    calls += 1;
    outbound = { url, options, body: JSON.parse(options.body) };
    pool.state.event.delivery_status = "sent";
    pool.state.event.attempts = 1;
    pool.state.event.provider_message_id = "wamid.test";
    pool.state.event.sent_at = new Date().toISOString();
    return new Response(JSON.stringify({ accepted: true, lifecycle: "sent" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const delivered = await dispatchCustomerNotificationEvent(pool, 41, {
    fetchImpl,
    webhookUrl: "https://n8n.example/webhook/admin-order-status",
  });
  assert.equal(delivered.lifecycle, "sent");
  assert.equal(delivered.event.provider_message_id, "wamid.test");
  assert.deepEqual(outbound.options.headers, { "content-type": "application/json" });
  assert.deepEqual(Object.keys(outbound.body).sort(), ["event", "event_id", "request_id", "source"]);
  assert(!JSON.stringify(outbound.body).includes("phone"), "Backend sent a browser/customer phone to n8n");

  const duplicate = await dispatchCustomerNotificationEvent(pool, 41, {
    fetchImpl,
    webhookUrl: "https://n8n.example/webhook/admin-order-status",
  });
  assert.equal(duplicate.lifecycle, "duplicate");
  assert.equal(calls, 1, "A sent event was dispatched twice");

  const failedPool = fakePool({ ...baseEvent });
  const failed = await dispatchCustomerNotificationEvent(failedPool, 41, {
    fetchImpl: async () => new Response(JSON.stringify({ message: "n8n unavailable" }), { status: 502 }),
    webhookUrl: "https://n8n.example/webhook/admin-order-status",
  });
  assert.equal(failed.lifecycle, "failed");
  assert.equal(failed.event.delivery_status, "failed");
  assert(failed.event.last_error.includes("n8n unavailable"));

  const htmlFailurePool = fakePool({ ...baseEvent });
  const htmlFailure = await dispatchCustomerNotificationEvent(htmlFailurePool, 41, {
    fetchImpl: async () => new Response("<!DOCTYPE html><title>502 Bad gateway</title>", { status: 502 }),
    webhookUrl: "https://n8n.example/webhook/admin-order-status",
  });
  assert.equal(htmlFailure.lifecycle, "failed");
  assert.equal(htmlFailure.event.last_error, "n8n webhook returned HTTP 502");

  const missingConfigPool = fakePool({ ...baseEvent });
  const missingConfig = await dispatchCustomerNotificationEvent(missingConfigPool, 41, {
    fetchImpl,
    webhookUrl: "",
  });
  assert.equal(missingConfig.lifecycle, "failed");
  assert(missingConfig.event.last_error.includes("N8N_ADMIN_WEBHOOK"));
}

async function main() {
  staticArchitectureTests();
  await dispatcherTests();
  console.log("Admin status architecture, isolation, payload validation, retry, and duplicate-dispatch tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
