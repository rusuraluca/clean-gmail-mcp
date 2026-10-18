import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn("node", [path.join(repo, "dist", "index.js")], {
  cwd: repo,
  // Scrub credentials so the error-path assertions stay hermetic even with a configured .env.
  // dotenv does not override existing process env, so empty strings mask the file values.
  env: {
    ...process.env,
    SLACK_BOT_TOKEN: "",
    SLACK_DEFAULT_CHANNEL: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REFRESH_TOKEN: "",
    GOOGLE_TOKEN_FILE: path.join(repo, ".tokens", "no-such-token.json"),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("NON-JSON LINE:", line);
      process.exitCode = 1;
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

server.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`server exited early with code ${code}`);
    process.exit(1);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(payload);
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    server.kill();
    process.exit(1);
  }
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.1" },
});

assert(init.result?.serverInfo?.name === "gmini", "initialize returns serverInfo");
console.log("initialize ok:", init.result.serverInfo);

notify("notifications/initialized", {});

const listed = await request("tools/list", {});
const tools = listed.result?.tools ?? [];
const names = tools.map((t) => t.name);
console.log("tools count:", tools.length);

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
const missing = expected.filter((n) => !names.includes(n));
assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);

for (const t of tools) {
  console.log(" -", t.name, "| required:", JSON.stringify(t.inputSchema?.required ?? []));
}

const gmailCall = await request("tools/call", {
  name: "gmail_fetch_recent",
  arguments: { hours: 24 },
});
assert(gmailCall.result?.isError === true, "gmail tool without credentials returns isError");
console.log(
  "no-credentials gmail call -> isError:",
  gmailCall.result.isError,
  "| text:",
  JSON.stringify(gmailCall.result.content?.[0]?.text?.slice(0, 80)),
);

const calendarCall = await request("tools/call", {
  name: "calendar_fetch_today",
  arguments: {},
});
assert(calendarCall.result?.isError === true, "calendar tool without credentials returns isError");
console.log(
  "no-credentials calendar call -> isError:",
  calendarCall.result.isError,
  "| text:",
  JSON.stringify(calendarCall.result.content?.[0]?.text?.slice(0, 80)),
);

const slackCall = await request("tools/call", {
  name: "slack_send_message",
  arguments: { text: "hello" },
});
assert(slackCall.result?.isError === true, "slack tool without token returns isError");
console.log(
  "no-token slack call -> isError:",
  slackCall.result.isError,
  "| text:",
  JSON.stringify(slackCall.result.content?.[0]?.text?.slice(0, 80)),
);

server.kill();
console.log("SMOKE TEST PASSED");
process.exit(0);
