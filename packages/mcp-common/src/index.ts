import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface RunOptions {
  http: boolean;
  port: number;
  host: string;
}

export function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { http: false, port: 3737, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") opts.http = true;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return opts;
}

/** stderr only: stdout is the protocol channel in stdio mode. */
export function log(...args: unknown[]): void {
  console.error("[mcp]", ...args);
}

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Run a server over stdio (default) or Streamable HTTP.
 * `makeServer` is called once for stdio and once per HTTP session, so each
 * session gets its own McpServer instance (the SDK binds one transport per server).
 */
export async function run(makeServer: () => McpServer, opts: RunOptions): Promise<void> {
  if (!opts.http) {
    await makeServer().connect(new StdioServerTransport());
    log("listening on stdio");
    return;
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end("Not found");
        return;
      }
      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      const body = req.method === "POST" ? await readBody(req) : undefined;

      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        const isInit =
          req.method === "POST" &&
          body !== undefined &&
          (Array.isArray(body) ? body : [body]).some((m) => (m as { method?: string })?.method === "initialize");
        if (!isInit) {
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: missing or unknown session" },
              id: null,
            }),
          );
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await makeServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("http error", e);
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`listening on http://${opts.host}:${port}/mcp`);
}
