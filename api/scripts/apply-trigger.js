// Applies prisma/sql/enforce_capacity_trigger.sql automatically as part of
// container startup (see docker-compose.yml), so the Docker deployment
// doesn't depend on a human remembering to run this by hand.
//
// Uses the raw 'pg' driver rather than Prisma's $executeRawUnsafe because
// this file is a multi-statement script (function + trigger, separated by
// semicolons), and node-postgres's simple query protocol (used when no
// parameters are passed to .query()) supports multiple statements in one
// call; Prisma's raw-query helpers are built around single prepared
// statements and aren't a good fit for this.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const sqlPath = path.join(__dirname, "..", "prisma", "sql", "enforce_capacity_trigger.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log("Capacity trigger applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply capacity trigger:", err.message);
  process.exit(1);
});
