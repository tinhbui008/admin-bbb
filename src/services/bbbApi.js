const crypto = require("crypto");
const CONFIG = require("../config");
const webhookStatusDb = require("../db/queries/webhookStatus");
const liveRoomsDb = require("../db/queries/liveRooms");

function buildChecksum(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest("hex");
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

  return { xml, returnCode, messageKey, message };
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

  await webhookStatusDb.updateWebhookStatus({
    configured: true,
    callbackUrl,
    bbbApiBaseUrl: CONFIG.bbbApiBaseUrl,
    getRaw: CONFIG.getRaw,
    eventIds: CONFIG.eventIds || null,
    registeredHookId: hookID,
    lastRegistrationAttemptAt: new Date().toISOString()
  });

  await webhookStatusDb.recordRegistrationAttempt({
    status,
    messageKey: result.messageKey,
    message: result.message
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

async function syncDashboardState() {
  const webhookStatus = await webhookStatusDb.getWebhookStatus();
  const callbackUrl = CONFIG.callbackUrl || webhookStatus.callbackUrl;

  if (!CONFIG.bbbApiBaseUrl || !CONFIG.bbbSharedSecret) {
    return;
  }

  try {
    const [hookList, liveMeetingList] = await Promise.all([
      callbackUrl ? listHooks() : Promise.resolve({ hooks: [] }),
      listLiveMeetings()
    ]);

    const matchingHooks = callbackUrl ? hookList.hooks.filter(hook => hook.callbackURL === callbackUrl) : [];
    const matchedHook = matchingHooks[0] || null;

    const liveRooms = [];
    for (const meeting of liveMeetingList.meetings) {
      const context = await liveRoomsDb.findMeetingContext(meeting.meetingID);
      liveRooms.push({
        meetingId: meeting.meetingID || "unknown-meeting",
        meetingName: meeting.meetingName?.replace(/&apos;/g, "'") || meeting.meetingID || "Unnamed room",
        attendeeCount: meeting.attendeeCount || 0,
        moderatorCount: meeting.moderatorCount || 0,
        running: meeting.running || null,
        createTime: meeting.createTime || null,
        classId: meeting.metadataClassId || context.classId || null,
        teacherId: meeting.metadataTeacherId || context.teacherId || null
      });
    }

    await liveRoomsDb.syncLiveRooms(liveRooms);

    await webhookStatusDb.updateWebhookStatus({
      callbackUrl,
      bbbApiBaseUrl: CONFIG.bbbApiBaseUrl,
      getRaw: CONFIG.getRaw,
      eventIds: CONFIG.eventIds || null,
      registeredHookId: matchedHook?.hookID || null,
      matchingHookIds: matchingHooks.map(hook => hook.hookID).filter(Boolean),
      lastHookSyncAt: new Date().toISOString(),
      lastError: matchedHook ? null : undefined
    });
  } catch (error) {
    await webhookStatusDb.updateWebhookStatus({
      lastHookSyncAt: new Date().toISOString(),
      lastError: error.message
    });
  }
}

function verifyBbbChecksum(req, rawBody, getRequestBaseUrl, getExpectedCallbackUrl) {
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

  const { URL } = require("url");
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

module.exports = {
  buildChecksum,
  computeApiChecksum,
  callBbbApi,
  registerGlobalHook,
  listHooks,
  listLiveMeetings,
  destroyHook,
  syncDashboardState,
  verifyBbbChecksum
};
