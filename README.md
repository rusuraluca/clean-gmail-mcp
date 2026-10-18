# clean-gmail-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent the hands it needs for a daily inbox routine:

- **Gmail**: fetch recent mail, read full messages, archive noise, star urgent, label, mark read
- **Calendar**: fetch a day's events from the primary Google Calendar
- **Slack**: post the summary in five sections — *Today*, *To reply*, *Important*, *Top news*, *Clean up summary* — to a channel or DM

The agent (OpenWork + a scheduled Automation) is the **brain**: it decides what's noise, what's urgent, and how to word the summary. This server only exposes clean, single-purpose **mechanisms**.

```
OpenWork Automation (daily, 7:00 + 17:00 Europe/London)
  └─ agent reasons over tool results
       ├─ gmail_fetch_recent ──► Gmail API
       ├─ gmail_archive / gmail_star / gmail_apply_label ──► Gmail API
       ├─ calendar_fetch_today ──► Calendar API
       └─ slack_send_message ──► Slack Web API
```

## Tools

| Tool | What it does |
| --- | --- |
| `gmail_fetch_recent` | Recent messages: id, from, subject, date, snippet, labels, attachment flag |
| `gmail_get_message` | One message with decoded body text |
| `gmail_archive` | Remove INBOX label (never deletes) |
| `gmail_mark_read` | Remove UNREAD label |
| `gmail_star` | Add STARRED label |
| `gmail_apply_label` | Apply a label by name, creating it if missing |
| `gmail_list_labels` | List system and custom labels |
| `calendar_fetch_today` | One day of primary-calendar events (times, location, Meet link) |
| `slack_send_message` | Post to `#channel`, channel id, or user id (DM) |

## Prerequisites

- Node.js >= 20
- A Google Cloud project with the **Gmail API** and **Calendar API** enabled
- A Slack workspace where you can create an app

## Setup

```sh
git clone git@github.com:rusuraluca/clean-gmail-mcp.git
cd clean-gmail-mcp
npm install
npm run build
cp .env.example .env
```

### Google setup (one-time)

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Gmail API** and **Calendar API**.
3. **APIs & Services → OAuth consent screen** → External → add scopes `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/calendar.readonly` → add your own Gmail address as a **test user**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app** → copy the client ID and secret into `.env`.
5. Exchange them for a refresh token (opens your browser, saves `.tokens/google-token.json`):

```sh
npm run auth:google
```

The `gmail.modify` scope reads and modifies mail (labels, archive, star, mark read) but cannot permanently delete anything; `calendar.readonly` reads events and cannot create or change them. Upgrading from an older token? Re-run `npm run auth:google` once so the consent includes the calendar scope.

### Slack setup (one-time)

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:read`, `groups:read`, `im:write`.
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) into `.env`.
4. Invite the bot where it should post: `/invite @your-app-name` (private channels too).
5. Optional: set `SLACK_DEFAULT_CHANNEL=#inbox-brief` in `.env`.

### Test locally

```sh
npm test
```

Runs both smoke tests: the stdio one (MCP handshake, all 9 tools, unconfigured-credentials error paths) and the HTTP one (initialize, session id, `tools/list` over Streamable HTTP). CI runs them on every PR.

For an interactive session with the official inspector:

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

## Wire it into OpenWork

OpenWork reads `opencode.json`, so add the server to your workspace config:

```json
{
  "mcp": {
    "clean-gmail-mcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "cwd": "/absolute/path/to/clean-gmail-mcp",
      "enabled": true
    }
  }
}
```

`cwd` matters: the server loads `.env` from it. Rebuild (`npm run build`) after code changes; OpenWork starts the server on demand.

## Use with any AI client

Same tools, two transports:

| Transport | How it starts | Connect from |
| --- | --- | --- |
| **stdio** (default) | the client spawns `node dist/index.js` itself and speaks MCP (JSON-RPC) over the process's stdin/stdout | any client that can run a local command: Claude Desktop, Cursor, VS Code, Codex, OpenCode |
| **Streamable HTTP** | `npm run start:http` → `http://127.0.0.1:3000/mcp` | any client that connects by URL: MCP Inspector, OpenWork (**Settings → Library → Add workspace MCP**), web-based agents |

```sh
npm run start:http          # PORT=3000 by default
PORT=8080 npm run start:http
HOST=0.0.0.0 npm run start:http   # listen on all interfaces (see warning below)
```

stdio needs no port or network — that is what "speaks MCP over stdio" means: the client owns the process, messages travel over the pipes. HTTP lets a client that never spawns processes reach the same server by URL.

> **Warning**: the HTTP endpoint has **no authentication** and binds `127.0.0.1` only. Do not expose it to the network without putting auth in front of it (reverse proxy, VPN, or tunnel).

Then create the Automations — daily, morning and at 5pm (e.g. 7:00 and 17:00 in your timezone), same prompt:

> Run my inbox routine using the clean-gmail-mcp tools.
>
> 1. `calendar_fetch_today` for today's agenda. `gmail_fetch_recent` with hours=24. Read full bodies (`gmail_get_message`) only when the snippet is ambiguous.
> 2. Triage: archive newsletters, promotions, marketing and automated notifications; mark the archived batch as read; label receipts as "Receipts"; star anything that needs a reply, has a deadline, or involves money.
> 3. Compose a Slack summary in mrkdwn with five sections: *Today* (calendar events with times and links), *To reply* (needs your answer), *Important* (deadlines, money, urgent), *Top news* (notable but not urgent), *Clean up summary* (X archived, Y kept). Two sentences max per item, one line per item. Skip anything trivial.
> 4. `slack_send_message` the summary. Do not change labels or archive beyond step 2, never trash messages, and never create, change or cancel calendar events.

The first runs are the time to tune the prompt — tell the agent what it got wrong and edit the Automation.

## Security notes

- `.env` and `.tokens/` are gitignored — never commit tokens.
- Refresh token is stored with `0600` permissions.
- Minimal scopes: `gmail.modify` (no delete, no send) + `calendar.readonly` (read-only) + `userinfo.email`.
- Revoking access anytime: [Google Account → Security → Third-party access](https://myaccount.google.com/permissions).

## Ideas for next versions

- Slack Socket Mode listener so @mentions in Slack trigger the same routine
- `slack_send_digest` with Block Kit cards
- Webhook mode so a hosted version can be triggered outside OpenWork
- Dry-run mode that returns the triage plan without applying it
- Per-thread reply detection (`gmail_fetch_recent` already returns thread ids)

## License

MIT
