const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { root } = require("./workflow-fixture");

require("dotenv").config({ quiet: true });

if (!process.env.TEST_DATABASE_URL) {
  console.log("Transactional ordering database test: SKIPPED (TEST_DATABASE_URL is not configured)");
  process.exit(0);
}

const migration = fs.readFileSync(
  path.join(root, "database/migration/022_transactional_order_state.sql"),
  "utf8"
).replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");

async function callJson(client, sql, values) {
  const result = await client.query(sql, values);
  return result.rows[0].value;
}

async function run() {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(migration);

    const deal = (await client.query(
      "SELECT id, price FROM restaurant_deals WHERE name = 'My Box Combo-1' AND active = TRUE"
    )).rows[0];
    assert(deal, "My Box Combo-1 is missing from the test database");

    const items = (await client.query(`
      SELECT name, id FROM restaurant_menu_items
      WHERE active = TRUE AND name IN ('Chicken Fajita', 'Chicken Wings', 'Garlic Mayo', 'Pepsi')
    `)).rows;
    const id = (name) => {
      const item = items.find((entry) => entry.name === name);
      assert(item, `${name} is missing from the test database`);
      return Number(item.id);
    };

    const customer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Transactional Test') RETURNING id",
      [`transaction-state-${Date.now()}`]
    )).rows[0];
    const oldCartItem = (await client.query(`
      SELECT mi.id AS menu_item_id, mi.name AS item_name, mi.category,
             mv.id AS variant_id, mv.variant_label AS size, mv.price
      FROM restaurant_menu_items mi
      JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id AND mv.active = TRUE
      WHERE mi.active = TRUE AND mi.name = 'Garlic Mayo'
      ORDER BY mv.id LIMIT 1
    `)).rows[0];
    assert(oldCartItem, "Existing-cart test needs an active Garlic Mayo variant");
    const existingLine = {
      record_type: "menu_item",
      menu_item_id: Number(oldCartItem.menu_item_id),
      variant_id: Number(oldCartItem.variant_id),
      deal_id: null,
      item_name: oldCartItem.item_name,
      category: oldCartItem.category,
      size: oldCartItem.size,
      quantity: 1,
      price: Number(oldCartItem.price),
      selected_components: [],
      line_total: Number(oldCartItem.price),
    };
    await client.query(
      "INSERT INTO conversation_sessions (customer_id, cart) VALUES ($1, $2::jsonb)",
      [customer.id, JSON.stringify({ items: [existingLine] })]
    );

    const action = async (selected, event = "draft_updated") => callJson(
      client,
      "SELECT pizza_apply_draft_deal_action($1, $2::jsonb) AS value",
      [customer.id, JSON.stringify({
        kind: "save_draft",
        handled: true,
        event,
        deal_id: Number(deal.id),
        deal_name: "My Box Combo-1",
        selected_choice_ids: selected,
      })]
    );

    let result = await action({}, "draft_started");
    assert.equal(result.draft_deal.status, "in_progress");
    assert.equal(result.draft_deal.missing_components.length, 4);

    const selections = { pizza_selection: id("Chicken Fajita") };
    result = await action(selections);
    assert.equal(result.draft_deal.pizza.choice, "Chicken Fajita");
    assert.equal(result.draft_deal.pizza.size, "Small");

    selections.wing_selection = id("Chicken Wings");
    result = await action(selections);
    assert.equal(result.draft_deal.wings.choice, "Chicken Wings");

    selections.dip_selection = id("Garlic Mayo");
    result = await action(selections);
    assert.equal(result.draft_deal.dip.choice, "Garlic Mayo");

    selections.drink_selection = id("Pepsi");
    result = await action(selections);
    assert.equal(result.event, "deal_completed");
    assert.equal(Number(result.deal_price), Number(deal.price));
    assert.equal(result.cart.items.filter((entry) => entry.record_type === "deal").length, 1);
    assert.equal(result.cart.items.filter((entry) => entry.item_name === "Garlic Mayo").length, 1);

    // SQL NULL semantics must never let a missing order type reach orders.order_type.
    let quote = await callJson(client, "SELECT pizza_prepare_checkout_quote($1) AS value", [customer.id]);
    assert.equal(quote.quote_created, false);
    assert.equal(quote.checkout_error, "order_type_required");

    await client.query(`
      UPDATE conversation_sessions
      SET order_type = 'delivery', delivery_name = 'Abbas', delivery_address = 'Durrani Hostel'
      WHERE customer_id = $1
    `, [customer.id]);

    quote = await callJson(client, "SELECT pizza_prepare_checkout_quote($1) AS value", [customer.id]);
    assert.equal(quote.quote_created, true);
    assert.equal(Number(quote.subtotal), Number(deal.price) + Number(oldCartItem.price));
    assert(Number(quote.total) >= Number(quote.subtotal));

    // Any checkout-relevant change invalidates the old quote.
    await client.query(
      "UPDATE conversation_sessions SET delivery_address = 'Durrani Hostel, University Road' WHERE customer_id = $1",
      [customer.id]
    );
    let confirmation = await callJson(client, "SELECT pizza_confirm_checkout_quote($1) AS value", [customer.id]);
    assert.equal(confirmation.confirmed, false);

    quote = await callJson(client, "SELECT pizza_prepare_checkout_quote($1) AS value", [customer.id]);
    assert.equal(quote.quote_created, true);
    confirmation = await callJson(client, "SELECT pizza_confirm_checkout_quote($1) AS value", [customer.id]);
    assert.equal(confirmation.confirmed, true);

    const placed = await callJson(client, "SELECT pizza_place_confirmed_order($1) AS value", [customer.id]);
    assert.equal(placed.order_created, true);
    assert.equal(Number(placed.total), Number(quote.total));

    const session = (await client.query(
      "SELECT cart, draft_deal, confirmation_status, active_order_id FROM conversation_sessions WHERE customer_id = $1",
      [customer.id]
    )).rows[0];
    assert.deepEqual(session.cart.items, []);
    assert.deepEqual(session.draft_deal, {});
    assert.equal(session.confirmation_status, "not_quoted");
    assert(session.active_order_id);

    console.log("Transactional ordering database integration test: PASS");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
