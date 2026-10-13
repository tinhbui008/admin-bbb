# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A BigBlueButton (BBB) admin stats dashboard for Nihaoma Mandarin classes. It receives BBB webhook events, aggregates them into a PostgreSQL database, and serves a single-page dashboard (`public/index.html`) plus a JSON/SSE API. The dashboard shows live rooms, per-class/teacher/student rollups, participant activity (talk time, webcam time, chat, reactions), recordings, and Greenlight room access-code history.

There is **no framework** — the server is built directly on Node's `http` module with hand-rolled routing in `server.js`. There is no build step, no bundler, and no test suite. Dependencies are just `pg`.

## Commands

```bash
npm start                # run server.js (serves dashboard + API on PORT, default 3000)
npm run migrate          # apply pending SQL migrations in src/db/migrations
npm run migrate:json     # one-time import from legacy data/store.json into Postgres

docker compose up -d --build   # production deploy; entrypoint runs migrate then start
```

There is no lint or test command. To exercise an endpoint locally, hit it directly (e.g. `curl http://localhost:3000/api/stats`). Requires a reachable Postgres (`DATABASE_URL`); the server still boots without one but DB-backed features fail.

## Configuration

Env is loaded by `src/config.js` from `.env` (a hand-rolled parser — no `dotenv`; existing `process.env` values win). See `.env.example` for the full list. Key vars:

- `DATABASE_URL` — dashboard Postgres (its own DB).
- `BBB_API_BASE_URL`, `BBB_SHARED_SECRET` — required to call the BBB API and verify webhook checksums.
- `BBB_CALLBACK_URL` — the public URL BBB posts events to; also the base string for checksum verification. If unset, it's derived per-request from `x-forwarded-*`/`host` headers.
- `BBB_USE_BEARER_AUTH` — when true, authenticate API calls and verify incoming webhooks via `Authorization: Bearer <shared secret>` instead of query checksum.
- `GREENLIGHT_DATABASE_URL` — **read-only** Greenlight Postgres for the access-code panel. Optional; blank disables the feature entirely (`src/db/greenlight.js` lazily creates its pool). Never point this at the dashboard's own DB.

## Architecture

### Request flow (`server.js`)
`http.createServer` dispatches by method + pathname in a top-to-bottom `if` chain. Order matters. Static files under `public/` are served by `tryServeStatic` (with a path-traversal guard). History/search endpoints (`/api/history/*`) are delegated to `handleHistoryRoutes` in `src/routes/history.js`. Responses use the `sendJson`/`sendText`/`sendFile` helpers.

### Webhook ingestion pipeline
This is the core of the system. BBB posts events to `POST /webhook/bbb`:

1. **`verifyBbbChecksum`** (`src/services/bbbApi.js`) — validates the request via Bearer token or by trying sha1/256/384/512 of `callbackUrl + rawBody + secret`. Invalid → 401, counter `checksum_rejected`.
2. **`processWebhookPayload`** (`src/services/eventProcessor.js`) → **`src/utils/normalizer.js`** — BBB webhook payloads come in many shapes (form-urlencoded with a JSON `event`/`events`/`data` field, raw JSON, single or batched, different BBB versions). `parseIncomingBody` + `extractEventCandidates` flatten them into candidate objects; `normalizeEvent` maps a large list of possible key paths (`pickFirstValue`) down to a flat `{ eventName, meetingId, userId, userName, classId, teacherId, meetingName, role, timestamp, raw }`. `dedupeNormalizedEvents` drops structurally identical candidates within one request.
3. **`processEvent`** — inserts into `events` and updates rollups. Insertion is idempotent: `insertEvent` hashes `raw_payload` (md5) into `raw_payload_hash` with a unique index and `ON CONFLICT DO NOTHING`. A null return means "duplicate, skip all counter increments." This is the primary defense against BBB re-delivering the same event.

### Event classification is regex-based (`src/utils/helpers.js`)
Event **types** are not matched by exact name — `isJoinEvent`, `isTalkStartEvent`, `isWebcamStopEvent`, etc. use regexes because event names vary across BBB versions and raw-vs-processed hooks. When adding support for a new event, extend the relevant matcher regex rather than hard-coding a name. Talk tracking specifically keys off `user-audio-unmuted`/`user-audio-muted` (explicit mic) with VAD `voice-enabled/disabled` as a fallback.

### Talk/webcam time tracking
`eventProcessor.js` holds in-memory `Map`s (`talkStartTimes`, `webcamStartTimes`) keyed by `${meetingId}:${userId}`. A start event records `Date.now()`; the matching stop event computes elapsed and calls `addParticipantTalkTime`/`addParticipantWebcamTime`. On `meeting-ended`, any still-open segments are flushed and the maps cleared for that meeting. **Because this state is in-memory, a server restart loses open segments.** For historical meetings that predate DB tracking (zero `talk_time_ms`/`webcam_time_ms`), `statsBuilder.buildParticipantActivity` falls back to recomputing durations from raw start/stop events — see the `_dbTalkTimeMs === 0` branches.

### Stats assembly (`src/services/statsBuilder.js`)
`buildStats()` fans out parallel DB reads, then builds `classDetails`/`teacherDetails`/`studentDetails` and `chartData`. `buildParticipantActivity` is the most intricate function: it merges authoritative per-participant rows from `meeting_participants` (marked `_hasDbData`) with event-derived activity, and does heavy **name resolution** — userIds/anonymous names like `gl-*` and `w_*` are replaced with real display names pulled from MODERATOR events and roster maps. `buildStats({ skipLiveSync: true })` avoids hitting the BBB API (used after reset/delete).

### BBB API sync (`syncDashboardState`)
Called on `GET /api/stats` and hook list/register. Pulls `getMeetings` → upserts `live_rooms`; matches registered hooks against the callback URL; and (best-effort) `getRecordings` → upserts `recordings`, attributing each to a class via metadata or `findMeetingContext`. Note `callBbbApi` uses `https.request` with `insecureHTTPParser: true` because BBB's `hooks/create` returns LF-only headers that native `fetch`/undici rejects.

### Real-time updates (SSE)
`GET /api/stream` is a Server-Sent Events endpoint. Clients are held in the `sseClients` set; after each webhook (and other mutations) `pushRealtimeUpdate("stats", ...)` broadcasts fresh stats. A 25s heartbeat keeps nginx from timing out the proxied connection.

### Database layer
`src/db/index.js` exports a `pg` pool with `query`/`transaction`/`healthCheck`. All SQL lives in `src/db/queries/*.js` (one module per domain: `events`, `classes`, `teachers`, `students`, `meetings`, `liveRooms`, `recordings`, `stats`, `webhookStatus`). Migrations are plain SQL files in `src/db/migrations/`, applied in filename order by `migrate.js`, tracked in a `migrations` table. **To change the schema, add a new numbered migration file** — never edit an applied one. Migrations should be idempotent (`IF NOT EXISTS`).

### Greenlight access-code panel (`src/db/greenlight.js`)
Read-only queries against a **separate** Greenlight Postgres to show room moderator/viewer access-code state and a change log (populated by an `access_code_audit` trigger on the Greenlight side, not created by this repo). Entirely best-effort: `handleClassDetail` wraps it in try/catch so an unreachable/unconfigured Greenlight DB never breaks class detail.

## Conventions

- CommonJS (`require`/`module.exports`), 2-space indent, double-quoted strings, semicolons. Async/await throughout; route handlers wrap bodies in try/catch and return `{ ok: false, error }` with an appropriate status.
- New API routes: add a method+pathname branch in `server.js` (or in `handleHistoryRoutes` for search/history), keep DB access in a `src/db/queries` module.
- `POST /api/reset` TRUNCATEs all data tables and zeroes stats — destructive; keep its table list in sync when adding tables.
