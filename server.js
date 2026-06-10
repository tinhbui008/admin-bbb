const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL, URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

loadEnvFile(path.join(__dirname, ".env"));

const CONFIG = {
  bbbApiBaseUrl: normalizeApiBaseUrl(process.env.BBB_API_BASE_URL || ""),
  bbbSharedSecret: process.env.BBB_SHARED_SECRET || "",
  callbackUrl: process.env.BBB_CALLBACK_URL || "",
  autoRegisterHook: /^true$/i.test(process.env.BBB_AUTO_REGISTER_HOOK || ""),
  getRaw: /^true$/i.test(process.env.BBB_GET_RAW || ""),
  eventIds: process.env.BBB_EVENT_IDS || "",
  useBearerAuth: /^true$/i.test(process.env.BBB_USE_BEARER_AUTH || "")
};

const sseClients = new Set();

function createEmptyStore() {
  return {
    totals: {
      events: 0,
      meetingsCreated: 0,
      meetingsEnded: 0,
      participantsJoined: 0,
      participantsLeft: 0,
      checksumVerified: 0,
      checksumRejected: 0
    },
    meetings: {},
    users: {},
    classes: {},
    recentEvents: [],
    webhookStatus: {
      configured: Boolean(CONFIG.bbbApiBaseUrl && CONFIG.bbbSharedSecret && CONFIG.callbackUrl),
      callbackUrl: CONFIG.callbackUrl || null,
      expectedCallbackUrl: CONFIG.callbackUrl || null,
      bbbApiBaseUrl: CONFIG.bbbApiBaseUrl || null,
      getRaw: CONFIG.getRaw,
      eventIds: CONFIG.eventIds || null,
      registeredHookId: null,
      matchingHookIds: [],
      allHooks: [],
      lastHookSyncAt: null,
      lastRegistrationAttemptAt: null,
      lastRegistrationResult: null,
      lastError: null
    }
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function normalizeApiBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORE_FILE)) {
    writeStore(createEmptyStore());
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  const defaults = createEmptyStore();

  store.totals = { ...defaults.totals, ...(store.totals || {}) };
  store.meetings = store.meetings || {};
  store.users = store.users || {};
  store.classes = store.classes || {};
  store.recentEvents = Array.isArray(store.recentEvents) ? store.recentEvents : [];
  store.webhookStatus = { ...defaults.webhookStatus, ...(store.webhookStatus || {}) };

  return store;
}

function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function pushRealtimeUpdate(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

function persistStore(mutator) {
  const store = readStore();
  const nextStore = mutator(store) || store;
  writeStore(nextStore);
  pushRealtimeUpdate("stats", buildStats(nextStore));
  return nextStore;
}

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

function parseIncomingBody(rawBody, contentType) {
  if (!rawBody) {
    return { rawBody: "", parsedBody: {}, formFields: {} };
  }

  if ((contentType || "").includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const fields = {};

    for (const [key, value] of params.entries()) {
      fields[key] = value;
    }

    let parsedEvent = fields.event;
    if (typeof parsedEvent === "string") {
      try {
        parsedEvent = JSON.parse(parsedEvent);
      } catch (error) {
        parsedEvent = { rawEvent: fields.event };
      }
    }

    return {
      rawBody,
      parsedBody: parsedEvent || {},
      formFields: fields
    };
  }

  if ((contentType || "").includes("application/json")) {
    return {
      rawBody,
      parsedBody: JSON.parse(rawBody),
      formFields: {}
    };
  }

  return {
    rawBody,
    parsedBody: {},
    formFields: {}
  };
}

function pickFirstValue(object, paths) {
  for (const pathKey of paths) {
    const value = pathKey.split(".").reduce((current, key) => {
      if (current && typeof current === "object") {
        return current[key];
      }

      return undefined;
    }, object);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return null;
}

function normalizeEvent(payload, formFields) {
  const eventName =
    pickFirstValue(payload, [
      "event",
      "eventName",
      "data.id",
      "data.eventName",
      "data.type",
      "data.attributes.eventName",
      "core.header.name",
      "envelope.name"
    ]) || "unknown";

  const meetingId =
    pickFirstValue(payload, [
      "meetingId",
      "meeting.id",
      "data.attributes.meeting.external-meeting-id",
      "data.attributes.meeting.externalMeetingId",
      "data.attributes.meeting.meetingId",
      "data.attributes.meeting.id",
      "data.meetingId",
      "core.body.meetingId",
      "core.body.props.meetingProp.intId",
      "core.body.props.meetingProp.extId"
    ]) || "unknown-meeting";

  const userId =
    pickFirstValue(payload, [
      "userId",
      "user.id",
      "data.attributes.user.userId",
      "data.attributes.user.external-user-id",
      "data.attributes.user.id",
      "data.attributes.attendee.userId",
      "data.attributes.attendee.externalUserId",
      "core.body.userId",
      "core.body.intId"
    ]) || null;

  const userName =
    pickFirstValue(payload, [
      "userName",
      "user.name",
      "data.attributes.user.name",
      "data.attributes.user.fullname",
      "data.attributes.attendee.name",
      "core.body.name"
    ]) || null;

  const classId =
    pickFirstValue(payload, [
      "classId",
      "metadata.classId",
      "meta.classId",
      "data.classId",
      "data.metadata.classId",
      "data.attributes.meeting.classId",
      "data.attributes.meeting.metadata.classId"
    ]) || "unmapped";

  const teacherId =
    pickFirstValue(payload, [
      "teacherId",
      "metadata.teacherId",
      "meta.teacherId",
      "data.teacherId",
      "data.metadata.teacherId",
      "data.attributes.meeting.teacherId",
      "data.attributes.meeting.metadata.teacherId"
    ]) || null;

  const timestamp =
    pickFirstValue(payload, [
      "timestamp",
      "time",
      "createdAt",
      "data.event.ts",
      "data.ts",
      "core.header.currentTime"
    ]) ||
    formFields.timestamp ||
    new Date().toISOString();

  return {
    eventName: String(eventName),
    meetingId: String(meetingId),
    userId: userId ? String(userId) : null,
    userName: userName ? String(userName) : null,
    classId: String(classId),
    teacherId: teacherId ? String(teacherId) : null,
    timestamp,
    raw: payload
  };
}

function isJoinEvent(eventName) {
  return /user.*join|participant.*join|joined/i.test(eventName);
}

function isLeaveEvent(eventName) {
  return /user.*left|user.*leave|participant.*left|participant.*leave|left/i.test(eventName);
}

function isMeetingCreatedEvent(eventName) {
  return /meeting.*create|create.*meeting/i.test(eventName);
}

function isMeetingEndedEvent(eventName) {
  return /meeting.*end|destroy|ended/i.test(eventName);
}

function updateStoreFromEvent(normalized, checksumValid) {
  return persistStore(store => {
    store.totals.events += 1;

    if (checksumValid) {
      store.totals.checksumVerified += 1;
    } else {
      store.totals.checksumRejected += 1;
    }

    if (!store.meetings[normalized.meetingId]) {
      store.meetings[normalized.meetingId] = {
        meetingId: normalized.meetingId,
        classId: normalized.classId,
        teacherId: normalized.teacherId,
        createdEvents: 0,
        endedEvents: 0,
        joinEvents: 0,
        leaveEvents: 0,
        users: {}
      };
    }

    const meeting = store.meetings[normalized.meetingId];
    meeting.classId = normalized.classId || meeting.classId;
    meeting.teacherId = normalized.teacherId || meeting.teacherId;

    if (normalized.userId && !store.users[normalized.userId]) {
      store.users[normalized.userId] = {
        userId: normalized.userId,
        userName: normalized.userName,
        joinCount: 0,
        leaveCount: 0,
        lastMeetingId: normalized.meetingId
      };
    }

    if (normalized.userId && normalized.userName) {
      store.users[normalized.userId].userName = normalized.userName;
    }

    if (normalized.classId && !store.classes[normalized.classId]) {
      store.classes[normalized.classId] = {
        classId: normalized.classId,
        meetings: {}
      };
    }

    if (normalized.classId) {
      store.classes[normalized.classId].meetings[normalized.meetingId] = true;
    }

    if (isMeetingCreatedEvent(normalized.eventName)) {
      store.totals.meetingsCreated += 1;
      meeting.createdEvents += 1;
    }

    if (isMeetingEndedEvent(normalized.eventName)) {
      store.totals.meetingsEnded += 1;
      meeting.endedEvents += 1;
    }

    if (isJoinEvent(normalized.eventName)) {
      store.totals.participantsJoined += 1;
      meeting.joinEvents += 1;

      if (normalized.userId) {
        store.users[normalized.userId].joinCount += 1;
        store.users[normalized.userId].lastMeetingId = normalized.meetingId;
        meeting.users[normalized.userId] = normalized.userName || normalized.userId;
      }
    }

    if (isLeaveEvent(normalized.eventName)) {
      store.totals.participantsLeft += 1;
      meeting.leaveEvents += 1;

      if (normalized.userId) {
        store.users[normalized.userId].leaveCount += 1;
        store.users[normalized.userId].lastMeetingId = normalized.meetingId;
        meeting.users[normalized.userId] = normalized.userName || store.users[normalized.userId].userName || normalized.userId;
      }
    }

    store.recentEvents.unshift({
      eventName: normalized.eventName,
      meetingId: normalized.meetingId,
      userId: normalized.userId,
      userName: normalized.userName,
      classId: normalized.classId,
      teacherId: normalized.teacherId,
      timestamp: normalized.timestamp,
      checksumValid
    });

    store.recentEvents = store.recentEvents.slice(0, 100);
    return store;
  });
}

function buildStats(store) {
  const meetings = Object.values(store.meetings);
  const users = Object.values(store.users);
  const classes = Object.values(store.classes);
  const classMap = new Map();
  const teacherMap = new Map();
  const studentMap = new Map();
  const hasApiBaseUrl = Boolean(CONFIG.bbbApiBaseUrl);
  const hasSharedSecret = Boolean(CONFIG.bbbSharedSecret);
  const hasCallbackUrl = Boolean(CONFIG.callbackUrl || store.webhookStatus.callbackUrl);
  const missingEnv = [];

  if (!hasApiBaseUrl) {
    missingEnv.push("BBB_API_BASE_URL");
  }

  if (!hasSharedSecret) {
    missingEnv.push("BBB_SHARED_SECRET");
  }

  if (!hasCallbackUrl) {
    missingEnv.push("BBB_CALLBACK_URL");
  }

  for (const meeting of meetings) {
    const classId = meeting.classId || "unmapped";
    const classEntry = classMap.get(classId) || {
      classId,
      meetingIds: new Set(),
      teacherIds: new Set(),
      studentIds: new Set(),
      joinEvents: 0,
      leaveEvents: 0
    };
    classEntry.meetingIds.add(meeting.meetingId);
    classEntry.joinEvents += meeting.joinEvents || 0;
    classEntry.leaveEvents += meeting.leaveEvents || 0;
    if (meeting.teacherId) {
      classEntry.teacherIds.add(meeting.teacherId);
    }
    for (const userId of Object.keys(meeting.users || {})) {
      classEntry.studentIds.add(userId);
    }
    classMap.set(classId, classEntry);

    const teacherId = meeting.teacherId || "unassigned";
    const teacherEntry = teacherMap.get(teacherId) || {
      teacherId,
      classIds: new Set(),
      meetingIds: new Set(),
      studentIds: new Set(),
      joinEvents: 0,
      leaveEvents: 0
    };
    teacherEntry.meetingIds.add(meeting.meetingId);
    teacherEntry.joinEvents += meeting.joinEvents || 0;
    teacherEntry.leaveEvents += meeting.leaveEvents || 0;
    if (meeting.classId) {
      teacherEntry.classIds.add(meeting.classId);
    }
    for (const userId of Object.keys(meeting.users || {})) {
      teacherEntry.studentIds.add(userId);
    }
    teacherMap.set(teacherId, teacherEntry);
  }

  for (const event of store.recentEvents) {
    if (event.classId) {
      const classEntry = classMap.get(event.classId) || {
        classId: event.classId,
        meetingIds: new Set(),
        teacherIds: new Set(),
        studentIds: new Set(),
        joinEvents: 0,
        leaveEvents: 0
      };
      if (event.meetingId) {
        classEntry.meetingIds.add(event.meetingId);
      }
      if (event.teacherId) {
        classEntry.teacherIds.add(event.teacherId);
      }
      if (event.userId) {
        classEntry.studentIds.add(event.userId);
      }
      classMap.set(event.classId, classEntry);
    }

    if (event.teacherId) {
      const teacherEntry = teacherMap.get(event.teacherId) || {
        teacherId: event.teacherId,
        classIds: new Set(),
        meetingIds: new Set(),
        studentIds: new Set(),
        joinEvents: 0,
        leaveEvents: 0
      };
      if (event.classId) {
        teacherEntry.classIds.add(event.classId);
      }
      if (event.meetingId) {
        teacherEntry.meetingIds.add(event.meetingId);
      }
      if (event.userId) {
        teacherEntry.studentIds.add(event.userId);
      }
      teacherMap.set(event.teacherId, teacherEntry);
    }
  }

  for (const user of users) {
    const studentEntry = {
      userId: user.userId,
      userName: user.userName,
      joins: user.joinCount || 0,
      leaves: user.leaveCount || 0,
      lastMeetingId: user.lastMeetingId || null,
      classIds: new Set(),
      teacherIds: new Set()
    };

    for (const meeting of meetings) {
      if (meeting.users && Object.prototype.hasOwnProperty.call(meeting.users, user.userId)) {
        if (meeting.classId) {
          studentEntry.classIds.add(meeting.classId);
        }
        if (meeting.teacherId) {
          studentEntry.teacherIds.add(meeting.teacherId);
        }
      }
    }

    for (const event of store.recentEvents) {
      if (event.userId === user.userId) {
        if (event.classId) {
          studentEntry.classIds.add(event.classId);
        }
        if (event.teacherId) {
          studentEntry.teacherIds.add(event.teacherId);
        }
      }
    }

    studentMap.set(user.userId, studentEntry);
  }

  const topClasses = Array.from(classMap.values())
    .map(item => ({
      classId: item.classId,
      meetings: item.meetingIds.size,
      teachers: item.teacherIds.size,
      students: item.studentIds.size,
      joinEvents: item.joinEvents,
      leaveEvents: item.leaveEvents
    }))
    .sort((a, b) => b.joinEvents - a.joinEvents)
    .slice(0, 10);

  const topTeachers = Array.from(teacherMap.values())
    .map(item => ({
      teacherId: item.teacherId,
      classes: item.classIds.size,
      meetings: item.meetingIds.size,
      students: item.studentIds.size,
      joinEvents: item.joinEvents,
      leaveEvents: item.leaveEvents
    }))
    .sort((a, b) => b.joinEvents - a.joinEvents)
    .slice(0, 10);

  const topStudents = Array.from(studentMap.values())
    .map(item => ({
      userId: item.userId,
      userName: item.userName,
      joins: item.joins,
      leaves: item.leaves,
      lastMeetingId: item.lastMeetingId,
      classes: item.classIds.size,
      teachers: item.teacherIds.size
    }))
    .sort((a, b) => (b.joins - a.joins) || (b.leaves - a.leaves))
    .slice(0, 10);

  const classDetails = Array.from(classMap.values())
    .map(item => {
      const relatedMeetings = meetings
        .filter(meeting => meeting.classId === item.classId)
        .map(meeting => ({
          meetingId: meeting.meetingId,
          teacherId: meeting.teacherId || null,
          joinEvents: meeting.joinEvents || 0,
          leaveEvents: meeting.leaveEvents || 0,
          students: Object.keys(meeting.users || {}).length
        }))
        .sort((a, b) => b.joinEvents - a.joinEvents);

      const teacherIds = Array.from(item.teacherIds);
      const students = Array.from(item.studentIds)
        .map(userId => {
          const user = store.users[userId] || {};
          return {
            userId,
            userName: user.userName || userId,
            joinCount: user.joinCount || 0,
            leaveCount: user.leaveCount || 0,
            lastMeetingId: user.lastMeetingId || null
          };
        })
        .sort((a, b) => b.joinCount - a.joinCount);

      return {
        classId: item.classId,
        meetings: relatedMeetings,
        teachers: teacherIds.map(teacherId => ({
          teacherId,
          meetings: relatedMeetings.filter(meeting => meeting.teacherId === teacherId).length
        })),
        students,
        totals: {
          meetings: item.meetingIds.size,
          teachers: teacherIds.length,
          students: students.length,
          joinEvents: item.joinEvents,
          leaveEvents: item.leaveEvents
        },
        recentEvents: store.recentEvents.filter(event => event.classId === item.classId).slice(0, 12)
      };
    })
    .sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);

  const teacherDetails = Array.from(teacherMap.values())
    .map(item => ({
      teacherId: item.teacherId,
      classIds: Array.from(item.classIds),
      studentIds: Array.from(item.studentIds),
      totals: {
        classes: item.classIds.size,
        meetings: item.meetingIds.size,
        students: item.studentIds.size,
        joinEvents: item.joinEvents,
        leaveEvents: item.leaveEvents
      },
      recentEvents: store.recentEvents.filter(event => (event.teacherId || "unassigned") === item.teacherId).slice(0, 10)
    }))
    .sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);

  const studentDetails = Array.from(studentMap.values())
    .map(item => ({
      userId: item.userId,
      userName: item.userName || item.userId,
      classIds: Array.from(item.classIds),
      teacherIds: Array.from(item.teacherIds),
      totals: {
        joins: item.joins,
        leaves: item.leaves
      },
      lastMeetingId: item.lastMeetingId,
      recentEvents: store.recentEvents.filter(event => event.userId === item.userId).slice(0, 10)
    }))
    .sort((a, b) => (b.totals.joins - a.totals.joins) || (b.totals.leaves - a.totals.leaves));

  return {
    totals: store.totals,
    summary: {
      uniqueMeetings: meetings.length,
      uniqueUsers: users.length,
      uniqueClasses: classes.filter(item => item.classId !== "unmapped").length,
      uniqueTeachers: Array.from(teacherMap.keys()).filter(item => item !== "unassigned").length
    },
    hook: {
      ...store.webhookStatus,
      configured: missingEnv.length === 0,
      hasApiBaseUrl,
      hasSharedSecret,
      hasCallbackUrl,
      missingEnv
    },
    topMeetings: meetings
      .map(meeting => ({
        meetingId: meeting.meetingId,
        classId: meeting.classId,
        teacherId: meeting.teacherId,
        participants: Object.keys(meeting.users).length,
        joinEvents: meeting.joinEvents,
        leaveEvents: meeting.leaveEvents
      }))
      .sort((a, b) => b.joinEvents - a.joinEvents)
      .slice(0, 10),
    topClasses,
    topTeachers,
    topStudents,
    classDetails,
    teacherDetails,
    studentDetails,
    recentEvents: store.recentEvents
  };
}

function getRequestBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function getExpectedCallbackUrl(req) {
  if (CONFIG.callbackUrl) {
    return CONFIG.callbackUrl;
  }

  return `${getRequestBaseUrl(req)}/webhook/bbb`;
}

function buildChecksum(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

function verifyBbbChecksum(req, rawBody) {
  const authHeader = req.headers.authorization || "";
  const bearerPrefix = "Bearer ";
  if (authHeader.startsWith(bearerPrefix) && CONFIG.bbbSharedSecret) {
    const bearerToken = authHeader.slice(bearerPrefix.length);
    if (bearerToken === CONFIG.bbbSharedSecret) {
      return {
        valid: true,
        algorithm: "bearer",
        callbackUrl: getExpectedCallbackUrl(req)
      };
    }

    return {
      valid: false,
      reason: "Bearer token mismatch"
    };
  }

  const incomingChecksum = new URL(req.url, getRequestBaseUrl(req)).searchParams.get("checksum");

  if (!CONFIG.bbbSharedSecret) {
    return {
      valid: false,
      reason: "BBB_SHARED_SECRET is missing"
    };
  }

  if (!incomingChecksum) {
    return {
      valid: false,
      reason: "Missing checksum query param"
    };
  }

  const callbackUrl = getExpectedCallbackUrl(req);
  const baseString = `${callbackUrl}${rawBody}${CONFIG.bbbSharedSecret}`;
  const algorithms = ["sha1", "sha256", "sha384", "sha512"];

  for (const algorithm of algorithms) {
    if (buildChecksum(algorithm, baseString) === incomingChecksum) {
      return {
        valid: true,
        algorithm,
        callbackUrl
      };
    }
  }

  return {
    valid: false,
    reason: "Checksum mismatch",
    callbackUrl
  };
}

function computeApiChecksum(callName, params) {
  const queryString = params.toString();
  return buildChecksum("sha1", `${callName}${queryString}${CONFIG.bbbSharedSecret}`);
}

function parseXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? match[1].trim() : null;
}

function parseHooks(xml) {
  const hooks = [];
  const hookMatches = xml.match(/<hook>([\s\S]*?)<\/hook>/gi) || [];

  for (const hookXml of hookMatches) {
    hooks.push({
      hookID: parseXmlTag(hookXml, "hookID"),
      callbackURL: parseXmlTag(hookXml, "callbackURL")?.replace("<![CDATA[", "").replace("]]>", "") || null,
      meetingID: parseXmlTag(hookXml, "meetingID"),
      permanentHook: parseXmlTag(hookXml, "permanentHook"),
      rawData: parseXmlTag(hookXml, "rawData")
    });
  }

  return hooks;
}

async function callBbbApi(callName, extraParams = {}) {
  if (!CONFIG.bbbApiBaseUrl || !CONFIG.bbbSharedSecret) {
    throw new Error("BBB_API_BASE_URL or BBB_SHARED_SECRET is missing");
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  params.set("checksum", computeApiChecksum(callName, params));

  const endpoint = `${CONFIG.bbbApiBaseUrl}/${callName}?${params.toString()}`;
  const headers = {};
  if (CONFIG.useBearerAuth) {
    headers.Authorization = `Bearer ${CONFIG.bbbSharedSecret}`;
  }

  const response = await fetch(endpoint, { headers });
  const xml = await response.text();

  if (!response.ok) {
    throw new Error(`BBB API HTTP ${response.status}: ${xml}`);
  }

  const returnCode = parseXmlTag(xml, "returncode");
  const messageKey = parseXmlTag(xml, "messageKey");
  const message = parseXmlTag(xml, "message");

  return {
    xml,
    returnCode,
    messageKey,
    message
  };
}

async function registerGlobalHook(callbackUrlOverride) {
  const callbackUrl = callbackUrlOverride || CONFIG.callbackUrl;

  if (!callbackUrl) {
    throw new Error("BBB_CALLBACK_URL is missing");
  }

  const result = await callBbbApi("hooks/create", {
    callbackURL: callbackUrl,
    getRaw: CONFIG.getRaw,
    eventID: CONFIG.eventIds
  });

  const hookID = parseXmlTag(result.xml, "hookID");
  const status = result.returnCode === "SUCCESS" ? "registered" : "failed";

  persistStore(store => {
    store.webhookStatus.configured = true;
    store.webhookStatus.callbackUrl = callbackUrl;
    store.webhookStatus.bbbApiBaseUrl = CONFIG.bbbApiBaseUrl;
    store.webhookStatus.getRaw = CONFIG.getRaw;
    store.webhookStatus.eventIds = CONFIG.eventIds || null;
    store.webhookStatus.registeredHookId = hookID;
    store.webhookStatus.lastRegistrationAttemptAt = new Date().toISOString();
    store.webhookStatus.lastRegistrationResult = {
      status,
      messageKey: result.messageKey,
      message: result.message
    };
    store.webhookStatus.lastError = status === "failed" ? result.message || "Registration failed" : null;
    return store;
  });

  return {
    ok: result.returnCode === "SUCCESS",
    hookID,
    messageKey: result.messageKey,
    message: result.message
  };
}

async function listHooks() {
  const result = await callBbbApi("hooks/list");
  return {
    ok: result.returnCode === "SUCCESS",
    hooks: parseHooks(result.xml),
    messageKey: result.messageKey,
    message: result.message
  };
}

async function destroyHook(hookID) {
  if (!hookID) {
    throw new Error("hookID is required");
  }

  const result = await callBbbApi("hooks/destroy", { hookID });
  return {
    ok: result.returnCode === "SUCCESS",
    hookID,
    messageKey: result.messageKey,
    message: result.message
  };
}

function getConfiguredCallbackUrl(store) {
  return CONFIG.callbackUrl || store?.webhookStatus?.callbackUrl || null;
}

async function syncRegisteredHookId() {
  const currentStore = readStore();
  const callbackUrl = getConfiguredCallbackUrl(currentStore);

  if (!CONFIG.bbbApiBaseUrl || !CONFIG.bbbSharedSecret || !callbackUrl) {
    return buildStats(currentStore);
  }

  try {
    const hookList = await listHooks();
    const matchingHooks = hookList.hooks.filter(hook => hook.callbackURL === callbackUrl);
    const matchedHook = matchingHooks[0] || null;

    const nextStore = persistStore(store => {
      store.webhookStatus.callbackUrl = callbackUrl;
      store.webhookStatus.expectedCallbackUrl = callbackUrl;
      store.webhookStatus.bbbApiBaseUrl = CONFIG.bbbApiBaseUrl;
      store.webhookStatus.getRaw = CONFIG.getRaw;
      store.webhookStatus.eventIds = CONFIG.eventIds || null;
      store.webhookStatus.registeredHookId = matchedHook?.hookID || null;
      store.webhookStatus.matchingHookIds = matchingHooks.map(hook => hook.hookID).filter(Boolean);
      store.webhookStatus.allHooks = hookList.hooks;
      store.webhookStatus.lastHookSyncAt = new Date().toISOString();
      if (matchedHook) {
        store.webhookStatus.lastError = null;
      }
      return store;
    });

    return buildStats(nextStore);
  } catch (error) {
    const nextStore = persistStore(store => {
      store.webhookStatus.expectedCallbackUrl = callbackUrl;
      store.webhookStatus.lastHookSyncAt = new Date().toISOString();
      store.webhookStatus.lastError = error.message;
      return store;
    });

    return buildStats(nextStore);
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  res.write(`event: stats\ndata: ${JSON.stringify(buildStats(readStore()))}\n\n`);
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
}

async function handleWebhook(req, res) {
  try {
    const rawBody = await getRawBody(req);
    const parsed = parseIncomingBody(rawBody, req.headers["content-type"]);
    const checksum = verifyBbbChecksum(req, rawBody);

    if (!checksum.valid) {
      persistStore(store => {
        store.totals.checksumRejected += 1;
        store.webhookStatus.lastError = checksum.reason;
        return store;
      });

      sendJson(res, 401, {
        ok: false,
        error: checksum.reason
      });
      return;
    }

    const normalized = normalizeEvent(parsed.parsedBody, parsed.formFields);
    const store = updateStoreFromEvent(normalized, true);

    sendJson(res, 200, {
      ok: true,
      checksumAlgorithm: checksum.algorithm,
      received: normalized,
      totals: buildStats(store).totals
    });
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error.message
    });
  }
}

function handleReset(res) {
  writeStore(createEmptyStore());
  pushRealtimeUpdate("stats", buildStats(readStore()));
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, getRequestBaseUrl(req));

  if (req.method === "GET" && parsedUrl.pathname === "/") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/stats") {
    sendJson(res, 200, await syncRegisteredHookId());
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/stream") {
    handleSse(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/webhook/bbb") {
    await handleWebhook(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/hooks/register") {
    try {
      const result = await registerGlobalHook(getExpectedCallbackUrl(req));
      sendJson(res, 200, result);
    } catch (error) {
      persistStore(store => {
        store.webhookStatus.lastRegistrationAttemptAt = new Date().toISOString();
        store.webhookStatus.lastError = error.message;
        return store;
      });
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/hooks/list") {
    try {
      const result = await listHooks();
      await syncRegisteredHookId();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/hooks/destroy") {
    try {
      const rawBody = await getRawBody(req);
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      const result = await destroyHook(parsed.hookID);
      await syncRegisteredHookId();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/reset") {
    handleReset(res);
    return;
  }

  sendText(res, 404, "Not found");
});

ensureStore();

server.listen(PORT, async () => {
  console.log(`BBB admin dashboard listening on http://localhost:${PORT}`);

  if (CONFIG.autoRegisterHook) {
    try {
      await registerGlobalHook();
      console.log("BBB global hook registered.");
    } catch (error) {
      console.error(`BBB hook registration failed: ${error.message}`);
    }
  }
});
