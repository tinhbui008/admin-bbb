const db = require("../index");

async function getStat(key) {
  const result = await db.query(
    `SELECT value FROM stats WHERE key = $1`,
    [key]
  );
  return result.rows[0]?.value || 0;
}

async function incrementStat(key, amount = 1) {
  await db.query(
    `INSERT INTO stats (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET
       value = stats.value + EXCLUDED.value,
       updated_at = NOW()`,
    [key, amount]
  );
}

async function setStat(key, value) {
  await db.query(
    `INSERT INTO stats (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [key, value]
  );
}

async function getAllStats() {
  const result = await db.query(`SELECT key, value FROM stats`);
  const stats = {};
  for (const row of result.rows) {
    stats[row.key] = parseInt(row.value, 10);
  }
  return stats;
}

async function getTotals() {
  const stats = await getAllStats();
  return {
    events: stats.events || 0,
    meetingsCreated: stats.meetings_created || 0,
    meetingsEnded: stats.meetings_ended || 0,
    participantsJoined: stats.participants_joined || 0,
    participantsLeft: stats.participants_left || 0,
    checksumVerified: stats.checksum_verified || 0,
    checksumRejected: stats.checksum_rejected || 0
  };
}

async function getSummary() {
  const [meetingsResult, usersResult, classesResult, teachersResult] = await Promise.all([
    db.query(`SELECT COUNT(*) as count FROM meetings WHERE meeting_id != 'unknown-meeting'`),
    db.query(`SELECT COUNT(*) as count FROM students`),
    db.query(`SELECT COUNT(*) as count FROM classes WHERE class_id != 'unmapped'`),
    db.query(`SELECT COUNT(*) as count FROM teachers WHERE teacher_id != 'unassigned'`)
  ]);

  return {
    uniqueMeetings: parseInt(meetingsResult.rows[0].count, 10),
    uniqueUsers: parseInt(usersResult.rows[0].count, 10),
    uniqueClasses: parseInt(classesResult.rows[0].count, 10),
    uniqueTeachers: parseInt(teachersResult.rows[0].count, 10)
  };
}

async function getTopClasses(limit = 10) {
  const result = await db.query(
    `SELECT c.class_id, c.class_name, c.created_at,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.class_id = c.class_id) as meetings,
       (SELECT COUNT(DISTINCT ct.teacher_id) FROM class_teachers ct WHERE ct.class_id = c.class_id) as teachers,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs WHERE cs.class_id = c.class_id) as students,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as leave_events,
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at
     FROM classes c
     WHERE c.class_id != 'unmapped'
       AND (
         (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.class_id = c.class_id) > 0
         OR (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs WHERE cs.class_id = c.class_id) > 0
       )
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    classId: row.class_id,
    className: row.class_name || row.class_id,
    meetings: parseInt(row.meetings, 10),
    teachers: parseInt(row.teachers, 10),
    students: parseInt(row.students, 10),
    joinEvents: parseInt(row.join_events, 10),
    leaveEvents: parseInt(row.leave_events, 10),
    createdAt: row.created_at,
    lastEndedAt: row.last_ended_at
  }));
}

async function getTopTeachers(limit = 10) {
  const result = await db.query(
    `SELECT t.teacher_id,
       (SELECT COUNT(DISTINCT ct.class_id) FROM class_teachers ct WHERE ct.teacher_id = t.teacher_id) as classes,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.teacher_id = t.teacher_id) as meetings,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs
        JOIN class_teachers ct ON ct.class_id = cs.class_id
        WHERE ct.teacher_id = t.teacher_id) as students,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as leave_events
     FROM teachers t
     WHERE t.teacher_id != 'unassigned'
     ORDER BY join_events DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    teacherId: row.teacher_id,
    classes: parseInt(row.classes, 10),
    meetings: parseInt(row.meetings, 10),
    students: parseInt(row.students, 10),
    joinEvents: parseInt(row.join_events, 10),
    leaveEvents: parseInt(row.leave_events, 10)
  }));
}

async function getTopStudents(limit = 10) {
  const result = await db.query(
    `SELECT s.user_id, s.user_name,
       (SELECT COALESCE(SUM(cs.join_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as joins,
       (SELECT COALESCE(SUM(cs.leave_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as leaves,
       (SELECT cs.last_meeting_id FROM class_students cs WHERE cs.user_id = s.user_id ORDER BY cs.updated_at DESC LIMIT 1) as last_meeting_id,
       (SELECT COUNT(DISTINCT cs.class_id) FROM class_students cs WHERE cs.user_id = s.user_id) as classes,
       (SELECT COUNT(DISTINCT ct.teacher_id) FROM class_teachers ct
        JOIN class_students cs ON cs.class_id = ct.class_id
        WHERE cs.user_id = s.user_id) as teachers
     FROM students s
     WHERE s.role IS NULL OR s.role NOT ILIKE '%moderator%'
     ORDER BY joins DESC, leaves DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    userId: row.user_id,
    userName: row.user_name || row.user_id,
    joins: parseInt(row.joins, 10),
    leaves: parseInt(row.leaves, 10),
    lastMeetingId: row.last_meeting_id,
    classes: parseInt(row.classes, 10),
    teachers: parseInt(row.teachers, 10)
  }));
}

module.exports = {
  getStat,
  incrementStat,
  setStat,
  getAllStats,
  getTotals,
  getSummary,
  getTopClasses,
  getTopTeachers,
  getTopStudents
};
