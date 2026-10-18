import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { google } from "googleapis";
import { resolveGoogleTokenFile } from "../config.js";
import { GOOGLE_SCOPES } from "../google-auth.js";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n" +
      "Copy .env.example to .env, fill in your Google Cloud OAuth Desktop client,\n" +
      "then run this script again:  npm run auth:google",
  );
  process.exit(1);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") execFile("open", [url], () => undefined);
  else if (platform === "win32") execFile("cmd", ["/c", "start", "", url], () => undefined);
  else execFile("xdg-open", [url], () => undefined);
}

const server = http.createServer();

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const port = (server.address() as AddressInfo).port;
const redirectUri = `http://127.0.0.1:${port}`;
const state = crypto.randomBytes(16).toString("hex");

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: GOOGLE_SCOPES,
  state,
});

console.error("\nAuthorize Google access (Gmail + Calendar) in your browser:\n");
console.error(`  ${authUrl}\n`);
console.error("Waiting for the redirect (this local server exits after one callback)...\n");
openBrowser(authUrl);

const timeout = setTimeout(() => {
  console.error("Timed out after 5 minutes waiting for the Google consent redirect.");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);

const finish = (html: string, error?: string) => {
  clearTimeout(timeout);
  server.close();
  if (error) {
    console.error(`\nAuthorization failed: ${error}`);
    process.exit(1);
  }
  process.stdout.write(html);
  process.exit(0);
};

server.on("request", (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/") {
    res.writeHead(404).end("Not found");
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Access denied</h1><p>You can close this tab.</p>");
    finish("<h1>Access denied</h1>", error);
    return;
  }

  if (!code || returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/html" }).end("<h1>Invalid callback</h1>");
    finish("", "Missing code or state mismatch in the OAuth redirect.");
    return;
  }

  void (async () => {
    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        res.writeHead(500, { "Content-Type": "text/html" }).end("<h1>No refresh token</h1>");
        throw new Error(
          "Google did not return a refresh_token. Re-run this script (the consent screen uses prompt=consent, " +
            "so a fresh token should be issued).",
        );
      }

      const tokenFile = resolveGoogleTokenFile();
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(
        tokenFile,
        `${JSON.stringify(
          {
            refresh_token: tokens.refresh_token,
            client_id: clientId,
            scope: GOOGLE_SCOPES.join(" "),
            obtained_at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<h1>Gmail authorized</h1><p>You can close this tab and return to the terminal.</p>");

      console.error(`Refresh token saved to: ${tokenFile}`);
      console.error("Next: npm run build && npm start (or point OpenWork at this server).");
      finish("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .writeHead(500, { "Content-Type": "text/html" })
        .end("<h1>Token exchange failed</h1><p>Check the terminal for details.</p>");
      finish("", message);
    }
  })();
});
