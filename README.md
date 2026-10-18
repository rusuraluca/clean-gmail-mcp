# morning-inbox-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent the hands it needs for a daily inbox routine: Gmail triage tools plus a Slack summary relay.

The agent (OpenWork + a scheduled Automation) is the **brain**: it decides what's noise, what's urgent, and how to word the summary. This server only exposes clean, single-purpose **mechanisms**.

## Development

Requires Node.js >= 20.

```sh
npm install
npm run build
npm start
```

The server speaks MCP over stdio — it waits for a client such as OpenWork to connect.

## Google setup (one-time)

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → add scope `https://www.googleapis.com/auth/gmail.modify` → add your own Gmail address as a **test user**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app** → copy the client ID and secret into `.env` (see `.env.example`).
5. Exchange them for a refresh token (opens your browser, saves `.tokens/google-token.json`):

```sh
npm run auth:google
```

The `gmail.modify` scope reads and modifies mail (labels, archive, star, mark read) but cannot permanently delete anything.

## Slack setup (one-time)

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:read`, `groups:read`, `im:write`.
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) into `.env`.
4. Invite the bot where it should post: `/invite @your-app-name` (private channels too).
5. Optional: set `SLACK_DEFAULT_CHANNEL=#inbox-brief` in `.env`.
