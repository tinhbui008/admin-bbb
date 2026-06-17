const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CONFIG = require("./src/config");
const db = require("./src/db");
const { buildStats, buildParticipantActivity } = require("./src/services/statsBuilder");
const { processWebhookPayload } = require("./src/services/eventProcessor");
const classesDb = require("./src/db/queries/classes");
const eventsDb = require("./src/db/queries/events");
const meetingsDb = require("./src/db/queries/meetings");
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

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function tryServeStatic(req, res, pathname) {
  if (req.method !== "GET" || pathname === "/") {
    return false;
  }

  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  const absolutePath = path.resolve(CONFIG.publicDir, relativePath);
  const publicRoot = path.resolve(CONFIG.publicDir) + path.sep;

  if (!absolutePath.startsWith(publicRoot) && absolutePath !== path.resolve(CONFIG.publicDir)) {
    return false;
  }

  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return false;
  }

  sendFile(res, absolutePath, getContentType(absolutePath));
  return true;
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
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*"
  });

  // Send initial newline to flush headers through nginx immediately
  res.write(":\n\n");

  try {
    const stats = await buildStats();
    res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  } catch (e) {
    console.error("SSE initial buildStats failed:", e.message);
  }

  sseClients.add(res);

  // Heartbeat every 25s to prevent nginx proxy_read_timeout (default 60s)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
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

    // Build stats without syncing live rooms from BBB
    const stats = await buildStats({ skipLiveSync: true });
    pushRealtimeUpdate("stats", stats);
    sendJson(res, 200, { ok: true, message: "Data cleared. Live rooms will reappear on next sync." });
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

async function handleDeleteClass(classId, res) {
  try {
    const existing = await classesDb.getClassById(classId);
    if (!existing) {
      sendJson(res, 404, { ok: false, error: "Class not found" });
      return;
    }
    await classesDb.deleteClass(classId);
    const stats = await buildStats({ skipLiveSync: true });
    pushRealtimeUpdate("stats", stats);
    sendJson(res, 200, { ok: true, message: "Class deleted" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleClassDetail(classId, res) {
  try {
    const classDetail = await classesDb.getClassDetails(classId);
    if (!classDetail) {
      sendJson(res, 404, { ok: false, error: "Class not found" });
      return;
    }

    const teacherIds = classDetail.teachers.map(t => t.teacherId);
    const studentNameMap = new Map(classDetail.students.map(s => [s.userId, s.userName]));
    const teacherNameMap = new Map(classDetail.teachers.map(t => [t.teacherId, t.teacherName]));

    const [relatedEvents, participantsData] = await Promise.all([
      eventsDb.getEventsByClassId(classId, 100),
      meetingsDb.getParticipantsByClassId(classId)
    ]);

    const participantActivity = await buildParticipantActivity(
      relatedEvents, teacherIds, studentNameMap, teacherNameMap, participantsData
    );

    sendJson(res, 200, { ok: true, ...classDetail, participantActivity });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
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

  if (tryServeStatic(req, res, parsedUrl.pathname)) {
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

  const classDeleteMatch = req.method === "DELETE" && parsedUrl.pathname.match(/^\/api\/classes\/(.+)$/);
  if (classDeleteMatch) {
    await handleDeleteClass(decodeURIComponent(classDeleteMatch[1]), res);
    return;
  }

  const classDetailMatch = req.method === "GET" && parsedUrl.pathname.match(/^\/api\/classes\/(.+)\/detail$/);
  if (classDetailMatch) {
    await handleClassDetail(decodeURIComponent(classDetailMatch[1]), res);
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
