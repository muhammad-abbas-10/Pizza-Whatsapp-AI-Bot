const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { root, loadWorkflow } = require("./workflow-fixture");

const workflow = loadWorkflow();
const migration = fs.readFileSync(
  path.join(root, "database/migration/022_transactional_order_state.sql"),
  "utf8"
);
const find = (name) => {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert(found, `Missing workflow node: ${name}`);
  return found;
};

const code = find("Determine Transaction Action").parameters.jsCode;
const replyCode = find("Build Transaction Reply").parameters.jsCode;
const deal = {
  id: 610,
  name: "My Box Combo-1",
  category: "Value Deals",
  price: 839,
  aliases: ["my box combo 1", "my box"],
  components: [
    { order: 1, type: "pizza", quantity: 1, unit: "pizza", size_label: "Small", label: "Small Pizza", selectable: true, selection_group: "pizza_selection", allowed_item_rule: { allowed: "any_active_pizza", size_label: "Small" } },
    { order: 2, type: "wings", quantity: 4, unit: "pcs", size_label: null, label: "Wings", selectable: true, selection_group: "wing_selection", allowed_item_rule: { allowed: "active_wing_items" } },
    { order: 3, type: "dip", quantity: 1, unit: "dip", size_label: null, label: "Dip", selectable: true, selection_group: "dip_selection", allowed_item_rule: { allowed: "active_sauces" } },
    { order: 4, type: "drink", quantity: 1, unit: "drink", size_label: "345ml", label: "345ml Drink", selectable: true, selection_group: "drink_selection", allowed_item_rule: { allowed_brands: ["7UP", "Pepsi", "Mountain Dew", "Mirinda"], size: "345ml" } },
  ],
};
const choices = [
  { id: 1, name: "Chicken Fajita", item_type: "pizza", aliases: ["chicken fajita", "chicken fajita pizza", "fajita pizza", "fajita"], variants: ["Small", "Medium", "Large", "Extra Large"] },
  { id: 2, name: "Classic Pepperoni", item_type: "pizza", aliases: ["classic pepperoni", "pepperoni pizza", "pepperoni"], variants: ["Small", "Medium", "Large", "Extra Large"] },
  { id: 3, name: "Chicken Wings", item_type: "appetizer", aliases: ["chicken wings"], variants: ["6 pcs", "12 pcs"] },
  { id: 4, name: "Garlic Mayo", item_type: "sauce", aliases: ["garlic mayo", "mayo"], variants: [null] },
  { id: 5, name: "Pepsi", item_type: "drink", aliases: ["pepsi"], variants: ["345ml", "1L", "1.5L"] },
];

function run(message, state = {}) {
  const input = {
    cart: { items: [] },
    cart_revision: 0,
    draft_deal: {},
    confirmation_status: "not_quoted",
    active_deals: [deal],
    component_choices: choices,
    ...state,
  };
  return vm.runInNewContext(`(function () { ${code} })()`, {
    $input: { first: () => ({ json: input }) },
    $: (name) => {
      if (name === "Claim Latest Customer Turn") {
        return { item: { json: { latest_text: message, combined_text: message } } };
      }
      if (name === "Route Simple Messages") {
        return { item: { json: { response_language: "english" } } };
      }
      throw new Error(`Unexpected node lookup: ${name}`);
    },
  })[0].json.transaction_action;
}

function applyDraft(action) {
  assert.equal(action.kind, "save_draft");
  const selected = action.selected_choice_ids || {};
  const selections = {};
  const missing = [];
  for (const component of deal.components) {
    const selectedChoice = choices.find((choice) => Number(choice.id) === Number(selected[component.selection_group]));
    if (!selectedChoice) {
      missing.push(component.label);
      selections[component.selection_group] = null;
      continue;
    }
    selections[component.selection_group] = {
      item_id: selectedChoice.id,
      choice: selectedChoice.name,
      type: component.type,
      quantity: component.quantity,
      unit: component.unit,
      size: component.size_label,
      label: component.label,
      selection_group: component.selection_group,
    };
  }
  return {
    deal_id: deal.id,
    deal_name: deal.name,
    price: deal.price,
    status: missing.length ? "in_progress" : "complete",
    selected_choice_ids: { ...selected },
    selections,
    missing_components: missing,
    pizza: selections.pizza_selection,
    wings: selections.wing_selection,
    dip: selections.dip_selection,
    drink: selections.drink_selection,
  };
}

function buildReply(result, language = "english") {
  return vm.runInNewContext(`(function () { ${replyCode} })()`, {
    $json: { transaction_result: result },
    $: (name) => {
      if (name === "Route Simple Messages") return { item: { json: { response_language: language } } };
      throw new Error(`Unexpected reply node lookup: ${name}`);
    },
  })[0].json.reply_text;
}

// Exact reported failure path.
let action = run("I want My Box Combo-1");
assert.equal(action.event, "draft_started");
let draft = applyDraft(action);
assert.deepEqual(draft.missing_components, ["Small Pizza", "Wings", "Dip", "345ml Drink"]);
let reply = buildReply({ ...action, draft_deal: draft });
assert.match(reply, /Please choose: Small Pizza/i);
assert.doesNotMatch(reply, /Please choose:.*Wings/i);

for (const wording of [
  "fajita", "chicken fajita", "fajita pizza", "small fajita", "haan fajita",
  "yes fajita", "fajita wala", "wo fajita", "I told you fajita", "same fajita",
  "Fajita chahiye", "Chicken Fajita dedo",
]) {
  const variantAction = run(wording, { draft_deal: draft });
  assert.equal(variantAction.kind, "save_draft", `Did not resolve state-constrained wording: ${wording}`);
  assert.equal(variantAction.selected_choice_ids.pizza_selection, 1);
}

action = run("I told u fajita", { draft_deal: draft });
draft = applyDraft(action);
assert.equal(draft.pizza.choice, "Chicken Fajita");
assert.equal(draft.pizza.size, "Small");
assert(!draft.missing_components.includes("Small Pizza"));
reply = buildReply({ ...action, draft_deal: draft });
assert.match(reply, /Please choose: Wings/i);
assert.doesNotMatch(reply, /Please choose:.*Dip/i);

action = run("6 pcs wings", { draft_deal: draft });
draft = applyDraft(action);
assert.equal(draft.wings.choice, "Chicken Wings");

action = run("Garlic Mayo", { draft_deal: draft });
draft = applyDraft(action);
assert.equal(draft.dip.choice, "Garlic Mayo");

action = run("345 ml Pepsi", { draft_deal: draft });
draft = applyDraft(action);
assert.equal(draft.drink.choice, "Pepsi");
assert.equal(draft.status, "complete");
assert.deepEqual(draft.missing_components, []);
reply = buildReply({ event: "deal_completed", completed_deal: draft, deal_price: deal.price });
assert.match(reply, /complete and has been added to your cart/i);
assert.match(reply, /Small Chicken Fajita/i);

// Change a selection: replace, do not append.
const incompleteIds = { ...draft.selected_choice_ids };
delete incompleteIds.drink_selection;
let changeDraft = {
  ...draft,
  status: "in_progress",
  drink: null,
  selections: { ...draft.selections, drink_selection: null },
  selected_choice_ids: incompleteIds,
  missing_components: ["345ml Drink"],
};
action = run("Actually make it Pepperoni", { draft_deal: changeDraft });
changeDraft = applyDraft(action);
assert.equal(changeDraft.pizza.choice, "Classic Pepperoni");
assert.equal(Object.keys(changeDraft.selected_choice_ids).filter((key) => key === "pizza_selection").length, 1);

// Repeating the same selection is handled without adding another component.
action = run("Pepperoni", { draft_deal: changeDraft });
assert.equal(action.event, "draft_status");
assert.equal(action.kind, "none");

// Status reads the persisted draft; incomplete placement is blocked.
action = run("What have I selected?", { draft_deal: changeDraft });
assert.equal(action.event, "draft_status");
action = run("now just place my order", { draft_deal: changeDraft });
assert.equal(action.event, "incomplete_deal");
assert.equal(action.handled, true);

// Cancelling a draft while asking for another item clears it and lets the
// ordinary item flow continue.
action = run("Actually remove that and give me a large pizza", { draft_deal: changeDraft });
assert.equal(action.kind, "clear_draft");
assert.equal(action.handled, false);

// Confirmation is scoped to a persisted current quote.
action = run("Yes", { draft_deal: {}, confirmation_status: "awaiting_confirmation", quote_cart_revision: 9, cart_revision: 9 });
assert.equal(action.kind, "confirm_quote");
action = run("Yes", { draft_deal: {}, confirmation_status: "not_quoted" });
assert.equal(action.kind, "none");

// Workflow architecture and migration guards.
assert.equal(find("OpenAI Chat Model").parameters.model.value, "openai/gpt-4.1-mini");
assert.equal(find("OpenAI Chat Model").parameters.options.temperature, 0.1);
assert(!find("Update Menu Item Cart").parameters.options.queryReplacement.startsWith("=={{"));
assert.match(find("Place Order").parameters.query, /pizza_place_confirmed_order/);
assert.match(find("Prepare Checkout Quote").parameters.query, /pizza_prepare_checkout_quote/);
assert.equal(workflow.connections["Use Simple Reply"].main[1][0].node, "Load Transaction State");
assert.equal(workflow.connections["Transaction Action Handled?"].main[1][0].node, "Load Active Menu");
assert.match(migration, /CREATE TRIGGER trg_pizza_invalidate_quote/);
assert.match(migration, /CREATE OR REPLACE FUNCTION pizza_apply_draft_deal_action/);
assert.match(migration, /CREATE OR REPLACE FUNCTION pizza_place_confirmed_order/);
assert.match(migration, /quote_cart_revision IS DISTINCT FROM v_session\.cart_revision/);

console.log("Persistent draft-deal and guarded checkout workflow tests: PASS");
