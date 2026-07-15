// Read-only access to the Greenlight database (separate Postgres) to surface
// room access-code state + change history recorded by the `access_code_audit`
// trigger. Pool is created lazily and only when GREENLIGHT_DATABASE_URL is set,
// so the whole feature self-disables (and never affects the dashboard's own DB)
// when unconfigured.
const { Pool } = require("pg");
const CONFIG = require("../config");

let pool = null;

function getPool() {
  if (!CONFIG.greenlightDatabaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: CONFIG.greenlightDatabaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    pool.on("error", (err) => {
      console.error("Greenlight pool error:", err.message);
    });
  }
  return pool;
}

// Greenlight meeting_option name -> short label used by the UI
const CODE_LABEL = {
  glModeratorAccessCode: "moderator",
  glViewerAccessCode: "viewer"
};

// Map dashboard meeting ids -> Greenlight room(s), returning current access-code
// values plus the recorded change history. Best-effort: caller wraps in try/catch.
async function getAccessCodeInfo(meetingIds) {
  const p = getPool();
  if (!p) return { rooms: [] };

  const ids = [...new Set((meetingIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return { rooms: [] };

  const roomsRes = await p.query(
    `SELECT id, name, meeting_id FROM rooms WHERE meeting_id = ANY($1::varchar[])`,
    [ids]
  );
  if (roomsRes.rows.length === 0) return { rooms: [] };

  const roomIds = roomsRes.rows.map(r => r.id);

  const [curRes, histRes] = await Promise.all([
    p.query(
      `SELECT rmo.room_id, mo.name AS opt, rmo.value, rmo.updated_at
       FROM room_meeting_options rmo
       JOIN meeting_options mo ON mo.id = rmo.meeting_option_id
       WHERE rmo.room_id = ANY($1::uuid[])
         AND mo.name IN ('glModeratorAccessCode', 'glViewerAccessCode')`,
      [roomIds]
    ),
    p.query(
      `SELECT room_id, option_name, op, old_value, new_value, changed_at
       FROM access_code_audit
       WHERE room_id = ANY($1::uuid[])
       ORDER BY changed_at DESC`,
      [roomIds]
    )
  ]);

  const rooms = roomsRes.rows.map(room => {
    const current = {
      moderator: { value: null, updatedAt: null },
      viewer: { value: null, updatedAt: null }
    };
    for (const c of curRes.rows) {
      if (c.room_id !== room.id) continue;
      const label = CODE_LABEL[c.opt];
      if (label) current[label] = { value: c.value || null, updatedAt: c.updated_at };
    }

    const history = histRes.rows
      .filter(h => h.room_id === room.id)
      .map(h => ({
        changedAt: h.changed_at,
        code: CODE_LABEL[h.option_name] || h.option_name,
        op: h.op,
        oldValue: h.old_value || null,
        newValue: h.new_value || null
      }));

    return {
      roomId: room.id,
      roomName: room.name,
      meetingId: room.meeting_id,
      current,
      history
    };
  });

  return { rooms };
}

module.exports = { getAccessCodeInfo };
