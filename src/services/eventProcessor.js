const eventsDb = require("../db/queries/events");
const classesDb = require("../db/queries/classes");
const teachersDb = require("../db/queries/teachers");
const studentsDb = require("../db/queries/students");
const meetingsDb = require("../db/queries/meetings");
const statsDb = require("../db/queries/stats");
const webhookStatusDb = require("../db/queries/webhookStatus");
const {
  parseIncomingBody,
  extractEventCandidates,
  normalizeEvent,
  isMeaningfulEvent,
  dedupeNormalizedEvents,
  shouldTrackUserInRoster
} = require("../utils/normalizer");
const {
  isJoinEvent,
  isLeaveEvent,
  isMeetingCreatedEvent,
  isMeetingEndedEvent,
  isMessageEvent,
  isReactionEvent,
  isPollVoteEvent,
  isRaiseHandEvent,
  isWebcamStartEvent,
  isWebcamStopEvent,
  isTalkStartEvent,
  isTalkStopEvent,
  isModeratorRole
} = require("../utils/helpers");

// In-memory state for tracking start times of talk/webcam segments.
// Key: `${meetingId}:${userId}`. Cleared when meeting ends.
const talkStartTimes = new Map();
const webcamStartTimes = new Map();

async function processWebhookPayload(rawBody, contentType, checksumValid) {
  const parsed = parseIncomingBody(rawBody, contentType);
  const candidates = extractEventCandidates(parsed.parsedBody, parsed.formFields, parsed.parsedBodySourceKey);
  const normalizedEvents = dedupeNormalizedEvents(
    candidates
      .map(candidate => normalizeEvent(candidate, parsed.formFields))
      .filter(isMeaningfulEvent)
  );

  await webhookStatusDb.recordWebhookReceived(contentType, rawBody);

  const results = [];
  for (const normalized of normalizedEvents) {
    const result = await processEvent(normalized, checksumValid);
    results.push(result);
  }

  return {
    receivedCount: normalizedEvents.length,
    received: normalizedEvents,
    results
  };
}

async function processEvent(normalized, checksumValid) {
  const inserted = await eventsDb.insertEvent({
    ...normalized,
    checksumValid
  });

  // Duplicate payload — already processed this exact event, skip all counters.
  if (!inserted) {
    return { eventName: normalized.eventName, processed: false, duplicate: true };
  }

  await statsDb.incrementStat("events");

  if (checksumValid) {
    await statsDb.incrementStat("checksum_verified");
  } else {
    await statsDb.incrementStat("checksum_rejected");
  }

  if (normalized.classId && normalized.classId !== "unmapped") {
    await classesDb.upsertClass(normalized.classId, normalized.meetingName);
  }

  if (normalized.teacherId && normalized.teacherId !== "unassigned") {
    await teachersDb.upsertTeacher(normalized.teacherId, normalized.teacherId);

    if (normalized.classId && normalized.classId !== "unmapped") {
      await classesDb.addClassTeacher(normalized.classId, normalized.teacherId);
    }
  }

  if (normalized.meetingId && normalized.meetingId !== "unknown-meeting") {
    await meetingsDb.upsertMeeting(normalized.meetingId, {
      meetingName: normalized.meetingName,
      classId: normalized.classId,
      teacherId: normalized.teacherId
    });
  }

  if (isMeetingCreatedEvent(normalized.eventName)) {
    await statsDb.incrementStat("meetings_created");
    if (normalized.meetingId) {
      await meetingsDb.incrementMeetingCreated(normalized.meetingId);
    }
  }

  if (isMeetingEndedEvent(normalized.eventName)) {
    await statsDb.incrementStat("meetings_ended");
    if (normalized.meetingId) {
      await meetingsDb.incrementMeetingEnded(normalized.meetingId);
      // Save any pending talk/webcam time before clearing (user still active when meeting ends)
      const now = Date.now();
      for (const [key, startMs] of talkStartTimes.entries()) {
        if (key.startsWith(`${normalized.meetingId}:`)) {
          const userId = key.slice(normalized.meetingId.length + 1);
          await meetingsDb.addParticipantTalkTime(normalized.meetingId, userId, now - startMs);
          talkStartTimes.delete(key);
        }
      }
      for (const [key, startMs] of webcamStartTimes.entries()) {
        if (key.startsWith(`${normalized.meetingId}:`)) {
          const userId = key.slice(normalized.meetingId.length + 1);
          await meetingsDb.addParticipantWebcamTime(normalized.meetingId, userId, now - startMs);
          webcamStartTimes.delete(key);
        }
      }
    }
  }

  const trackUser = shouldTrackUserInRoster(normalized);

  if (trackUser && normalized.userId) {
    const isTeacher = isModeratorRole(normalized.role);

    if (!isTeacher) {
      await studentsDb.upsertStudent(normalized.userId, normalized.userName, normalized.role);
    }

    if (normalized.meetingId && normalized.meetingId !== "unknown-meeting") {
      await meetingsDb.upsertMeetingParticipant(normalized.meetingId, normalized.userId, {
        userName: normalized.userName,
        role: normalized.role,
        joinAt: isJoinEvent(normalized.eventName) ? new Date(normalized.timestamp) : null
      });
    }
  }

  if (isJoinEvent(normalized.eventName)) {
    await statsDb.incrementStat("participants_joined");

    if (normalized.meetingId) {
      await meetingsDb.incrementMeetingJoin(normalized.meetingId);
    }

    if (trackUser && normalized.userId && !isModeratorRole(normalized.role)) {
      if (normalized.classId && normalized.classId !== "unmapped") {
        await classesDb.addClassStudent(normalized.classId, normalized.userId, normalized.meetingId);
      }
    }
  }

  if (isLeaveEvent(normalized.eventName)) {
    await statsDb.incrementStat("participants_left");

    if (normalized.meetingId) {
      await meetingsDb.incrementMeetingLeave(normalized.meetingId);
    }

    if (trackUser && normalized.userId && normalized.meetingId) {
      await meetingsDb.updateParticipantLeft(
        normalized.meetingId,
        normalized.userId,
        new Date(normalized.timestamp)
      );
    }

    if (trackUser && normalized.userId && !isModeratorRole(normalized.role)) {
      if (normalized.classId && normalized.classId !== "unmapped") {
        await classesDb.incrementClassStudentLeave(normalized.classId, normalized.userId);
      }
    }
  }

  if (isMessageEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    await meetingsDb.incrementParticipantActivity(normalized.meetingId, normalized.userId, "messages");
  }

  if (isReactionEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    await meetingsDb.incrementParticipantActivity(normalized.meetingId, normalized.userId, "reactions");
  }

  if (isPollVoteEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    await meetingsDb.incrementParticipantActivity(normalized.meetingId, normalized.userId, "poll_votes");
  }

  if (isRaiseHandEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    await meetingsDb.incrementParticipantActivity(normalized.meetingId, normalized.userId, "raise_hands");
  }

  if (isTalkStartEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    talkStartTimes.set(`${normalized.meetingId}:${normalized.userId}`, Date.now());
  }

  if (isTalkStopEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    const key = `${normalized.meetingId}:${normalized.userId}`;
    const startMs = talkStartTimes.get(key);
    if (startMs) {
      talkStartTimes.delete(key);
      await meetingsDb.addParticipantTalkTime(normalized.meetingId, normalized.userId, Date.now() - startMs);
    }
  }

  if (isWebcamStartEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    webcamStartTimes.set(`${normalized.meetingId}:${normalized.userId}`, Date.now());
  }

  if (isWebcamStopEvent(normalized.eventName) && normalized.meetingId && normalized.userId) {
    const key = `${normalized.meetingId}:${normalized.userId}`;
    const startMs = webcamStartTimes.get(key);
    if (startMs) {
      webcamStartTimes.delete(key);
      await meetingsDb.addParticipantWebcamTime(normalized.meetingId, normalized.userId, Date.now() - startMs);
    }
  }

  return { eventName: normalized.eventName, processed: true };
}

module.exports = {
  processWebhookPayload,
  processEvent
};
