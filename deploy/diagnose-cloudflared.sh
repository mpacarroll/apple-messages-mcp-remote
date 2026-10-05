#!/usr/bin/env bash
#
# Read-only diagnosis of whatever cloudflared setup already exists on this
# Mac, before wiring this server's HTTP transport into a tunnel.
#
# Why this exists: this repo's sibling, mcp-timeline, may already run a
# cloudflared tunnel on this same machine. `cloudflared service install`
# manages exactly one system LaunchDaemon with one default config, so
# running it again for this server does not add a second tunnel, it
# overwrites the first one's service registration. The fix in almost every
# case is to add an ingress rule to the tunnel that is already running
# rather than installing a second one. This script only looks; it changes
# nothing. Read its output before touching any cloudflared config.
#
# Usage:
#   ./deploy/diagnose-cloudflared.sh
#
# Safe to run on any OS: on Linux (or a Mac with no cloudflared at all) it
# reports that nothing was found, rather than erroring out.

set -uo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/apple-messages-mcp-remote.env"

section() { printf '\n== %s ==\n' "$1"; }

section "This server's expected public host"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
  if [[ -n "${MCP_PUBLIC_HOST:-}" ]]; then
    echo "MCP_PUBLIC_HOST=$MCP_PUBLIC_HOST (from $ENV_FILE)"
  else
    echo "MCP_PUBLIC_HOST is not set in $ENV_FILE yet."
  fi
  echo "MCP_PORT=${MCP_PORT:-8443} (default shown if unset)"
else
  echo "$ENV_FILE does not exist yet (run deploy/install-macos.sh first). Showing general cloudflared state only."
fi

section "cloudflared binary"
if command -v cloudflared >/dev/null 2>&1; then
  echo "found: $(command -v cloudflared)"
  cloudflared --version 2>&1 || true
else
  echo "not found on PATH. Nothing below will apply until 'brew install cloudflared'."
fi

section "running processes"
# The [c] trick keeps grep from matching itself; excluding this script's own
# name keeps it from matching its own invocation too (both contain "cloudflared").
ps aux 2>/dev/null | grep -i '[c]loudflared' | grep -v diagnose-cloudflared.sh \
  || echo "no cloudflared process running"

section "user-level launchd jobs (gui/\$(id -u))"
launchctl list 2>/dev/null | grep -i cloudflare || echo "none registered at the user level"

section "root-level launchd jobs (system/) — may prompt for your password"
if command -v sudo >/dev/null 2>&1; then
  sudo -n true 2>/dev/null
  if [[ $? -eq 0 ]]; then
    sudo launchctl list 2>/dev/null | grep -i cloudflare || echo "none registered at the root level"
  else
    echo "skipped: sudo needs a password here. Run this yourself and compare:"
    echo "  sudo launchctl list | grep -i cloudflare"
  fi
else
  echo "no sudo on this system"
fi

section "LaunchDaemon and LaunchAgent plists on disk"
for f in /Library/LaunchDaemons/*cloudflare*.plist "$HOME/Library/LaunchAgents"/*cloudflare*.plist; do
  if [[ -f "$f" ]]; then
    echo "--- $f ---"
    /usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$f" 2>/dev/null \
      || grep -A6 'ProgramArguments' "$f" 2>/dev/null \
      || echo "(could not read contents)"
  fi
done
shopt -s nullglob 2>/dev/null
found_plist=0
for f in /Library/LaunchDaemons/*cloudflare*.plist "$HOME/Library/LaunchAgents"/*cloudflare*.plist; do
  [[ -f "$f" ]] && found_plist=1
done
[[ "$found_plist" -eq 0 ]] && echo "no cloudflared plist found in either location"

section "config files (ingress rules only, nothing else printed)"
found_config=0
for f in /etc/cloudflared/config.yml "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared"/*.yml; do
  if [[ -f "$f" ]]; then
    found_config=1
    echo "--- $f ---"
    grep -E 'tunnel:|hostname:|service:' "$f" 2>/dev/null || echo "(no ingress lines matched; check the file by hand)"
  fi
done
[[ "$found_config" -eq 0 ]] && echo "no cloudflared config.yml found in /etc/cloudflared or ~/.cloudflared"

section "tunnels registered to your cloudflared account"
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared tunnel list 2>&1 || echo "(failed; probably not logged in yet: cloudflared tunnel login)"
else
  echo "skipped, cloudflared not installed"
fi

cat <<'EOF'

== Reading this ==

- A root-level (system/) job plus a plist under /Library/LaunchDaemons is
  almost certainly mcp-timeline's tunnel, kept alive without anyone logged
  in. A user-level (gui/) job is the other, more fragile pattern.
- If a config.yml already exists and already runs a tunnel: do not run
  `cloudflared service install` again, and do not create a second tunnel.
  Add one ingress entry to that same config.yml, above the final
  `http_status:404` line:
    - hostname: <your MCP_PUBLIC_HOST>
      service: http://127.0.0.1:<your MCP_PORT>
  then add the DNS route for the new hostname under the SAME tunnel name
  already in that file's `tunnel:` key:
    cloudflared tunnel route dns <existing-tunnel-name> <your MCP_PUBLIC_HOST>
  and reload whichever service owns it instead of reinstalling it:
    sudo launchctl kickstart -k system/com.cloudflare.cloudflared      # root job
    launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared    # user job
- If nothing above was found at all, there is no existing tunnel to
  collide with. Follow the README's "Remote setup" section as written,
  with its own tunnel name (for example `apple-messages`, not a name
  mcp-timeline already owns).
EOF
