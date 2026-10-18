# clean-gmail-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent the hands it needs for a daily inbox routine:

- **Gmail**: fetch recent mail, read full messages, archive noise, star urgent, label, mark read
- **Slack**: post the morning summary to a channel or DM

The agent (OpenWork + a scheduled Automation) is the **brain**: it decides what's noise, what's urgent, and how to word the summary. This server only exposes clean, single-purpose **mechanisms**.

```
OpenWork Automation (daily, 7:00 Europe/Bucharest)
  └─ agent reasons over tool results
       ├─ gmail_fetch_recent ──► Gmail API
       ├─ gmail_archive / gmail_star / gmail_apply_label ──► Gmail API
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
| `slack_send_message` | Post to `#channel`, channel id, or user id (DM) |

## Prerequisites

- Node.js >= 20
- A Google Cloud project with the **Gmail API** enabled
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
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → add scope `https://www.googleapis.com/auth/gmail.modify` → add your own Gmail address as a **test user**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app** → copy the client ID and secret into `.env`.
5. Exchange them for a refresh token (opens your browser, saves `.tokens/google-token.json`):

```sh
npm run auth:google
```

The `gmail.modify` scope reads and modifies mail (labels, archive, star, mark read) but cannot permanently delete anything.

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

Runs the stdio smoke test: it spawns the built server, performs the MCP handshake, and asserts all 8 tools plus the unconfigured-credentials error paths (also run by CI on every PR).

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

(If you ever host it remotely, the **Settings → Library → Add workspace MCP** UI takes a server URL instead.)

Then create the morning Automation: **daily schedule in your timezone**, with a prompt like:

> Run my morning inbox routine using the clean-gmail-mcp tools.
>
> 1. `gmail_fetch_recent` with hours=24. Read full bodies (`gmail_get_message`) only when the snippet is ambiguous.
> 2. Triage: archive newsletters, promotions, marketing and automated notifications; mark the archived batch as read; label receipts as "Receipts"; star anything that needs a reply, has a deadline, or involves money.
> 3. Compose a Slack summary in mrkdwn: *Needs you* (starred/action), *Heads up* (meetments, deadlines), *Stats* (X archived, Y kept). Two sentences max per item, one line per item. Skip anything trivial.
> 4. `slack_send_message` the summary. Do not change labels or archive beyond step 2, and never trash messages.

The first runs are the time to tune the prompt — tell the agent what it got wrong and edit the Automation.

## Security notes

- `.env` and `.tokens/` are gitignored — never commit tokens.
- Refresh token is stored with `0600` permissions.
- Minimal scopes: `gmail.modify` (no delete, no send) + `userinfo.email`.
- Revoking access anytime: [Google Account → Security → Third-party access](https://myaccount.google.com/permissions).

## Ideas for next versions

- `slack_send_digest` with Block Kit cards
- Webhook mode so a hosted version can be triggered outside OpenWork
- Dry-run mode that returns the triage plan without applying it
- Per-thread reply detection (`gmail_fetch_recent` already returns thread ids)

## License

MIT
