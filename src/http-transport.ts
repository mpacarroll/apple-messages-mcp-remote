import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./server.js";

/**
 * Remote (HTTP) entrypoint for the Apple Messages MCP server.
 *
 * Security model, deliberately simple:
 * - A single bearer token, set via MCP_AUTH_TOKEN, gates every request.
 *   There is no per-user auth because this server only ever has one thing
 *   to say yes or no to: "is this the one person who owns this Mac's
 *   Messages database." OAuth buys nothing here — see the project README.
 * - The token is compared with a constant-time check to avoid timing
 *   side-channels, and never logged.
 * - The request's Host header must match MCP_PUBLIC_HOST, the hostname
 *   the tunnel actually serves this on. This is DNS-rebinding protection:
 *   the MCP SDK's own built-in version of this check is deprecated in
 *   favor of doing it in front of the transport, which is what this does.
 *   A mismatch returns 421, before the auth check runs.
 * - This process is meant to sit behind a private tunnel (Tailscale,
 *   Cloudflare Tunnel, etc.), not a raw open port on the public internet.
 *   The token is your only line of defense if that assumption doesn't
 *   hold, so treat it like a password: long, random, never committed.
 *
 * One MCP session (StreamableHTTPServerTransport) is created per
 * connecting client and torn down when the client disconnects, so
 * multiple callers can hold independent sessions concurrently.
 */

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function invalidHost(res: ServerResponse) {
  res.writeHead(421, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "invalid host header" }));
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);

  const presentedBuf = Buffer.from(presented);
  const tokenBuf = Buffer.from(token);
  if (presentedBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(presentedBuf, tokenBuf);
}

// Strips a port suffix before comparing, so MCP_PUBLIC_HOST can be set to
// just the hostname (the common case, and what the tunnel's TLS cert
// covers) while still matching a Host header that includes ":443" or a
// non-standard port some clients send explicitly.
export function isAllowedHost(req: IncomingMessage, publicHost: string): boolean {
  const header = req.headers["host"];
  if (typeof header !== "string") return false;
  const presentedHost = header.split(":")[0].toLowerCase();
  return presentedHost === publicHost.toLowerCase();
}

export function startHttpServer() {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.length < 32) {
    console.error(
      "MCP_AUTH_TOKEN must be set to a random string of at least 32 characters. " +
        "Generate one with: openssl rand -hex 32"
    );
    process.exit(1);
  }

  const publicHost = process.env.MCP_PUBLIC_HOST;
  if (!publicHost) {
    console.error(
      "MCP_PUBLIC_HOST must be set in http mode: the hostname your tunnel " +
        "serves this on (for example messages.your-tunnel.example). Without " +
        "it there is nothing to check the Host header against, and every " +
        "tunneled request would be rejected with 421 anyway once a real " +
        "tunnel is in front of this."
    );
    process.exit(1);
  }

  const port = Number(process.env.MCP_PORT ?? 8443);
  const host = process.env.MCP_HOST ?? "127.0.0.1";

  // sessionId -> transport, so repeat requests from the same client reuse
  // the same MCP session instead of starting a new one every call.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    if (!isAllowedHost(req, publicHost)) {
      invalidHost(res);
      return;
    }

    if (!isAuthorized(req, token)) {
      unauthorized(res);
      return;
    }

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) sessions.delete(transport!.sessionId);
      };
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res);
  });

  httpServer.listen(port, host, () => {
    console.error(`Apple Messages MCP server (remote) listening on http://${host}:${port}`);
    console.error(`Expecting requests behind a private tunnel serving ${publicHost}, not a public IP. See README.`);
  });
}
