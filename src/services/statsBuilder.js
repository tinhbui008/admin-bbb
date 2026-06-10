const statsDb = require("../db/queries/stats");
const eventsDb = require("../db/queries/events");
const classesDb = require("../db/queries/classes");
const teachersDb = require("../db/queries/teachers");
const studentsDb = require("../db/queries/students");
const meetingsDb = require("../db/queries/meetings");
const webhookStatusDb = require("../db/queries/webhookStatus");
const liveRoomsDb = require("../db/queries/liveRooms");
const CONFIG = require("../config");
const {
  formatDurationMs,
  isJoinEvent,
  isLeaveEvent,
  isMessageEvent,
  isReactionEvent,
  isPollVoteEvent,
  isRaiseHandEvent,
  isTalkStartEvent,
  isTalkStopEvent,
  isWebcamStartEvent,
  isWebcamStopEvent,
  isModeratorRole,
  toTimestampMs
} = require("../utils/helpers");

async function buildStats(options = {}) {
  const { skipLiveSync = false } = options;

  const [
    totals,
    summary,
    webhookStatus,
    liveRooms,
    topMeetings,
    topClasses,
    topTeachers,
    topStudents,
    recentEvents
  ] = await Promise.all([
    statsDb.getTotals(),
    statsDb.getSummary(),
    webhookStatusDb.getWebhookStatus(),
    skipLiveSync ? [] : liveRoomsDb.getLiveRooms(),
    meetingsDb.getTopMeetings(10),
    statsDb.getTopClasses(10),
    statsDb.getTopTeachers(10),
    statsDb.getTopStudents(10),
    eventsDb.getRecentEvents(100)
  ]);

  const hasApiBaseUrl = Boolean(CONFIG.bbbApiBaseUrl);
  const hasSharedSecret = Boolean(CONFIG.bbbSharedSecret);
  const hasCallbackUrl = Boolean(CONFIG.callbackUrl || webhookStatus.callbackUrl);
  const missingEnv = [];

  if (!hasApiBaseUrl) missingEnv.push("BBB_API_BASE_URL");
  if (!hasSharedSecret) missingEnv.push("BBB_SHARED_SECRET");
  if (!hasCallbackUrl) missingEnv.push("BBB_CALLBACK_URL");

  const classDetails = await buildClassDetails();
  const teacherDetails = await buildTeacherDetails();
  const studentDetails = await buildStudentDetails();

  return {
    totals,
    summary,
    hook: {
      ...webhookStatus,
      configured: missingEnv.length === 0,
      hasApiBaseUrl,
      hasSharedSecret,
      hasCallbackUrl,
      missingEnv,
      expectedCallbackUrl: CONFIG.callbackUrl || webhookStatus.callbackUrl
    },
    liveRooms,
    topMeetings,
    topClasses,
    topTeachers,
    topStudents,
    classDetails,
    teacherDetails,
    studentDetails,
    recentEvents: recentEvents.filter(e => e.eventName !== "unknown" || e.meetingId !== "unknown-meeting")
  };
}

async function buildClassDetails() {
  const classesResult = await classesDb.getAllClasses();
  const details = [];

  for (const cls of classesResult.slice(0, 50)) {
    const classDetail = await classesDb.getClassDetails(cls.class_id);
    if (!classDetail) continue;

    const relatedEvents = await eventsDb.getEventsByClassId(cls.class_id, 100);
    const participantActivity = await buildParticipantActivity(relatedEvents, classDetail.teachers.map(t => t.teacherId));

    details.push({
      classId: classDetail.classId,
      className: classDetail.className,
      meetings: classDetail.meetings,
      teachers: classDetail.teachers,
      students: classDetail.students,
      totals: classDetail.totals,
      participantActivity,
      recentEvents: relatedEvents.slice(0, 12)
    });
  }

  return details.sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);
}

async function buildTeacherDetails() {
  const teachersResult = await teachersDb.getAllTeachers();
  const details = [];

  for (const teacher of teachersResult.slice(0, 50)) {
    const teacherDetail = await teachersDb.getTeacherDetails(teacher.teacher_id);
    if (!teacherDetail) continue;

    const recentEvents = await eventsDb.searchEvents({
      teacherId: teacher.teacher_id,
      limit: 10
    });

    details.push({
      teacherId: teacherDetail.teacherId,
      classIds: teacherDetail.classes.map(c => c.classId),
      classNames: teacherDetail.classes.map(c => c.className),
      studentIds: teacherDetail.students.map(s => s.userId),
      totals: teacherDetail.totals,
      recentEvents: recentEvents.data.slice(0, 10)
    });
  }

  return details.sort((a, b) => b.totals.joinEvents - a.totals.joinEvents);
}

async function buildStudentDetails() {
  const studentsResult = await studentsDb.getAllStudents();
  const details = [];

  for (const student of studentsResult.slice(0, 50)) {
    const studentDetail = await studentsDb.getStudentDetails(student.user_id);
    if (!studentDetail) continue;

    const recentEvents = await eventsDb.searchEvents({
      userId: student.user_id,
      limit: 10
    });

    details.push({
      userId: studentDetail.userId,
      userName: studentDetail.userName,
      classIds: studentDetail.classes.map(c => c.classId),
      classNames: studentDetail.classes.map(c => c.className),
      teacherIds: studentDetail.teachers.map(t => t.teacherId),
      totals: studentDetail.totals,
      lastMeetingId: studentDetail.classes[0]?.lastMeetingId || null,
      recentEvents: recentEvents.data.slice(0, 10)
    });
  }

  return details.sort((a, b) => (b.totals.joins - a.totals.joins) || (b.totals.leaves - a.totals.leaves));
}

async function buildParticipantActivity(events, teacherIds = []) {
  const participantMap = new Map();

  const ensureParticipant = (userId, fallbackName = null, fallbackRole = null) => {
    if (!userId) return null;

    const existing = participantMap.get(userId);
    if (existing) {
      if (!existing.name && fallbackName) existing.name = fallbackName;
      if (!existing.role && fallbackRole) existing.role = fallbackRole;
      return existing;
    }

    const participant = {
      userId,
      name: fallbackName || userId,
      role: fallbackRole || null,
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

  for (const event of events) {
    if (!event.userId) continue;

    const isRosterParticipantEvent =
      isJoinEvent(event.eventName) ||
      isLeaveEvent(event.eventName) ||
      isMessageEvent(event.eventName) ||
      isReactionEvent(event.eventName) ||
      isPollVoteEvent(event.eventName) ||
      isRaiseHandEvent(event.eventName) ||
      isTalkStartEvent(event.eventName) ||
      isTalkStopEvent(event.eventName) ||
      isWebcamStartEvent(event.eventName) ||
      isWebcamStopEvent(event.eventName);

    if (!isRosterParticipantEvent) continue;

    const participant = ensureParticipant(event.userId, event.userName, event.role);
    if (!participant) continue;

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

    if (isMessageEvent(event.eventName)) participant.messages += 1;
    if (isReactionEvent(event.eventName)) participant.reactions += 1;
    if (isPollVoteEvent(event.eventName)) participant.pollVotes += 1;
    if (isRaiseHandEvent(event.eventName)) participant.raiseHands += 1;

    if (isTalkStartEvent(event.eventName) && timestampMs) {
      participant.talkEvents += 1;
      if (!participant.activeTalkAt) participant.activeTalkAt = timestampMs;
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
      if (!participant.activeWebcamAt) participant.activeWebcamAt = timestampMs;
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
  return Array.from(participantMap.values())
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

      const moderator = isModeratorRole(participant.role) || teacherIds.includes(participant.name);

      return {
        userId: participant.userId,
        name: participant.name,
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
}

module.exports = {
  buildStats,
  buildClassDetails,
  buildTeacherDetails,
  buildStudentDetails,
  buildParticipantActivity
};
