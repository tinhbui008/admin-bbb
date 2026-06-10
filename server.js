const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CONFIG = require("./src/config");
const db = require("./src/db");
const { buildStats } = require("./src/services/statsBuilder");
const { processWebhookPayload } = require("./src/services/eventProcessor");
const {
  registerGlobalHook,
  listHooks,
  destroyHook,
  syncDashboardState,
  verifyBbbChecksum
} = require("./src/services/bbbApi");
const { handleHistoryRoutes } = require("./src/routes/history");
const statsDb = require("./src/db/queries/stats");
const webhookStatusDb = require("./src/db/queries/webhookStatus");

const sseClients = new Set();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function getRequestBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${CONFIG.port}`;
  return `${protocol}://${host}`;
}

function getExpectedCallbackUrl(req) {
  if (CONFIG.callbackUrl) {
    return CONFIG.callbackUrl;
  }
  return `${getRequestBaseUrl(req)}/webhook/bbb`;
}

function pushRealtimeUpdate(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

async function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const stats = await buildStats();
  res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
}

async function handleWebhook(req, res) {
  try {
    const rawBody = await getRawBody(req);
    const checksum = verifyBbbChecksum(req, rawBody, getRequestBaseUrl, getExpectedCallbackUrl);

    if (!checksum.valid) {
      await statsDb.incrementStat("checksum_rejected");
      await webhookStatusDb.updateWebhookStatus({ lastError: checksum.reason });
      sendJson(res, 401, { ok: false, error: checksum.reason });
      return;
    }

    const result = await processWebhookPayload(rawBody, req.headers["content-type"], true);
    const stats = await buildStats();
    pushRealtimeUpdate("stats", stats);

    sendJson(res, 200, {
      ok: true,
      checksumAlgorithm: checksum.algorithm,
      receivedCount: result.receivedCount,
      received: result.received,
      totals: stats.totals
    });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleReset(res) {
  try {
    await db.query("TRUNCATE events, meetings, classes, teachers, students, class_teachers, class_students, meeting_participants, live_rooms RESTART IDENTITY CASCADE");
    await db.query("UPDATE stats SET value = 0, updated_at = NOW()");
    await db.query("UPDATE webhook_status SET last_webhook_received_at = NULL, last_webhook_preview = NULL, last_error = NULL, updated_at = NOW() WHERE id = 1");

    const stats = await buildStats();
    pushRealtimeUpdate("stats", stats);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleStats(res) {
  try {
    await syncDashboardState();
    const stats = await buildStats();
    sendJson(res, 200, stats);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleRegisterHook(req, res) {
  try {
    const result = await registerGlobalHook(getExpectedCallbackUrl(req));
    sendJson(res, 200, result);
  } catch (error) {
    await webhookStatusDb.updateWebhookStatus({
      lastRegistrationAttemptAt: new Date().toISOString(),
      lastError: error.message
    });
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleListHooks(res) {
  try {
    const result = await listHooks();
    await syncDashboardState();
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleDestroyHook(req, res) {
  try {
    const rawBody = await getRawBody(req);
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    const result = await destroyHook(parsed.hookID);
    await syncDashboardState();
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleHealthCheck(res) {
  const dbHealth = await db.healthCheck();
  if (dbHealth.ok) {
    sendJson(res, 200, { ok: true, database: "connected", timestamp: dbHealth.timestamp });
  } else {
    sendJson(res, 503, { ok: false, database: "disconnected", error: dbHealth.error });
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, getRequestBaseUrl(req));

  if (req.method === "GET" && parsedUrl.pathname === "/") {
    sendFile(res, path.join(CONFIG.publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/stats") {
    await handleStats(res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/stream") {
    await handleSse(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
    await handleHealthCheck(res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/webhook/bbb") {
    await handleWebhook(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/hooks/register") {
    await handleRegisterHook(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/hooks/list") {
    await handleListHooks(res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/hooks/destroy") {
    await handleDestroyHook(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/reset") {
    await handleReset(res);
    return;
  }

  const handled = await handleHistoryRoutes(req, res, parsedUrl, sendJson);
  if (handled) {
    return;
  }

  sendText(res, 404, "Not found");
});

async function startServer() {
  console.log("Checking database connection...");
  const dbHealth = await db.healthCheck();

  if (!dbHealth.ok) {
    console.error("Database connection failed:", dbHealth.error);
    console.log("Server will start but database features may not work.");
    console.log("Run 'npm run migrate' to set up the database.");
  } else {
    console.log(`Database connected at ${dbHealth.timestamp}`);
  }

  server.listen(CONFIG.port, async () => {
    console.log(`BBB admin dashboard listening on http://localhost:${CONFIG.port}`);

    if (CONFIG.autoRegisterHook) {
      try {
        await registerGlobalHook();
        console.log("BBB global hook registered.");
      } catch (error) {
        console.error(`BBB hook registration failed: ${error.message}`);
      }
    }
  });
}

startServer();
