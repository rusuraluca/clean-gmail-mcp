import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { getSlackAllowedUser, getSlackSocketToken, getSlackToken } from "./config.js";
import { OpenworkBridge } from "./openwork.js";
import {
  buildPrompt,
  extractRequestText,
  shouldHandleEvent,
  truncateAnswer,
  type SlackEvent,
} from "./slack-events.js";

const MAX_SEEN_EVENTS = 500;

interface HandlerDeps {
  bridge: OpenworkBridge;
  web: WebClient;
  allowedUser: string;
}

function makeEventDeduper() {
  const seen = new Set<string>();
  return function seenEvent(id: string | undefined): boolean {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > MAX_SEEN_EVENTS) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    return false;
  };
}

export async function handleSlackEvent(event: SlackEvent, deps: HandlerDeps): Promise<void> {
  const { bridge, web, allowedUser } = deps;
  if (!shouldHandleEvent(event, allowedUser)) return;
  const request = extractRequestText(event);
  if (!request) return;
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  if (!channel || !threadTs) return;

  const status = await web.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Running the OpenWork session…",
  });
  const statusTs = status.ts;
  if (!statusTs) return;

  const title = `Gmini Slack: ${request.slice(0, 60)}`;
  console.error(`handling request in ${channel}/${threadTs}: ${request.slice(0, 120)}`);
  try {
    const result = await bridge.ask(buildPrompt(request), title);
    console.error(`session ${result.sessionId ?? "?"} -> ${result.status}`);
    await web.chat.update({
      channel,
      ts: statusTs,
      text: truncateAnswer(result.text || "(the session returned no text)"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ask failed:", message);
    await web.chat.update({
      channel,
      ts: statusTs,
      text: `Failed to reach OpenWork: ${message}`,
    });
  }
}

export async function startSlackListener(): Promise<void> {
  const socketToken = getSlackSocketToken();
  const botToken = getSlackToken();
  const allowedUser = getSlackAllowedUser();

  const bridge = new OpenworkBridge();
  console.error("connecting to the OpenWork gateway (browser sign-in on first run)…");
  await bridge.connect();

  const web = new WebClient(botToken);
  const socket = new SocketModeClient({ appToken: socketToken });
  const dedupe = makeEventDeduper();
  const deps: HandlerDeps = { bridge, web, allowedUser };

  const onEvent = (type: string, event: SlackEvent) => {
    void (async () => {
      if (dedupe(event.client_msg_id)) return;
      await handleSlackEvent({ ...event, type }, deps);
    })().catch((err) => console.error("event handler failed:", err));
  };

  socket.on("app_mention", (payload: { ack: () => Promise<void>; event: SlackEvent }) => {
    void payload.ack().catch(() => {});
    onEvent("app_mention", payload.event);
  });
  socket.on("message", (payload: { ack: () => Promise<void>; event: SlackEvent }) => {
    void payload.ack().catch(() => {});
    onEvent("message", payload.event);
  });
  socket.on("error", (err: Error) => console.error("socket mode error:", err));

  await socket.start();
  console.error(`gmini slack listener ready (acting as ${allowedUser})`);
}
