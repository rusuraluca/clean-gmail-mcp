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
