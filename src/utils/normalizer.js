const { URLSearchParams } = require("url");
const { tryParseJson, pickFirstValue } = require("./helpers");

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

    // Track which key was used to derive parsedBody so extractEventCandidates
    // can skip re-parsing it (prevents every event from being processed twice).
    let parsedBodySourceKey = null;
    let parsedEvent = null;

    if (tryParseJson(fields.event) !== null) {
      parsedEvent = tryParseJson(fields.event);
      parsedBodySourceKey = "event";
    } else if (tryParseJson(fields.events) !== null) {
      parsedEvent = tryParseJson(fields.events);
      parsedBodySourceKey = "events";
    } else if (tryParseJson(fields.data) !== null) {
      parsedEvent = tryParseJson(fields.data);
      parsedBodySourceKey = "data";
    } else {
      parsedEvent = tryParseJson(rawBody) ?? fields.event ?? fields.events ?? {};
    }

    return {
      rawBody,
      parsedBody: parsedEvent || {},
      formFields: fields,
      parsedBodySourceKey
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

function extractEventCandidates(parsedBody, formFields, parsedBodySourceKey = null) {
  const candidates = [];
  collectEventCandidates(parsedBody, candidates);

  for (const key of ["event", "events", "data", "message"]) {
    // Skip the key that was already used to derive parsedBody — re-parsing it
    // would produce identical candidates and cause every event to be counted twice.
    if (key === parsedBodySourceKey) continue;
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
    // Use raw payload JSON as primary dedup key: two candidates extracted from the
    // same source object are structurally identical, so their JSON is identical.
    // Fall back to field-based signature for events without a raw payload.
    const rawStr = event.raw ? JSON.stringify(event.raw) : null;
    const signature = rawStr || [
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

  const { isJoinEvent, isLeaveEvent } = require("./helpers");

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

module.exports = {
  parseIncomingBody,
  collectEventCandidates,
  extractEventCandidates,
  normalizeEvent,
  isMeaningfulEvent,
  dedupeNormalizedEvents,
  shouldTrackUserInRoster
};
