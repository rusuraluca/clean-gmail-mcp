import http from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

type Session = { server: McpServer; transport: StreamableHTTPServerTransport };

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function plain(res: http.ServerResponse, status: number, text: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export async function startHttp(port: number): Promise<void> {
  const sessions = new Map<string, Session>();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      plain(res, 404, "Not found. The MCP endpoint is POST /mcp");
      return;
    }

    if (req.method === "POST") {
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        plain(res, 400, "Bad Request: body is not valid JSON");
        return;
      }

      const sessionId = header(req, "mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          plain(res, 404, "Session not found");
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        plain(res, 400, "Bad Request: No session ID");
        return;
      }

      let session!: Session;
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, session);
        },
      });
      session = { server: createServer(), transport };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await session.server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = header(req, "mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        plain(res, 400, "Bad Request: No session ID");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    plain(res, 405, "Method Not Allowed");
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("http request error:", err);
      plain(res, 500, "Internal Server Error");
    });
  });

  const host = process.env.HOST ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  console.error(`gmini ready (http) -> http://${host}:${port}/mcp`);
}
