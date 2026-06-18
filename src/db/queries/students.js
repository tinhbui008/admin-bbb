const db = require("../index");

async function upsertStudent(userId, userName = null, role = null) {
  if (!userId) return null;

  const result = await db.query(
    `INSERT INTO students (user_id, user_name, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       user_name = COALESCE(EXCLUDED.user_name, students.user_name),
       role = COALESCE(EXCLUDED.role, students.role),
       updated_at = NOW()
     RETURNING *`,
    [userId, userName, role]
  );
  return result.rows[0];
}

async function getStudentById(userId) {
  const result = await db.query(
    `SELECT * FROM students WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getAllStudents() {
  const result = await db.query(
    `SELECT s.*,
       (SELECT COUNT(DISTINCT cs.class_id) FROM class_students cs WHERE cs.user_id = s.user_id) as class_count,
       (SELECT COALESCE(SUM(cs.join_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as total_joins,
       (SELECT COALESCE(SUM(cs.leave_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as total_leaves
     FROM students s
     WHERE s.role IS NULL OR s.role NOT ILIKE '%moderator%'
     ORDER BY s.updated_at DESC`
  );
  return result.rows;
}

async function searchStudents({ search, classId, teacherId, from, to, page = 1, limit = 20 }) {
  const conditions = ["(s.role IS NULL OR s.role NOT ILIKE '%moderator%')"];
  const params = [];
  let paramIndex = 1;

  if (search) {
    conditions.push(`(s.user_id ILIKE $${paramIndex} OR s.user_name ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }
  if (classId) {
    conditions.push(`EXISTS (SELECT 1 FROM class_students cs WHERE cs.user_id = s.user_id AND cs.class_id = $${paramIndex++})`);
    params.push(classId);
  }
  if (teacherId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM class_students cs
      JOIN class_teachers ct ON ct.class_id = cs.class_id
      WHERE cs.user_id = s.user_id AND ct.teacher_id = $${paramIndex++}
    )`);
    params.push(teacherId);
  }
  if (from) {
    conditions.push(`s.created_at >= $${paramIndex++}::date`);
    params.push(from);
  }
  if (to) {
    conditions.push(`s.created_at < ($${paramIndex++}::date + interval '1 day')`);
    params.push(to);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * limit;

  const countResult = await db.query(
    `SELECT COUNT(*) as total FROM students s ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT s.*,
       (SELECT COUNT(DISTINCT cs.class_id) FROM class_students cs WHERE cs.user_id = s.user_id) as class_count,
       (SELECT COALESCE(SUM(cs.join_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as total_joins,
       (SELECT COALESCE(SUM(cs.leave_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) as total_leaves,
       (SELECT cs.last_meeting_id FROM class_students cs WHERE cs.user_id = s.user_id ORDER BY cs.updated_at DESC LIMIT 1) as last_meeting_id
     FROM students s
     ${whereClause}
     ORDER BY (SELECT COALESCE(SUM(cs.join_count), 0) FROM class_students cs WHERE cs.user_id = s.user_id) DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    data: result.rows.map(row => ({
      userId: row.user_id,
      userName: row.user_name || row.user_id,
      role: row.role,
      classCount: parseInt(row.class_count, 10),
      totalJoins: parseInt(row.total_joins, 10),
      totalLeaves: parseInt(row.total_leaves, 10),
      lastMeetingId: row.last_meeting_id,
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

async function getStudentDetails(userId) {
  const studentResult = await db.query(
    `SELECT * FROM students WHERE user_id = $1`,
    [userId]
  );
  if (studentResult.rows.length === 0) return null;

  const student = studentResult.rows[0];

  const classesResult = await db.query(
    `SELECT c.*, cs.join_count, cs.leave_count, cs.last_meeting_id
     FROM classes c
     JOIN class_students cs ON cs.class_id = c.class_id
     WHERE cs.user_id = $1
     ORDER BY cs.join_count DESC`,
    [userId]
  );

  const teachersResult = await db.query(
    `SELECT DISTINCT t.*
     FROM teachers t
     JOIN class_teachers ct ON ct.teacher_id = t.teacher_id
     JOIN class_students cs ON cs.class_id = ct.class_id
     WHERE cs.user_id = $1`,
    [userId]
  );

  const participationsResult = await db.query(
    `SELECT mp.*, m.meeting_name, m.class_id
     FROM meeting_participants mp
     JOIN meetings m ON m.meeting_id = mp.meeting_id
     WHERE mp.user_id = $1
     ORDER BY mp.join_at DESC
     LIMIT 20`,
    [userId]
  );

  const totalJoins = classesResult.rows.reduce((sum, c) => sum + (c.join_count || 0), 0);
  const totalLeaves = classesResult.rows.reduce((sum, c) => sum + (c.leave_count || 0), 0);

  return {
    userId: student.user_id,
    userName: student.user_name || student.user_id,
    role: student.role,
    createdAt: student.created_at,
    updatedAt: student.updated_at,
    classes: classesResult.rows.map(c => ({
      classId: c.class_id,
      className: c.class_name || c.class_id,
      joinCount: c.join_count,
      leaveCount: c.leave_count,
      lastMeetingId: c.last_meeting_id
    })),
    teachers: teachersResult.rows.map(t => ({
      teacherId: t.teacher_id,
      teacherName: t.teacher_name || t.teacher_id
    })),
    recentParticipations: participationsResult.rows.map(p => ({
      meetingId: p.meeting_id,
      meetingName: p.meeting_name,
      classId: p.class_id,
      joinAt: p.join_at,
      leftAt: p.left_at,
      durationMs: Number(p.duration_ms) || 0,
      talkTimeMs: Number(p.talk_time_ms) || 0,
      webcamTimeMs: Number(p.webcam_time_ms) || 0,
      messages: p.messages,
      reactions: p.reactions
    })),
    totals: {
      classes: classesResult.rows.length,
      teachers: teachersResult.rows.length,
      joins: totalJoins,
      leaves: totalLeaves
    }
  };
}

module.exports = {
  upsertStudent,
  getStudentById,
  getAllStudents,
  searchStudents,
  getStudentDetails
};
