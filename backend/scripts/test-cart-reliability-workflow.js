const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow-ai-bot.json"), "utf8"));
const find = (name) => {
  const found = workflow.nodes.find((node) => node.name === name);
  assert(found, `Missing workflow node: ${name}`);
  return found;
};

const upsert = find("Upsert Customer and Session");
assert.match(upsert.parameters.query, /cart_updated_at/);
assert.match(upsert.parameters.query, /INTERVAL '4 hours'/);
assert.match(upsert.parameters.query, /active_order\.status IN \('completed', 'cancelled'\)/);

for (const name of ["Update Cart", "Update Menu Item Cart"]) {
  const cartTool = find(name);
  assert.match(cartTool.parameters.query, /active_order_id = NULL/);
  assert.match(cartTool.parameters.query, /cart_updated_at = NOW\(\)/);
}

const replace = find("Replace Draft Cart");
assert.match(replace.parameters.toolDescription, /ENTIRE draft cart/i);
assert.match(replace.parameters.query, /invalid_or_incomplete_replacement_cart/);
assert(workflow.connections["Replace Draft Cart"]?.ai_tool, "Replace Draft Cart is not connected to the agent");

const place = find("Place Order");
assert.match(place.parameters.query, /checkout_error/);
assert.match(place.parameters.query, /delivery_address_required/);

const handoff = find("Escalate To Human");
assert.match(handoff.parameters.query, /human_handoff/);
assert.match(handoff.parameters.query, /admin_requests/);
assert.match(handoff.parameters.query, /dashboard_request_visible/);

const agent = find("Pizza Ordering Agent");
assert.match(agent.parameters.options.systemMessage, /FULL-CART REPLACEMENT/);
assert.match(agent.parameters.options.systemMessage, /DELIVERY ADDRESS CAPTURE/);
assert.match(agent.parameters.options.systemMessage, /PLACE ORDER RESULT/);

const guard = find("Guard Cancellation Reply");
assert.match(guard.parameters.jsCode, /checkout_error/);
assert.match(guard.parameters.jsCode, /handoffResult/);
assert.match(guard.parameters.jsCode, /containsOrderSuccessClaim/);

const routes = fs.readFileSync(path.join(root, "backend", "src", "admin-routes.js"), "utf8");
assert.match(routes, /requestRow\.request_type === "human_handoff"/);

const frontend = fs.readFileSync(path.join(root, "frontend", "src", "main.js"), "utf8");
assert.match(frontend, /Customer complaint \/ staff handoff/);
assert.match(frontend, /Mark resolved/);

console.log("Cart expiry, full-cart replacement, checkout guard, and human-handoff workflow checks: PASS");
