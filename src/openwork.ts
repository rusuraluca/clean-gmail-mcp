import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { getOpenworkGatewayUrl, getOpenworkOAuthPort, resolveOpenworkTokenFile } from "./config.js";

const execFileAsync = promisify(execFile);

interface StoredState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
  state?: string;
}

class OpenworkOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private readonly redirectUrlValue: string | URL;
  private stateValue?: string;
  private codeVerifierValue?: string;
  private authServer?: HttpServer;
  private codeDeferred?: { resolve: (code: string) => void; reject: (err: Error) => void };
  private codePromise?: Promise<string>;

  constructor(redirectPort: number) {
    this.file = resolveOpenworkTokenFile();
    this.redirectUrlValue = `http://127.0.0.1:${redirectPort}/callback`;
  }

  get redirectUrl(): string | URL {
    return this.redirectUrlValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "gmini-slack-bridge",
      redirect_uris: [String(this.redirectUrlValue)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const data = this.read();
    data.client = clientInformation;
    this.write(data);
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = this.read();
    data.tokens = tokens;
    this.write(data);
  }

  async state(): Promise<string> {
    this.stateValue = randomUUID();
    const data = this.read();
    data.state = this.stateValue;
    this.write(data);
    return this.stateValue;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
    const data = this.read();
    data.codeVerifier = codeVerifier;
    this.write(data);
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.codeVerifierValue ?? this.read().codeVerifier;
    if (!verifier) throw new Error("Missing OpenWork PKCE code verifier");
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const data = this.read();
    data.discovery = state;
    this.write(data);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.read().discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const data = this.read();
    if (scope === "all" || scope === "tokens") delete data.tokens;
    if (scope === "all" || scope === "client") delete data.client;
    if (scope === "all" || scope === "verifier") delete data.codeVerifier;
    if (scope === "all" || scope === "discovery") delete data.discovery;
    this.write(data);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.codeDeferred = { resolve, reject };
      setTimeout(() => reject(new Error("OpenWork sign-in timed out after 5 minutes")), 5 * 60 * 1000).unref();
    });
    await this.startCallbackServer();
    console.error(`openwork sign-in: opening ${authorizationUrl.origin} in your browser`);
    await openBrowser(authorizationUrl);
  }

  waitForCode(): Promise<string> {
    if (!this.codePromise) {
      return Promise.reject(new Error("OpenWork sign-in was not started"));
    }
    return this.codePromise;
  }

  private async startCallbackServer(): Promise<void> {
    if (this.authServer) return;
    const url = new URL(String(this.redirectUrlValue));
    const port = Number(url.port);
    this.authServer = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      const expectedState = this.read().state;
      res.writeHead(200, { "Content-Type": "text/html" });
      if (!code) {
        res.end("<h1>Sign-in failed: no code in redirect.</h1>");
        this.codeDeferred?.reject(new Error("OpenWork sign-in redirect had no code"));
        return;
      }
      if (expectedState && state !== expectedState) {
        res.end("<h1>Sign-in failed: state mismatch.</h1>");
        this.codeDeferred?.reject(new Error("OpenWork sign-in state mismatch"));
        return;
      }
      res.end("<h1>Signed in. You can close this tab and return to the terminal.</h1>");
      this.codeDeferred?.resolve(code);
    });
    await new Promise<void>((resolve, reject) => {
      this.authServer!.once("error", reject);
      this.authServer!.listen(port, "127.0.0.1", resolve);
    });
  }

  private read(): StoredState {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as StoredState;
    } catch {
      return {};
    }
  }

  private write(data: StoredState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2) + "\n");
    chmodSync(this.file, 0o600);
  }
}

export interface CloudSessionResult {
  status: "idle" | "error" | "waiting" | "timeout";
  text: string;
  sessionId?: string;
}

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 45;

export class OpenworkBridge {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private executeToolName?: string;

  async connect(): Promise<void> {
    const provider = new OpenworkOAuthProvider(getOpenworkOAuthPort());
    const url = new URL(getOpenworkGatewayUrl());
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const client = new Client({ name: "gmini-slack-bridge", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const code = await provider.waitForCode();
      await transport.finishAuth(code);
      await client.connect(transport);
    }
    const tools = await client.listTools();
    const executeTool = tools.tools.find((tool) => tool.name.includes("execute"));
    if (!executeTool) {
      throw new Error("OpenWork gateway does not advertise an execute capability tool");
    }
    this.client = client;
    this.transport = transport;
    this.executeToolName = executeTool.name;
    console.error(`openwork gateway connected (${this.executeToolName})`);
  }

  async askCloud(prompt: string, title: string): Promise<CloudSessionResult> {
    const created = await this.execute("remote-session:create", { target: "cloud", title, prompt });
    const parsedCreate = parseGatewayResult(created);
    const sessionId = findStringField(parsedCreate, "sessionId");
    if (!sessionId) {
      return { status: "error", text: `OpenWork did not return a session id: ${summarize(parsedCreate)}` };
    }
    const retryAfterMs = findNumberField(parsedCreate, "retryAfterMs");
    if (retryAfterMs) await sleep(retryAfterMs);

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const read = await this.execute("remote-session:read", { sessionId });
      const parsedRead = parseGatewayResult(read);
      const session = findSessionBlock(parsedRead);
      if (!session) continue;
      const status = findStringField(session, "status");
      if (status === "idle") {
        return { status: "idle", text: findStringField(session, "finalText") ?? "", sessionId };
      }
      if (status === "error") {
        return {
          status: "error",
          text: findStringField(session, "lastError") ?? "OpenWork session failed.",
          sessionId,
        };
      }
      if (status === "waiting") {
        return {
          status: "waiting",
          text: "The OpenWork session is waiting for approval. Finish it in OpenWork Web, then ask again.",
          sessionId,
        };
      }
    }
    return {
      status: "timeout",
      text: `Still running in OpenWork Web (session ${sessionId}). It will finish there; ask again later for the answer.`,
      sessionId,
    };
  }

  private async execute(name: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.client || !this.executeToolName) throw new Error("OpenWork gateway is not connected");
    const result = await this.client.callTool({ name: this.executeToolName, arguments: { name, body } });
    if (result.isError) {
      throw new Error(`OpenWork ${name} failed: ${summarize(result)}`);
    }
    return result;
  }
}

function parseGatewayResult(result: unknown): Record<string, unknown> {
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  if (structured && typeof structured === "object") return structured as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("\n")
      .trim();
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { text };
      }
    }
    return { text };
  }
  return record;
}

function findSessionBlock(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionBlock(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (typeof status === "string" && ["idle", "error", "waiting", "running", "pending"].includes(status)) {
    return record;
  }
  for (const key of ["session", "result", "data", "transcript"]) {
    const found = findSessionBlock(record[key]);
    if (found) return found;
  }
  return undefined;
}

function findStringField(value: unknown, field: string, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, field, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record[field];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const key of ["session", "result", "data"]) {
    const found = findStringField(record[key], field, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findNumberField(value: unknown, field: string, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record[field];
  if (typeof direct === "number") return direct;
  for (const key of ["session", "result", "data"]) {
    const found = findNumberField(record[key], field, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function summarize(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function openBrowser(url: URL): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    await execFileAsync(command, [url.toString()]);
  } catch {
    console.error(`open this URL manually: ${url}`);
  }
}
