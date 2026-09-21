#!/usr/bin/env bash
#
# Install the apple-messages-mcp-remote HTTP server as a macOS launchd user
# agent, so it starts at login, restarts if it crashes, and survives a
# reboot. Same pattern as mcp-timeline's deploy/install-macos.sh.
#
# Why this exists: run from a terminal, the process dies when the window
# closes or the machine restarts. For a Messages server reached from a
# cloud AI session, that is an outage you notice the next time you ask it
# something and get nothing back.
#
# Usage:
#   ./deploy/install-macos.sh              install or reinstall
#   ./deploy/install-macos.sh --uninstall  remove the service
#   ./deploy/install-macos.sh --dry-run    write the plist to
#                                          ./deploy/dry-run and load nothing
#                                          (works anywhere, including here)
#
# Configuration lives in deploy/apple-messages-mcp-remote.env, created on
# first run from .env.example with a freshly generated token. The token
# stays in that file and in the generated plist, both written owner-only.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/deploy/apple-messages-mcp-remote.env"
SAMPLE_ENV="$REPO_DIR/.env.example"
LOG_DIR="$HOME/Library/Logs/apple-messages-mcp-remote"

SERVER_LABEL="com.mpacarroll.apple-messages-mcp-remote"

MODE="install"
case "${1:-}" in
  --uninstall) MODE="uninstall" ;;
  --dry-run)   MODE="dry-run" ;;
  "")          ;;
  *)           echo "unknown option: $1" >&2; exit 2 ;;
esac

if [[ "$MODE" == "dry-run" ]]; then
  AGENTS_DIR="$REPO_DIR/deploy/dry-run"
else
  AGENTS_DIR="$HOME/Library/LaunchAgents"
fi

die() { echo "error: $*" >&2; exit 1; }

unload_agent() {
  [[ "$MODE" == "dry-run" ]] && return 0
  # bootout is the modern verb; fall back to unload on older systems.
  launchctl bootout "gui/$(id -u)/$SERVER_LABEL" 2>/dev/null \
    || launchctl unload "$AGENTS_DIR/$SERVER_LABEL.plist" 2>/dev/null \
    || true
}

if [[ "$MODE" == "uninstall" ]]; then
  unload_agent
  rm -f "$AGENTS_DIR/$SERVER_LABEL.plist"
  echo "removed $SERVER_LABEL"
  echo
  echo "The service is gone. $ENV_FILE was left alone."
  exit 0
fi

if [[ "$MODE" == "install" && "$(uname)" != "Darwin" ]]; then
  die "installing needs macOS (launchd), and Messages access needs macOS regardless. Use --dry-run to inspect the plist here."
fi

if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$SAMPLE_ENV" ]] || die "missing $SAMPLE_ENV"
  cp "$SAMPLE_ENV" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # Generate a real token up front rather than shipping a placeholder that
  # looks configured but protects nothing.
  tmp="$(mktemp)"
  sed "s|^MCP_AUTH_TOKEN=.*|MCP_AUTH_TOKEN=$(openssl rand -hex 32)|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "created $ENV_FILE with a freshly generated MCP_AUTH_TOKEN"
  echo "Set MCP_PUBLIC_HOST in it before running this again."
  echo
fi

# shellcheck source=/dev/null
set -a; source "$ENV_FILE"; set +a

NODE_BIN="${NODE_BIN:-$(command -v node)}"
ENTRY="$REPO_DIR/build/index.js"
MCP_PORT="${MCP_PORT:-8443}"
MCP_HOST="${MCP_HOST:-127.0.0.1}"

if [[ "$MODE" == "install" ]]; then
  [[ -n "$NODE_BIN" ]] || die "no node found on PATH. Install Node.js 22+ first."
  [[ -f "$ENTRY" ]] || die "no build at $ENTRY. Build first:
  npm install && npm run build"
fi
[[ -n "${MCP_AUTH_TOKEN:-}" ]] || die "MCP_AUTH_TOKEN is empty in $ENV_FILE"
if [[ ${#MCP_AUTH_TOKEN} -lt 32 ]]; then
  die "MCP_AUTH_TOKEN in $ENV_FILE is shorter than 32 characters. Generate a new one:
  openssl rand -hex 32"
fi
# The sample ships empty so the file documents itself, but an empty or
# still-example MCP_PUBLIC_HOST installs fine here and then fails much
# later, and much more confusingly, as a 421 from the server on every
# tunneled request. Catch it now instead.
if [[ -z "${MCP_PUBLIC_HOST:-}" || "$MCP_PUBLIC_HOST" == *example* ]]; then
  die "set MCP_PUBLIC_HOST in $ENV_FILE to your own tunnel hostname
(currently ${MCP_PUBLIC_HOST:-empty}). Without a real value the server
rejects every tunneled request with 421 Invalid Host header."
fi

mkdir -p "$AGENTS_DIR"
[[ "$MODE" == "dry-run" ]] || mkdir -p "$LOG_DIR"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

plist="$AGENTS_DIR/$SERVER_LABEL.plist"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
  echo '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0">'
  echo '<dict>'
  printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$SERVER_LABEL")"
  echo '  <key>ProgramArguments</key>'
  echo '  <array>'
  printf '    <string>%s</string>\n' "$(xml_escape "$NODE_BIN")"
  printf '    <string>%s</string>\n' "$(xml_escape "$ENTRY")"
  echo '  </array>'
  printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$REPO_DIR")"
  echo '  <key>RunAtLoad</key><true/>'
  echo '  <key>KeepAlive</key><true/>'
  printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$LOG_DIR/$SERVER_LABEL.log")"
  printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$LOG_DIR/$SERVER_LABEL.err")"
  echo '  <key>EnvironmentVariables</key>'
  echo '  <dict>'
  printf '    <key>MCP_TRANSPORT</key><string>http</string>\n'
  printf '    <key>MCP_AUTH_TOKEN</key><string>%s</string>\n' "$(xml_escape "$MCP_AUTH_TOKEN")"
  printf '    <key>MCP_PUBLIC_HOST</key><string>%s</string>\n' "$(xml_escape "$MCP_PUBLIC_HOST")"
  printf '    <key>MCP_PORT</key><string>%s</string>\n' "$(xml_escape "$MCP_PORT")"
  printf '    <key>MCP_HOST</key><string>%s</string>\n' "$(xml_escape "$MCP_HOST")"
  echo '  </dict>'
  echo '</dict>'
  echo '</plist>'
} > "$plist"

# Plists carry the bearer token, so keep them owner-only.
chmod 600 "$plist"
unload_agent

if [[ "$MODE" == "dry-run" ]]; then
  echo "wrote $plist"
  echo
  echo "Dry run: nothing was loaded. Inspect the plist above."
  exit 0
fi

# launchctl load returns 0 even when it prints "Load failed", so its exit
# status cannot be trusted. Ask launchctl afterwards whether the job is
# actually registered, rather than reporting a success we never checked.
launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
  || launchctl load "$plist" 2>/dev/null || true

echo
if launchctl list 2>/dev/null | grep -q "[[:space:]]$SERVER_LABEL\$"; then
  echo "loaded  $SERVER_LABEL"
else
  echo "FAILED to load $SERVER_LABEL (plist written to $plist)"
  echo "Most often something else is already bound to port $MCP_PORT, commonly a copy"
  echo "still running from a terminal. Check with:"
  echo "  lsof -i :$MCP_PORT"
  echo "and read $LOG_DIR/$SERVER_LABEL.err"
  exit 1
fi

echo
echo "  status:  launchctl list | grep apple-messages-mcp-remote"
echo "  logs:    tail -f $LOG_DIR/*.log"
echo "  remove:  ./deploy/install-macos.sh --uninstall"
echo
# Deliberately not echoing the token. Printing a secret to the terminal
# puts it in scrollback, and in any transcript pasted somewhere for help.
echo "Listening on http://$MCP_HOST:$MCP_PORT, expecting to be reached"
echo "through a tunnel serving $MCP_PUBLIC_HOST. Point that tunnel here."
echo
echo "Bearer token is in $ENV_FILE and is not printed here. Read it when"
echo "you need it, for example when configuring the client side:"
echo "  grep '^MCP_AUTH_TOKEN=' $ENV_FILE | cut -d= -f2"
echo
echo "Full Disk Access must be granted to node (or your terminal, if it"
echo "inherits the grant) for this to actually read Messages. If the log"
echo "shows empty results instead of an error, that's usually why:"
echo "  System Settings > Privacy & Security > Full Disk Access"
