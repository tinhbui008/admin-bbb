const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const CONFIG = require("../config");
const webhookStatusDb = require("../db/queries/webhookStatus");
const liveRoomsDb = require("../db/queries/liveRooms");
const recordingsDb = require("../db/queries/recordings");

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

function stripCdata(value) {
  if (typeof value !== "string") return value;
  return value.replace("<![CDATA[", "").replace("]]>", "").trim();
}

function parsePlaybackFormats(recordingXml) {
  const formats = [];
  const formatMatches = recordingXml.match(/<format>([\s\S]*?)<\/format>/gi) || [];

  for (const formatXml of formatMatches) {
    const url = parseXmlTag(formatXml, "url");
    if (!url) continue;
    const lengthRaw = parseXmlTag(formatXml, "length");
    formats.push({
      type: parseXmlTag(formatXml, "type"),
      url: stripCdata(url),
      length: lengthRaw !== null ? Number(lengthRaw) : null // minutes
    });
  }

  return formats;
}

function parseRecordings(xml) {
  const recordings = [];
  const recordingMatches = xml.match(/<recording>([\s\S]*?)<\/recording>/gi) || [];

  for (const recXml of recordingMatches) {
    const startTime = Number(parseXmlTag(recXml, "startTime") || 0) || null;
    const endTime = Number(parseXmlTag(recXml, "endTime") || 0) || null;
    const playback = parsePlaybackFormats(recXml);

    let durationMs = startTime && endTime && endTime > startTime ? endTime - startTime : null;
    if (!durationMs && playback.length) {
      const maxLength = Math.max(...playback.map(f => f.length || 0));
      durationMs = maxLength > 0 ? maxLength * 60 * 1000 : null;
    }

    const publishedRaw = parseXmlTag(recXml, "published");

    recordings.push({
      recordId: parseXmlTag(recXml, "recordID"),
      meetingId: parseXmlTag(recXml, "meetingID"),
      name: stripCdata(parseXmlTag(recXml, "name") || "")?.replace(/&apos;/g, "'") || null,
      state: parseXmlTag(recXml, "state"),
      published: publishedRaw ? /^true$/i.test(publishedRaw) : null,
      startTime,
      endTime,
      durationMs,
      participants: Number(parseXmlTag(recXml, "participants") || 0) || null,
      // getRecordings nests metadata keys without the meta_ prefix; try both forms
      metadataClassId:
        parseXmlTag(recXml, "classid") ||
        parseXmlTag(recXml, "classId") ||
        parseXmlTag(recXml, "meta_classid") ||
        null,
      playback
    });
  }

  return recordings;
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

  // Use https.request instead of fetch — BBB's hooks/create endpoint returns
  // LF-only header endings (HTTP/1.1 non-compliant), which undici (native fetch)
  // rejects. The https module is lenient about this.
  const xml = await new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "GET", headers, insecureHTTPParser: true },
      (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk.toString("utf8"); });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`BBB API HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });

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

async function getRecordings(extraParams = {}) {
  const result = await callBbbApi("getRecordings", extraParams);
  return {
    ok: result.returnCode === "SUCCESS",
    recordings: parseRecordings(result.xml),
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

    // Sync recordings (best-effort — a recordings failure must not break hook/live sync)
    try {
      const recordingResult = await getRecordings();
      const recordings = [];
      for (const rec of recordingResult.recordings) {
        if (!rec.recordId) continue;

        let classId = rec.metadataClassId;
        if (!classId && rec.meetingId) {
          const ctx = await liveRoomsDb.findMeetingContext(rec.meetingId);
          classId = ctx.classId;
        }

        // Only keep recordings we can attribute to a known class
        if (!classId) continue;
        recordings.push({ ...rec, classId });
      }
      await recordingsDb.syncRecordings(recordings);
    } catch (recordingError) {
      console.error("Recording sync failed:", recordingError.message);
    }

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
  getRecordings,
  destroyHook,
  syncDashboardState,
  verifyBbbChecksum
};
