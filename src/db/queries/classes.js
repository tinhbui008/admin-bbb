const db = require("../index");
const recordingsDb = require("./recordings");

async function upsertClass(classId, className = null) {
  if (!classId || classId === "unmapped") return null;

  const result = await db.query(
    `INSERT INTO classes (class_id, class_name)
     VALUES ($1, $2)
     ON CONFLICT (class_id) DO UPDATE SET
       class_name = COALESCE(EXCLUDED.class_name, classes.class_name),
       updated_at = NOW()
     RETURNING *`,
    [classId, className]
  );
  return result.rows[0];
}

async function getClassById(classId) {
  const result = await db.query(
    `SELECT * FROM classes WHERE class_id = $1`,
    [classId]
  );
  return result.rows[0] || null;
}

async function getAllClasses() {
  const result = await db.query(
    `SELECT c.*,
       (SELECT COUNT(DISTINCT ct.teacher_id) FROM class_teachers ct WHERE ct.class_id = c.class_id) as teacher_count,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.class_id = c.class_id) as meeting_count,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as leave_events
     FROM classes c
     ORDER BY c.updated_at DESC`
  );
  return result.rows;
}

async function searchClasses({ search, teacherId, from, to, page = 1, limit = 20 }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  // Apply activity filter only when a date range is given (to hide orphans in ranged view)
  // When searching by name or fetching all (no date, no search): show everything
  if (!search && (from || to)) {
    conditions.push(`(
      (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.class_id = c.class_id) > 0
      OR (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs WHERE cs.class_id = c.class_id) > 0
    )`);
  }

  if (search) {
    conditions.push(`(c.class_id ILIKE $${paramIndex} OR c.class_name ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }
  if (teacherId) {
    conditions.push(`EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $${paramIndex++})`);
    params.push(teacherId);
  }
  // Skip date filter when searching by name — user wants to find a specific class regardless of date
  if (!search) {
    if (from) {
      conditions.push(`c.updated_at >= $${paramIndex++}::date`);
      params.push(from);
    }
    if (to) {
      conditions.push(`c.updated_at < ($${paramIndex++}::date + interval '1 day')`);
      params.push(to);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM classes c ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT c.*,
       (SELECT COUNT(DISTINCT ct.teacher_id) FROM class_teachers ct WHERE ct.class_id = c.class_id) as teacher_count,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs WHERE cs.class_id = c.class_id) as student_count,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.class_id = c.class_id) as meeting_count,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.class_id = c.class_id) as leave_events,
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at
     FROM classes c
     ${whereClause}
     ORDER BY c.updated_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    data: result.rows.map(row => ({
      classId: row.class_id,
      className: row.class_name || row.class_id,
      teacherCount: parseInt(row.teacher_count, 10),
      studentCount: parseInt(row.student_count, 10),
      meetingCount: parseInt(row.meeting_count, 10),
      joinEvents: parseInt(row.join_events, 10),
      leaveEvents: parseInt(row.leave_events, 10),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEndedAt: row.last_ended_at
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getClassDetails(classId) {
  const classResult = await db.query(
    `SELECT * FROM classes WHERE class_id = $1`,
    [classId]
  );
  if (classResult.rows.length === 0) return null;

  const cls = classResult.rows[0];

  const teachersResult = await db.query(
    `SELECT t.* FROM teachers t
     JOIN class_teachers ct ON ct.teacher_id = t.teacher_id
     WHERE ct.class_id = $1`,
    [classId]
  );

  const studentsResult = await db.query(
    `SELECT s.*, cs.join_count, cs.leave_count, cs.last_meeting_id
     FROM students s
     JOIN class_students cs ON cs.user_id = s.user_id
     WHERE cs.class_id = $1
     ORDER BY cs.join_count DESC`,
    [classId]
  );

  const meetingsResult = await db.query(
    `SELECT * FROM meetings WHERE class_id = $1 ORDER BY started_at DESC`,
    [classId]
  );

  const recordings = await recordingsDb.getRecordingsByClassId(classId);

  return {
    classId: cls.class_id,
    className: cls.class_name || cls.class_id,
    createdAt: cls.created_at,
    updatedAt: cls.updated_at,
    teachers: teachersResult.rows.map(t => ({
      teacherId: t.teacher_id,
      teacherName: t.teacher_name || t.teacher_id
    })),
    students: studentsResult.rows.map(s => ({
      userId: s.user_id,
      userName: s.user_name || s.user_id,
      joinCount: s.join_count,
      leaveCount: s.leave_count,
      lastMeetingId: s.last_meeting_id
    })),
    meetings: meetingsResult.rows.map(m => ({
      meetingId: m.meeting_id,
      meetingName: m.meeting_name,
      teacherId: m.teacher_id,
      joinEvents: m.join_events,
      leaveEvents: m.leave_events,
      startedAt: m.started_at,
      endedAt: m.ended_at
    })),
    recordings,
    totals: {
      teachers: teachersResult.rows.length,
      students: studentsResult.rows.length,
      meetings: meetingsResult.rows.length,
      joinEvents: meetingsResult.rows.reduce((sum, m) => sum + (m.join_events || 0), 0),
      leaveEvents: meetingsResult.rows.reduce((sum, m) => sum + (m.leave_events || 0), 0)
    }
  };
}

async function addClassTeacher(classId, teacherId) {
  if (!classId || !teacherId || classId === "unmapped" || teacherId === "unassigned") return;

  await db.query(
    `INSERT INTO class_teachers (class_id, teacher_id)
     VALUES ($1, $2)
     ON CONFLICT (class_id, teacher_id) DO NOTHING`,
    [classId, teacherId]
  );
}

async function addClassStudent(classId, userId, meetingId = null) {
  if (!classId || !userId || classId === "unmapped") return;

  await db.query(
    `INSERT INTO class_students (class_id, user_id, join_count, last_meeting_id)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (class_id, user_id) DO UPDATE SET
       join_count = class_students.join_count + 1,
       last_meeting_id = COALESCE(EXCLUDED.last_meeting_id, class_students.last_meeting_id),
       updated_at = NOW()`,
    [classId, userId, meetingId]
  );
}

async function incrementClassStudentLeave(classId, userId) {
  if (!classId || !userId || classId === "unmapped") return;

  await db.query(
    `UPDATE class_students SET
       leave_count = leave_count + 1,
       updated_at = NOW()
     WHERE class_id = $1 AND user_id = $2`,
    [classId, userId]
  );
}

async function deleteClass(classId) {
  await db.query(
    `DELETE FROM meeting_participants WHERE meeting_id IN (SELECT meeting_id FROM meetings WHERE class_id = $1)`,
    [classId]
  );
  await db.query(`DELETE FROM meetings WHERE class_id = $1`, [classId]);
  await db.query(`DELETE FROM class_students WHERE class_id = $1`, [classId]);
  await db.query(`DELETE FROM class_teachers WHERE class_id = $1`, [classId]);
  await db.query(`DELETE FROM live_rooms WHERE class_id = $1`, [classId]);
  await db.query(`DELETE FROM recordings WHERE class_id = $1`, [classId]);
  await db.query(`DELETE FROM classes WHERE class_id = $1`, [classId]);
}

module.exports = {
  upsertClass,
  getClassById,
  getAllClasses,
  searchClasses,
  getClassDetails,
  addClassTeacher,
  addClassStudent,
  incrementClassStudentLeave,
  deleteClass
};
