import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as calendar from "./calendar.js";
import * as gmail from "./gmail.js";
import * as slack from "./slack.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "clean-gmail-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "gmail_fetch_recent",
    {
      title: "Fetch recent Gmail messages",
      description:
        "Fetch recent Gmail messages (metadata + snippet, newest first) for triage. " +
        "Returns id, from, subject, date, snippet, labelIds and attachment flag for each message. " +
        "Use gmail_get_message when the snippet is not enough to judge a message.",
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(2160)
          .default(24)
          .describe("How far back to look, in hours (default 24)."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(25)
          .describe("Maximum messages to return, newest first (default 25)."),
        query: z
          .string()
          .optional()
          .describe("Extra Gmail search terms, e.g. 'is:unread' or 'from:alice@example.com'."),
      },
    },
    async ({ hours, maxResults, query }) => {
      try {
        return ok(await gmail.fetchRecent({ hours, maxResults, query }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_get_message",
    {
      title: "Read one Gmail message",
      description:
        "Fetch a single Gmail message with its decoded body text. " +
        "Use after gmail_fetch_recent when a snippet is not enough to decide what to do.",
      inputSchema: {
        id: z.string().describe("Message id from gmail_fetch_recent."),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100000)
          .default(20000)
          .describe("Truncate the body at this many characters (default 20000)."),
      },
    },
    async ({ id, maxChars }) => {
      try {
        return ok(await gmail.getMessage({ id, maxChars }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_archive",
    {
      title: "Archive Gmail messages",
      description:
        "Archive messages by removing the INBOX label. Messages are kept, never deleted. " +
        "Use for newsletters, promotions, notifications and other noise after triage.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(500).describe("Message ids to archive."),
      },
    },
    async ({ ids }) => {
      try {
        return ok(await gmail.archiveMessages(ids));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_mark_read",
    {
      title: "Mark Gmail messages as read",
      description: "Remove the UNREAD label from the given messages.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(500).describe("Message ids to mark as read."),
      },
    },
    async ({ ids }) => {
      try {
        return ok(await gmail.markRead(ids));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_star",
    {
      title: "Star Gmail messages",
      description: "Add the STARRED label to the given messages. Use for urgent or action-needed mail.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(500).describe("Message ids to star."),
      },
    },
    async ({ ids }) => {
      try {
        return ok(await gmail.starMessages(ids));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_apply_label",
    {
      title: "Apply a Gmail label",
      description:
        "Apply a label to the given messages. The label is created if it does not exist yet " +
        "(e.g. 'Newsletters', 'Receipts', 'To Review').",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(500).describe("Message ids to label."),
        label: z.string().min(1).max(200).describe("Label name, e.g. 'Receipts'."),
      },
    },
    async ({ ids, label }) => {
      try {
        return ok(await gmail.applyLabel({ ids, label }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "List Gmail labels",
      description: "List all Gmail labels (system and custom) with their ids.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await gmail.listLabels());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "calendar_fetch_today",
    {
      title: "Fetch today's calendar",
      description:
        "List Google Calendar events for one day on the primary calendar, ordered by start time. " +
        "Returns title, start/end, all-day flag, location, Meet link and event link for each event. " +
        "The day defaults to today in the CALENDAR_TIMEZONE setting (Europe/London by default).",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Day to fetch as YYYY-MM-DD (default: today in CALENDAR_TIMEZONE)."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Maximum events to return, ordered by start time (default 50)."),
      },
    },
    async ({ date, maxResults }) => {
      try {
        return ok(await calendar.fetchToday({ date, maxResults }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slack_send_message",
    {
      title: "Send a Slack message",
      description:
        "Post a message to a Slack channel, or to a user id for a DM. " +
        "Uses Slack mrkdwn formatting (*bold*, _italic_, > quote, • bullet). " +
        "channel defaults to SLACK_DEFAULT_CHANNEL when omitted.",
      inputSchema: {
        text: z.string().min(1).max(39000).describe("Message text, Slack mrkdwn allowed."),
        channel: z
          .string()
          .optional()
          .describe("Target: '#channel-name', 'C0123456789', or a user id for a DM."),
      },
    },
    async ({ text, channel }) => {
      try {
        return ok(await slack.sendSlackMessage({ text, channel }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
