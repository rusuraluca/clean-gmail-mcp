import { google, type calendar_v3 } from "googleapis";
import { getCalendarTimezone } from "./config.js";
import { createOAuthClient } from "./google-auth.js";

function calendarClient(): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: createOAuthClient() });
}

function dateInTz(tz: string, when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

function offsetInTz(tz: string, when: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(when);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  if (name === "GMT") return "+00:00";
  return name.replace("GMT", "");
}

function nextDate(date: string): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FetchTodayParams {
  date?: string;
  maxResults?: number;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  status: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  meetLink: string | null;
  htmlLink: string;
  attendees: string[];
}

export async function fetchToday(params: FetchTodayParams = {}): Promise<{
  timezone: string;
  date: string;
  timeMin: string;
  timeMax: string;
  count: number;
  events: CalendarEvent[];
}> {
  const tz = getCalendarTimezone();
  const date = params.date ?? dateInTz(tz, new Date());
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`Invalid date "${date}", expected YYYY-MM-DD.`);
  }
  const maxResults = params.maxResults ?? 50;
  const following = nextDate(date);
  const timeMin = `${date}T00:00:00${offsetInTz(tz, new Date(`${date}T12:00:00Z`))}`;
  const timeMax = `${following}T00:00:00${offsetInTz(tz, new Date(`${following}T12:00:00Z`))}`;

  try {
    const res = await calendarClient().events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      timeZone: tz,
      singleEvents: true,
      orderBy: "startTime",
      maxResults,
    });

    const events: CalendarEvent[] = (res.data.items ?? [])
      .filter((item) => item.id)
      .map((item) => {
        const allDay = Boolean(item.start?.date);
        return {
          id: item.id as string,
          summary: item.summary ?? "(no title)",
          status: item.status ?? "",
          start: item.start?.dateTime ?? item.start?.date ?? "",
          end: item.end?.dateTime ?? item.end?.date ?? "",
          allDay,
          location: item.location ?? "",
          meetLink: item.hangoutLink ?? null,
          htmlLink: item.htmlLink ?? "",
          attendees: (item.attendees ?? [])
            .map((a) => a.email ?? "")
            .filter(Boolean),
        } satisfies CalendarEvent;
      });

    return { timezone: tz, date, timeMin, timeMax, count: events.length, events };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/insufficient|scope|403/i.test(message)) {
      throw new Error(
        `${message}\nHint: the stored Google token predates the calendar.readonly scope. ` +
          `Re-run "npm run auth:google" to grant it.`,
      );
    }
    throw err instanceof Error ? err : new Error(message);
  }
}
