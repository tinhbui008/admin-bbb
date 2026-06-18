function tryParseJson(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function pickFirstValue(object, paths) {
  for (const pathKey of paths) {
    const value = pathKey.split(".").reduce((current, key) => {
      if (current && typeof current === "object") {
        return current[key];
      }
      return undefined;
    }, object);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "-";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function isJoinEvent(eventName) {
  return /user.*join|participant.*join|joined/i.test(eventName);
}

function isLeaveEvent(eventName) {
  return /user.*left|user.*leave|participant.*left|participant.*leave|left/i.test(eventName);
}

function isMeetingCreatedEvent(eventName) {
  return /meeting.*create|create.*meeting/i.test(eventName);
}

function isMeetingEndedEvent(eventName) {
  return /meeting.*end|destroy|ended/i.test(eventName);
}

function isMessageEvent(eventName) {
  return /chat.*message|message.*sent/i.test(String(eventName || ""));
}

function isReactionEvent(eventName) {
  // BBB sends "user-emoji-changed" for emoji reactions (not raise-hand, which has its own event)
  return /reaction|emoji.?changed/i.test(String(eventName || ""));
}

function isPollVoteEvent(eventName) {
  // BBB sends "poll-responded" when a user votes in a poll
  return /poll.*vote|vote.*poll|poll.?responded/i.test(String(eventName || ""));
}

function isRaiseHandEvent(eventName) {
  return /raise.*hand|hand.*raise/i.test(String(eventName || ""));
}

function isWebcamStartEvent(eventName) {
  // BBB sends "user-cam-broadcast-start" when webcam is turned on
  return /webcam.*start|start.*webcam|shared-webcam-started|camera.*start|cam.*broadcast.*start/i.test(String(eventName || ""));
}

function isWebcamStopEvent(eventName) {
  // BBB sends "user-cam-broadcast-end" when webcam is turned off
  return /webcam.*stop|stop.*webcam|shared-webcam-stopped|camera.*stop|cam.*broadcast.*end/i.test(String(eventName || ""));
}

function isTalkStartEvent(eventName) {
  // BBB sends "user-audio-voice-enabled" when voice activity is detected (user speaking)
  return /talk.*start|start.*talk|voice.*start|started-talking|audio.*voice.*enabled/i.test(String(eventName || ""));
}

function isTalkStopEvent(eventName) {
  // BBB sends "user-audio-voice-disabled" when user stops speaking
  return /talk.*stop|stop.*talk|voice.*stop|stopped-talking|audio.*voice.*disabled/i.test(String(eventName || ""));
}

function isModeratorRole(role) {
  return /moderator/i.test(String(role || ""));
}

function isTeacherIdentity(userLike, teacherId) {
  if (!userLike) {
    return false;
  }

  if (isModeratorRole(userLike.role)) {
    return true;
  }

  if (teacherId && userLike.userName && userLike.userName === teacherId) {
    return true;
  }

  return false;
}

function shouldCountAsStudent(userLike, teacherId) {
  if (!userLike?.userId) {
    return false;
  }

  return !isTeacherIdentity(userLike, teacherId);
}

module.exports = {
  tryParseJson,
  pickFirstValue,
  toTimestampMs,
  formatDurationMs,
  isJoinEvent,
  isLeaveEvent,
  isMeetingCreatedEvent,
  isMeetingEndedEvent,
  isMessageEvent,
  isReactionEvent,
  isPollVoteEvent,
  isRaiseHandEvent,
  isWebcamStartEvent,
  isWebcamStopEvent,
  isTalkStartEvent,
  isTalkStopEvent,
  isModeratorRole,
  isTeacherIdentity,
  shouldCountAsStudent
};
