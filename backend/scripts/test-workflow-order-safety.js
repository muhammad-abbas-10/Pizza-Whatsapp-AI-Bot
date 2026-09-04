require("dotenv").config();

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const workflow = require("../../admin request.json");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../database/migration/016_dashboard_customer_status_events.sql"),
  "utf8"
).replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
const query = (name) => {
  const node = workflow.nodes.find((entry) => entry.name === name);
  assert(node, `Missing workflow node ${name}`);
  return node.parameters.query;
};

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration);
    const variants = (await client.query(`
      SELECT mi.id AS menu_item_id, mi.name, mv.id AS variant_id, mv.variant_label, mv.price
      FROM restaurant_menu_items mi JOIN restaurant_menu_variants mv ON mv.menu_item_id = mi.id
      WHERE mi.active = TRUE AND mv.active = TRUE ORDER BY mi.id, mv.id LIMIT 20`)).rows;
    const valid = variants[0];
    const other = variants.find((entry) => String(entry.menu_item_id) !== String(valid.menu_item_id));
    assert(valid && other, "Active menu data is insufficient for order safety tests");

    const phone = `order-safety-${Date.now()}`;
    const customerId = (await client.query("INSERT INTO customers (whatsapp_phone, name) VALUES ($1, 'Order Safety') RETURNING id", [phone])).rows[0].id;
    await client.query("INSERT INTO conversation_sessions (customer_id, order_type) VALUES ($1, 'pickup')", [customerId]);
    const line = {
      record_type: "menu_item", menu_item_id: Number(valid.menu_item_id), variant_id: Number(valid.variant_id),
      item_name: valid.name, size: valid.variant_label, quantity: 1,
      price: Number(valid.price), line_total: Number(valid.price), selected_components: [],
    };
    const setCart = async (item) => client.query(
      "UPDATE conversation_sessions SET cart = jsonb_build_object('items', $2::jsonb), order_type = 'pickup', order_status = 'draft' WHERE customer_id = $1",
      [customerId, JSON.stringify([item])],
    );

    await setCart(line);
    const placed = (await client.query(query("Place Order"), [customerId])).rows[0];
    assert.equal(placed.order_created, true);
    assert.deepEqual(placed.invalid_items, []);

    const upsertState = (await client.query(query("Upsert Customer and Session"), [phone, "Order Safety"])).rows[0];
    assert.equal(upsertState.active_order_status, "received", "Active order status was not loaded from orders");
    const corrected = await client.query(query("Update Placed Order Delivery Info"), [customerId, placed.id, "Correct Name", "Correct Address"]);
    assert.equal(corrected.rows.length, 1);
    await client.query("UPDATE orders SET status = 'preparing' WHERE id = $1", [placed.id]);
    await client.query("UPDATE orders SET status = 'oven' WHERE id = $1", [placed.id]);
    await client.query("UPDATE orders SET status = 'completed' WHERE id = $1", [placed.id]);
    const tooLate = await client.query(query("Update Placed Order Delivery Info"), [customerId, placed.id, "Late Name", "Late Address"]);
    assert.equal(tooLate.rows.length, 0, "Delivery information changed after the allowed order states");

    const invalidCases = [
      { ...line, item_name: "Invalid menu item", menu_item_id: 999999999 },
      { ...line, item_name: "Mismatched variant", variant_id: Number(other.variant_id) },
      { record_type: "deal", deal_id: 999999999, item_name: "Invalid deal", quantity: 1, price: 1, line_total: 1, selected_components: [] },
    ];
    for (const invalid of invalidCases) {
      await setCart(invalid);
      const result = (await client.query(query("Place Order"), [customerId])).rows[0];
      assert.equal(result.order_created, false);
      assert(result.invalid_items.includes(invalid.item_name), `${invalid.item_name} was not reported`);
    }

    const firstEscalation = (await client.query(query("Escalate To Human"), [customerId, "Wrong delivered item"])).rows[0];
    const secondEscalation = (await client.query(query("Escalate To Human"), [customerId, "Customer requested a person"])).rows[0];
    assert(firstEscalation.admin_notification_id && secondEscalation.admin_notification_id);
    assert.notEqual(firstEscalation.admin_notification_id, secondEscalation.admin_notification_id);

    await client.query("ROLLBACK");
    console.log("Order revalidation, active status, placed-order edit guard, and escalation persistence: PASS");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
