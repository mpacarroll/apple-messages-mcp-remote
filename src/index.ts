#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttpServer } from "./http-transport.js";

/**
 * Transport is stdio by default — that keeps this a drop-in replacement
 * for the original @griches/apple-messages-mcp for anyone using it
 * locally. Set MCP_TRANSPORT=http to run the remote-capable server
 * instead (see README for the tunnel + auth setup that makes that safe
 * to expose).
 */
async function main() {
  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

  if (transportMode === "http") {
    startHttpServer();
    return;
  }

  if (transportMode !== "stdio") {
    console.error(`Unknown MCP_TRANSPORT "${transportMode}", expected "stdio" or "http".`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Messages MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
