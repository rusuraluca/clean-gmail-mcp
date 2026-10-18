import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 3847;
const endpoint = `http://127.0.0.1:${port}/mcp`;
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function fail(message, child) {
  console.error(`FAIL: ${message}`);
  child.kill();
  process.exit(1);
}

function parseBody(text) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  const dataLine = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return JSON.parse(dataLine);
}

const child = spawn("node", [path.join(repo, "dist", "index.js"), "--http"], {
  cwd: repo,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "inherit", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
child.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`server exited early with code ${code}\n${stderr}`);
    process.exit(1);
  }
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(endpoint, { method: "GET" });
      return res.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail(`server did not start on port ${port}\n${stderr}`, child);
}

const readyStatus = await waitForServer();
console.log("server up, GET without session ->", readyStatus);
if (readyStatus !== 400) fail(`expected 400 for GET without session, got ${readyStatus}`, child);

const initRes = await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-test", version: "0.0.1" },
    },
  }),
});
if (initRes.status !== 200) fail(`initialize HTTP ${initRes.status}`, child);
const sessionId = initRes.headers.get("mcp-session-id");
if (!sessionId) fail("initialize response has no Mcp-Session-Id header", child);
const init = parseBody(await initRes.text());
if (init.result?.serverInfo?.name !== "clean-gmail-mcp") fail("initialize serverInfo", child);
console.log("initialize ok, session:", sessionId);

const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
const notifyRes = await fetch(endpoint, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
if (notifyRes.status !== 202) fail(`initialized notification HTTP ${notifyRes.status}`, child);
console.log("initialized notification -> 202");

const listRes = await fetch(endpoint, {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
if (listRes.status !== 200) fail(`tools/list HTTP ${listRes.status}`, child);
const listed = parseBody(await listRes.text());
const names = (listed.result?.tools ?? []).map((tool) => tool.name);
const expected = [
  "gmail_fetch_recent",
  "gmail_get_message",
  "gmail_archive",
  "gmail_mark_read",
  "gmail_star",
  "gmail_apply_label",
  "gmail_list_labels",
  "calendar_fetch_today",
  "slack_send_message",
];
const missing = expected.filter((name) => !names.includes(name));
if (missing.length > 0) fail(`missing tools: ${missing.join(", ")}`, child);
console.log("tools/list ok:", names.length, "tools");

const bogusRes = await fetch(endpoint, {
  method: "POST",
  headers: { ...headers, "mcp-session-id": "bogus-session" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
});
if (bogusRes.status !== 404) fail(`bogus session expected 404, got ${bogusRes.status}`, child);
console.log("bogus session -> 404");

const wrongPathRes = await fetch(`http://127.0.0.1:${port}/nope`, { method: "GET" });
if (wrongPathRes.status !== 404) fail(`wrong path expected 404, got ${wrongPathRes.status}`, child);
console.log("wrong path -> 404");

child.kill();
console.log("HTTP TEST PASSED");
process.exit(0);
