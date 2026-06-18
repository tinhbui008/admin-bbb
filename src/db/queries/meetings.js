const db = require("../index");

async function upsertMeeting(meetingId, data = {}) {
  if (!meetingId || meetingId === "unknown-meeting") return null;

  const result = await db.query(
    `INSERT INTO meetings (meeting_id, meeting_name, class_id, teacher_id, started_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (meeting_id) DO UPDATE SET
       meeting_name = COALESCE(EXCLUDED.meeting_name, meetings.meeting_name),
       class_id = COALESCE(EXCLUDED.class_id, meetings.class_id),
       teacher_id = COALESCE(EXCLUDED.teacher_id, meetings.teacher_id),
       updated_at = NOW()
     RETURNING *`,
    [meetingId, data.meetingName, data.classId, data.teacherId]
  );
  return result.rows[0];
}

async function getMeetingById(meetingId) {
  const result = await db.query(
    `SELECT * FROM meetings WHERE meeting_id = $1`,
    [meetingId]
  );
  return result.rows[0] || null;
}

async function incrementMeetingCreated(meetingId) {
  await db.query(
    `UPDATE meetings SET
       created_events = created_events + 1,
       started_at = COALESCE(started_at, NOW()),
       updated_at = NOW()
     WHERE meeting_id = $1`,
    [meetingId]
  );
}

async function incrementMeetingEnded(meetingId) {
  await db.query(
    `UPDATE meetings SET
       ended_events = ended_events + 1,
       ended_at = NOW(),
       updated_at = NOW()
     WHERE meeting_id = $1`,
    [meetingId]
  );
}

async function incrementMeetingJoin(meetingId) {
  await db.query(
    `UPDATE meetings SET
       join_events = join_events + 1,
       updated_at = NOW()
     WHERE meeting_id = $1`,
    [meetingId]
  );
}

async function incrementMeetingLeave(meetingId) {
  await db.query(
    `UPDATE meetings SET
       leave_events = leave_events + 1,
       updated_at = NOW()
     WHERE meeting_id = $1`,
    [meetingId]
  );
}

async function searchMeetings({ classId, teacherId, from, to, page = 1, limit = 20 }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  // Filter out orphan meetings with no activity
  conditions.push(`(
    join_events > 0
    OR (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.meeting_id) > 0
  )`);

  if (classId) {
    conditions.push(`class_id = $${paramIndex++}`);
    params.push(classId);
  }
  if (teacherId) {
    conditions.push(`teacher_id = $${paramIndex++}`);
    params.push(teacherId);
  }
  if (from) {
    conditions.push(`started_at >= $${paramIndex++}::date`);
    params.push(from);
  }
  if (to) {
    conditions.push(`started_at < ($${paramIndex++}::date + interval '1 day')`);
    params.push(to);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM meetings m ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT m.*,
       (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.meeting_id) as participant_count
     FROM meetings m
     ${whereClause}
     ORDER BY m.started_at DESC NULLS LAST
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    data: result.rows.map(row => ({
      meetingId: row.meeting_id,
      meetingName: row.meeting_name,
      classId: row.class_id,
      teacherId: row.teacher_id,
      createdEvents: row.created_events,
      endedEvents: row.ended_events,
      joinEvents: row.join_events,
      leaveEvents: row.leave_events,
      participantCount: parseInt(row.participant_count, 10),
      startedAt: row.started_at,
      endedAt: row.ended_at
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getMeetingDetails(meetingId) {
  const meetingResult = await db.query(
    `SELECT * FROM meetings WHERE meeting_id = $1`,
    [meetingId]
  );
  if (meetingResult.rows.length === 0) return null;

  const meeting = meetingResult.rows[0];

  const participantsResult = await db.query(
    `SELECT * FROM meeting_participants WHERE meeting_id = $1 ORDER BY join_at ASC`,
    [meetingId]
  );

  return {
    meetingId: meeting.meeting_id,
    meetingName: meeting.meeting_name,
    classId: meeting.class_id,
    teacherId: meeting.teacher_id,
    createdEvents: meeting.created_events,
    endedEvents: meeting.ended_events,
    joinEvents: meeting.join_events,
    leaveEvents: meeting.leave_events,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    participants: participantsResult.rows.map(p => ({
      userId: p.user_id,
      userName: p.user_name,
      role: p.role,
      joinAt: p.join_at,
      leftAt: p.left_at,
      durationMs: Number(p.duration_ms) || 0,
      talkTimeMs: Number(p.talk_time_ms) || 0,
      webcamTimeMs: Number(p.webcam_time_ms) || 0,
      messages: p.messages,
      reactions: p.reactions,
      pollVotes: p.poll_votes,
      raiseHands: p.raise_hands
    }))
  };
}

async function upsertMeetingParticipant(meetingId, userId, data = {}) {
  if (!meetingId || !userId) return null;

  const result = await db.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, user_name, role, join_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (meeting_id, user_id) DO UPDATE SET
       user_name = COALESCE(EXCLUDED.user_name, meeting_participants.user_name),
       role = COALESCE(EXCLUDED.role, meeting_participants.role),
       updated_at = NOW()
     RETURNING *`,
    [meetingId, userId, data.userName, data.role, data.joinAt || new Date()]
  );
  return result.rows[0];
}

async function updateParticipantLeft(meetingId, userId, leftAt) {
  await db.query(
    `UPDATE meeting_participants SET
       left_at = $3,
       duration_ms = CASE
         WHEN join_at IS NOT NULL
         THEN GREATEST(0, EXTRACT(EPOCH FROM ($3::timestamptz - join_at)) * 1000)::bigint
         ELSE duration_ms
       END,
       updated_at = NOW()
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, leftAt]
  );
}

async function incrementParticipantActivity(meetingId, userId, field) {
  const validFields = ["messages", "reactions", "poll_votes", "raise_hands"];
  if (!validFields.includes(field)) return;

  await db.query(
    `UPDATE meeting_participants SET
       ${field} = ${field} + 1,
       updated_at = NOW()
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
}

async function addParticipantTalkTime(meetingId, userId, durationMs) {
  await db.query(
    `UPDATE meeting_participants SET
       talk_time_ms = talk_time_ms + $3,
       updated_at = NOW()
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, durationMs]
  );
}

async function addParticipantWebcamTime(meetingId, userId, durationMs) {
  await db.query(
    `UPDATE meeting_participants SET
       webcam_time_ms = webcam_time_ms + $3,
       updated_at = NOW()
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, durationMs]
  );
}

async function getParticipantsByClassId(classId) {
  const result = await db.query(
    `SELECT mp.*, m.meeting_name
     FROM meeting_participants mp
     JOIN meetings m ON m.meeting_id = mp.meeting_id
     WHERE m.class_id = $1
     ORDER BY mp.join_at ASC`,
    [classId]
  );
  return result.rows.map(p => ({
    meetingId: p.meeting_id,
    meetingName: p.meeting_name,
    userId: p.user_id,
    userName: p.user_name,
    role: p.role,
    joinAt: p.join_at,
    leftAt: p.left_at,
    durationMs: Number(p.duration_ms) || 0,
    talkTimeMs: Number(p.talk_time_ms) || 0,
    webcamTimeMs: Number(p.webcam_time_ms) || 0,
    messages: p.messages,
    reactions: p.reactions,
    pollVotes: p.poll_votes,
    raiseHands: p.raise_hands
  }));
}

async function getTopMeetings(limit = 10) {
  const result = await db.query(
    `SELECT m.*,
       (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.meeting_id) as participant_count
     FROM meetings m
     WHERE m.join_events > 0 OR (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.meeting_id) > 0
     ORDER BY m.join_events DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    meetingId: row.meeting_id,
    meetingName: row.meeting_name,
    classId: row.class_id,
    teacherId: row.teacher_id,
    participants: parseInt(row.participant_count, 10),
    joinEvents: row.join_events,
    leaveEvents: row.leave_events
  }));
}

module.exports = {
  upsertMeeting,
  getMeetingById,
  incrementMeetingCreated,
  incrementMeetingEnded,
  incrementMeetingJoin,
  incrementMeetingLeave,
  searchMeetings,
  getMeetingDetails,
  upsertMeetingParticipant,
  updateParticipantLeft,
  incrementParticipantActivity,
  addParticipantTalkTime,
  addParticipantWebcamTime,
  getParticipantsByClassId,
  getTopMeetings
};
