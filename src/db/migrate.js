const fs = require("fs");
const path = require("path");
const db = require("./index");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations() {
  const result = await db.query("SELECT name FROM migrations ORDER BY name");
  return new Set(result.rows.map(row => row.name));
}

async function runMigration(name, sql) {
  console.log(`Running migration: ${name}`);
  await db.transaction(async (client) => {
    await client.query(sql);
    await client.query("INSERT INTO migrations (name) VALUES ($1)", [name]);
  });
  console.log(`Completed: ${name}`);
}

async function migrate() {
  try {
    console.log("Checking database connection...");
    const health = await db.healthCheck();
    if (!health.ok) {
      throw new Error(`Database connection failed: ${health.error}`);
    }
    console.log(`Connected to database at ${health.timestamp}`);

    await ensureMigrationsTable();
    const executed = await getExecutedMigrations();

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort();

    let migrationsRun = 0;
    for (const file of files) {
      if (executed.has(file)) {
        console.log(`Skipping (already executed): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await runMigration(file, sql);
      migrationsRun++;
    }

    if (migrationsRun === 0) {
      console.log("No new migrations to run.");
    } else {
      console.log(`Successfully ran ${migrationsRun} migration(s).`);
    }

    await db.close();
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error.message);
    await db.close();
    process.exit(1);
  }
}

migrate();
