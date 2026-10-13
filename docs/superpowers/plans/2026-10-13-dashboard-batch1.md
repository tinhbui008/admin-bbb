# Dashboard Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the history date-filter (filter by activity date, not row update date), make recording-sync stop exhausting the DB pool, and surface a single "primary teacher" per class.

**Architecture:** Three independent read-side changes. #1 rewrites three `search*` SQL filters to use `EXISTS` over `meetings.started_at`. #2 batches an N+1 lookup and throttles the recordings block off the `/api/stats` path. #3a derives (does not store) a primary teacher via one shared JS helper fed by the class's teacher list. No schema migration.

**Tech Stack:** Node (CommonJS, `http` module), `pg`, vanilla single-file `public/index.html`. No test framework, no bundler.

**Conventions for this plan (repo-specific):**
- There is **no test runner**. "Verify" steps are `node` one-liners run **inside the running container** against the app's own pool, or a dashboard load after deploy. Run them against prod (`docker exec -w /app bbb-admin-nihaoma node -e '…'`) or a local `npm start` with a reachable `DATABASE_URL`.
- **Do not run git commit** — the user commits. "Commit" steps give the exact suggested message to hand to the user.
- Keep style: CommonJS, 2-space indent, double-quoted strings, semicolons.

---

## Task 1: #1 — Classes filter by activity date (`classes.js`)

**Files:**
- Modify: `src/db/queries/classes.js` (inside `searchClasses`, the `if (!search) { …date… }` block)

- [ ] **Step 1: Replace the `updated_at` date filter with an activity EXISTS**

Find this block in `searchClasses`:
```js
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
```
Replace with:
```js
  // Filter by ACTIVITY date (had a meeting in range), not the class row's updated_at.
  // Skip when searching by name — user wants the class regardless of date.
  if (!search && (from || to)) {
    const rangeConds = [];
    if (from) { rangeConds.push(`m.started_at >= $${paramIndex++}::date`); params.push(from); }
    if (to)   { rangeConds.push(`m.started_at < ($${paramIndex++}::date + 1)`); params.push(to); }
    conditions.push(`EXISTS (SELECT 1 FROM meetings m WHERE m.class_id = c.class_id AND ${rangeConds.join(" AND ")})`);
  }
```

- [ ] **Step 2: Verify (after deploy, or local)**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const c=require("./src/db/queries/classes");c.searchClasses({from:"2026-10-10",to:"2026-10-10",page:1,limit:50}).then(r=>{console.log("total:",r.pagination.total,"sample:",r.data.slice(0,3).map(x=>x.className));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: `total` > 0 and sample class names are rooms that had a meeting on 2026-10-10 (e.g. includes "T036 - Tra My NGUYEN"). Before the fix this returned few/none.

- [ ] **Step 3: Commit (suggested message for the user)**

```
fix(history): filter classes by meeting-activity date, not row updated_at
```

---

## Task 2: #1 — Teachers filter by activity date (`teachers.js`)

**Files:**
- Modify: `src/db/queries/teachers.js` (inside `searchTeachers`)

- [ ] **Step 1: Replace the `created_at` date filter**

Find:
```js
  if (from) {
    conditions.push(`t.created_at >= $${paramIndex++}::date`);
    params.push(from);
  }
  if (to) {
    conditions.push(`t.created_at < ($${paramIndex++}::date + interval '1 day')`);
    params.push(to);
  }
```
Replace with:
```js
  if (from || to) {
    const rangeConds = [];
    if (from) { rangeConds.push(`m.started_at >= $${paramIndex++}::date`); params.push(from); }
    if (to)   { rangeConds.push(`m.started_at < ($${paramIndex++}::date + 1)`); params.push(to); }
    conditions.push(`EXISTS (SELECT 1 FROM class_teachers ct JOIN meetings m ON m.class_id = ct.class_id WHERE ct.teacher_id = t.teacher_id AND ${rangeConds.join(" AND ")})`);
  }
```

- [ ] **Step 2: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const t=require("./src/db/queries/teachers");t.searchTeachers({from:"2026-10-10",to:"2026-10-10",page:1,limit:50}).then(r=>{console.log("total:",r.pagination.total);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: `total` > 0 (teachers who had a class meeting on 2026-10-10).

- [ ] **Step 3: Commit (suggested)**

```
fix(history): filter teachers by meeting-activity date, not teacher created_at
```

---

## Task 3: #1 — Students filter by activity date (`students.js`)

**Files:**
- Modify: `src/db/queries/students.js` (inside `searchStudents`)

- [ ] **Step 1: Replace the `created_at` date filter**

Find:
```js
  if (from) {
    conditions.push(`s.created_at >= $${paramIndex++}::date`);
    params.push(from);
  }
  if (to) {
    conditions.push(`s.created_at < ($${paramIndex++}::date + interval '1 day')`);
    params.push(to);
  }
```
Replace with:
```js
  if (from || to) {
    const rangeConds = [];
    if (from) { rangeConds.push(`m.started_at >= $${paramIndex++}::date`); params.push(from); }
    if (to)   { rangeConds.push(`m.started_at < ($${paramIndex++}::date + 1)`); params.push(to); }
    conditions.push(`EXISTS (SELECT 1 FROM class_students cs JOIN meetings m ON m.class_id = cs.class_id WHERE cs.user_id = s.user_id AND ${rangeConds.join(" AND ")})`);
  }
```

- [ ] **Step 2: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const s=require("./src/db/queries/students");s.searchStudents({from:"2026-10-10",to:"2026-10-10",page:1,limit:50}).then(r=>{console.log("total:",r.pagination.total);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: `total` > 0 (students in a class that met on 2026-10-10).

- [ ] **Step 3: Commit (suggested)**

```
fix(history): filter students by meeting-activity date, not student created_at
```

---

## Task 4: #2 — Batch meeting-context lookup (`liveRooms.js`)

**Files:**
- Modify: `src/db/queries/liveRooms.js` (add `findMeetingContextsBatch`, export it)

- [ ] **Step 1: Add the batch helper**

Immediately after the existing `findMeetingContext` function, add:
```js
async function findMeetingContextsBatch(meetingIds) {
  const map = new Map();
  const ids = [...new Set((meetingIds || []).filter(Boolean))];
  if (ids.length === 0) return map;

  const mRes = await db.query(
    `SELECT meeting_id, class_id, teacher_id FROM meetings
     WHERE meeting_id = ANY($1) AND class_id IS NOT NULL`,
    [ids]
  );
  for (const row of mRes.rows) {
    map.set(row.meeting_id, { classId: row.class_id, teacherId: row.teacher_id });
  }

  const missing = ids.filter(id => !map.has(id));
  if (missing.length > 0) {
    const eRes = await db.query(
      `SELECT DISTINCT ON (meeting_id) meeting_id, class_id, teacher_id FROM events
       WHERE meeting_id = ANY($1) AND class_id IS NOT NULL
       ORDER BY meeting_id, created_at DESC`,
      [missing]
    );
    for (const row of eRes.rows) {
      if (!map.has(row.meeting_id)) map.set(row.meeting_id, { classId: row.class_id, teacherId: row.teacher_id });
    }
  }
  return map;
}
```

- [ ] **Step 2: Export it**

In the `module.exports = { … }` block of `liveRooms.js`, add `findMeetingContextsBatch` alongside `findMeetingContext`:
```js
module.exports = {
  // …existing exports…
  findMeetingContext,
  findMeetingContextsBatch
};
```
(Keep the other existing exports; only add the new name.)

- [ ] **Step 3: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const lr=require("./src/db/queries/liveRooms");const api=require("./src/services/bbbApi");api.getRecordings().then(async r=>{const ids=r.recordings.filter(x=>x.recordId&&!x.metadataClassId&&x.meetingId).map(x=>x.meetingId);const m=await lr.findMeetingContextsBatch(ids);console.log("asked:",ids.length,"resolved:",m.size);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: `resolved` ≈ 489 (matching the per-row loop from investigation), in one quick run with 2 queries.

- [ ] **Step 4: Commit (suggested)**

```
perf(sync): add batch meeting-context lookup to replace per-recording N+1
```

---

## Task 5: #2 — Use batch + throttle recording sync (`bbbApi.js`)

**Files:**
- Modify: `src/services/bbbApi.js` (module constant + `syncDashboardState` recordings block)

- [ ] **Step 1: Add throttle constant + state near the top**

After the `require(...)` lines at the top of `bbbApi.js`, add:
```js
const RECORDING_SYNC_INTERVAL_MS = 5 * 60 * 1000; // throttle recording sync off the /api/stats path
let lastRecordingSyncAt = 0;
```

- [ ] **Step 2: Replace the recordings block in `syncDashboardState`**

Find:
```js
    // Sync recordings (best-effort — a recordings failure must not break hook/live sync)
    try {
      const recordingResult = await getRecordings();
      const recordings = [];
      for (const rec of recordingResult.recordings) {
        if (!rec.recordId) continue;

        let classId = rec.metadataClassId;
        if (!classId && rec.meetingId) {
          const ctx = await liveRoomsDb.findMeetingContext(rec.meetingId);
          classId = ctx.classId;
        }

        // Only keep recordings we can attribute to a known class
        if (!classId) continue;
        recordings.push({ ...rec, classId });
      }
      await recordingsDb.syncRecordings(recordings);
    } catch (recordingError) {
      console.error("Recording sync failed:", recordingError.message);
    }
```
Replace with:
```js
    // Sync recordings (best-effort; throttled so it doesn't run on every /api/stats and
    // exhaust the pool). A recordings failure must not break hook/live sync.
    if (Date.now() - lastRecordingSyncAt > RECORDING_SYNC_INTERVAL_MS) {
      try {
        const recordingResult = await getRecordings();
        const needCtx = recordingResult.recordings
          .filter(rec => rec.recordId && !rec.metadataClassId && rec.meetingId)
          .map(rec => rec.meetingId);
        const ctxMap = await liveRoomsDb.findMeetingContextsBatch(needCtx);

        const recordings = [];
        for (const rec of recordingResult.recordings) {
          if (!rec.recordId) continue;
          const ctx = rec.meetingId ? ctxMap.get(rec.meetingId) : null;
          const classId = rec.metadataClassId || (ctx ? ctx.classId : null);
          if (!classId) continue; // keep only attributable recordings (unchanged behavior)
          recordings.push({ ...rec, classId });
        }
        await recordingsDb.syncRecordings(recordings);
        lastRecordingSyncAt = Date.now();
      } catch (recordingError) {
        console.error("Recording sync failed:", recordingError.message);
      }
    }
```

- [ ] **Step 3: Verify (after deploy)**

Hit stats several times, then check logs and row count:
```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null http://localhost:3000/api/stats; done
docker logs --since 10m bbb-admin-nihaoma 2>&1 | grep -c "Recording sync failed"
docker exec -w /app bbb-admin-nihaoma node -e 'const db=require("./src/db");db.query("SELECT count(*) c FROM recordings").then(r=>{console.log("recordings:",r.rows[0].c);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: grep count `0` (no new timeout failures), `recordings` ≈ 489.

- [ ] **Step 4: Commit (suggested)**

```
perf(sync): throttle recording sync (5m) and use batch context lookup

Stops the per-/api/stats 499x findMeetingContext storm that exhausted the
pg pool (connectionTimeoutMillis 2s) and caused "Recording sync failed:
timeout exceeded when trying to connect".
```

---

## Task 6: #3a — Shared primary-teacher helper (`helpers.js`)

**Files:**
- Modify: `src/utils/helpers.js` (add `pickPrimaryTeacher`, export it)

- [ ] **Step 1: Add the helper**

Add this function to `src/utils/helpers.js`:
```js
// Primary teacher of a class: the linked teacher whose name appears in the room/class
// name (rooms are named like "T036 - Tra My NGUYEN"), else the earliest-linked one.
// `teachers` items carry { teacherId, teacherName, linkedAt }.
function pickPrimaryTeacher(className, teachers) {
  if (!Array.isArray(teachers) || teachers.length === 0) return null;
  const haystack = String(className || "").toLowerCase();
  const byName = teachers.find(t => {
    const name = String(t.teacherName || t.teacherId || "").trim().toLowerCase();
    return name && haystack.includes(name);
  });
  if (byName) return byName;
  return [...teachers].sort((a, b) => {
    const la = a.linkedAt ? new Date(a.linkedAt).getTime() : Infinity;
    const lb = b.linkedAt ? new Date(b.linkedAt).getTime() : Infinity;
    return la - lb;
  })[0];
}
```

- [ ] **Step 2: Export it**

Add `pickPrimaryTeacher` to the `module.exports` object in `helpers.js` (keep existing exports).

- [ ] **Step 3: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const{pickPrimaryTeacher}=require("./src/utils/helpers");console.log(pickPrimaryTeacher("T036 - Tra My NGUYEN (茶媚)",[{teacherId:"Jenna QI",linkedAt:"2026-07-07T09:36:33Z"},{teacherId:"Tra My",linkedAt:"2026-07-07T09:36:00Z"},{teacherId:"STL-Han",linkedAt:"2026-09-26T01:31:02Z"}]).teacherId);process.exit(0)'
```
Expected: prints `Tra My`.

- [ ] **Step 4: Commit (suggested)**

```
feat(teachers): add pickPrimaryTeacher helper (name-in-room, else earliest)
```

---

## Task 7: #3a — Primary teacher in class detail (`classes.js` `getClassDetails`)

**Files:**
- Modify: `src/db/queries/classes.js` (`require` helper; `getClassDetails` teachers query + return)

- [ ] **Step 1: Require the helper**

At the top of `classes.js`, below `const recordingsDb = require("./recordings");`, add:
```js
const { pickPrimaryTeacher } = require("../../utils/helpers");
```

- [ ] **Step 2: Include `linked_at` in the teachers query**

In `getClassDetails`, find:
```js
  const teachersResult = await db.query(
    `SELECT t.* FROM teachers t
     JOIN class_teachers ct ON ct.teacher_id = t.teacher_id
     WHERE ct.class_id = $1`,
    [classId]
  );
```
Replace with:
```js
  const teachersResult = await db.query(
    `SELECT t.*, ct.created_at AS linked_at FROM teachers t
     JOIN class_teachers ct ON ct.teacher_id = t.teacher_id
     WHERE ct.class_id = $1
     ORDER BY ct.created_at ASC`,
    [classId]
  );
```

- [ ] **Step 3: Compute primary before the return, expose it**

In `getClassDetails`, find the `return {` object and the `teachers:` line inside it:
```js
    teachers: teachersResult.rows.map(t => ({
      teacherId: t.teacher_id,
      teacherName: t.teacher_name || t.teacher_id
    })),
```
First, immediately BEFORE the `return {` statement, insert:
```js
  const teachers = teachersResult.rows.map(t => ({
    teacherId: t.teacher_id,
    teacherName: t.teacher_name || t.teacher_id,
    linkedAt: t.linked_at
  }));
  const primary = pickPrimaryTeacher(cls.class_name || cls.class_id, teachers);
  const primaryTeacherId = primary ? primary.teacherId : null;
  for (const t of teachers) t.isPrimary = t.teacherId === primaryTeacherId;
```
Then replace the `teachers: teachersResult.rows.map(...)` property with:
```js
    teachers,
    primaryTeacher: primary ? primary.teacherName : null,
    primaryTeacherId,
```

- [ ] **Step 4: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const c=require("./src/db/queries/classes");c.getClassDetails("kvmkkfk8sorfddu4puqfbbeozvn9i0zxsymhtssz").then(d=>{console.log("primary:",d.primaryTeacher,"teachers:",d.teachers.map(t=>t.teacherId+(t.isPrimary?"*":"")));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: `primary: Tra My` and the `Tra My` entry marked `*`.

- [ ] **Step 5: Commit (suggested)**

```
feat(classes): expose primaryTeacher in class detail
```

---

## Task 8: #3a — Primary teacher in class lists (`stats.js` + `classes.js`)

**Files:**
- Modify: `src/db/queries/stats.js` (`getTopClasses`: require helper, add `teachers_json`, map `primaryTeacher`)
- Modify: `src/db/queries/classes.js` (`searchClasses`: add `teachers_json`, map `primaryTeacher`)

- [ ] **Step 1: `stats.js` — require helper**

At the top of `stats.js`, add (below the existing `const db = require("../index");`):
```js
const { pickPrimaryTeacher } = require("../../utils/helpers");
```

- [ ] **Step 2: `stats.js` — add teachers_json to `getTopClasses` SELECT**

In `getTopClasses`, find the line:
```js
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at
     FROM classes c
```
Replace with:
```js
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at,
       (SELECT json_agg(json_build_object('teacherId', t.teacher_id, 'teacherName', t.teacher_name, 'linkedAt', ct.created_at) ORDER BY ct.created_at)
          FROM class_teachers ct JOIN teachers t ON t.teacher_id = ct.teacher_id WHERE ct.class_id = c.class_id) as teachers_json
     FROM classes c
```

- [ ] **Step 3: `stats.js` — map `primaryTeacher` in `getTopClasses`**

Find the returned object mapping and its `lastEndedAt: row.last_ended_at` line:
```js
    createdAt: row.created_at,
    lastEndedAt: row.last_ended_at
  }));
```
Replace with:
```js
    createdAt: row.created_at,
    lastEndedAt: row.last_ended_at,
    primaryTeacher: (() => { const p = pickPrimaryTeacher(row.class_name || row.class_id, row.teachers_json || []); return p ? p.teacherName : null; })()
  }));
```

- [ ] **Step 4: `classes.js` — add teachers_json to `searchClasses` SELECT**

In `searchClasses`, find:
```js
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at
     FROM classes c
     ${whereClause}
```
Replace with:
```js
       (SELECT MAX(m.ended_at) FROM meetings m WHERE m.class_id = c.class_id) as last_ended_at,
       (SELECT json_agg(json_build_object('teacherId', t.teacher_id, 'teacherName', t.teacher_name, 'linkedAt', ct.created_at) ORDER BY ct.created_at)
          FROM class_teachers ct JOIN teachers t ON t.teacher_id = ct.teacher_id WHERE ct.class_id = c.class_id) as teachers_json
     FROM classes c
     ${whereClause}
```

- [ ] **Step 5: `classes.js` — map `primaryTeacher` in `searchClasses`**

Find, inside `searchClasses`'s `data: result.rows.map(...)`:
```js
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEndedAt: row.last_ended_at
    })),
```
Replace with:
```js
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEndedAt: row.last_ended_at,
      primaryTeacher: (() => { const p = pickPrimaryTeacher(row.class_name || row.class_id, row.teachers_json || []); return p ? p.teacherName : null; })()
    })),
```
(`pickPrimaryTeacher` is already required at the top of `classes.js` from Task 7.)

- [ ] **Step 6: Verify**

Run:
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'const s=require("./src/db/queries/stats");s.getTopClasses(10).then(r=>{console.log(r.map(x=>x.className+" => "+x.primaryTeacher).slice(0,5));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
docker exec -w /app bbb-admin-nihaoma node -e 'const c=require("./src/db/queries/classes");c.searchClasses({search:"tra my",page:1,limit:5}).then(r=>{console.log(r.data.map(x=>x.className+" => "+x.primaryTeacher));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})'
```
Expected: each class prints its primary teacher name; the "tra my" search shows `T036 - Tra My NGUYEN (茶媚) => Tra My`.

- [ ] **Step 7: Commit (suggested)**

```
feat(classes): expose primaryTeacher in top-classes and class search lists
```

---

## Task 9: #3a — Frontend: primary teacher in detail + table (`index.html`)

**Files:**
- Modify: `public/index.html` (`renderClassDetail` teachers block; `renderClassesTable` Teachers column, both branches)

- [ ] **Step 1: Class detail — split primary vs other moderators**

In `renderClassDetail`, find the Teachers block:
```js
    <div class="nh-list-hdr">Teachers</div>
    ${(s.teachers||[]).map(t => { const tm=(s.meetings||[]).filter(m=>m.teacherId===t.teacherId).length; return `<div class="nh-list-item">
      <span class="nh-avatar" style="background:var(--amberSoft);color:var(--amber);">${initials(t.teacherName||t.teacherId)}</span>
      <div><div style="font-size:13px;font-weight:600;">${t.teacherName||t.teacherId||"-"}</div><div style="font-size:11px;color:var(--text3);">${tm} meeting${tm!==1?"s":""}</div></div>
    </div>`; }).join("") || `<div class="nh-list-item"><span class="nh-muted">No teachers</span></div>`}
```
Replace with:
```js
    <div class="nh-list-hdr">Primary teacher</div>
    ${(() => {
      const all = s.teachers || [];
      const primary = all.find(t => t.isPrimary) || (s.primaryTeacher ? { teacherName: s.primaryTeacher } : null);
      const others = all.filter(t => !t.isPrimary && (!primary || t.teacherId !== primary.teacherId));
      const row = t => { const tm=(s.meetings||[]).filter(m=>m.teacherId===t.teacherId).length; return `<div class="nh-list-item">
        <span class="nh-avatar" style="background:var(--amberSoft);color:var(--amber);">${initials(t.teacherName||t.teacherId)}</span>
        <div><div style="font-size:13px;font-weight:600;">${t.teacherName||t.teacherId||"-"}</div><div style="font-size:11px;color:var(--text3);">${tm} meeting${tm!==1?"s":""}</div></div>
      </div>`; };
      const primaryHtml = primary ? row(primary) : `<div class="nh-list-item"><span class="nh-muted">No teacher</span></div>`;
      const othersHtml = others.length ? `<div class="nh-list-hdr" style="margin-top:12px;">Other moderators</div>` + others.map(row).join("") : "";
      return primaryHtml + othersHtml;
    })()}
```

- [ ] **Step 2: Classes table — show primary teacher name (filtered branch)**

In `renderClassesTable`, in the `classFilterState.results` branch, find:
```js
      <td>${it.teacherCount||0}</td><td>${it.studentCount||0}</td><td>${it.joinEvents||0}</td><td>${it.leaveEvents||0}</td>
```
Replace with:
```js
      <td>${it.primaryTeacher || (it.teacherCount||0)}</td><td>${it.studentCount||0}</td><td>${it.joinEvents||0}</td><td>${it.leaveEvents||0}</td>
```

- [ ] **Step 3: Classes table — show primary teacher name (unfiltered branch)**

In `renderClassesTable`, in the `else` (topClasses) branch, find:
```js
      <td>${it.teachers||0}</td><td>${it.students||0}</td><td>${it.joinEvents||0}</td><td>${it.leaveEvents||0}</td>
```
Replace with:
```js
      <td>${it.primaryTeacher || (it.teachers||0)}</td><td>${it.students||0}</td><td>${it.joinEvents||0}</td><td>${it.leaveEvents||0}</td>
```

- [ ] **Step 4: Verify (after deploy, in browser)**

Load the dashboard → Classes tab. The "Teachers" column shows a teacher name (e.g. "Tra My") rather than a count for attributed classes. Open class **T036 - Tra My NGUYEN** → detail shows **Primary teacher: Tra My** with "Other moderators" (Jenna QI, STL-Han) below.

- [ ] **Step 5: Commit (suggested)**

```
feat(dashboard): show primary teacher in class detail and classes table
```

---

## Task 10: Final verification + deploy

- [ ] **Step 1: Syntax sanity on changed server modules**

Run (inside the container after files are deployed, or locally):
```bash
docker exec -w /app bbb-admin-nihaoma node -e 'require("./src/db/queries/classes");require("./src/db/queries/teachers");require("./src/db/queries/students");require("./src/db/queries/liveRooms");require("./src/db/queries/stats");require("./src/services/bbbApi");require("./src/utils/helpers");console.log("all modules load OK");process.exit(0)'
```
Expected: `all modules load OK` (catches require/syntax errors).

- [ ] **Step 2: Deploy**

Rebuild image + recreate container:
```bash
docker compose up -d --build
```
(The entrypoint re-runs migrate on start — a harmless no-op, no new migrations here.)

- [ ] **Step 3: Smoke test**

- `/api/stats` loads; dashboard renders.
- History/Classes filter to 2026-10-10 → classes that met that day appear.
- Classes table shows primary teacher names; T036 detail shows Primary teacher = Tra My + Other moderators.
- `docker logs --since 10m bbb-admin-nihaoma 2>&1 | grep -c "Recording sync failed"` → `0` after a few `/api/stats` hits.

---

## Notes

- All changes are read-side; no migration. The existing `#4` display fix (history detail `[0]` fallback) is already in `public/index.html` and independent of this batch.
- Deferred to a separate spec: `#3b` per-session meetings (re-key `meetings` on internal meeting id).
