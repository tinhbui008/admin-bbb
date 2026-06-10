const fs = require("fs");
const path = require("path");
const db = require("./index");

const STORE_FILE = path.join(__dirname, "..", "..", "data", "store.json");

async function migrateFromJson() {
  console.log("Starting migration from store.json to PostgreSQL...");

  if (!fs.existsSync(STORE_FILE)) {
    console.log("No store.json found. Nothing to migrate.");
    process.exit(0);
  }

  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  console.log("Loaded store.json");

  const health = await db.healthCheck();
  if (!health.ok) {
    console.error("Database connection failed:", health.error);
    process.exit(1);
  }
  console.log("Database connected");

  await db.transaction(async (client) => {
    if (store.totals) {
      const statMappings = {
        events: "events",
        meetingsCreated: "meetings_created",
        meetingsEnded: "meetings_ended",
        participantsJoined: "participants_joined",
        participantsLeft: "participants_left",
        checksumVerified: "checksum_verified",
        checksumRejected: "checksum_rejected"
      };

      for (const [jsonKey, dbKey] of Object.entries(statMappings)) {
        const value = store.totals[jsonKey] || 0;
        await client.query(
          `INSERT INTO stats (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [dbKey, value]
        );
      }
      console.log("Migrated stats totals");
    }

    const classes = Object.values(store.classes || {});
    for (const cls of classes) {
      if (cls.classId && cls.classId !== "unmapped") {
        await client.query(
          `INSERT INTO classes (class_id, class_name)
           VALUES ($1, $2)
           ON CONFLICT (class_id) DO NOTHING`,
          [cls.classId, cls.classId]
        );
      }
    }
    console.log(`Migrated ${classes.length} classes`);

    const meetings = Object.values(store.meetings || {});
    const teacherIds = new Set();
    const userIds = new Set();

    for (const meeting of meetings) {
      if (meeting.teacherId && meeting.teacherId !== "unassigned") {
        teacherIds.add(meeting.teacherId);
      }
      for (const userId of Object.keys(meeting.users || {})) {
        userIds.add(userId);
      }
    }

    for (const teacherId of teacherIds) {
      await client.query(
        `INSERT INTO teachers (teacher_id, teacher_name)
         VALUES ($1, $1)
         ON CONFLICT (teacher_id) DO NOTHING`,
        [teacherId]
      );
    }
    console.log(`Migrated ${teacherIds.size} teachers`);

    const users = Object.values(store.users || {});
    for (const user of users) {
      if (user.userId) {
        const isModerator = /moderator/i.test(user.role || "");
        if (!isModerator) {
          await client.query(
            `INSERT INTO students (user_id, user_name, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO NOTHING`,
            [user.userId, user.userName, user.role]
          );
        }
      }
    }
    console.log(`Migrated ${users.length} users`);

    for (const meeting of meetings) {
      if (meeting.meetingId && meeting.meetingId !== "unknown-meeting") {
        await client.query(
          `INSERT INTO meetings (meeting_id, meeting_name, class_id, teacher_id, created_events, ended_events, join_events, leave_events)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (meeting_id) DO NOTHING`,
          [
            meeting.meetingId,
            meeting.meetingName,
            meeting.classId !== "unmapped" ? meeting.classId : null,
            meeting.teacherId !== "unassigned" ? meeting.teacherId : null,
            meeting.createdEvents || 0,
            meeting.endedEvents || 0,
            meeting.joinEvents || 0,
            meeting.leaveEvents || 0
          ]
        );

        if (meeting.classId && meeting.classId !== "unmapped" && meeting.teacherId && meeting.teacherId !== "unassigned") {
          await client.query(
            `INSERT INTO class_teachers (class_id, teacher_id)
             VALUES ($1, $2)
             ON CONFLICT (class_id, teacher_id) DO NOTHING`,
            [meeting.classId, meeting.teacherId]
          );
        }

        for (const [userId, userName] of Object.entries(meeting.users || {})) {
          const user = store.users[userId];
          const isModerator = /moderator/i.test(user?.role || "");

          await client.query(
            `INSERT INTO meeting_participants (meeting_id, user_id, user_name, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (meeting_id, user_id) DO NOTHING`,
            [meeting.meetingId, userId, userName || user?.userName, user?.role]
          );

          if (!isModerator && meeting.classId && meeting.classId !== "unmapped") {
            await client.query(
              `INSERT INTO class_students (class_id, user_id, join_count, leave_count, last_meeting_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (class_id, user_id) DO UPDATE SET
                 join_count = class_students.join_count + EXCLUDED.join_count,
                 last_meeting_id = EXCLUDED.last_meeting_id,
                 updated_at = NOW()`,
              [meeting.classId, userId, user?.joinCount || 1, user?.leaveCount || 0, meeting.meetingId]
            );
          }
        }
      }
    }
    console.log(`Migrated ${meetings.length} meetings`);

    const recentEvents = store.recentEvents || [];
    for (const event of recentEvents) {
      await client.query(
        `INSERT INTO events (event_name, meeting_id, user_id, user_name, class_id, teacher_id, meeting_name, role, timestamp, checksum_valid, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          event.eventName,
          event.meetingId,
          event.userId,
          event.userName,
          event.classId,
          event.teacherId,
          event.meetingName,
          event.role,
          event.timestamp || new Date().toISOString(),
          event.checksumValid !== false,
          JSON.stringify({})
        ]
      );
    }
    console.log(`Migrated ${recentEvents.length} recent events`);

    if (store.webhookStatus) {
      await client.query(
        `UPDATE webhook_status SET
           configured = $1,
           callback_url = $2,
           bbb_api_base_url = $3,
           registered_hook_id = $4,
           last_webhook_received_at = $5,
           last_error = $6,
           updated_at = NOW()
         WHERE id = 1`,
        [
          store.webhookStatus.configured || false,
          store.webhookStatus.callbackUrl,
          store.webhookStatus.bbbApiBaseUrl,
          store.webhookStatus.registeredHookId,
          store.webhookStatus.lastWebhookReceivedAt,
          store.webhookStatus.lastError
        ]
      );
      console.log("Migrated webhook status");
    }
  });

  console.log("Migration completed successfully!");
  await db.close();
  process.exit(0);
}

migrateFromJson().catch(error => {
  console.error("Migration failed:", error);
  process.exit(1);
});
