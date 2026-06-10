const db = require("../index");

async function insertEvent(event) {
  const result = await db.query(
    `INSERT INTO events (
      event_name, meeting_id, user_id, user_name, class_id, teacher_id,
      meeting_name, role, timestamp, checksum_valid, raw_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id`,
    [
      event.eventName,
      event.meetingId,
      event.userId,
      event.userName,
      event.classId,
      event.teacherId,
      event.meetingName,
      event.role,
      event.timestamp || new Date().toISOString(),
      event.checksumValid !== false,
      JSON.stringify(event.raw || {})
    ]
  );
  return result.rows[0];
}

async function getRecentEvents(limit = 100) {
  const result = await db.query(
    `SELECT event_name, meeting_id, user_id, user_name, class_id, teacher_id,
            meeting_name, role, timestamp, checksum_valid
     FROM events
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    eventName: row.event_name,
    meetingId: row.meeting_id,
    userId: row.user_id,
    userName: row.user_name,
    classId: row.class_id,
    teacherId: row.teacher_id,
    meetingName: row.meeting_name,
    role: row.role,
    timestamp: row.timestamp,
    checksumValid: row.checksum_valid
  }));
}

async function searchEvents({ classId, teacherId, userId, meetingId, eventName, from, to, page = 1, limit = 50 }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (classId) {
    conditions.push(`class_id = $${paramIndex++}`);
    params.push(classId);
  }
  if (teacherId) {
    conditions.push(`teacher_id = $${paramIndex++}`);
    params.push(teacherId);
  }
  if (userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(userId);
  }
  if (meetingId) {
    conditions.push(`meeting_id = $${paramIndex++}`);
    params.push(meetingId);
  }
  if (eventName) {
    conditions.push(`event_name ILIKE $${paramIndex++}`);
    params.push(`%${eventName}%`);
  }
  if (from) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(to);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM events ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT id, event_name, meeting_id, user_id, user_name, class_id, teacher_id,
            meeting_name, role, timestamp, checksum_valid, created_at
     FROM events
     ${whereClause}
     ORDER BY timestamp DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    data: result.rows.map(row => ({
      id: row.id,
      eventName: row.event_name,
      meetingId: row.meeting_id,
      userId: row.user_id,
      userName: row.user_name,
      classId: row.class_id,
      teacherId: row.teacher_id,
      meetingName: row.meeting_name,
      role: row.role,
      timestamp: row.timestamp,
      checksumValid: row.checksum_valid,
      createdAt: row.created_at
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getEventsByMeetingId(meetingId) {
  const result = await db.query(
    `SELECT event_name, meeting_id, user_id, user_name, class_id, teacher_id,
            meeting_name, role, timestamp, checksum_valid
     FROM events
     WHERE meeting_id = $1
     ORDER BY timestamp ASC`,
    [meetingId]
  );
  return result.rows.map(row => ({
    eventName: row.event_name,
    meetingId: row.meeting_id,
    userId: row.user_id,
    userName: row.user_name,
    classId: row.class_id,
    teacherId: row.teacher_id,
    meetingName: row.meeting_name,
    role: row.role,
    timestamp: row.timestamp,
    checksumValid: row.checksum_valid
  }));
}

async function getEventsByClassId(classId, limit = 100) {
  const result = await db.query(
    `SELECT event_name, meeting_id, user_id, user_name, class_id, teacher_id,
            meeting_name, role, timestamp, checksum_valid
     FROM events
     WHERE class_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [classId, limit]
  );
  return result.rows.map(row => ({
    eventName: row.event_name,
    meetingId: row.meeting_id,
    userId: row.user_id,
    userName: row.user_name,
    classId: row.class_id,
    teacherId: row.teacher_id,
    meetingName: row.meeting_name,
    role: row.role,
    timestamp: row.timestamp,
    checksumValid: row.checksum_valid
  }));
}

module.exports = {
  insertEvent,
  getRecentEvents,
  searchEvents,
  getEventsByMeetingId,
  getEventsByClassId
};
