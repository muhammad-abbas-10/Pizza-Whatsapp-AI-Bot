const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { parseFeedback } = require("../src/feedback-parser");
const { root, loadWorkflow } = require("./workflow-fixture");

require("dotenv").config({ quiet: true });

if (!process.env.DATABASE_URL) {
  console.log("Feedback database test: SKIPPED (DATABASE_URL is not configured)");
  process.exit(0);
}

const migration = fs.readFileSync(
  path.join(root, "database/migration/020_post_delivery_feedback.sql"),
  "utf8"
).replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
const workflow = loadWorkflow();
const saveFeedbackSql = workflow.nodes.find((node) => node.name === "Save Customer Feedback")?.parameters?.query;
assert(saveFeedbackSql, "Save Customer Feedback SQL is missing");

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE customers (
        id BIGSERIAL PRIMARY KEY,
        whatsapp_phone TEXT UNIQUE NOT NULL,
        name TEXT
      );
      CREATE TEMP TABLE orders (
        id BIGSERIAL PRIMARY KEY,
        customer_id BIGINT NOT NULL REFERENCES customers(id),
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TEMP TABLE conversation_sessions (
        id BIGSERIAL PRIMARY KEY,
        customer_id BIGINT UNIQUE NOT NULL REFERENCES customers(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TEMP TABLE feedback (
        id BIGSERIAL PRIMARY KEY,
        customer_id BIGINT NOT NULL REFERENCES customers(id),
        order_id BIGINT REFERENCES orders(id),
        rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      SET LOCAL search_path TO pg_temp, public;
    `);
    await client.query(migration);

    const customer = (await client.query(
      "INSERT INTO customers (whatsapp_phone, name) VALUES ($1, $2) RETURNING id",
      [`feedback-test-${Date.now()}`, "Feedback Test"]
    )).rows[0];
    const order = (await client.query(
      "INSERT INTO orders (customer_id, status) VALUES ($1, 'completed') RETURNING id",
      [customer.id]
    )).rows[0];
    await client.query(
      "INSERT INTO conversation_sessions (customer_id, awaiting_feedback_order_id) VALUES ($1, $2)",
      [customer.id, order.id]
    );

    const ratingOnly = parseFeedback("10/10");
    await client.query(saveFeedbackSql, [customer.id, order.id, ratingOnly.rating, ratingOnly.message]);
    const commentOnly = parseFeedback("amazing pizza!");
    await client.query(saveFeedbackSql, [customer.id, order.id, commentOnly.rating, commentOnly.message]);

    const adminResult = await client.query(`
      SELECT f.id, f.rating, f.message, f.order_id, f.created_at,
             c.name AS customer_name, c.whatsapp_phone AS customer_phone
      FROM feedback f
      JOIN customers c ON c.id = f.customer_id
      WHERE f.order_id = $1
    `, [order.id]);
    assert.equal(adminResult.rowCount, 1, "Expected one feedback record for the order");
    assert.equal(adminResult.rows[0].rating, 5);
    assert.equal(adminResult.rows[0].message, "amazing pizza!");
    assert.equal(adminResult.rows[0].customer_name, "Feedback Test");

    await client.query(`
      UPDATE conversation_sessions cs
      SET awaiting_feedback_order_id = CASE
        WHEN EXISTS (
          SELECT 1 FROM feedback f
          WHERE f.order_id = cs.awaiting_feedback_order_id
            AND f.customer_id = cs.customer_id
        ) THEN NULL ELSE cs.awaiting_feedback_order_id END
      WHERE cs.customer_id = $1
    `, [customer.id]);
    const session = await client.query(
      "SELECT awaiting_feedback_order_id FROM conversation_sessions WHERE customer_id = $1",
      [customer.id]
    );
    assert.equal(session.rows[0].awaiting_feedback_order_id, null);

    console.log("Feedback migration, one-row-per-order upsert, admin query, and session reset: PASS");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
