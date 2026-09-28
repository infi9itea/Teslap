// Waits until Postgres accepts real TCP connections before the API runs
// migrations. Needed because the official postgres image briefly runs a
// temporary socket-only server during first-time init, which can make a
// socket-based healthcheck pass before TCP connections actually work. This
// makes API startup robust regardless of how slow the database is to come up.
const { Client } = require("pg");

const RETRIES = Number(process.env.WAIT_RETRIES || 30);
const DELAY_MS = Number(process.env.WAIT_DELAY_MS || 1000);
const CONNECT_TIMEOUT_MS = Number(process.env.WAIT_CONNECT_TIMEOUT_MS || 5000);

async function tryConnect() {
  // connectionTimeoutMillis turns a silent network hang into a visible, retried error.
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  await client.query("SELECT 1");
  await client.end();
}

async function main() {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await tryConnect();
      console.log(`Database is accepting connections (attempt ${attempt}).`);
      return;
    } catch (err) {
      console.log(`Waiting for database (attempt ${attempt}/${RETRIES}): ${err.message}`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.error("Database never became reachable, giving up.");
  process.exit(1);
}

main();
