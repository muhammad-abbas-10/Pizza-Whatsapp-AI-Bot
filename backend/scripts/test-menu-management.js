const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
  CANONICAL_MENU_DELETE_TABLES,
  deleteCanonicalMenuData,
  deleteMenuImage,
} = require("../src/menu-management");
const { hasValidImageSignature } = require("../src/menu-image-validation");

require("dotenv").config({ quiet: true });

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const adminRoutes = read("backend/src/admin-routes.js");
const apiIndex = read("backend/api/index.js");
const frontend = read("frontend/src/main.js");

const expectedMenuTables = [
  "restaurant_deal_components",
  "restaurant_deals",
  "restaurant_menu_aliases",
  "restaurant_menu_variants",
  "restaurant_menu_items",
  "restaurant_menu_rules",
];
const protectedTables = [
  "menu_images",
  "orders",
  "customers",
  "feedback",
  "restaurant_settings",
  "admin_users",
  "conversation_sessions",
  "customer_notification_events",
];

assert.deepEqual(CANONICAL_MENU_DELETE_TABLES, expectedMenuTables);
protectedTables.forEach((table) => {
  assert(!CANONICAL_MENU_DELETE_TABLES.includes(table), `${table} must not be bulk-deleted`);
});
assert(adminRoutes.indexOf('app.use("/admin", requireAdminSession)') < adminRoutes.indexOf('app.delete("/admin/menu/images/:id"'));
assert(adminRoutes.indexOf('app.delete("/admin/menu/images/:id"') < adminRoutes.indexOf('app.delete("/admin/menu/:kind/:id"'));
assert(adminRoutes.includes('req.body?.confirm !== true'));
assert(adminRoutes.includes("deleteMenuImage(pool, imageId)"));
assert(adminRoutes.includes('req.body?.confirmation !== "DELETE ENTIRE MENU"'));
assert(adminRoutes.includes('await client.query("BEGIN")'));
assert(adminRoutes.includes('await client.query("ROLLBACK")'));
assert(apiIndex.includes('requireAdminSession,\n  upload.array("images", 3)'));
assert(apiIndex.includes("hasValidImageSignature"));
assert(!apiIndex.includes("Please upload at least 2 images"));
assert(frontend.includes("Add menu image"));
assert(frontend.includes("Are you sure you want to delete this menu image? This action cannot be undone."));
assert(frontend.includes("Menu images, orders, customers, feedback, settings, sessions, notifications, and admin accounts will not be deleted."));
assert(frontend.includes('confirmation: "DELETE ENTIRE MENU"'));

const validImages = [
  { mimetype: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]) },
  { mimetype: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  { mimetype: "image/gif", buffer: Buffer.from("GIF89a", "ascii") },
  { mimetype: "image/webp", buffer: Buffer.from("RIFF0000WEBP", "ascii") },
];
validImages.forEach((file) => assert.equal(hasValidImageSignature(file), true));
assert.equal(hasValidImageSignature({ mimetype: "image/png", buffer: Buffer.from("not an image") }), false);
assert.equal(hasValidImageSignature({ mimetype: "text/plain", buffer: Buffer.from("GIF89a") }), false);

async function runDatabaseIsolationTest() {
  if (!process.env.DATABASE_URL) {
    console.log("Menu management database isolation: SKIPPED (DATABASE_URL is not configured)");
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE restaurant_menu_rules (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE restaurant_menu_items (id BIGSERIAL PRIMARY KEY, name TEXT);
      CREATE TEMP TABLE restaurant_menu_variants (id BIGSERIAL PRIMARY KEY, item_id BIGINT REFERENCES restaurant_menu_items(id), label TEXT);
      CREATE TEMP TABLE restaurant_menu_aliases (id BIGSERIAL PRIMARY KEY, item_id BIGINT REFERENCES restaurant_menu_items(id), alias TEXT);
      CREATE TEMP TABLE restaurant_deals (id BIGSERIAL PRIMARY KEY, name TEXT);
      CREATE TEMP TABLE restaurant_deal_components (id BIGSERIAL PRIMARY KEY, deal_id BIGINT REFERENCES restaurant_deals(id), value TEXT);
      CREATE TEMP TABLE menu_images (id BIGSERIAL PRIMARY KEY, name TEXT);
      CREATE TEMP TABLE orders (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE customers (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE feedback (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE restaurant_settings (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE admin_users (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE conversation_sessions (id BIGSERIAL PRIMARY KEY, value TEXT);
      CREATE TEMP TABLE customer_notification_events (id BIGSERIAL PRIMARY KEY, value TEXT);
      SET LOCAL search_path TO pg_temp, public;

      INSERT INTO restaurant_menu_rules (value) VALUES ('rule');
      INSERT INTO restaurant_menu_items (name) VALUES ('item');
      INSERT INTO restaurant_menu_variants (item_id, label) VALUES (1, 'variant');
      INSERT INTO restaurant_menu_aliases (item_id, alias) VALUES (1, 'alias');
      INSERT INTO restaurant_deals (name) VALUES ('deal');
      INSERT INTO restaurant_deal_components (deal_id, value) VALUES (1, 'component');
      INSERT INTO menu_images (name) VALUES ('selected image'), ('image to keep');
      INSERT INTO orders (value) VALUES ('order');
      INSERT INTO customers (value) VALUES ('customer');
      INSERT INTO feedback (value) VALUES ('feedback');
      INSERT INTO restaurant_settings (value) VALUES ('settings');
      INSERT INTO admin_users (value) VALUES ('admin');
      INSERT INTO conversation_sessions (value) VALUES ('session');
      INSERT INTO customer_notification_events (value) VALUES ('notification');
    `);

    const deletedImage = await deleteMenuImage(client, 1);
    assert.equal(String(deletedImage.id), "1");
    const remainingImages = await client.query("SELECT id, name FROM menu_images ORDER BY id");
    assert.deepEqual(remainingImages.rows.map((row) => row.name), ["image to keep"]);

    const deleted = await deleteCanonicalMenuData(client);
    expectedMenuTables.forEach((table) => assert.equal(deleted[table], 1, `Expected one deleted row from ${table}`));

    for (const table of expectedMenuTables) {
      const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      assert.equal(result.rows[0].count, 0, `${table} should be empty`);
    }
    for (const table of protectedTables) {
      const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      assert.equal(result.rows[0].count, 1, `${table} should be unchanged`);
    }
    console.log("Menu management database isolation: PASS");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

runDatabaseIsolationTest()
  .then(() => console.log("Menu management routes, confirmations, upload validation, and table scope: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
