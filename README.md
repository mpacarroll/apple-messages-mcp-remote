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
| `get_chat_messages` | Get message history for a specific chat (with optional date range filtering). Voice messages are flagged with `is_audio_message` and carry `audio_transcript` once macOS has transcribed them |
| `search_messages` | Search messages by text content. Results carry the same voice-message fields |
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
| `MCP_PUBLIC_HOST` | yes, in `http` mode | The hostname your tunnel actually serves this on, for example `messages.your-tunnel.example`. Every request's `Host` header is checked against this and rejected with `421` on a mismatch: DNS-rebinding protection, implemented here rather than through the MCP SDK's `enableDnsRebindingProtection`, which is deprecated in favor of exactly this, a check in front of the transport. |
| `MCP_PORT` | no (default `8443`) | Port to listen on. |
| `MCP_HOST` | no (default `127.0.0.1`) | Bind address. Leave this on loopback and reach it through a tunnel (see below) rather than binding `0.0.0.0` and exposing a raw port. |

**Do not expose a raw open port on the public internet.** Put a private tunnel in front of this instead. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is what this project's sibling ([mcp-timeline](https://github.com/mpacarroll/mcp-timeline)) already runs, so it's the tested path.

**Before touching cloudflared, check what is already there:**

```bash
./deploy/diagnose-cloudflared.sh
```

It only reads (processes, launchd jobs, plist and config file contents) and changes nothing. This matters because `cloudflared service install` manages exactly one system service with one default config; running it again for this server does not add a second tunnel, it overwrites the registration of whichever tunnel already exists. If another tool on this Mac (mcp-timeline, for instance) already runs one, follow "Adding to an existing tunnel" below instead of "Fresh setup."

**Fresh setup**, if the script above found no existing tunnel:

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create apple-messages
cloudflared tunnel route dns apple-messages messages.your-domain.example
```

Then a config file, typically `~/.cloudflared/config.yml`:

```yaml
tunnel: apple-messages
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: messages.your-domain.example
    service: http://127.0.0.1:8443
  - service: http_status:404
```

```bash
cloudflared service install   # registers it as its own background service, survives reboot on its own
```

**Adding to an existing tunnel**, if the script found one already running: add one ingress entry to that tunnel's own config.yml, above its final `service: http_status:404` line, using this server's own hostname and port:

```yaml
  - hostname: messages.your-domain.example
    service: http://127.0.0.1:8443
```

Route DNS for the new hostname under that same tunnel (its name is the `tunnel:` key already in that file), then reload the service that owns it instead of reinstalling it:

```bash
cloudflared tunnel route dns <existing-tunnel-name> messages.your-domain.example
sudo launchctl kickstart -k system/com.cloudflare.cloudflared      # if it's a root-level LaunchDaemon
launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared    # if it's a user-level LaunchAgent
```

Either way, `MCP_PUBLIC_HOST` in your env file is that same `messages.your-domain.example`. [Tailscale](https://tailscale.com) works too if you'd rather keep this on a private network you control instead of a public hostname; either way, the port is never directly internet-routable, the bearer token is a second layer rather than your only layer, and you get to revoke access by removing a tunnel or device rather than by hoping nobody guessed the token.

**Connecting to Claude**, once the tunnel is up:

```json
{
  "mcpServers": {
    "apple-messages-remote": {
      "url": "https://messages.your-domain.example/",
      "headers": {
        "Authorization": "Bearer <your MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

For Claude Desktop, that goes in `claude_desktop_config.json` alongside the local example above. For claude.ai, add it under Settings → Connectors → Add custom connector, with the same URL and an `Authorization: Bearer <token>` header.

**What this does *not* do:** encrypt anything beyond what your tunnel provides, rate-limit requests, expire or rotate the token automatically, or provide per-tool permission scoping (a valid token can call every tool, including `send_message`). If any of that matters for your setup, treat this as a starting point, not a finished security product — patches welcome.

## Running it unattended (macOS)

Started from a terminal, the process dies when the window closes or the machine reboots. For a server other sessions expect to reach at any time, that's an outage you find out about the next time you ask it something.

`deploy/install-macos.sh` installs the HTTP server as a launchd user agent, so it starts at login and restarts if it crashes:

```bash
npm install && npm run build      # build/index.js has to exist first
./deploy/install-macos.sh --dry-run   # inspect the generated plist first
./deploy/install-macos.sh             # install and load it
```

The first run creates `deploy/apple-messages-mcp-remote.env` from `.env.example` with a freshly generated `MCP_AUTH_TOKEN`. Set `MCP_PUBLIC_HOST` in that file to your tunnel hostname before installing; without it the server rejects every tunneled request with `421 Invalid Host header`. The env file and the generated plist hold the token, so both are written owner-only, and the env file is gitignored.

```bash
launchctl list | grep apple-messages-mcp-remote   # status
tail -f ~/Library/Logs/apple-messages-mcp-remote/*.log   # logs
./deploy/install-macos.sh --uninstall             # remove the service
```

The tunnel itself is separate; `cloudflared service install` (above) already registers it as its own background service.

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
