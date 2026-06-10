const db = require("../index");

async function upsertTeacher(teacherId, teacherName = null) {
  if (!teacherId || teacherId === "unassigned") return null;

  const result = await db.query(
    `INSERT INTO teachers (teacher_id, teacher_name)
     VALUES ($1, $2)
     ON CONFLICT (teacher_id) DO UPDATE SET
       teacher_name = COALESCE(EXCLUDED.teacher_name, teachers.teacher_name),
       updated_at = NOW()
     RETURNING *`,
    [teacherId, teacherName]
  );
  return result.rows[0];
}

async function getTeacherById(teacherId) {
  const result = await db.query(
    `SELECT * FROM teachers WHERE teacher_id = $1`,
    [teacherId]
  );
  return result.rows[0] || null;
}

async function getAllTeachers() {
  const result = await db.query(
    `SELECT t.*,
       (SELECT COUNT(DISTINCT ct.class_id) FROM class_teachers ct WHERE ct.teacher_id = t.teacher_id) as class_count,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs
        JOIN class_teachers ct ON ct.class_id = cs.class_id
        WHERE ct.teacher_id = t.teacher_id) as student_count,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.teacher_id = t.teacher_id) as meeting_count,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as leave_events
     FROM teachers t
     ORDER BY t.updated_at DESC`
  );
  return result.rows;
}

async function searchTeachers({ search, classId, from, to, page = 1, limit = 20 }) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (search) {
    conditions.push(`(t.teacher_id ILIKE $${paramIndex} OR t.teacher_name ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }
  if (classId) {
    conditions.push(`EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.teacher_id = t.teacher_id AND ct.class_id = $${paramIndex++})`);
    params.push(classId);
  }
  if (from) {
    conditions.push(`t.created_at >= $${paramIndex++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`t.created_at <= $${paramIndex++}`);
    params.push(to);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM teachers t ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT t.*,
       (SELECT COUNT(DISTINCT ct.class_id) FROM class_teachers ct WHERE ct.teacher_id = t.teacher_id) as class_count,
       (SELECT COUNT(DISTINCT cs.user_id) FROM class_students cs
        JOIN class_teachers ct ON ct.class_id = cs.class_id
        WHERE ct.teacher_id = t.teacher_id) as student_count,
       (SELECT COUNT(DISTINCT m.meeting_id) FROM meetings m WHERE m.teacher_id = t.teacher_id) as meeting_count,
       (SELECT COALESCE(SUM(m.join_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as join_events,
       (SELECT COALESCE(SUM(m.leave_events), 0) FROM meetings m WHERE m.teacher_id = t.teacher_id) as leave_events
     FROM teachers t
     ${whereClause}
     ORDER BY t.updated_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    data: result.rows.map(row => ({
      teacherId: row.teacher_id,
      teacherName: row.teacher_name || row.teacher_id,
      classCount: parseInt(row.class_count, 10),
      studentCount: parseInt(row.student_count, 10),
      meetingCount: parseInt(row.meeting_count, 10),
      joinEvents: parseInt(row.join_events, 10),
      leaveEvents: parseInt(row.leave_events, 10),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

async function getTeacherDetails(teacherId) {
  const teacherResult = await db.query(
    `SELECT * FROM teachers WHERE teacher_id = $1`,
    [teacherId]
  );
  if (teacherResult.rows.length === 0) return null;

  const teacher = teacherResult.rows[0];

  const classesResult = await db.query(
    `SELECT c.* FROM classes c
     JOIN class_teachers ct ON ct.class_id = c.class_id
     WHERE ct.teacher_id = $1`,
    [teacherId]
  );

  const studentsResult = await db.query(
    `SELECT DISTINCT s.*, cs.join_count, cs.leave_count
     FROM students s
     JOIN class_students cs ON cs.user_id = s.user_id
     JOIN class_teachers ct ON ct.class_id = cs.class_id
     WHERE ct.teacher_id = $1
     ORDER BY cs.join_count DESC`,
    [teacherId]
  );

  const meetingsResult = await db.query(
    `SELECT * FROM meetings WHERE teacher_id = $1 ORDER BY started_at DESC`,
    [teacherId]
  );

  return {
    teacherId: teacher.teacher_id,
    teacherName: teacher.teacher_name || teacher.teacher_id,
    createdAt: teacher.created_at,
    updatedAt: teacher.updated_at,
    classes: classesResult.rows.map(c => ({
      classId: c.class_id,
      className: c.class_name || c.class_id
    })),
    students: studentsResult.rows.map(s => ({
      userId: s.user_id,
      userName: s.user_name || s.user_id,
      joinCount: s.join_count,
      leaveCount: s.leave_count
    })),
    meetings: meetingsResult.rows.map(m => ({
      meetingId: m.meeting_id,
      meetingName: m.meeting_name,
      classId: m.class_id,
      joinEvents: m.join_events,
      leaveEvents: m.leave_events,
      startedAt: m.started_at,
      endedAt: m.ended_at
    })),
    totals: {
      classes: classesResult.rows.length,
      students: studentsResult.rows.length,
      meetings: meetingsResult.rows.length,
      joinEvents: meetingsResult.rows.reduce((sum, m) => sum + (m.join_events || 0), 0),
      leaveEvents: meetingsResult.rows.reduce((sum, m) => sum + (m.leave_events || 0), 0)
    }
  };
}

module.exports = {
  upsertTeacher,
  getTeacherById,
  getAllTeachers,
  searchTeachers,
  getTeacherDetails
};
