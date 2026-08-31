require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const migrationName = process.argv[2];
if (!migrationName || !/^\d{3}_[a-z0-9_]+\.sql$/.test(migrationName)) {
  console.error("Usage: node scripts/run-migration.js 010_admin_dashboard.sql");
  process.exit(1);
}

const migrationPath = path.resolve(__dirname, "..", "..", "database", "migration", migrationName);
const sql = fs.readFileSync(migrationPath, "utf8");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});
const keepAlive = setInterval(() => {}, 1000);

pool.query(sql)
  .then(() => console.log(`Applied ${migrationName}`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(keepAlive);
    await pool.end();
  });
