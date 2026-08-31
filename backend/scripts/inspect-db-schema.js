require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

console.log("Inspecting database schema...");

async function main() {
  console.log("Connecting...");
  const client = await pool.connect();
  const database = await client.query("SELECT current_database() AS database, current_schema() AS schema");
  console.log(`Database: ${database.rows[0].database}; schema: ${database.rows[0].schema}`);
  const tables = await client.query(`
    SELECT schemaname, tablename FROM pg_catalog.pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, tablename
  `);
  console.log(tables.rows.map((row) => `${row.schemaname}.${row.tablename}`).join("\n"));
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_name, ordinal_position
  `);

  let currentTable = null;
  for (const row of rows) {
    if (row.table_name !== currentTable) {
      currentTable = row.table_name;
      console.log(`\n[${currentTable}]`);
    }
    console.log(`${row.column_name}: ${row.data_type} ${row.is_nullable === "NO" ? "NOT NULL" : ""}`.trim());
  }
  client.release();
}

const keepAlive = setInterval(() => {}, 1000);

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(keepAlive);
    await pool.end();
  });
