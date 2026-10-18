import { google, type gmail_v1 } from "googleapis";
import { createOAuthClient } from "./google-auth.js";

function gmailClient(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: createOAuthClient() });
}

export interface FetchRecentParams {
  hours: number;
  maxResults: number;
  query?: string;
}

export interface RecentMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
  hasAttachments: boolean;
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  const found = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

export async function fetchRecent(params: FetchRecentParams): Promise<{
  windowHours: number;
  gmailQuery: string;
  count: number;
  messages: RecentMessage[];
}> {
  const { hours, maxResults, query } = params;
  const gmail = gmailClient();
  const after = Math.floor(Date.now() / 1000) - hours * 3600;
  const gmailQuery = [`after:${after}`, query].filter(Boolean).join(" ");

  const list = await gmail.users.messages.list({
    userId: "me",
    q: gmailQuery,
    maxResults,
  });

  const ids = (list.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  const messages = await Promise.all(
    ids.map(async (id) => {
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];
      return {
        id: msg.id ?? id,
        threadId: msg.threadId ?? "",
        from: headerValue(headers, "From"),
        to: headerValue(headers, "To"),
        subject: headerValue(headers, "Subject"),
        date: headerValue(headers, "Date"),
        snippet: msg.snippet ?? "",
        labelIds: msg.labelIds ?? [],
        hasAttachments: Boolean(msg.payload?.parts?.some((p) => p.filename)),
      } satisfies RecentMessage;
    }),
  );

  return { windowHours: hours, gmailQuery, count: messages.length, messages };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectTextBodies(
  part: gmail_v1.Schema$MessagePart | null | undefined,
  plain: string[],
  html: string[],
  depth = 0,
): void {
  if (!part || depth > 20) return;
  const mime = part.mimeType ?? "";
  if (part.body?.data) {
    if (mime.startsWith("text/plain")) plain.push(decodeBase64Url(part.body.data));
    else if (mime.startsWith("text/html")) html.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) collectTextBodies(child, plain, html, depth + 1);
}

function extractBody(payload: gmail_v1.Schema$MessagePart | null | undefined): { body: string; hadAttachment: boolean } {
  const plain: string[] = [];
  const html: string[] = [];
  let hadAttachment = false;

  const walk = (part: gmail_v1.Schema$MessagePart | null | undefined, depth = 0): void => {
    if (!part || depth > 20) return;
    if (part.body?.attachmentId) hadAttachment = true;
    collectTextBodies(part, plain, html, depth);
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(payload);

  if (plain.length > 0) return { body: plain.join("\n"), hadAttachment };
  if (html.length > 0) return { body: html.map(stripHtml).join("\n"), hadAttachment };
  return { body: "", hadAttachment };
}

export async function getMessage(params: {
  id: string;
  maxChars?: number;
}): Promise<{
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  labelIds: string[];
  body: string;
  truncated: boolean;
  hadAttachment: boolean;
}> {
  const maxChars = params.maxChars ?? 20000;
  const gmail = gmailClient();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: params.id,
    format: "full",
  });
  const msg = res.data;
  const headers = msg.payload?.headers ?? [];
  const { body: rawBody, hadAttachment } = extractBody(msg.payload);
  const truncated = rawBody.length > maxChars;

  return {
    id: msg.id ?? params.id,
    threadId: msg.threadId ?? "",
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    labelIds: msg.labelIds ?? [],
    body: truncated ? `${rawBody.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]` : rawBody,
    truncated,
    hadAttachment,
  };
}

const MODIFY_CHUNK = 100;

async function batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<{ updated: number }> {
  if (ids.length === 0) throw new Error("No message ids provided.");
  const gmail = gmailClient();
  for (let i = 0; i < ids.length; i += MODIFY_CHUNK) {
    const chunk = ids.slice(i, i + MODIFY_CHUNK);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: chunk,
        addLabelIds,
        removeLabelIds,
      },
    });
  }
  return { updated: ids.length };
}

export function archiveMessages(ids: string[]): Promise<{ updated: number }> {
  return batchModify(ids, [], ["INBOX"]);
}

export function markRead(ids: string[]): Promise<{ updated: number }> {
  return batchModify(ids, [], ["UNREAD"]);
}

export function starMessages(ids: string[]): Promise<{ updated: number }> {
  return batchModify(ids, ["STARRED"], []);
}

export async function applyLabel(params: { ids: string[]; label: string }): Promise<{
  updated: number;
  labelId: string;
  labelName: string;
  created: boolean;
}> {
  const { ids, label } = params;
  if (ids.length === 0) throw new Error("No message ids provided.");
  const gmail = gmailClient();

  const listed = await gmail.users.labels.list({ userId: "me" });
  const labels = listed.data.labels ?? [];
  let match = labels.find((l) => l.id === label || l.name?.toLowerCase() === label.toLowerCase());
  let created = false;

  if (!match) {
    const createdLabel = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name: label },
    });
    match = createdLabel.data;
    created = true;
  }

  if (!match?.id) throw new Error(`Could not resolve Gmail label "${label}".`);

  await batchModify(ids, [match.id], []);
  return { updated: ids.length, labelId: match.id, labelName: match.name ?? label, created };
}

export async function listLabels(): Promise<{
  labels: { id: string; name: string; type: string; messagesTotal: number }[];
}> {
  const gmail = gmailClient();
  const listed = await gmail.users.labels.list({ userId: "me" });
  const labels = (listed.data.labels ?? [])
    .filter((l) => l.id && l.name)
    .map((l) => ({
      id: l.id as string,
      name: l.name as string,
      type: l.type ?? "",
      messagesTotal: l.messagesTotal ?? 0,
    }));
  return { labels };
}
