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
    liveRooms: [],
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
      lastError: null,
      lastWebhookReceivedAt: null,
      lastWebhookContentType: null,
      lastWebhookPreview: null
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
  store.liveRooms = Array.isArray(store.liveRooms) ? store.liveRooms : [];
  store.recentEvents = Array.isArray(store.recentEvents) ? store.recentEvents : [];
  store.webhookStatus = { ...defaults.webhookStatus, ...(store.webhookStatus || {}) };

  return compactStore(store);
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

    const parsedEvent =
      tryParseJson(fields.event) ??
      tryParseJson(fields.events) ??
      tryParseJson(fields.data) ??
      tryParseJson(rawBody) ??
      fields.event ??
      fields.events ??
      {};

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

function tryParseJson(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function collectEventCandidates(value, sink) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectEventCandidates(item, sink);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const directArrayKeys = ["events", "event", "data", "messages"];
  for (const key of directArrayKeys) {
    const nextValue = value[key];
    if (Array.isArray(nextValue)) {
      for (const item of nextValue) {
        collectEventCandidates(item, sink);
      }
    } else if (nextValue && typeof nextValue === "object" && key !== "data") {
      collectEventCandidates(nextValue, sink);
    }
  }

  if (
    pickFirstValue(value, [
      "event",
      "eventName",
      "data.id",
      "data.eventName",
      "data.type",
      "data.attributes.meeting.internal-meeting-id",
      "data.attributes.meeting.external-meeting-id",
      "core.header.name",
      "envelope.name",
      "header.name"
    ]) !== null
  ) {
    sink.push(value);
  }
}

function extractEventCandidates(parsedBody, formFields) {
  const candidates = [];
  collectEventCandidates(parsedBody, candidates);

  for (const key of ["event", "events", "data", "message"]) {
    const parsedValue = tryParseJson(formFields[key]);
    if (parsedValue) {
      collectEventCandidates(parsedValue, candidates);
    }
  }

  if (candidates.length === 0 && parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
    candidates.push(parsedBody);
  }

  return candidates;
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
  const externalMeetingId =
    pickFirstValue(payload, [
      "externalMeetingId",
      "meeting.externalMeetingId",
      "meeting.external-meeting-id",
      "data.attributes.meeting.external-meeting-id",
      "data.attributes.meeting.externalMeetingId",
      "core.body.props.meetingProp.extId"
    ]) || null;

  const internalMeetingId =
    pickFirstValue(payload, [
      "meetingId",
      "meeting.id",
      "meeting.meetingID",
      "meeting.meetingId",
      "meetingID",
      "data.attributes.meeting.internal-meeting-id",
      "data.attributes.meeting.internalMeetingId",
      "data.attributes.meeting.meetingId",
      "data.attributes.meeting.id",
      "data.meetingId",
      "data.meetingID",
      "data.event.meetingId",
      "header.meetingId",
      "core.body.meetingId",
      "core.body.props.meetingProp.intId"
    ]) || null;

  const meetingName =
    pickFirstValue(payload, [
      "meetingName",
      "meeting.name",
      "data.attributes.meeting.name",
      "data.attributes.meeting.meetingName",
      "core.body.props.meetingProp.name"
    ]) || null;

  const eventName =
    pickFirstValue(payload, [
      "event",
      "eventName",
      "header.name",
      "data.id",
      "data.eventName",
      "data.type",
      "data.attributes.eventName",
      "data.attributes.messageName",
      "data.event.name",
      "envelope.routing.name",
      "core.header.name",
      "envelope.name"
    ]) || "unknown";

  const meetingId = externalMeetingId || internalMeetingId || meetingName || "unknown-meeting";

  const userId =
    pickFirstValue(payload, [
      "userId",
      "user.id",
      "user.userId",
      "data.attributes.chat-message.sender.external-user-id",
      "data.attributes.chat-message.sender.externalUserId",
      "data.attributes.chat-message.sender.internal-user-id",
      "data.attributes.chat-message.sender.internalUserId",
      "data.attributes.user.external-user-id",
      "data.attributes.user.externalUserId",
      "data.attributes.user.internal-user-id",
      "data.attributes.user.internalUserId",
      "data.attributes.user.userId",
      "data.attributes.user.id",
      "data.attributes.attendee.userId",
      "data.attributes.attendee.externalUserId",
      "data.event.userId",
      "core.body.userId",
      "core.body.intId",
      "core.body.props.user.intId",
      "core.body.props.user.userId"
    ]) || null;

  const userName =
    pickFirstValue(payload, [
      "userName",
      "user.name",
      "user.fullname",
      "data.attributes.chat-message.sender.name",
      "data.attributes.user.name",
      "data.attributes.user.fullname",
      "data.attributes.user.fullName",
      "data.attributes.attendee.name",
      "data.event.userName",
      "core.body.name",
      "core.body.props.user.name"
    ]) || null;

  const role =
    pickFirstValue(payload, [
      "role",
      "user.role",
      "data.attributes.user.role",
      "data.attributes.attendee.role",
      "core.body.props.user.role"
    ]) || null;

  let classId =
    pickFirstValue(payload, [
      "classId",
      "metadata.classId",
      "meta.classId",
      "data.classId",
      "data.metadata.classId",
      "data.attributes.meeting.meta_classId",
      "data.attributes.meeting.meta_classid",
      "data.attributes.meeting.classId",
      "data.attributes.meeting.metadata.classId",
      "core.body.props.meetingProp.metadata.classId",
      "core.body.props.meetingProp.metadata.classid"
    ]) || null;

  let teacherId =
    pickFirstValue(payload, [
      "teacherId",
      "metadata.teacherId",
      "meta.teacherId",
      "data.teacherId",
      "data.metadata.teacherId",
      "data.attributes.meeting.meta_teacherId",
      "data.attributes.meeting.meta_teacherid",
      "data.attributes.meeting.teacherId",
      "data.attributes.meeting.metadata.teacherId",
      "core.body.props.meetingProp.metadata.teacherId",
      "core.body.props.meetingProp.metadata.teacherid"
    ]) || null;

  if (!classId) {
    classId = externalMeetingId || meetingName || internalMeetingId || "unmapped";
  }

  if (!teacherId && role && /moderator/i.test(String(role))) {
    teacherId = userName || userId || "moderator";
  }

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
    meetingName: meetingName ? String(meetingName) : null,
    role: role ? String(role) : null,
    timestamp,
    raw: payload
  };
}

function isMeaningfulEvent(normalized) {
  if (!normalized) {
    return false;
  }

  if (normalized.eventName !== "unknown") {
    return true;
  }

  if (normalized.meetingId !== "unknown-meeting") {
    return true;
  }

  if (normalized.userId || normalized.userName || normalized.classId !== "unmapped" || normalized.teacherId) {
    return true;
  }

  return false;
}

function dedupeNormalizedEvents(events) {
  const seen = new Set();
  const result = [];

  for (const event of events) {
    const signature = [
      event.eventName,
      event.meetingId,
      event.userId || "",
      event.userName || "",
      event.timestamp || "",
      event.role || ""
    ].join("|");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    result.push(event);
  }

  return result;
}

function shouldTrackUserInRoster(normalized) {
  if (!normalized?.userId) {
    return false;
  }

  if (isJoinEvent(normalized.eventName) || isLeaveEvent(normalized.eventName)) {
    return true;
  }

  if (/chat.*message|message.*sent/i.test(normalized.eventName)) {
    return true;
  }

  if (normalized.userName && normalized.role) {
    return true;
  }

  return false;
}

function isModeratorRole(role) {
  return /moderator/i.test(String(role || ""));
}

function isTeacherIdentity(userLike, teacherId) {
  if (!userLike) {
    return false;
  }

  if (isModeratorRole(userLike.role)) {
    return true;
  }

  if (teacherId && userLike.userName && userLike.userName === teacherId) {
    return true;
  }

  return false;
}

function shouldCountAsStudent(userLike, teacherId) {
  if (!userLike?.userId) {
    return false;
  }

  if (!shouldTrackUserInRoster(userLike) && !userLike.joinCount && !userLike.leaveCount) {
    return false;
  }

  return !isTeacherIdentity(userLike, teacherId);
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function isMessageEvent(eventName) {
  return /chat.*message|message.*sent/i.test(String(eventName || ""));
}

function isReactionEvent(eventName) {
  return /reaction/i.test(String(eventName || ""));
}

function isPollVoteEvent(eventName) {
  return /poll.*vote|vote.*poll/i.test(String(eventName || ""));
}

function isRaiseHandEvent(eventName) {
  return /raise.*hand|hand.*raise/i.test(String(eventName || ""));
}

function isWebcamStartEvent(eventName) {
  return /webcam.*start|start.*webcam|shared-webcam-started|camera.*start/i.test(String(eventName || ""));
}

function isWebcamStopEvent(eventName) {
  return /webcam.*stop|stop.*webcam|shared-webcam-stopped|camera.*stop/i.test(String(eventName || ""));
}

function isTalkStartEvent(eventName) {
  return /talk.*start|start.*talk|voice.*start|started-talking/i.test(String(eventName || ""));
}

function isTalkStopEvent(eventName) {
  return /talk.*stop|stop.*talk|voice.*stop|stopped-talking/i.test(String(eventName || ""));
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "-";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function applyEventToStore(store, normalized, checksumValid) {
  store.totals.events += 1;

  if (checksumValid) {
    store.totals.checksumVerified += 1;
  } else {
    store.totals.checksumRejected += 1;
  }

  if (!store.meetings[normalized.meetingId]) {
    store.meetings[normalized.meetingId] = {
      meetingId: normalized.meetingId,
      meetingName: normalized.meetingName,
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
  meeting.meetingName = normalized.meetingName || meeting.meetingName;
  meeting.classId = normalized.classId || meeting.classId;
  meeting.teacherId = normalized.teacherId || meeting.teacherId;

  const trackRosterUser = shouldTrackUserInRoster(normalized);

  if (trackRosterUser && normalized.userId && !store.users[normalized.userId]) {
    store.users[normalized.userId] = {
      userId: normalized.userId,
      userName: normalized.userName,
      role: normalized.role,
      joinCount: 0,
      leaveCount: 0,
      lastMeetingId: normalized.meetingId
    };
  }

  if (trackRosterUser && normalized.userId && normalized.userName) {
    store.users[normalized.userId].userName = normalized.userName;
  }

  if (trackRosterUser && normalized.userId && normalized.role) {
    store.users[normalized.userId].role = normalized.role;
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

    if (trackRosterUser && normalized.userId) {
      store.users[normalized.userId].joinCount += 1;
      store.users[normalized.userId].lastMeetingId = normalized.meetingId;
      meeting.users[normalized.userId] = normalized.userName || normalized.userId;
    }
  }

  if (isLeaveEvent(normalized.eventName)) {
    store.totals.participantsLeft += 1;
    meeting.leaveEvents += 1;

    if (trackRosterUser && normalized.userId) {
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
    meetingName: normalized.meetingName,
    role: normalized.role,
    timestamp: normalized.timestamp,
    checksumValid
  });

  store.recentEvents = store.recentEvents.slice(0, 100);
  return store;
}

function compactStore(store) {
  const defaults = createEmptyStore();
  const compacted = {
    ...defaults,
    liveRooms: Array.isArray(store.liveRooms) ? store.liveRooms : [],
    webhookStatus: { ...defaults.webhookStatus, ...(store.webhookStatus || {}) }
  };

  const dedupedEvents = dedupeNormalizedEvents(
    (Array.isArray(store.recentEvents) ? store.recentEvents : [])
      .filter(isMeaningfulEvent)
      .map(event => ({
        eventName: event.eventName || "unknown",
        meetingId: event.meetingId || "unknown-meeting",
        userId: event.userId || null,
        userName: event.userName || null,
        classId: event.classId || "unmapped",
        teacherId: event.teacherId || null,
        meetingName: event.meetingName || null,
        role: event.role || null,
        timestamp: event.timestamp || null
      }))
  );

  for (const event of dedupedEvents.slice().reverse()) {
    applyEventToStore(compacted, event, true);
  }

  return compacted;
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
  return persistStore(store => applyEventToStore(store, normalized, checksumValid));
}

function buildStats(store) {
  const meetings = Object.values(store.meetings).filter(meeting => {
    const hasSignals =
      (meeting.joinEvents || 0) > 0 ||
      (meeting.leaveEvents || 0) > 0 ||
      (meeting.createdEvents || 0) > 0 ||
      (meeting.endedEvents || 0) > 0 ||
      Object.keys(meeting.users || {}).length > 0;

    if (hasSignals) {
      return true;
    }

    return meeting.meetingId !== "unknown-meeting";
  });
  const users = Object.values(store.users);
  const classes = Object.values(store.classes).filter(item => item.classId !== "unmapped" || Object.keys(item.meetings || {}).length > 0);
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
      const user = store.users[userId];
      if (shouldCountAsStudent(user, meeting.teacherId)) {
        classEntry.studentIds.add(userId);
      }
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
      const user = store.users[userId];
      if (shouldCountAsStudent(user, meeting.teacherId)) {
        teacherEntry.studentIds.add(userId);
      }
    }
    teacherMap.set(teacherId, teacherEntry);
  }

  for (const event of store.recentEvents.filter(isMeaningfulEvent)) {
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
      if (event.userId && shouldCountAsStudent(event, event.teacherId)) {
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
      if (event.userId && shouldCountAsStudent(event, event.teacherId)) {
        teacherEntry.studentIds.add(event.userId);
      }
      teacherMap.set(event.teacherId, teacherEntry);
    }
  }

  for (const user of users) {
    if (isModeratorRole(user.role)) {
      continue;
    }

    const studentEntry = {
      userId: user.userId,
      userName: user.userName,
      role: user.role || null,
      joins: user.joinCount || 0,
      leaves: user.leaveCount || 0,
      lastMeetingId: user.lastMeetingId || null,
      classIds: new Set(),
      teacherIds: new Set()
    };

    for (const meeting of meetings) {
      if (meeting.users && Object.prototype.hasOwnProperty.call(meeting.users, user.userId)) {
        if (shouldCountAsStudent(user, meeting.teacherId) && meeting.classId) {
          studentEntry.classIds.add(meeting.classId);
        }
        if (shouldCountAsStudent(user, meeting.teacherId) && meeting.teacherId) {
          studentEntry.teacherIds.add(meeting.teacherId);
        }
      }
    }

    for (const event of store.recentEvents.filter(isMeaningfulEvent)) {
      if (event.userId === user.userId && shouldCountAsStudent(event, event.teacherId)) {
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
      className: item.classId,
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

  const meetingNameMap = new Map();
  for (const meeting of meetings) {
    if (meeting.meetingId && meeting.meetingName) {
      meetingNameMap.set(meeting.meetingId, meeting.meetingName);
    }
  }
  for (const room of store.liveRooms || []) {
    if (room.meetingId && room.meetingName) {
      meetingNameMap.set(room.meetingId, room.meetingName.replace(/&apos;/g, "'"));
    }
  }

  const classNameMap = new Map();
  for (const meeting of meetings) {
    if (meeting.classId && meeting.meetingName) {
      classNameMap.set(meeting.classId, meeting.meetingName);
    }
  }
  for (const room of store.liveRooms || []) {
    if (room.classId && room.meetingName) {
      classNameMap.set(room.classId, room.meetingName.replace(/&apos;/g, "'"));
    }
  }
  for (const event of store.recentEvents.filter(isMeaningfulEvent)) {
    if (event.classId && event.meetingName) {
      classNameMap.set(event.classId, event.meetingName);
    }
  }

  const classDetails = Array.from(classMap.values())
    .map(item => {
      const relatedMeetingIds = new Set(item.meetingIds);
      const relatedMeetings = meetings
        .filter(meeting => meeting.classId === item.classId)
        .map(meeting => ({
          meetingId: meeting.meetingId,
          meetingName: meeting.meetingName || meetingNameMap.get(meeting.meetingId) || null,
          teacherId: meeting.teacherId || null,
          joinEvents: meeting.joinEvents || 0,
          leaveEvents: meeting.leaveEvents || 0,
          students: Object.keys(meeting.users || {}).filter(userId => {
            const user = store.users[userId];
            return shouldCountAsStudent(user, meeting.teacherId);
          }).length
        }))
        .sort((a, b) => b.joinEvents - a.joinEvents);

      const teacherIds = Array.from(item.teacherIds);
      const relatedEvents = store.recentEvents.filter(
        event => isMeaningfulEvent(event) && relatedMeetingIds.has(event.meetingId)
      );
      const students = Array.from(item.studentIds)
        .filter(userId => {
          const user = store.users[userId];
          return shouldCountAsStudent(user, teacherIds[0] || null);
        })
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

      const participantMap = new Map();
      const ensureParticipant = (userId, fallbackName = null, fallbackRole = null) => {
        if (!userId) {
          return null;
        }

        const existing = participantMap.get(userId);
        if (existing) {
          if (!existing.name && fallbackName) {
            existing.name = fallbackName;
          }
          if (!existing.role && fallbackRole) {
            existing.role = fallbackRole;
          }
          return existing;
        }

        const knownUser = store.users[userId] || {};
        const participant = {
          userId,
          name: fallbackName || knownUser.userName || userId,
          role: fallbackRole || knownUser.role || null,
          joinAt: null,
          leftAt: null,
          durationMs: 0,
          activeJoinAt: null,
          talkTimeMs: 0,
          activeTalkAt: null,
          webcamTimeMs: 0,
          activeWebcamAt: null,
          messages: 0,
          reactions: 0,
          pollVotes: 0,
          raiseHands: 0,
          talkEvents: 0,
          webcamEvents: 0
        };
        participantMap.set(userId, participant);
        return participant;
      };

      for (const meeting of relatedMeetings) {
        const sourceMeeting = store.meetings[meeting.meetingId];
        for (const userId of Object.keys(sourceMeeting?.users || {})) {
          const user = store.users[userId];
          if (!user) {
            continue;
          }
          ensureParticipant(userId, user.userName || userId, user.role || null);
        }
      }

      for (const event of relatedEvents) {
        if (!event.userId) {
          continue;
        }

        const participant = ensureParticipant(event.userId, event.userName, event.role);
        if (!participant) {
          continue;
        }

        const timestampMs = toTimestampMs(event.timestamp);

        if (isJoinEvent(event.eventName) && timestampMs) {
          participant.joinAt = participant.joinAt ? Math.min(participant.joinAt, timestampMs) : timestampMs;
          participant.activeJoinAt = timestampMs;
        }

        if (isLeaveEvent(event.eventName) && timestampMs) {
          participant.leftAt = participant.leftAt ? Math.max(participant.leftAt, timestampMs) : timestampMs;
          if (participant.activeJoinAt) {
            participant.durationMs += Math.max(0, timestampMs - participant.activeJoinAt);
            participant.activeJoinAt = null;
          }
        }

        if (isMessageEvent(event.eventName)) {
          participant.messages += 1;
        }

        if (isReactionEvent(event.eventName)) {
          participant.reactions += 1;
        }

        if (isPollVoteEvent(event.eventName)) {
          participant.pollVotes += 1;
        }

        if (isRaiseHandEvent(event.eventName)) {
          participant.raiseHands += 1;
        }

        if (isTalkStartEvent(event.eventName) && timestampMs) {
          participant.talkEvents += 1;
          if (!participant.activeTalkAt) {
            participant.activeTalkAt = timestampMs;
          }
        }

        if (isTalkStopEvent(event.eventName) && timestampMs) {
          participant.talkEvents += 1;
          if (participant.activeTalkAt) {
            participant.talkTimeMs += Math.max(0, timestampMs - participant.activeTalkAt);
            participant.activeTalkAt = null;
          }
        }

        if (isWebcamStartEvent(event.eventName) && timestampMs) {
          participant.webcamEvents += 1;
          if (!participant.activeWebcamAt) {
            participant.activeWebcamAt = timestampMs;
          }
        }

        if (isWebcamStopEvent(event.eventName) && timestampMs) {
          participant.webcamEvents += 1;
          if (participant.activeWebcamAt) {
            participant.webcamTimeMs += Math.max(0, timestampMs - participant.activeWebcamAt);
            participant.activeWebcamAt = null;
          }
        }
      }

      const nowMs = Date.now();
      const participantActivity = Array.from(participantMap.values())
        .map(participant => {
          let durationMs = participant.durationMs;
          if (participant.activeJoinAt) {
            durationMs += Math.max(0, nowMs - participant.activeJoinAt);
          }

          let talkTimeMs = participant.talkTimeMs;
          if (participant.activeTalkAt) {
            talkTimeMs += Math.max(0, nowMs - participant.activeTalkAt);
          }

          let webcamTimeMs = participant.webcamTimeMs;
          if (participant.activeWebcamAt) {
            webcamTimeMs += Math.max(0, nowMs - participant.activeWebcamAt);
          }

          const knownUser = store.users[participant.userId] || {};
          const effectiveRole = participant.role || knownUser.role || null;
          const effectiveName = participant.name || knownUser.userName || participant.userId;
          const moderator = isModeratorRole(effectiveRole) || teacherIds.includes(effectiveName);

          return {
            userId: participant.userId,
            name: effectiveName,
            moderator,
            activityScore:
              participant.messages +
              participant.reactions +
              participant.pollVotes +
              participant.raiseHands +
              participant.talkEvents +
              participant.webcamEvents,
            talkTime: formatDurationMs(talkTimeMs),
            webcamTime: formatDurationMs(webcamTimeMs),
            messages: participant.messages,
            reactions: participant.reactions,
            pollVotes: participant.pollVotes,
            raiseHands: participant.raiseHands,
            joinAt: participant.joinAt,
            leftAt: participant.leftAt,
            duration: formatDurationMs(durationMs)
          };
        })
        .filter(item => item.name && item.userId)
        .sort((a, b) => {
          if (Number(b.moderator) !== Number(a.moderator)) {
            return Number(b.moderator) - Number(a.moderator);
          }
          if (b.activityScore !== a.activityScore) {
            return b.activityScore - a.activityScore;
          }
          return String(a.name).localeCompare(String(b.name));
        });

      return {
        classId: item.classId,
        className: classNameMap.get(item.classId) || item.classId,
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
        participantActivity,
        recentEvents: store.recentEvents.filter(event => isMeaningfulEvent(event) && event.classId === item.classId).slice(0, 12)
      };
    })
    .sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);

  const teacherDetails = Array.from(teacherMap.values())
    .map(item => ({
      teacherId: item.teacherId,
      classIds: Array.from(item.classIds),
      classNames: Array.from(item.classIds).map(classId => classNameMap.get(classId) || classId),
      studentIds: Array.from(item.studentIds),
      totals: {
        classes: item.classIds.size,
        meetings: item.meetingIds.size,
        students: item.studentIds.size,
        joinEvents: item.joinEvents,
        leaveEvents: item.leaveEvents
      },
      recentEvents: store.recentEvents.filter(event => isMeaningfulEvent(event) && (event.teacherId || "unassigned") === item.teacherId).slice(0, 10)
    }))
    .sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);

  const studentDetails = Array.from(studentMap.values())
    .map(item => ({
      userId: item.userId,
      userName: item.userName || item.userId,
      classIds: Array.from(item.classIds),
      classNames: Array.from(item.classIds).map(classId => classNameMap.get(classId) || classId),
      teacherIds: Array.from(item.teacherIds),
      totals: {
        joins: item.joins,
        leaves: item.leaves
      },
      lastMeetingId: item.lastMeetingId,
      recentEvents: store.recentEvents.filter(event => isMeaningfulEvent(event) && event.userId === item.userId).slice(0, 10)
    }))
    .sort((a, b) => (b.totals.joins - a.totals.joins) || (b.totals.leaves - a.totals.leaves));

  for (const item of topClasses) {
    item.className = classNameMap.get(item.classId) || item.classId;
  }

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
    liveRooms: store.liveRooms || [],
    topMeetings: meetings
      .map(meeting => ({
        meetingId: meeting.meetingId,
        meetingName: meeting.meetingName || meetingNameMap.get(meeting.meetingId) || null,
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
    recentEvents: store.recentEvents.filter(isMeaningfulEvent)
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

function parseMeetings(xml) {
  const meetings = [];
  const meetingMatches = xml.match(/<meeting>([\s\S]*?)<\/meeting>/gi) || [];

  for (const meetingXml of meetingMatches) {
    meetings.push({
      meetingID: parseXmlTag(meetingXml, "meetingID"),
      meetingName: parseXmlTag(meetingXml, "meetingName"),
      attendeeCount: Number(parseXmlTag(meetingXml, "participantCount") || 0),
      moderatorCount: Number(parseXmlTag(meetingXml, "moderatorCount") || 0),
      running: parseXmlTag(meetingXml, "running"),
      createTime: parseXmlTag(meetingXml, "createTime"),
      metadataClassId:
        parseXmlTag(meetingXml, "meta_classid") ||
        parseXmlTag(meetingXml, "meta_classId") ||
        parseXmlTag(meetingXml, "metadata_classid") ||
        null,
      metadataTeacherId:
        parseXmlTag(meetingXml, "meta_teacherid") ||
        parseXmlTag(meetingXml, "meta_teacherId") ||
        parseXmlTag(meetingXml, "metadata_teacherid") ||
        null
    });
  }

  return meetings;
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

async function listLiveMeetings() {
  const result = await callBbbApi("getMeetings");
  return {
    ok: result.returnCode === "SUCCESS",
    meetings: parseMeetings(result.xml),
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

function findMeetingContext(store, meetingId) {
  if (!meetingId) {
    return { classId: null, teacherId: null };
  }

  const directMeeting = store.meetings?.[meetingId];
  if (directMeeting) {
    return {
      classId: directMeeting.classId || null,
      teacherId: directMeeting.teacherId || null
    };
  }

  const relatedEvents = (store.recentEvents || []).filter(event => event.meetingId === meetingId);
  const classId = relatedEvents.find(event => event.classId && event.classId !== "unmapped")?.classId || null;
  const teacherId = relatedEvents.find(event => event.teacherId)?.teacherId || null;

  return { classId, teacherId };
}

async function syncDashboardState() {
  const currentStore = readStore();
  const callbackUrl = getConfiguredCallbackUrl(currentStore);

  if (!CONFIG.bbbApiBaseUrl || !CONFIG.bbbSharedSecret) {
    return buildStats(currentStore);
  }

  try {
    const [hookList, liveMeetingList] = await Promise.all([
      callbackUrl ? listHooks() : Promise.resolve({ hooks: [] }),
      listLiveMeetings()
    ]);
    const matchingHooks = callbackUrl ? hookList.hooks.filter(hook => hook.callbackURL === callbackUrl) : [];
    const matchedHook = matchingHooks[0] || null;

    const nextStore = persistStore(store => {
      store.liveRooms = liveMeetingList.meetings.map(meeting => {
        const context = findMeetingContext(store, meeting.meetingID);
        return {
          meetingId: meeting.meetingID || "unknown-meeting",
          meetingName: meeting.meetingName || meeting.meetingID || "Unnamed room",
          attendeeCount: meeting.attendeeCount || 0,
          moderatorCount: meeting.moderatorCount || 0,
          running: meeting.running || null,
          createTime: meeting.createTime || null,
          classId: meeting.metadataClassId || context.classId || null,
          teacherId: meeting.metadataTeacherId || context.teacherId || null
        };
      });
      store.webhookStatus.callbackUrl = callbackUrl;
      store.webhookStatus.expectedCallbackUrl = callbackUrl;
      store.webhookStatus.bbbApiBaseUrl = CONFIG.bbbApiBaseUrl;
      store.webhookStatus.getRaw = CONFIG.getRaw;
      store.webhookStatus.eventIds = CONFIG.eventIds || null;
      store.webhookStatus.registeredHookId = matchedHook?.hookID || null;
      store.webhookStatus.matchingHookIds = matchingHooks.map(hook => hook.hookID).filter(Boolean);
      store.webhookStatus.allHooks = hookList.hooks || [];
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

    const candidates = extractEventCandidates(parsed.parsedBody, parsed.formFields);
    const normalizedEvents = dedupeNormalizedEvents(
      candidates
        .map(candidate => normalizeEvent(candidate, parsed.formFields))
        .filter(isMeaningfulEvent)
    );

    persistStore(store => {
      store.webhookStatus.lastWebhookReceivedAt = new Date().toISOString();
      store.webhookStatus.lastWebhookContentType = req.headers["content-type"] || null;
      store.webhookStatus.lastWebhookPreview = rawBody.slice(0, 4000);
      return store;
    });

    let lastStore = readStore();
    for (const normalized of normalizedEvents) {
      lastStore = updateStoreFromEvent(normalized, true);
    }

    sendJson(res, 200, {
      ok: true,
      checksumAlgorithm: checksum.algorithm,
      receivedCount: normalizedEvents.length,
      received: normalizedEvents,
      totals: buildStats(lastStore).totals
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
    sendJson(res, 200, await syncDashboardState());
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
      await syncDashboardState();
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
      await syncDashboardState();
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
