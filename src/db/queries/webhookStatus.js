const db = require("../index");

async function getWebhookStatus() {
  const result = await db.query(`SELECT * FROM webhook_status WHERE id = 1`);
  if (result.rows.length === 0) {
    return {
      configured: false,
      callbackUrl: null,
      bbbApiBaseUrl: null,
      registeredHookId: null,
      getRaw: false,
      eventIds: null,
      matchingHookIds: [],
      lastWebhookReceivedAt: null,
      lastWebhookContentType: null,
      lastWebhookPreview: null,
      lastHookSyncAt: null,
      lastRegistrationAttemptAt: null,
      lastRegistrationResult: null,
      lastError: null
    };
  }

  const row = result.rows[0];
  return {
    configured: row.configured,
    callbackUrl: row.callback_url,
    bbbApiBaseUrl: row.bbb_api_base_url,
    registeredHookId: row.registered_hook_id,
    getRaw: row.get_raw,
    eventIds: row.event_ids,
    matchingHookIds: row.matching_hook_ids || [],
    lastWebhookReceivedAt: row.last_webhook_received_at,
    lastWebhookContentType: row.last_webhook_content_type,
    lastWebhookPreview: row.last_webhook_preview,
    lastHookSyncAt: row.last_hook_sync_at,
    lastRegistrationAttemptAt: row.last_registration_attempt_at,
    lastRegistrationResult: row.last_registration_result,
    lastError: row.last_error
  };
}

async function updateWebhookStatus(updates) {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  const fieldMap = {
    configured: "configured",
    callbackUrl: "callback_url",
    bbbApiBaseUrl: "bbb_api_base_url",
    registeredHookId: "registered_hook_id",
    getRaw: "get_raw",
    eventIds: "event_ids",
    matchingHookIds: "matching_hook_ids",
    lastWebhookReceivedAt: "last_webhook_received_at",
    lastWebhookContentType: "last_webhook_content_type",
    lastWebhookPreview: "last_webhook_preview",
    lastHookSyncAt: "last_hook_sync_at",
    lastRegistrationAttemptAt: "last_registration_attempt_at",
    lastRegistrationResult: "last_registration_result",
    lastError: "last_error"
  };

  for (const [key, dbField] of Object.entries(fieldMap)) {
    if (key in updates) {
      let value = updates[key];
      if (key === "lastRegistrationResult" && typeof value === "object") {
        value = JSON.stringify(value);
      }
      fields.push(`${dbField} = $${paramIndex++}`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  fields.push("updated_at = NOW()");
  values.push(1);

  await db.query(
    `UPDATE webhook_status SET ${fields.join(", ")} WHERE id = $${paramIndex}`,
    values
  );
}

async function recordWebhookReceived(contentType, preview) {
  await db.query(
    `UPDATE webhook_status SET
       last_webhook_received_at = NOW(),
       last_webhook_content_type = $1,
       last_webhook_preview = $2,
       updated_at = NOW()
     WHERE id = 1`,
    [contentType, preview?.slice(0, 4000)]
  );
}

async function recordRegistrationAttempt(result) {
  await db.query(
    `UPDATE webhook_status SET
       last_registration_attempt_at = NOW(),
       last_registration_result = $1,
       last_error = $2,
       updated_at = NOW()
     WHERE id = 1`,
    [JSON.stringify(result), result.status === "failed" ? result.message : null]
  );
}

module.exports = {
  getWebhookStatus,
  updateWebhookStatus,
  recordWebhookReceived,
  recordRegistrationAttempt
};
