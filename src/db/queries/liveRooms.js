const db = require("../index");

async function getLiveRooms() {
  const result = await db.query(
    `SELECT * FROM live_rooms ORDER BY attendee_count DESC`
  );
  return result.rows.map(row => ({
    meetingId: row.meeting_id,
    meetingName: row.meeting_name,
    attendeeCount: row.attendee_count,
    moderatorCount: row.moderator_count,
    running: row.running,
    createTime: row.create_time,
    classId: row.class_id,
    teacherId: row.teacher_id
  }));
}

async function syncLiveRooms(rooms) {
  await db.transaction(async (client) => {
    await client.query(`DELETE FROM live_rooms`);

    for (const room of rooms) {
      await client.query(
        `INSERT INTO live_rooms (
          meeting_id, meeting_name, attendee_count, moderator_count,
          running, create_time, class_id, teacher_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          room.meetingId || "unknown-meeting",
          room.meetingName || room.meetingId || "Unnamed room",
          room.attendeeCount || 0,
          room.moderatorCount || 0,
          room.running || null,
          room.createTime || null,
          room.classId || null,
          room.teacherId || null
        ]
      );
    }
  });
}

async function findMeetingContext(meetingId) {
  if (!meetingId) {
    return { classId: null, teacherId: null };
  }

  const meetingResult = await db.query(
    `SELECT class_id, teacher_id FROM meetings WHERE meeting_id = $1`,
    [meetingId]
  );

  if (meetingResult.rows.length > 0) {
    return {
      classId: meetingResult.rows[0].class_id,
      teacherId: meetingResult.rows[0].teacher_id
    };
  }

  const eventResult = await db.query(
    `SELECT class_id, teacher_id FROM events
     WHERE meeting_id = $1 AND (class_id IS NOT NULL OR teacher_id IS NOT NULL)
     ORDER BY created_at DESC LIMIT 1`,
    [meetingId]
  );

  if (eventResult.rows.length > 0) {
    return {
      classId: eventResult.rows[0].class_id,
      teacherId: eventResult.rows[0].teacher_id
    };
  }

  return { classId: null, teacherId: null };
}

module.exports = {
  getLiveRooms,
  syncLiveRooms,
  findMeetingContext
};
