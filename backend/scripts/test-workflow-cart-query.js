require("dotenv").config();

const { Pool } = require("pg");
const workflow = require("../../admin request.json");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameComponents(left, right) {
  const stableObject = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const canonical = (value) => JSON.stringify(value.map(stableObject).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return canonical(left) === canonical(right);
}

async function main() {
  const updateCartQuery = workflow.nodes.find((node) => node.name === "Update Cart")?.parameters?.query;
  if (!updateCartQuery) throw new Error("Update Cart SQL not found in workflow");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const menu = await client.query(`
      SELECT mi.id AS menu_item_id, mi.name, v.id AS variant_id, v.variant_label, v.price
      FROM restaurant_menu_items mi
      JOIN restaurant_menu_variants v ON v.menu_item_id = mi.id
      WHERE mi.active = TRUE AND v.active = TRUE
        AND mi.id IN (
          SELECT menu_item_id FROM restaurant_menu_variants WHERE active = TRUE
          GROUP BY menu_item_id HAVING COUNT(*) >= 2
        )
      ORDER BY mi.id, v.sort_order, v.id
    `);
    const firstItemId = menu.rows[0]?.menu_item_id;
    const secondItemId = menu.rows.find((row) => row.menu_item_id !== firstItemId)?.menu_item_id;
    const itemA = menu.rows.filter((row) => row.menu_item_id === firstItemId).slice(0, 2);
    const itemB = menu.rows.filter((row) => row.menu_item_id === secondItemId).slice(0, 1);
    assert(itemA.length === 2 && itemB.length === 1, "Test menu needs two items and two variants");

    const dealResult = await client.query(`
      SELECT d.id, d.name, d.price
      FROM restaurant_deals d
      JOIN restaurant_deal_components dc ON dc.deal_id = d.id AND dc.selectable = TRUE
      WHERE d.active = TRUE
      GROUP BY d.id
      HAVING COUNT(DISTINCT dc.selection_group) >= 2
      ORDER BY d.id LIMIT 1
    `);
    const deal = dealResult.rows[0];
    assert(deal, "Test menu needs one active configurable deal");
    const componentRules = (await client.query(`
      SELECT selection_group, allowed_item_rule
      FROM restaurant_deal_components
      WHERE deal_id = $1 AND selectable = TRUE
      ORDER BY id
    `, [deal.id])).rows;

    async function validChoices(rule) {
      if (rule.allowed === "any_active_pizza") {
        return (await client.query(`
          SELECT DISTINCT mi.name FROM restaurant_menu_items mi
          JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id AND mv.active = TRUE
          WHERE mi.active = TRUE AND mi.item_type LIKE 'pizza%'
            AND LOWER(mv.variant_label) = LOWER($1) ORDER BY mi.name`, [rule.size_label])).rows.map((row) => row.name);
      }
      if (rule.allowed === "active_wing_items") {
        return (await client.query("SELECT name FROM restaurant_menu_items WHERE active = TRUE AND name ILIKE '%wing%' ORDER BY name")).rows.map((row) => row.name);
      }
      if (rule.allowed === "active_sauces") {
        return (await client.query("SELECT name FROM restaurant_menu_items WHERE active = TRUE AND item_type = 'sauce' ORDER BY name")).rows.map((row) => row.name);
      }
      if (Array.isArray(rule.allowed_brands)) {
        return (await client.query(`
          SELECT DISTINCT mi.name FROM restaurant_menu_items mi
          JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id AND mv.active = TRUE
          WHERE mi.active = TRUE AND mi.item_type = 'drink' AND mi.name = ANY($1::text[])
            AND LOWER(mv.variant_label) = LOWER($2) ORDER BY mi.name`,
          [rule.allowed_brands, rule.size || rule.size_label])).rows.map((row) => row.name);
      }
      return [];
    }

    const choiceSets = [];
    for (const component of componentRules) {
      const choices = await validChoices(component.allowed_item_rule);
      assert(choices.length > 0, `No valid choice for ${component.selection_group}`);
      choiceSets.push({ group: component.selection_group, choices });
    }

    const customer = await client.query(
      `INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Cart Workflow Test') RETURNING id`,
      [`cart-workflow-test-${Date.now()}`]
    );
    const customerId = customer.rows[0].id;
    await client.query(`INSERT INTO conversation_sessions (customer_id) VALUES ($1)`, [customerId]);

    async function resetCart() {
      await client.query(
        `UPDATE conversation_sessions SET cart = '{"items":[]}'::jsonb, order_status = 'placed' WHERE customer_id = $1`,
        [customerId]
      );
    }

    async function updateCart(items) {
      // These are the same two bound values used by the n8n Postgres node:
      // $1 is a JSON array string and $2 is the session customer ID.
      const result = await client.query(updateCartQuery, [JSON.stringify(items), customerId]);
      assert(result.rows.length === 1, "Update Cart did not find the customer session");
      const row = result.rows[0];
      const session = await client.query(`SELECT order_status FROM conversation_sessions WHERE customer_id = $1`, [customerId]);
      assert(session.rows[0].order_status === "draft", "Cart update did not restore draft order state");
      return { ...row, items: row.cart.items };
    }

    const menuLine = (record, quantity = 1) => ({
      record_type: "menu_item",
      menu_item_id: Number(record.menu_item_id),
      variant_id: Number(record.variant_id),
      quantity,
    });
    const dealLine = (components, quantity = 1) => ({
      record_type: "deal",
      deal_id: Number(deal.id),
      quantity,
      selected_components: components,
    });
    const configA = choiceSets.map(({ group, choices }) => ({ selection_group: group, choice: choices[0] }));
    const configAReordered = [...configA].reverse();
    const alternateIndex = choiceSets.findIndex(({ choices }) => choices.length > 1);
    assert(alternateIndex >= 0, "Configurable deal needs one component with multiple valid choices");
    const configB = configA.map((entry, index) => index === alternateIndex
      ? { ...entry, choice: choiceSets[index].choices[1] }
      : { ...entry });

    // 1. Empty cart -> one pizza.
    await resetCart();
    let result = await updateCart([menuLine(itemA[0])]);
    assert(result.items.length === 1 && result.items[0].quantity === 1, "Test 1 failed: empty cart add");
    assert(Number(result.items[0].price) === Number(itemA[0].price), "Database price was not used");

    // 2. Existing pizza + same pizza -> quantity 2.
    result = await updateCart([menuLine(itemA[0])]);
    assert(result.items.length === 1 && result.items[0].quantity === 2, "Test 2 failed: same pizza merge");

    // 3. Same pizza, different size remains separate.
    result = await updateCart([menuLine(itemA[1])]);
    assert(result.items.length === 2 && new Set(result.items.map((item) => String(item.variant_id))).size === 2, "Test 3 failed: variants merged");

    // 4. Different pizza remains separate.
    result = await updateCart([menuLine(itemB[0])]);
    assert(result.items.length === 3, "Test 4 failed: different pizza missing");

    // 5. Empty cart -> configured deal.
    await resetCart();
    result = await updateCart([dealLine(configA)]);
    assert(result.items.length === 1 && result.items[0].record_type === "deal", "Test 5 failed: deal add");

    // 6. Same deal/configuration, even with component order changed, merges.
    result = await updateCart([dealLine(configAReordered)]);
    assert(result.items.length === 1 && result.items[0].quantity === 2, "Test 6 failed: same deal did not merge");

    // 7. Same deal with a different configuration remains separate.
    result = await updateCart([dealLine(configB)]);
    assert(result.items.length === 2, "Test 7 failed: distinct deal configurations merged");
    assert(result.items.some((item) => sameComponents(item.selected_components, configA)), "Configuration A missing");
    assert(result.items.some((item) => sameComponents(item.selected_components, configB)), "Configuration B missing");

    // 8. Multiple new lines, including duplicate input rows, aggregate correctly.
    await resetCart();
    result = await updateCart([menuLine(itemA[0]), menuLine(itemA[0]), menuLine(itemB[0]), dealLine(configA)]);
    assert(result.items.length === 3, "Test 8 failed: multiple new items");
    assert(result.items.find((item) => String(item.variant_id) === String(itemA[0].variant_id))?.quantity === 2, "Duplicate new pizza quantity incorrect");

    // 9. Invalid menu item is rejected without replacing the cart.
    const beforeInvalid = JSON.stringify(result.cart);
    result = await updateCart([{ record_type: "menu_item", menu_item_id: 999999999, variant_id: Number(itemA[0].variant_id), quantity: 1 }]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Test 9 failed: invalid menu item changed cart");

    // 10. Variant belonging to another item is rejected.
    result = await updateCart([menuLine({ menu_item_id: itemA[0].menu_item_id, variant_id: itemB[0].variant_id })]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Test 10 failed: invalid variant changed cart");

    // 11. Invalid deal is rejected.
    result = await updateCart([{ record_type: "deal", deal_id: 999999999, quantity: 1, selected_components: [] }]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Test 11 failed: invalid deal changed cart");

    // Deal component rules reject missing groups, unknown choices, and unknown groups.
    result = await updateCart([dealLine(configA.slice(0, -1))]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Missing deal component was accepted");
    result = await updateCart([dealLine(configA.map((entry, index) => index ? entry : { ...entry, choice: "Not A Real Menu Choice" }))]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Invalid deal choice was accepted");
    result = await updateCart([dealLine([...configA, { selection_group: "unknown", choice: configA[0].choice }])]);
    assert(result.rejected_item_count === 1 && JSON.stringify(result.cart) === beforeInvalid, "Unknown deal group was accepted");

    // 12. Existing mixed cart merges matching lines and preserves other lines.
    result = await updateCart([menuLine(itemA[0]), dealLine(configA)]);
    assert(result.items.length === 3, "Test 12 failed: mixed cart lines were lost");
    assert(result.items.find((item) => String(item.variant_id) === String(itemA[0].variant_id))?.quantity === 3, "Mixed cart pizza quantity incorrect");
    assert(result.items.find((item) => item.record_type === "deal")?.quantity === 2, "Mixed cart deal quantity incorrect");

    // Additional contract checks: decrement and exact-line removal.
    result = await updateCart([menuLine(itemA[0], -1)]);
    assert(result.items.find((item) => String(item.variant_id) === String(itemA[0].variant_id))?.quantity === 2, "Negative quantity decrement failed");
    result = await updateCart([dealLine(configA, 0)]);
    assert(!result.items.some((item) => item.record_type === "deal"), "Quantity zero did not remove exact deal line");

    await client.query("ROLLBACK");
    console.log("Cart tests 1-12: passed");
    console.log("Duplicate aggregation, canonical deal matching, component-rule validation, decrement, removal, and draft state: passed");
    console.log("n8n $1 JSON string and $2 customer ID bindings: passed");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
