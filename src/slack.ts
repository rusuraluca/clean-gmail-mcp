import { WebClient } from "@slack/web-api";
import { getDefaultSlackChannel, getSlackToken } from "./config.js";

export interface SendSlackMessageParams {
  text: string;
  channel?: string;
}

async function resolveChannel(client: WebClient, channel: string): Promise<string> {
  if (channel.startsWith("#")) {
    const name = channel.slice(1);
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const match = (res.channels ?? []).find((c) => c.name === name);
      if (match?.id) return match.id;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    throw new Error(
      `Slack channel #${name} not found. For private channels the bot must be invited first (/invite @your-app).`,
    );
  }

  if (/^U[A-Z0-9]{8,}$/i.test(channel)) {
    const opened = await client.conversations.open({ users: channel });
    if (opened.channel?.id) return opened.channel.id;
    throw new Error(`Could not open a direct message with user ${channel}.`);
  }

  return channel;
}

export async function sendSlackMessage(params: SendSlackMessageParams): Promise<{
  channel: string;
  ts: string;
  permalink?: string;
}> {
  const token = getSlackToken();
  const target = params.channel ?? getDefaultSlackChannel();
  if (!target) {
    throw new Error(
      "No Slack target. Pass `channel` (e.g. #inbox-brief, C0123456789, or a user id for a DM) " +
        "or set SLACK_DEFAULT_CHANNEL in .env.",
    );
  }
  if (!params.text.trim()) throw new Error("Message text is empty.");

  const client = new WebClient(token);
  const channel = await resolveChannel(client, target);

  const result = await client.chat.postMessage({
    channel,
    text: params.text,
    unfurl_links: false,
    unfurl_media: false,
  });

  let permalink: string | undefined;
  if (result.ts && result.channel) {
    try {
      const perma = await client.chat.getPermalink({
        channel: result.channel,
        message_ts: result.ts,
      });
      permalink = perma.permalink ?? undefined;
    } catch {
      permalink = undefined;
    }
  }

  return { channel: result.channel ?? channel, ts: result.ts ?? "", permalink };
}
