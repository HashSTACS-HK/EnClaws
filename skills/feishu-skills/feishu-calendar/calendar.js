"use strict";
/**
 * feishu-calendar: Feishu calendar and event management via user OAuth.
 *
 * Usage:
 *   node calendar.js --action <action> --open-id <open_id> [options]
 *
 * Actions:
 *   list_calendars       - List user's calendars
 *   get_primary          - Get primary calendar
 *   create_event         - Create calendar event
 *   list_events          - List events in a calendar
 *   get_event            - Get event details
 *   update_event         - Update event
 *   delete_event         - Delete event
 *   search_events        - Search events
 *   add_attendees        - Add attendees to event
 *   list_attendees       - List event attendees
 *   remove_attendees     - Remove attendees from event
 *   check_freebusy       - Check free/busy status
 */

const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));
const { sendCard } = require(path.join(__dirname, "../feishu-auth/send-card.js"));

function parseArgs() {
  const argv = process.argv.slice(2);
  const r = {
    action: null,
    openId: null,
    calendarId: null,
    eventId: null,
    summary: null,
    description: null,
    startTime: null,
    endTime: null,
    timeZone: "Asia/Shanghai",
    location: null,
    attendees: null,
    query: null,
    pageSize: 50,
    pageToken: null,
    userIds: null,
    names: null,
    chatId: null,
    startMin: null,
    startMax: null,
    isAllDay: false,
    recurrence: null,
    repeat: null,
    reminder: null,
    needAttendee: false,
    showCancelled: false,
    autoRecord: false,
    noMeetingChat: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--action":
        r.action = argv[++i];
        break;
      case "--open-id":
        r.openId = argv[++i];
        break;
      case "--calendar-id":
        r.calendarId = argv[++i];
        break;
      case "--event-id":
        r.eventId = argv[++i];
        break;
      case "--summary":
        r.summary = argv[++i];
        break;
      case "--description":
        r.description = argv[++i];
        break;
      case "--start-time":
        r.startTime = argv[++i];
        break;
      case "--end-time":
        r.endTime = argv[++i];
        break;
      case "--time-zone":
        r.timeZone = argv[++i];
        break;
      case "--location":
        r.location = argv[++i];
        break;
      case "--attendees":
        r.attendees = argv[++i];
        break;
      case "--query":
        r.query = argv[++i];
        break;
      case "--page-size":
        r.pageSize = parseInt(argv[++i], 10);
        break;
      case "--page-token":
        r.pageToken = argv[++i];
        break;
      case "--user-ids":
        r.userIds = argv[++i];
        break;
      case "--start-min":
        r.startMin = argv[++i];
        break;
      case "--start-max":
        r.startMax = argv[++i];
        break;
      case "--all-day":
        r.isAllDay = true;
        break;
      case "--need-attendee":
        r.needAttendee = true;
        break;
      case "--repeat":
        r.repeat = argv[++i];
        break;
      case "--recurrence":
        r.recurrence = argv[++i];
        break;
      case "--names":
        r.names = argv[++i];
        break;
      case "--chat-id":
        r.chatId = argv[++i];
        break;
      case "--show-cancelled":
        r.showCancelled = true;
        break;
      case "--auto-record":
        r.autoRecord = true;
        break;
      case "--no-meeting-chat":
        r.noMeetingChat = true;
        break;
    }
  }
  return r;
}

const REPEAT_RRULE = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  workdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
};

function resolveRecurrence(args) {
  if (args.recurrence) return args.recurrence;
  if (args.repeat) return REPEAT_RRULE[args.repeat] ?? null;
  return null;
}

async function getTenantToken(cfg) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`获取 tenant_access_token 失败: ${json.msg}`);
  return json.tenant_access_token;
}

/**
 * Search chat members by name (substring, case-insensitive).
 * Returns array of { open_id, name }.
 */
async function searchChatMembersByName(chatId, names, appToken) {
  // Fetch all members (paginate)
  const allMembers = [];
  let pageToken = null;
  do {
    const params = { member_id_type: "open_id" };
    if (pageToken) params.page_token = pageToken;
    let url = `https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members`;
    const qs = new URLSearchParams(params).toString();
    if (qs) url += "?" + qs;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${appToken}` } });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`获取群成员失败: code=${json.code} msg=${json.msg}`);
    for (const m of json.data?.items ?? []) allMembers.push(m);
    pageToken = json.data?.has_more ? json.data.page_token : null;
  } while (pageToken);

  // Match each name
  const result = [];
  for (const name of names) {
    const q = name.toLowerCase();
    const matched = allMembers.filter((m) => (m.name || "").toLowerCase().includes(q));
    if (matched.length === 0) {
      result.push({ name, open_id: null, error: `未在群中找到"${name}"` });
    } else {
      result.push({ name, open_id: matched[0].member_id, display_name: matched[0].name });
    }
  }
  return result;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function die(obj) {
  out(obj);
  process.exit(1);
}

async function apiCall(method, urlPath, token, body, query) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function toTimestamp(dateStr) {
  return String(Math.floor(new Date(dateStr).getTime() / 1000));
}

/**
 * Convert Feishu event time object { timestamp, timezone } or { date }
 * to a human-readable string in the event's timezone (default Asia/Shanghai).
 */
function formatEventTime(timeObj) {
  if (!timeObj) return "";
  if (timeObj.date) return timeObj.date; // all-day event
  const ts = parseInt(timeObj.timestamp, 10);
  if (!ts || isNaN(ts)) return "";
  const tz = timeObj.timezone || "Asia/Shanghai";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Enrich event objects with human-readable start_time_str / end_time_str.
 */
function enrichEventTimes(event) {
  if (!event) return event;
  const enriched = { ...event };
  if (event.start_time) enriched.start_time_str = formatEventTime(event.start_time);
  if (event.end_time) enriched.end_time_str = formatEventTime(event.end_time);
  return enriched;
}

/**
 * Convert a date string to RFC3339 format with +08:00 timezone.
 * Accepts ISO8601 with timezone, or "YYYY-MM-DD HH:mm:ss" (treated as +08:00).
 */
function toRFC3339(input) {
  const trimmed = input.trim();
  // Already has timezone indicator
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) throw new Error(`无效时间: ${input}`);
    return trimmed;
  }
  // No timezone → treat as Asia/Shanghai +08:00
  // Accept "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss"
  const m = trimmed.replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`;
  }
  // Fallback: parse and format
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) throw new Error(`无效时间: ${input}`);
  // Format as local +08:00
  const offset = 8 * 60;
  const local = new Date(d.getTime() + offset * 60000);
  const iso = local.toISOString().replace("Z", "+08:00");
  return iso;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function listCalendars(args, token) {
  const query = { page_size: String(args.pageSize) };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall("GET", "/calendar/v4/calendars", token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    calendars: data.data?.calendar_list || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function getPrimary(args, token) {
  const data = await apiCall("POST", "/calendar/v4/calendars/primary", token, {});
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ calendar: data.data?.calendars?.[0]?.calendar || data.data });
}

async function createEvent(args, token) {
  const calId = args.calendarId || "primary";
  const body = {
    summary: args.summary || "未命名日程",
    description: args.description || "",
    start_time: args.isAllDay
      ? { date: args.startTime }
      : { timestamp: toTimestamp(args.startTime), timezone: args.timeZone },
    end_time: args.isAllDay
      ? { date: args.endTime }
      : { timestamp: toTimestamp(args.endTime), timezone: args.timeZone },
    vchat: {
      vc_type: "vc",
      ...(args.autoRecord && {
        meeting_settings: { auto_record: true },
      }),
    },
    reminders: [{ minutes: 15 }],
  };
  const rrule = resolveRecurrence(args);
  if (rrule) {
    body.recurrence = rrule;
    // Meeting chat creation requires attendee list to be visible
    if (!args.noMeetingChat) body.attendee_ability = "can_see_others";
  }
  if (args.location) body.location = { name: args.location };
  // Don't put attendees in create body — use separate attendees API for reliable processing
  const attendeeIds = args.attendees ? args.attendees.split(",").map((id) => id.trim()) : [];
  const query = { user_id_type: "open_id" };
  if (args.needAttendee) query.need_attendee = "true";
  const data = await apiCall("POST", `/calendar/v4/calendars/${calId}/events`, token, body, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);

  let event = data.data?.event;
  const eventId = event?.event_id;

  // Add attendees via dedicated API — create event body attendees may not be fully processed
  if (attendeeIds.length > 0 && eventId) {
    const attBody = {
      attendees: attendeeIds.map((id) => ({ type: "user", user_id: id, is_optional: false })),
    };
    await apiCall(
      "POST",
      `/calendar/v4/calendars/${calId}/events/${eventId}/attendees`,
      token,
      attBody,
      { user_id_type: "open_id" },
    );
  }

  // GET event to retrieve meeting URL — create response often lacks vchat details,
  // Feishu needs a moment to provision the video conference.
  let meetingUrl = event?.vchat?.meeting_url;
  if (!meetingUrl && eventId) {
    await new Promise((r) => setTimeout(r, 1000));
    const getData = await apiCall(
      "GET",
      `/calendar/v4/calendars/${calId}/events/${eventId}`,
      token,
      null,
      { user_id_type: "open_id" },
    );
    if (getData.code === 0 && getData.data?.event) {
      meetingUrl = getData.data.event.vchat?.meeting_url;
      event = getData.data.event;
    }
  }

  // Strip app_link from event output — it's an internal deep link that doesn't open in browser
  if (event?.app_link) delete event.app_link;

  // Auto-create meeting chat for recurring events (default on, use --no-meeting-chat to skip)
  let meetingChat = null;
  let meetingChatWarning = null;
  if (rrule && !args.noMeetingChat && eventId && attendeeIds.length >= 2) {
    const actualCalId = event?.organizer_calendar_id || calId;
    const chatData = await apiCall(
      "POST",
      `/calendar/v4/calendars/${actualCalId}/events/${eventId}/meeting_chat`,
      token,
    );
    if (chatData.code === 0 && chatData.data) {
      meetingChat = {
        meeting_chat_id: chatData.data.meeting_chat_id,
        applink: chatData.data.applink,
      };
    } else {
      meetingChatWarning = `创建会议群失败: code=${chatData.code} msg=${chatData.msg}`;
    }
  }

  const summary = args.summary || "未命名日程";
  const meetingChatTip = meetingChat ? `\n会议群已创建` : "";
  const replyText = `日程「${summary}」已创建${rrule ? `（重复：${args.repeat || args.recurrence}）` : ""}${meetingChatTip}`;

  // Send card to user if there's a meeting URL
  if (meetingUrl && args.openId) {
    await sendCard({
      openId: args.openId,
      title: "📅 日程已创建",
      body: replyText,
      buttonText: "加入会议",
      buttonUrl: meetingUrl,
      color: "green",
    }).catch(() => {});
  }

  out({
    event,
    meeting_url: meetingUrl,
    ...(meetingChat && { meeting_chat: meetingChat }),
    ...(meetingChatWarning && { meeting_chat_warning: meetingChatWarning }),
    reply: replyText,
  });
}

async function listEvents(args, token) {
  const calId = args.calendarId || "primary";
  const query = { page_size: String(Math.min(args.pageSize, 500)) };
  if (args.pageToken) query.page_token = args.pageToken;

  // Default to today if no time range provided
  if (args.startMin) {
    query.start_time = toTimestamp(args.startMin);
  } else {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    query.start_time = String(Math.floor(todayStart.getTime() / 1000));
  }
  if (args.startMax) {
    query.end_time = toTimestamp(args.startMax);
  } else if (!args.startMin) {
    // Only auto-set end_time when start_time was also auto-set (today)
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    query.end_time = String(Math.floor(todayEnd.getTime() / 1000));
  }
  const data = await apiCall("GET", `/calendar/v4/calendars/${calId}/events`, token, null, query);
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  const events = (data.data?.items || []).map(enrichEventTimes);

  // Build formatted reply so LLM can display directly without interpretation
  const reply = formatEventList(events, { showCancelled: args.showCancelled });
  out({ events, has_more: data.data?.has_more, page_token: data.data?.page_token, reply });
}

/**
 * Format event list into a human-readable reply string.
 * LLM should output this directly without modification.
 *
 * Covers: meetings (with video link), regular events, all-day events,
 * recurring events, cancelled, tentative, private events.
 */
function formatEventList(events, { showCancelled = false } = {}) {
  if (!events || events.length === 0) return "当前时间段内没有日程。";

  // Sort: upcoming first (by start_time ascending), past events after, cancelled last
  const now = Math.floor(Date.now() / 1000);
  const sorted = [...events].sort((a, b) => {
    const aCanc = a.status === "cancelled" ? 1 : 0;
    const bCanc = b.status === "cancelled" ? 1 : 0;
    if (aCanc !== bCanc) return aCanc - bCanc; // cancelled last

    const aTs = parseInt(a.start_time?.timestamp || "0", 10);
    const bTs = parseInt(b.start_time?.timestamp || "0", 10);
    const aFuture = aTs >= now ? 0 : 1;
    const bFuture = bTs >= now ? 0 : 1;
    if (aFuture !== bFuture) return aFuture - bFuture; // upcoming before past

    return aTs - bTs; // ascending by start time
  });

  // Separate active vs cancelled
  const active = sorted.filter((ev) => ev.status !== "cancelled");
  const cancelled = sorted.filter((ev) => ev.status === "cancelled");
  const toFormat = showCancelled ? sorted : active;

  const lines = [];
  for (const ev of toFormat) {
    const summary = ev.summary || "未命名日程";
    const startStr = ev.start_time_str || "";
    const endStr = ev.end_time_str || "";
    const status = ev.status || "confirmed";
    const organizer = ev.event_organizer?.display_name || "";
    const meetingUrl = ev.vchat?.meeting_url || "";
    const vcType = ev.vchat?.vc_type || "";
    const description = ev.description || "";
    const location = ev.location?.name || "";
    const attendeeCount = ev.attendees?.length;
    const freeBusy = ev.free_busy_status || "";
    const visibility = ev.visibility || "default";
    const isAllDay = !!ev.start_time?.date;
    const isRecurring = !!ev.recurrence;

    // Badge: determine event type based on status + vchat config
    // Feishu has no event_type field — type is implicit from vchat.vc_type:
    //   vc = Feishu video meeting
    //   third_party = external meeting link
    //   lark_live = Feishu live stream (read-only)
    //   no_meeting / empty = no video conference
    let badge = "";
    if (status === "cancelled") badge = "❌ 已取消";
    else if (status === "tentative") badge = "❓ 待确认";
    else if (vcType === "lark_live") badge = "📺 直播";
    else if (meetingUrl) badge = "📹 会议";
    else if (isAllDay) badge = "🗓️ 全天";
    else badge = "📅 日程";

    // Time display
    let timeDisplay = "";
    if (isAllDay) {
      const startDate = ev.start_time?.date || startStr;
      const endDate = ev.end_time?.date || endStr;
      timeDisplay = startDate === endDate ? `全天（${startDate}）` : `${startDate} ~ ${endDate}`;
    } else {
      const startTime = startStr.split(" ")[1] || startStr;
      const endTime = endStr.split(" ")[1] || endStr;
      // If start and end are on different dates, show full date+time
      const startDate = startStr.split(" ")[0] || "";
      const endDate = endStr.split(" ")[0] || "";
      if (startDate && endDate && startDate !== endDate) {
        timeDisplay = `${startStr} ~ ${endStr}`;
      } else {
        timeDisplay = startTime && endTime ? `${startTime} - ${endTime}` : startStr;
      }
    }

    let entry = `${badge}  **${summary}**\n    时间：${timeDisplay}`;

    // Tags line (compact metadata)
    const tags = [];
    if (isRecurring) tags.push("🔁 重复");
    if (freeBusy === "free") tags.push("空闲");
    if (visibility === "private") tags.push("🔒 私密");
    if (tags.length > 0) entry += `\n    标签：${tags.join(" · ")}`;

    if (organizer) entry += `\n    组织者：${organizer}`;
    if (location) entry += `\n    地点：${location}`;

    // Meeting / live link (only for active events)
    if (meetingUrl && status !== "cancelled") {
      const vcLabels = { third_party: "三方会议链接", lark_live: "直播链接", vc: "会议链接" };
      const vcLabel = vcLabels[vcType] || "会议链接";
      entry += `\n    ${vcLabel}：${meetingUrl}`;
    }

    if (description) entry += `\n    备注：${description}`;
    if (attendeeCount) entry += `\n    参与者：${attendeeCount} 人`;

    // Status notes
    if (status === "cancelled") entry += `\n    ⚠️ 此日程已被取消`;
    if (status === "tentative") entry += `\n    ⏳ 此日程尚未确认`;

    lines.push(entry);
  }

  let result = lines.join("\n\n");

  // Append cancelled count hint (only when not showing cancelled)
  if (!showCancelled && cancelled.length > 0) {
    result += `\n\n---\n另有 ${cancelled.length} 个已取消的日程未显示，如需查看请回复"显示已取消日程"。`;
  }

  if (active.length === 0 && cancelled.length > 0 && !showCancelled) {
    result = `当前时间段内没有有效日程。\n\n另有 ${cancelled.length} 个已取消的日程，如需查看请回复"显示已取消日程"。`;
  }

  return result;
}

async function getEvent(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  const calId = args.calendarId || "primary";
  const query = { user_id_type: "open_id" };
  if (args.needAttendee) query.need_attendee = "true";
  const data = await apiCall(
    "GET",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ event: enrichEventTimes(data.data?.event) });
}

async function updateEvent(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  const calId = args.calendarId || "primary";
  const body = {};
  if (args.summary) body.summary = args.summary;
  if (args.description) body.description = args.description;
  if (args.startTime)
    body.start_time = args.isAllDay
      ? { date: args.startTime }
      : { timestamp: toTimestamp(args.startTime), timezone: args.timeZone };
  if (args.endTime)
    body.end_time = args.isAllDay
      ? { date: args.endTime }
      : { timestamp: toTimestamp(args.endTime), timezone: args.timeZone };
  if (args.location) body.location = { name: args.location };
  const data = await apiCall(
    "PATCH",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ event: data.data?.event, reply: "日程已更新" });
}

async function deleteEvent(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  const calId = args.calendarId || "primary";
  const data = await apiCall(
    "DELETE",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}`,
    token,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "日程已删除" });
}

async function searchEvents(args, token) {
  if (!args.query) die({ error: "missing_param", message: "--query 必填" });
  const calId = args.calendarId || "primary";
  const body = { query: args.query };
  const query = { page_size: String(Math.min(args.pageSize, 50)), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall(
    "POST",
    `/calendar/v4/calendars/${calId}/events/search`,
    token,
    body,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  const events = (data.data?.items || []).map(enrichEventTimes);
  out({ events, has_more: data.data?.has_more, page_token: data.data?.page_token });
}

async function addAttendees(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  if (!args.attendees) die({ error: "missing_param", message: "--attendees 必填" });
  const calId = args.calendarId || "primary";
  const body = {
    attendees: args.attendees.split(",").map((id) => ({ type: "user", user_id: id.trim() })),
  };
  const data = await apiCall(
    "POST",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}/attendees`,
    token,
    body,
    { user_id_type: "open_id" },
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ attendees: data.data?.attendees, reply: "参与者已添加" });
}

async function listAttendees(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  const calId = args.calendarId || "primary";
  const query = { page_size: String(args.pageSize), user_id_type: "open_id" };
  if (args.pageToken) query.page_token = args.pageToken;
  const data = await apiCall(
    "GET",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}/attendees`,
    token,
    null,
    query,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({
    attendees: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  });
}

async function removeAttendees(args, token) {
  if (!args.eventId) die({ error: "missing_param", message: "--event-id 必填" });
  if (!args.attendees) die({ error: "missing_param", message: "--attendees 必填" });
  const calId = args.calendarId || "primary";
  const body = {
    attendee_ids: args.attendees.split(",").map((id) => id.trim()),
  };
  const data = await apiCall(
    "POST",
    `/calendar/v4/calendars/${calId}/events/${args.eventId}/attendees/batch_delete`,
    token,
    body,
  );
  if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.msg}`);
  out({ success: true, reply: "参与者已移除" });
}

async function checkFreebusy(args, token, cfg) {
  if (!args.userIds && !args.names)
    die({ error: "missing_param", message: "--user-ids 或 --names 必填" });
  if (!args.startTime || !args.endTime)
    die({ error: "missing_param", message: "--start-time 和 --end-time 必填" });

  let userIds = args.userIds ? args.userIds.split(",").map((id) => id.trim()) : [];
  const nameResolutions = [];

  // Resolve names → open_ids via chat members
  if (args.names) {
    if (!args.chatId) die({ error: "missing_param", message: "按姓名查忙闲需要 --chat-id" });
    const appToken = await getTenantToken(cfg);
    const names = args.names.split(",").map((n) => n.trim());
    const resolved = await searchChatMembersByName(args.chatId, names, appToken);
    for (const r of resolved) {
      nameResolutions.push(r);
      if (r.open_id) userIds.push(r.open_id);
    }
    const notFound = nameResolutions.filter((r) => !r.open_id);
    if (notFound.length > 0 && userIds.length === 0) {
      die({ error: "user_not_found", message: notFound.map((r) => r.error).join("；") });
    }
  }

  const timeMin = toRFC3339(args.startTime);
  const timeMax = toRFC3339(args.endTime);
  const idToName = Object.fromEntries(
    nameResolutions.filter((r) => r.open_id).map((r) => [r.open_id, r.display_name || r.name]),
  );

  // freebusy/list is one user per request — query in parallel
  const results = await Promise.all(
    userIds.map(async (uid) => {
      const body = {
        time_min: timeMin,
        time_max: timeMax,
        user_id: uid,
      };
      const data = await apiCall("POST", "/calendar/v4/freebusy/list", token, body, {
        user_id_type: "open_id",
      });
      if (data.code !== 0)
        throw new Error(`查询 ${uid} 忙闲失败: code=${data.code} msg=${data.msg}`);
      const busyPeriods = data.data?.freebusy_list || [];
      return {
        user_id: uid,
        ...(idToName[uid] && { display_name: idToName[uid] }),
        busy_periods: busyPeriods,
        is_free: busyPeriods.length === 0,
      };
    }),
  );

  const warnings = nameResolutions.filter((r) => !r.open_id).map((r) => r.error);
  out({ freebusy: results, ...(warnings.length > 0 && { warnings }) });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ACTIONS = {
  list_calendars: listCalendars,
  get_primary: getPrimary,
  create_event: createEvent,
  list_events: listEvents,
  get_event: getEvent,
  update_event: updateEvent,
  delete_event: deleteEvent,
  search_events: searchEvents,
  add_attendees: addAttendees,
  list_attendees: listAttendees,
  remove_attendees: removeAttendees,
  check_freebusy: checkFreebusy,
};

async function main() {
  const args = parseArgs();
  if (!args.openId) die({ error: "missing_param", message: "--open-id 参数必填" });
  if (!args.action)
    die({
      error: "missing_param",
      message: `--action 参数必填。可选: ${Object.keys(ACTIONS).join(", ")}`,
    });

  const handler = ACTIONS[args.action];
  if (!handler)
    die({
      error: "invalid_action",
      message: `未知操作: ${args.action}。可选: ${Object.keys(ACTIONS).join(", ")}`,
    });

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    die({ error: "config_error", message: err.message });
  }

  let accessToken;
  try {
    accessToken = await getValidToken(args.openId, cfg.appId, cfg.appSecret);
  } catch (err) {
    die({ error: "token_error", message: err.message });
  }
  if (!accessToken) {
    die({ error: "auth_required", message: `用户未授权。open_id: ${args.openId}` });
  }

  try {
    await handler(args, accessToken, cfg);
  } catch (err) {
    if (err.message?.includes("99991663"))
      die({ error: "auth_required", message: "token 已失效，请重新授权" });
    const msg = err.message || "";
    if (msg.includes("99991400")) {
      die({ error: "rate_limited", message: msg || "请求频率超限，请稍后重试" });
    }
    if (
      msg.includes("99991672") ||
      msg.includes("99991679") ||
      /permission|scope|not support|tenant/i.test(msg)
    ) {
      die({
        error: "permission_required",
        message: msg,
        required_scopes: [
          "calendar:calendar",
          "calendar:calendar:read",
          "calendar:calendar.event:create",
          "calendar:calendar.event:read",
          "calendar:calendar.event:update",
          "calendar:calendar.event:delete",
          "calendar:calendar.free_busy:read",
        ],
        reply: "⚠️ **权限不足，需要重新授权以获取所需权限。**",
      });
    }
    die({ error: "api_error", message: err.message });
  }
}

main();
