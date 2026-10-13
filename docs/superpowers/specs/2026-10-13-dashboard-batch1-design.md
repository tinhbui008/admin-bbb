# Dashboard Batch 1 — Date-filter, Recording-sync, Primary-teacher

**Date:** 2026-10-13
**Status:** Approved design, ready for implementation plan
**Scope:** Three independent, low-risk fixes bundled into one spec. A deeper
remodel (per-session meetings, issue "#3b") is explicitly deferred to its own
spec.

## Background

The BBB admin dashboard (Node `http` server + Postgres + single-file
`public/index.html`) exposes a History/filter view and per-class/teacher/student
detail panels. Investigation of "missing records" surfaced three separate issues
in the existing data model, where for Greenlight rooms `classId == meetingId ==`
the persistent room external id, and `teacher_id` is just the moderator's
display name (`src/utils/normalizer.js:264`). This batch fixes the two
contained bugs plus a display-only teacher improvement.

Confirmed data facts (prod, via the app's own pool):
- `/api/stats` carries only a recent subset (~27 classes / 50 teachers).
- `getRecordings()` returns 499 recordings, all `published`, all lacking
  `meta_classid`; 489/499 resolve a class via `findMeetingContext` in ~1.5s for
  a single isolated run.
- The DB pool is `max: 20`, `connectionTimeoutMillis: 2000`.
- Recording sync logs repeated `Recording sync failed: timeout exceeded when
  trying to connect` — pool exhaustion under concurrent `/api/stats` calls, each
  running a 499× `findMeetingContext` loop.

## Out of scope (deferred to a separate spec)

- **#3b per-session meetings.** `meetings` is keyed by the room external id, so
  every session of a room collapses into one row (`meetings: 1`). Fixing this
  requires re-keying `meetings` on the internal meeting id and touches ingestion,
  talk/webcam tracking, recordings attribution, live rooms, and all aggregation.
  Too risky to bundle here.
- No schema migrations in this batch.

---

## Feature #1 — Date filter by "had a meeting in range"

**Problem.** History filters for Classes/Teachers/Students filter by the
entity row's `updated_at`/`created_at`, not by whether the entity had a *session*
in the date range. A class that met on 2026-10-10 but also later has
`updated_at` after the range and drops out → user perceives the day as empty.
(`meetings`/`events` searches already filter correctly by their own timestamps.)

**Change.** Replace the entity-date conditions with an `EXISTS` over
`events.created_at` within `[from, to]`.

> **Correction (found during implementation):** `meetings.started_at` cannot be
> used as the activity signal — `upsertMeeting`/`incrementMeetingCreated` set it
> only on first creation and never update it (rooms are persistent, one row per
> room), so it reflects when a class was *first created*, not recent activity.
> Filtering by it returned empty for recent ranges (e.g. 2026-10-12→13). The
> reliable per-activity signal is `events.created_at` (+ `events.class_id`), used
> below. This is a symptom of the deferred #3b (meetings collapse per room).

- `src/db/queries/classes.js` `searchClasses`: remove the `c.updated_at >= $::date`
  / `c.updated_at < ($::date + interval '1 day')` conditions; add
  `EXISTS (SELECT 1 FROM events e WHERE e.class_id = c.class_id AND e.created_at >= $from::date AND e.created_at < $to::date + 1)`.
  Keep the existing lifetime "activity filter" (`SUM(join_events) > 0`).
- `src/db/queries/teachers.js` `searchTeachers`: replace `t.created_at` conditions
  with `EXISTS (SELECT 1 FROM class_teachers ct JOIN events e ON e.class_id = ct.class_id WHERE ct.teacher_id = t.teacher_id AND e.created_at >= $from::date AND e.created_at < $to::date + 1)`.
- `src/db/queries/students.js` `searchStudents`: replace `s.created_at` conditions
  with `EXISTS (SELECT 1 FROM class_students cs JOIN events e ON e.class_id = cs.class_id WHERE cs.user_id = s.user_id AND e.created_at >= $from::date AND e.created_at < $to::date + 1)`.

`from` and `to` may each be supplied independently; apply whichever is present
(only lower bound if `to` absent, only upper bound if `from` absent), matching
the current independent handling.

**Timezone.** Keep UTC `::date` boundaries, consistent with the already-correct
`meetings` search. Classes run midday VN, which falls inside the UTC day
(verified: UTC-day count == VN-day count == 14 for 2026-10-10). No timezone
conversion is added (YAGNI); noted as a known minor edge for sessions near the
UTC midnight boundary.

**Acceptance.** Filtering Classes/Teachers/Students to a single past day on which
sessions occurred returns the entities that had a meeting that day, regardless of
when their row was last updated/created.

---

## Feature #2 — Recording sync: remove N+1, throttle off the request path

**Problem.** `syncDashboardState` (`src/services/bbbApi.js`) runs on every
`/api/stats`. Its recordings block calls `findMeetingContext` once per recording
(499× → ~1000 sequential queries) because no recording has `meta_classid`. Under
concurrent requests the 20-connection pool is exhausted and recording sync aborts
with a 2s connect timeout, so recordings rarely refresh.

**Change A — batch the context resolution.** In the recordings block, collect the
external `meetingId`s of recordings that lack a `metadataClassId`, then resolve
all of them with two set-based queries instead of a per-row loop:
- `SELECT meeting_id, class_id FROM meetings WHERE meeting_id = ANY($1) AND class_id IS NOT NULL`
- fallback for still-unresolved ids:
  `SELECT DISTINCT ON (meeting_id) meeting_id, class_id FROM events WHERE meeting_id = ANY($1) AND class_id IS NOT NULL ORDER BY meeting_id, created_at DESC`

Build a `Map<meetingId, classId>` and attribute from it. Recordings still dropped
only when no classId can be resolved (unchanged behavior, ~10/499). Add a helper
in `src/db/queries/liveRooms.js` (or `meetings.js`) e.g.
`findMeetingContextsBatch(meetingIds)` returning the map; keep the existing
single `findMeetingContext` for other callers.

**Change B — throttle.** Add a module-level `lastRecordingSyncAt = 0` in
`bbbApi.js`. Run the recordings block only when
`Date.now() - lastRecordingSyncAt > RECORDING_SYNC_INTERVAL_MS` (default **5
minutes**, a module constant); update the timestamp after a successful run.
Hook-match and live-room sync continue to run on every call (cheap). The
recordings block remains wrapped in its own try/catch so a failure never breaks
hook/live sync.

**Acceptance.** Under repeated/concurrent `/api/stats`, no
`Recording sync failed: timeout` entries; recordings refresh at most every 5
minutes; attribution count unchanged (~489/499).

---

## Feature #3a — Primary teacher (display/derivation only)

**Problem.** `teacher_id` is the moderator display name, so a room accumulates
every moderator who ever joined (e.g. class `kvmkkfk…` has `Tra My`, `Jenna QI`,
`STL-Han`). The UI lists them all with no notion of the nominal teacher, and a
shared moderator bridges unrelated classes.

**Change.** Derive (not store) a single **primary teacher** per class:
1. Primary = the class's teacher whose `teacher_name` (or `teacher_id`) is a
   **case-insensitive substring of `class_name`** (room names follow
   `"T036 - Tra My NGUYEN (茶媚)"`, so the nominal teacher's name appears).
2. Fallback when no name matches: the teacher with the smallest
   `class_teachers.created_at` (earliest recorded moderator).

Implement once as a shared pure helper (e.g. `pickPrimaryTeacher(className,
teachers)` where `teachers` carry `teacherId`/`teacherName`/`createdAt`) and use
it in both `src/services/statsBuilder.js` (`classDetails`) and
`src/db/queries/classes.js` `getClassDetails`. Expose on each class object a
`primaryTeacher` field and keep the full `teachers` list; mark the others as
secondary (e.g. `secondaryTeachers` or a boolean flag).

**Display (`public/index.html`).**
- Class detail: show **"Primary teacher: &lt;name&gt;"** prominently; render the
  remaining moderators under an **"Other moderators"** subheading.
- Classes table: the "Teachers" column shows the **primary teacher name** (fall
  back to the count when a class has no resolvable teacher).

**No schema change, no ingestion change** — derivation happens at read time.

**Acceptance.** Class `kvmkkfk…` ("T036 - Tra My NGUYEN") shows primary teacher
`Tra My`, with `Jenna QI`/`STL-Han` listed as other moderators.

---

## Affected files (no migrations)

`src/db/queries/classes.js`, `src/db/queries/teachers.js`,
`src/db/queries/students.js`, `src/db/queries/liveRooms.js` (or `meetings.js`,
batch helper), `src/services/statsBuilder.js`, `src/services/bbbApi.js`,
`public/index.html`.

## Risks / notes

- No automated tests exist; verification is manual (query the app pool; load the
  dashboard after deploy). Each feature has a concrete acceptance check above.
- `#3a` substring matching can mis-pick if a moderator's name is itself a
  substring of the room name while the nominal teacher's is not; the room-name
  convention makes this unlikely, and the fallback is deterministic.
- `#1` student filter keys on "belongs to a class that met in range" rather than
  actual attendance (`meeting_participants`), chosen for simplicity/consistency.
- Deploy is a static `public/index.html` + server change → image rebuild +
  container recreate; the no-op migrate on restart is harmless.
