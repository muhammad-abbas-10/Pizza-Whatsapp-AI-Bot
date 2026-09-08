require("dotenv").config();

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../database/migration/018_admin_username_password_auth.sql"),
  "utf8"
).replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration);
    const password = "database-test-password";
    const passwordHash = await bcrypt.hash(password, 12);
    const username = `auth-db-test-${Date.now()}`;
    const user = (await client.query(
      "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash",
      [username, passwordHash]
    )).rows[0];
    assert.notEqual(user.password_hash, password);
    assert(await bcrypt.compare(password, user.password_hash));

    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const session = (await client.query(
      "INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING token_hash",
      [user.id, tokenHash]
    )).rows[0];
    assert.equal(session.token_hash.length, 64);
    assert.notEqual(session.token_hash, rawToken);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
  console.log("Admin authentication migration and hashed credential/session storage test: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
