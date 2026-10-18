#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as gmail from "./gmail.js";

const server = new McpServer({
  name: "morning-inbox-mcp",
  version: "0.1.0",
});

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("morning-inbox-mcp ready (stdio)");
