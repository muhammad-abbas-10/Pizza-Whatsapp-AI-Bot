require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "../..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function node(name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  if (!found) throw new Error(`Workflow node not found: ${name}`);
  return found;
}

async function main() {
  const updateCartQuery = node("Update Cart").parameters.query;
  const pendingDealQuery = node("Set Pending Deal Configuration").parameters.query;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dealResult = await client.query(`
      SELECT d.id, d.name, d.price,
             jsonb_agg(jsonb_build_object(
               'selection_group', c.selection_group,
               'size', c.allowed_item_rule->>'size'
             ) ORDER BY c.component_order) AS components
      FROM restaurant_deals d
      JOIN restaurant_deal_components c ON c.deal_id = d.id AND c.selectable = TRUE
      WHERE d.name = 'Value Deal-1' AND d.active = TRUE
      GROUP BY d.id
    `);
    const deal = dealResult.rows[0];
    assert(deal, "Value Deal-1 must be active");
    assert.equal(deal.components.find((component) => component.selection_group === "drink_selection")?.size, "345ml");

    const choices = await client.query(`
      SELECT mi.name, mv.variant_label
      FROM restaurant_menu_items mi
      JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id AND mv.active = TRUE
      WHERE mi.active = TRUE
        AND (mi.name = 'Chicken Fajita' AND mv.variant_label = 'Small'
             OR mi.name = '7UP' AND mv.variant_label = '345ml')
      ORDER BY mi.name, mv.variant_label
    `);
    assert.equal(choices.rows.length, 2, "The required Small Chicken Fajita and 345ml 7UP variants must exist");

    const customer = await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Deal Selection Test') RETURNING id",
      [`deal-selection-test-${Date.now()}`]
    );
    const customerId = customer.rows[0].id;
    await client.query("INSERT INTO conversation_sessions (customer_id) VALUES ($1)", [customerId]);

    const partial = [{ selection_group: "drink_selection", choice: "7UP" }];
    const pending = await client.query(pendingDealQuery, [deal.id, JSON.stringify(partial), customerId]);
    assert.equal(pending.rows.length, 1, "Pending-deal tool must return one result");
    assert.equal(pending.rows[0].pending_saved, true, "Known drink brand must persist while pizza choice is unresolved");
    assert.equal(pending.rows[0].error, null);
    assert.deepEqual(
      pending.rows[0].missing_components.map((component) => component.selection_group),
      ["pizza_selection"],
      "Only the pizza choice should remain unresolved"
    );

    const fullConfiguration = [
      { selection_group: "pizza_selection", choice: "Chicken Fajita" },
      { selection_group: "drink_selection", choice: "7UP" },
    ];
    const cart = await client.query(updateCartQuery, [JSON.stringify([{
      record_type: "deal",
      deal_id: Number(deal.id),
      quantity: 1,
      selected_components: fullConfiguration,
    }]), customerId]);

    assert.equal(cart.rows.length, 1, "Deal cart tool must return one result");
    assert.equal(cart.rows[0].updated, true, "A complete Value Deal-1 configuration must be accepted");
    assert.equal(cart.rows[0].error, null);
    assert.equal(cart.rows[0].accepted_item_count, 1);
    assert.equal(cart.rows[0].rejected_item_count, 0);
    assert.equal(cart.rows[0].cart.items.length, 1);
    assert.equal(cart.rows[0].cart.items[0].item_name, "Value Deal-1");

    const session = await client.query(
      "SELECT pending_items FROM conversation_sessions WHERE customer_id = $1",
      [customerId]
    );
    assert.deepEqual(session.rows[0].pending_items, [], "Successful cart update must clear the pending deal state");

    const pairResult = await client.query(`
      SELECT d.id,
             jsonb_agg(jsonb_build_object(
               'selection_group', c.selection_group,
               'quantity', c.quantity,
               'size', c.allowed_item_rule->>'size_label'
             ) ORDER BY c.component_order) AS components
      FROM restaurant_deals d
      JOIN restaurant_deal_components c ON c.deal_id = d.id AND c.selectable = TRUE
      WHERE d.name = '2 Small Pizzas' AND d.active = TRUE
      GROUP BY d.id
    `);
    const pair = pairResult.rows[0];
    assert(pair, "2 Small Pizzas must be active");
    assert.deepEqual(
      pair.components.map((component) => component.selection_group),
      ["pizza_selection_1", "pizza_selection_2"],
      "Each pizza in a two-pizza deal must have an independent selection group"
    );
    assert(pair.components.every((component) => Number(component.quantity) === 1 && component.size === "Small"));

    const smallPizzaChoices = await client.query(`
      SELECT mi.name
      FROM restaurant_menu_items mi
      JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id AND mv.active = TRUE
      WHERE mi.active = TRUE
        AND mi.item_type LIKE 'pizza%'
        AND mv.variant_label = 'Small'
      ORDER BY mi.name
      LIMIT 2
    `);
    assert.equal(smallPizzaChoices.rows.length, 2, "Two Small pizza choices must exist for independent slots");

    const pairConfiguration = pair.components.map((component, index) => ({
      selection_group: component.selection_group,
      choice: smallPizzaChoices.rows[index].name,
    }));
    const pairCart = await client.query(updateCartQuery, [JSON.stringify([{
      record_type: "deal",
      deal_id: Number(pair.id),
      quantity: 1,
      selected_components: pairConfiguration,
    }]), customerId]);
    assert.equal(pairCart.rows[0].updated, true, "Two independently selected pizzas must be accepted");
    const savedPair = pairCart.rows[0].cart.items.find((item) => Number(item.deal_id) === Number(pair.id));
    assert(savedPair, "The configured two-pizza deal must be stored in the cart");
    assert.deepEqual(savedPair.selected_components, pairConfiguration);

    await client.query("ROLLBACK");
    console.log("Deal selection variants and independent multi-choice slots: PASS");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
