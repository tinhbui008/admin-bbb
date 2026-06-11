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

  // Build chart data for visualizations
  const chartData = await buildChartData(recentEvents, classDetails, teacherDetails, liveRooms, summary);

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
    chartData,
    recentEvents: recentEvents.filter(e => e.eventName !== "unknown" || e.meetingId !== "unknown-meeting")
  };
}

async function buildClassDetails() {
  const classesResult = await classesDb.getAllClasses();
  const details = [];

  for (const cls of classesResult.slice(0, 50)) {
    const classDetail = await classesDb.getClassDetails(cls.class_id);
    if (!classDetail) continue;

    // Skip classes with no meaningful data (orphan records from archive events)
    if (classDetail.totals.joinEvents === 0 && classDetail.totals.students === 0) {
      continue;
    }

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
      // Update name if we have a real name and current name is just the userId
      if (fallbackName && existing.name === existing.userId) existing.name = fallbackName;
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

/**
 * Build chart data for dashboard visualizations
 */
async function buildChartData(recentEvents, classDetails, teacherDetails, liveRooms, summary) {
  // 1. Meeting Activity Timeline (last 7 days)
  const meetingActivityByDay = buildMeetingActivityByDay(recentEvents);

  // 2. Peak Usage Hours (24 hours distribution)
  const peakUsageHours = buildPeakUsageHours(recentEvents);

  // 3. Class Duration Trend
  const classDurationTrend = buildClassDurationTrend(classDetails);

  // 4. Participant Distribution (Teachers vs Students)
  const participantDistribution = {
    teachers: summary.uniqueTeachers || 0,
    students: summary.uniqueUsers || 0
  };

  // 5. Class Status (Live vs Ended)
  const liveCount = (liveRooms || []).length;
  const endedCount = (classDetails || []).filter(c =>
    c.meetings && c.meetings.some(m => m.endedAt)
  ).length;
  const classStatus = {
    live: liveCount,
    ended: endedCount
  };

  // 6. Event Type Breakdown
  const eventTypeBreakdown = buildEventTypeBreakdown(recentEvents);

  // 7. Teacher Workload
  const teacherWorkload = buildTeacherWorkload(teacherDetails);

  // 8. Activity Score Distribution
  const activityDistribution = buildActivityDistribution(classDetails);

  return {
    meetingActivityByDay,
    peakUsageHours,
    classDurationTrend,
    participantDistribution,
    classStatus,
    eventTypeBreakdown,
    teacherWorkload,
    activityDistribution
  };
}

function buildMeetingActivityByDay(events) {
  const dayMap = new Map();
  const now = new Date();

  // Initialize last 7 days
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const key = date.toISOString().split('T')[0];
    dayMap.set(key, { meetings: 0, joins: 0, leaves: 0 });
  }

  for (const event of events) {
    if (!event.timestamp) continue;
    const date = new Date(event.timestamp);
    const key = date.toISOString().split('T')[0];

    if (!dayMap.has(key)) continue;

    const entry = dayMap.get(key);
    if (event.eventName === 'meeting-created') {
      entry.meetings++;
    } else if (isJoinEvent(event.eventName)) {
      entry.joins++;
    } else if (isLeaveEvent(event.eventName)) {
      entry.leaves++;
    }
  }

  const labels = [];
  const meetings = [];
  const joins = [];
  const leaves = [];

  for (const [date, data] of dayMap) {
    labels.push(date);
    meetings.push(data.meetings);
    joins.push(data.joins);
    leaves.push(data.leaves);
  }

  return { labels, meetings, joins, leaves };
}

function buildPeakUsageHours(events) {
  const hourCounts = new Array(24).fill(0);

  for (const event of events) {
    if (!event.timestamp || !isJoinEvent(event.eventName)) continue;
    const date = new Date(event.timestamp);
    const hour = date.getHours();
    hourCounts[hour]++;
  }

  const labels = [];
  for (let i = 0; i < 24; i++) {
    labels.push(`${i.toString().padStart(2, '0')}:00`);
  }

  return { labels, counts: hourCounts };
}

function buildClassDurationTrend(classDetails) {
  const dayMap = new Map();

  for (const cls of classDetails || []) {
    for (const meeting of cls.meetings || []) {
      if (!meeting.startedAt || !meeting.endedAt) continue;

      const startDate = new Date(meeting.startedAt);
      const endDate = new Date(meeting.endedAt);
      const durationMinutes = Math.round((endDate - startDate) / 60000);

      if (durationMinutes <= 0 || durationMinutes > 480) continue; // Skip invalid durations

      const key = startDate.toISOString().split('T')[0];

      if (!dayMap.has(key)) {
        dayMap.set(key, { total: 0, count: 0 });
      }

      const entry = dayMap.get(key);
      entry.total += durationMinutes;
      entry.count++;
    }
  }

  const sorted = Array.from(dayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sorted.map(([date]) => date);
  const avgDurations = sorted.map(([, data]) =>
    data.count > 0 ? Math.round(data.total / data.count) : 0
  );

  return { labels, avgDurations };
}

function buildEventTypeBreakdown(events) {
  const counts = {
    joins: 0,
    leaves: 0,
    messages: 0,
    reactions: 0,
    pollVotes: 0,
    raiseHands: 0
  };

  for (const event of events) {
    if (isJoinEvent(event.eventName)) counts.joins++;
    else if (isLeaveEvent(event.eventName)) counts.leaves++;
    else if (isMessageEvent(event.eventName)) counts.messages++;
    else if (isReactionEvent(event.eventName)) counts.reactions++;
    else if (isPollVoteEvent(event.eventName)) counts.pollVotes++;
    else if (isRaiseHandEvent(event.eventName)) counts.raiseHands++;
  }

  return counts;
}

function buildTeacherWorkload(teacherDetails) {
  const workload = [];

  for (const teacher of teacherDetails || []) {
    if (teacher.totals && teacher.totals.classes > 0) {
      workload.push({
        name: teacher.teacherId,
        classes: teacher.totals.classes,
        students: teacher.totals.students || 0
      });
    }
  }

  // Sort by classes descending, take top 10
  workload.sort((a, b) => b.classes - a.classes);
  return workload.slice(0, 10);
}

function buildActivityDistribution(classDetails) {
  let totalMessages = 0;
  let totalTalkEvents = 0;
  let totalWebcamEvents = 0;
  let totalReactions = 0;

  for (const cls of classDetails || []) {
    for (const participant of cls.participantActivity || []) {
      totalMessages += participant.messages || 0;
      totalReactions += participant.reactions || 0;
      // Count talk/webcam time as activity indicators
      if (participant.talkTime && participant.talkTime !== '-') totalTalkEvents++;
      if (participant.webcamTime && participant.webcamTime !== '-') totalWebcamEvents++;
    }
  }

  return {
    messages: totalMessages,
    talkEvents: totalTalkEvents,
    webcamEvents: totalWebcamEvents,
    reactions: totalReactions
  };
}

module.exports = {
  buildStats,
  buildClassDetails,
  buildTeacherDetails,
  buildStudentDetails,
  buildParticipantActivity,
  buildChartData
};
