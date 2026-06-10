const { Pool } = require("pg");
const CONFIG = require("../config");

const pool = new Pool({
  connectionString: CONFIG.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log("Slow query:", { text: text.slice(0, 100), duration, rows: result.rowCount });
    }
    return result;
  } catch (error) {
    console.error("Query error:", { text: text.slice(0, 100), error: error.message });
    throw error;
  }
}

async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  client.release = () => {
    client.release = originalRelease;
    return originalRelease();
  };
  return client;
}

async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    const result = await query("SELECT NOW()");
    return { ok: true, timestamp: result.rows[0].now };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getClient,
  transaction,
  healthCheck,
  close
};
