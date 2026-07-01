const db = require("../index");

function mapRecording(row) {
  return {
    recordId: row.record_id,
    meetingId: row.meeting_id,
    classId: row.class_id,
    name: row.name,
    state: row.state,
    published: row.published,
    // BIGINT columns come back as strings from pg — coerce to Number for the frontend
    startTime: row.start_time !== null ? Number(row.start_time) : null,
    endTime: row.end_time !== null ? Number(row.end_time) : null,
    durationMs: row.duration_ms !== null ? Number(row.duration_ms) : null,
    participants: row.participants,
    playback: Array.isArray(row.playback) ? row.playback : []
  };
}

async function syncRecordings(recordings) {
  if (!Array.isArray(recordings) || recordings.length === 0) return;

  await db.transaction(async (client) => {
    for (const rec of recordings) {
      if (!rec.recordId) continue;

      await client.query(
        `INSERT INTO recordings (
           record_id, meeting_id, class_id, name, state, published,
           start_time, end_time, duration_ms, participants, playback, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (record_id) DO UPDATE SET
           meeting_id = EXCLUDED.meeting_id,
           class_id = COALESCE(EXCLUDED.class_id, recordings.class_id),
           name = EXCLUDED.name,
           state = EXCLUDED.state,
           published = EXCLUDED.published,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           duration_ms = EXCLUDED.duration_ms,
           participants = EXCLUDED.participants,
           playback = EXCLUDED.playback,
           updated_at = NOW()`,
        [
          rec.recordId,
          rec.meetingId || null,
          rec.classId || null,
          rec.name || null,
          rec.state || null,
          typeof rec.published === "boolean" ? rec.published : null,
          rec.startTime || null,
          rec.endTime || null,
          rec.durationMs || null,
          rec.participants || null,
          JSON.stringify(rec.playback || [])
        ]
      );
    }
  });
}

async function getRecordingsByClassId(classId) {
  if (!classId) return [];

  const result = await db.query(
    `SELECT * FROM recordings WHERE class_id = $1 ORDER BY start_time DESC NULLS LAST`,
    [classId]
  );
  return result.rows.map(mapRecording);
}

module.exports = {
  syncRecordings,
  getRecordingsByClassId
};
