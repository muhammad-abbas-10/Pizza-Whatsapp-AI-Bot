const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const migration = fs.readFileSync(
  path.join(root, "database", "migration", "022_deal_selection_clarity.sql"),
  "utf8"
);

function node(name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert(found, `Missing workflow node: ${name}`);
  return found;
}

const agent = node("Pizza Ordering Agent");
assert.equal(agent.parameters.options.maxIterations, 8, "Agent needs enough tool calls for a configured deal");
assert.match(agent.parameters.options.systemMessage, /DEAL COMPONENT RESOLUTION — NO SIZE AMBIGUITY/);
assert.match(agent.parameters.options.systemMessage, /never ask the customer to repeat or choose that size/i);
assert.match(agent.parameters.options.systemMessage, /Set Pending Deal Configuration/);
assert.match(agent.parameters.options.systemMessage, /each is an independent required choice/i);

const dealCart = node("Update Cart");
assert.match(dealCart.parameters.toolDescription, /selection_group, choice/);
assert.match(dealCart.parameters.toolDescription, /database resolves fixed variants/i);
assert.match(dealCart.parameters.toolDescription, /independent choices/i);
assert.match(dealCart.parameters.query, /mutation_valid AS/);
assert.match(dealCart.parameters.query, /invalid_or_incomplete_cart_operation/);
assert.match(dealCart.parameters.query, /EXISTS \(SELECT 1 FROM updated\) AS updated/);
assert.match(dealCart.parameters.query, /pending_items = '\[\]'::jsonb/);

const pendingDeal = node("Set Pending Deal Configuration");
assert.match(pendingDeal.parameters.query, /choice_validity AS/);
assert.match(pendingDeal.parameters.query, /pending_saved/);
assert.match(pendingDeal.parameters.toolDescription, /missing_components/);
assert.match(pendingDeal.parameters.toolDescription, /independent choice/i);
assert(workflow.connections["Set Pending Deal Configuration"]?.ai_tool, "Pending-deal tool is not connected to the agent");

assert.match(node("Cancel Order").parameters.query, /pending_items = CASE/);
assert.match(node("Replace Draft Cart").parameters.query, /pending_items = '\[\]'::jsonb/);

for (const name of ["Load Active Menu", "Menu Lookup"]) {
  assert.match(node(name).parameters.query, /normalized_message|search_normalized/);
  assert.match(node(name).parameters.query, /regexp_replace\(LOWER/);
}

assert.match(migration, /"size":"345ml"/);
assert.match(migration, /deal_regular_drink_size/);
assert.match(migration, /Regular deal drink must resolve to the 345ml variant/);

console.log("Deterministic deal-selection contract: PASS");
