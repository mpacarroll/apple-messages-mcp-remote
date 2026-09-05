# apple-messages-mcp-remote

A fork of [@griches/apple-messages-mcp](https://github.com/griches/apple-mcp/tree/main/messages) that adds an optional remote (HTTP) transport, for running this server on an always-on Mac and reaching it from a cloud AI session instead of only a session running locally on the same machine. Local stdio mode is unchanged and remains the default — this is purely additive.

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants access to Apple Messages on macOS. Reads messages from the Messages database (SQLite) and sends messages via AppleScript.

## Quick Start (local, stdio — same as upstream)

```bash
npx apple-messages-mcp-remote
```

## Quick Start (remote, HTTP)

Only do this if you understand what you're exposing: this gives whoever holds the token read access to your real iMessage history, and send access to your Messages app. See [Remote setup](#remote-setup) below before running this on a machine reachable from outside your own network.

```bash
export MCP_TRANSPORT=http
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)   # save this, you'll need it on the client side
npx apple-messages-mcp-remote
```

## Tools

| Tool | Description |
|------|-------------|
| `list_chats` | List recent chats with last message preview |
| `get_chat_messages` | Get message history for a specific chat (with optional date range filtering) |
| `search_messages` | Search messages by text content |
| `send_message` | Send an iMessage or SMS |
| `get_chat_participants` | Get participants of a chat |

## Configuration

### Claude Code

```bash
claude mcp add apple-messages -- npx apple-messages-mcp-remote
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-messages": {
      "command": "npx",
      "args": ["apple-messages-mcp-remote"]
    }
  }
}
```

## Remote setup

This adds an HTTP transport (Streamable HTTP, the current MCP spec's remote transport) alongside the original stdio one. Stdio is still the default — you only get the HTTP server if you set `MCP_TRANSPORT=http`.

**Threat model this was actually designed for:** one person, one Mac, one client at a time, connecting from that same person's own cloud AI session. It is *not* designed to be a multi-tenant hosted service — every deployment only ever has one real Messages database behind it, so there's no "different users, different permissions" problem to solve, which is why this uses a single bearer token instead of OAuth. If you want to offer this to other people against their own Macs, each of them runs their own instance with their own token; you're not meant to run one instance for many people.

**Environment variables:**

| Variable | Required | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | no (default `stdio`) | Set to `http` to enable the remote server. |
| `MCP_AUTH_TOKEN` | yes, in `http` mode | Bearer token every request must present. Generate with `openssl rand -hex 32`. Must be at least 32 characters — the server refuses to start otherwise. Never commit this. |
| `MCP_PORT` | no (default `8443`) | Port to listen on. |
| `MCP_HOST` | no (default `127.0.0.1`) | Bind address. Leave this on loopback and reach it through a tunnel (see below) rather than binding `0.0.0.0` and exposing a raw port. |

**Do not expose a raw open port on the public internet.** Put a private tunnel in front of this instead — [Tailscale](https://tailscale.com) or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) both work well and mean the port is never directly internet-routable, the bearer token is a second layer rather than your only layer, and you get to revoke access by removing a device/tunnel rather than by hoping nobody guessed the token.

**Connecting a client**, once the tunnel is up:

```json
{
  "mcpServers": {
    "apple-messages-remote": {
      "url": "https://your-tunnel-hostname/",
      "headers": {
        "Authorization": "Bearer <your MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

**What this does *not* do:** encrypt anything beyond what your tunnel provides, rate-limit requests, expire or rotate the token automatically, or provide per-tool permission scoping (a valid token can call every tool, including `send_message`). If any of that matters for your setup, treat this as a starting point, not a finished security product — patches welcome.

## Requirements

- **macOS** (uses AppleScript and macOS Messages database)
- **Node.js** 22+ (uses built-in `node:sqlite`)
- **Full Disk Access** granted to your terminal app (System Settings > Privacy & Security > Full Disk Access) — required for reading the Messages database

## Permissions

- **Reading messages**: Requires Full Disk Access for your terminal app to read `~/Library/Messages/chat.db`
- **Sending messages**: macOS will prompt you to allow your terminal app to control the Messages app via AppleScript

## Credit

The stdio server, database reader, and AppleScript send logic are almost entirely the original work of [@griches/apple-messages-mcp](https://github.com/griches/apple-mcp/tree/main/messages) — this fork's own contribution is the remote HTTP transport and the auth/tunnel setup around it.

## License

MIT.
