#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttp } from "./http.js";

if (process.argv.includes("--http")) {
  const port = Number(process.env.PORT ?? 3000);
  try {
    await startHttp(port);
  } catch (err) {
    console.error(`failed to start http transport on port ${port}:`, err);
    process.exit(1);
  }
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("clean-gmail-mcp ready (stdio)");
}
