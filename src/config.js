const path = require("path");
const fs = require("fs");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));

function normalizeApiBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "postgresql://bbb:bbb@localhost:5432/bbb_admin",
  dataDir: path.join(__dirname, "..", "data"),
  publicDir: path.join(__dirname, "..", "public"),
  bbbApiBaseUrl: normalizeApiBaseUrl(process.env.BBB_API_BASE_URL || ""),
  bbbSharedSecret: process.env.BBB_SHARED_SECRET || "",
  callbackUrl: process.env.BBB_CALLBACK_URL || "",
  autoRegisterHook: /^true$/i.test(process.env.BBB_AUTO_REGISTER_HOOK || ""),
  getRaw: /^true$/i.test(process.env.BBB_GET_RAW || ""),
  eventIds: process.env.BBB_EVENT_IDS || "",
  useBearerAuth: /^true$/i.test(process.env.BBB_USE_BEARER_AUTH || ""),
  greenlightDatabaseUrl: process.env.GREENLIGHT_DATABASE_URL || ""
};

module.exports = CONFIG;
