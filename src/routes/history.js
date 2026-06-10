const eventsDb = require("../db/queries/events");
const classesDb = require("../db/queries/classes");
const teachersDb = require("../db/queries/teachers");
const studentsDb = require("../db/queries/students");
const meetingsDb = require("../db/queries/meetings");

function parseQueryParams(url) {
  const params = {};
  const searchParams = url.searchParams;

  params.search = searchParams.get("search") || undefined;
  params.classId = searchParams.get("class_id") || undefined;
  params.teacherId = searchParams.get("teacher_id") || undefined;
  params.userId = searchParams.get("user_id") || undefined;
  params.meetingId = searchParams.get("meeting_id") || undefined;
  params.eventName = searchParams.get("event_name") || undefined;
  params.from = searchParams.get("from") || undefined;
  params.to = searchParams.get("to") || undefined;
  params.page = parseInt(searchParams.get("page") || "1", 10);
  params.limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);

  return params;
}

function extractPathParam(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

async function handleHistoryRoutes(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;
  const params = parseQueryParams(parsedUrl);

  if (req.method === "GET" && pathname === "/api/history/classes") {
    try {
      const result = await classesDb.searchClasses({
        search: params.search,
        teacherId: params.teacherId,
        from: params.from,
        to: params.to,
        page: params.page,
        limit: params.limit
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  const classIdMatch = extractPathParam(pathname, /^\/api\/history\/classes\/(.+)$/);
  if (req.method === "GET" && classIdMatch) {
    try {
      const result = await classesDb.getClassDetails(classIdMatch);
      if (!result) {
        sendJson(res, 404, { ok: false, error: "Class not found" });
      } else {
        sendJson(res, 200, { ok: true, data: result });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history/teachers") {
    try {
      const result = await teachersDb.searchTeachers({
        search: params.search,
        classId: params.classId,
        from: params.from,
        to: params.to,
        page: params.page,
        limit: params.limit
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  const teacherIdMatch = extractPathParam(pathname, /^\/api\/history\/teachers\/(.+)$/);
  if (req.method === "GET" && teacherIdMatch) {
    try {
      const result = await teachersDb.getTeacherDetails(teacherIdMatch);
      if (!result) {
        sendJson(res, 404, { ok: false, error: "Teacher not found" });
      } else {
        sendJson(res, 200, { ok: true, data: result });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history/students") {
    try {
      const result = await studentsDb.searchStudents({
        search: params.search,
        classId: params.classId,
        teacherId: params.teacherId,
        from: params.from,
        to: params.to,
        page: params.page,
        limit: params.limit
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  const studentIdMatch = extractPathParam(pathname, /^\/api\/history\/students\/(.+)$/);
  if (req.method === "GET" && studentIdMatch) {
    try {
      const result = await studentsDb.getStudentDetails(studentIdMatch);
      if (!result) {
        sendJson(res, 404, { ok: false, error: "Student not found" });
      } else {
        sendJson(res, 200, { ok: true, data: result });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history/meetings") {
    try {
      const result = await meetingsDb.searchMeetings({
        classId: params.classId,
        teacherId: params.teacherId,
        from: params.from,
        to: params.to,
        page: params.page,
        limit: params.limit
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  const meetingIdMatch = extractPathParam(pathname, /^\/api\/history\/meetings\/(.+)$/);
  if (req.method === "GET" && meetingIdMatch) {
    try {
      const result = await meetingsDb.getMeetingDetails(meetingIdMatch);
      if (!result) {
        sendJson(res, 404, { ok: false, error: "Meeting not found" });
      } else {
        sendJson(res, 200, { ok: true, data: result });
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/history/events") {
    try {
      const result = await eventsDb.searchEvents({
        classId: params.classId,
        teacherId: params.teacherId,
        userId: params.userId,
        meetingId: params.meetingId,
        eventName: params.eventName,
        from: params.from,
        to: params.to,
        page: params.page,
        limit: Math.min(params.limit, 50)
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return true;
  }

  return false;
}

module.exports = {
  handleHistoryRoutes
};
