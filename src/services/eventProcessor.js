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
  isModeratorRole
} = require("../utils/helpers");

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
  await statsDb.incrementStat("events");

  if (checksumValid) {
    await statsDb.incrementStat("checksum_verified");
  } else {
    await statsDb.incrementStat("checksum_rejected");
  }

  await eventsDb.insertEvent({
    ...normalized,
    checksumValid
  });

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

  return { eventName: normalized.eventName, processed: true };
}

module.exports = {
  processWebhookPayload,
  processEvent
};
