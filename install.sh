#!/usr/bin/env bash
# QA Flow installer.
#
#   curl -fsSL https://raw.githubusercontent.com/OctopusRage/qa-flow/main/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --service       also run it as a login service (systemd on Linux, launchd on macOS)
#   --mcp           add the MCP server to Claude Code (user scope)
#   --no-start      do not start the server at the end
#   --dir <path>    install folder (default ~/.qa-flow, or $QA_FLOW_DIR)
#   --ref <branch>  git branch or tag (default main)
# Re-running the installer updates an existing install.
set -euo pipefail

REPO="${QA_FLOW_REPO:-https://github.com/OctopusRage/qa-flow.git}"
DIR="${QA_FLOW_DIR:-$HOME/.qa-flow}"
REF="main"
BIN_DIR="${QA_FLOW_BIN:-$HOME/.local/bin}"
SERVICE=0
MCP=0
START=1
PORT="${PORT:-4777}"

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE=1 ;;
    --mcp) MCP=1 ;;
    --no-start) START=0 ;;
    --dir) DIR="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    -h|--help) echo "Options: --service --mcp --no-start --dir <path> --ref <branch>"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B= G= Y= R= N=; fi
step() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die() { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

printf '\n%sQA Flow installer%s\n\n' "$B" "$N"

# ---- prerequisites ------------------------------------------------------------
step "Checking prerequisites"
command -v git >/dev/null || die "git is required"
command -v curl >/dev/null || die "curl is required"
command -v node >/dev/null || die "Node.js 22.13+ is required (https://nodejs.org, or: mise use -g node@lts)"
NODE_VERSION="$(node -p 'process.versions.node')"
# node:sqlite is built in (no flag) from Node 22.13.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js $NODE_VERSION is too old: 22.13 or newer is required"
ok "node $NODE_VERSION"

if ! command -v pnpm >/dev/null; then
  if command -v corepack >/dev/null; then
    warn "pnpm not found; enabling it through corepack"
    corepack enable pnpm 2>/dev/null || corepack enable --install-directory "$BIN_DIR" pnpm
    export PATH="$BIN_DIR:$PATH"
  fi
  command -v pnpm >/dev/null || die "pnpm is required: npm install -g pnpm"
fi
ok "pnpm $(pnpm --version)"

if command -v claude >/dev/null; then
  ok "claude CLI $(claude --version 2>/dev/null | head -1)"
else
  warn "claude CLI not found. AI generation needs a Claude login (or an Anthropic API key in Settings)."
  warn "Install it with: curl -fsSL https://claude.ai/install.sh | bash"
fi

# ---- code ---------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  step "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" checkout --quiet "$REF"
  git -C "$DIR" pull --quiet --ff-only origin "$REF"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not a qa-flow checkout (use --dir to pick another folder)"
else
  step "Cloning into $DIR"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi
ok "$(git -C "$DIR" log -1 --format='%h %s')"

cd "$DIR"
step "Installing dependencies"
pnpm install --frozen-lockfile --reporter=silent
ok "node modules"

step "Installing the Chromium browser for Playwright"
if ./node_modules/.bin/playwright install chromium >/dev/null 2>&1; then
  ok "chromium"
else
  warn "Playwright could not install Chromium. Try: cd $DIR && npx playwright install chromium"
fi
if node -e "require('@playwright/test').chromium.launch().then((b) => b.close()).catch(() => process.exit(1))" >/dev/null 2>&1; then
  ok "chromium launches"
else
  warn "Chromium does not launch; install its system libraries: sudo $DIR/node_modules/.bin/playwright install-deps chromium"
fi

step "Building the dashboard"
pnpm run --silent build >/dev/null
ok "dist/"

# ---- command --------------------------------------------------------------------
step "Installing the qa-flow command"
chmod +x "$DIR/bin/qa-flow"
mkdir -p "$BIN_DIR"
ln -sf "$DIR/bin/qa-flow" "$BIN_DIR/qa-flow"
ok "$BIN_DIR/qa-flow"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    case "${SHELL##*/}" in
      zsh) RC="$HOME/.zshrc" ;;
      bash) if [ "$(uname -s)" = "Darwin" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
      *) RC="$HOME/.profile" ;;
    esac
    if [ "${SHELL##*/}" = "fish" ]; then
      warn "$BIN_DIR is not on your PATH. Run: fish_add_path $BIN_DIR"
    else
      warn "$BIN_DIR is not on your PATH. Run: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $RC  then open a new terminal"
    fi
    ;;
esac

# ---- service (optional) ------------------------------------------------------------
if [ "$SERVICE" = 1 ]; then
  NODE_BIN="$(command -v node)"
  CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo "$BIN_DIR/claude")")"
  SVC_PATH="$(dirname "$NODE_BIN"):$CLAUDE_DIR:$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$DIR/data"
  # A background copy started by `qa-flow start` would hold the port.
  "$DIR/bin/qa-flow" stop >/dev/null 2>&1 || true

  if [ "$(uname -s)" = "Darwin" ]; then
    step "Installing the launchd agent"
    PLIST="$HOME/Library/LaunchAgents/com.qaflow.server.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.qaflow.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/node_modules/tsx/dist/cli.mjs</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl bootout "gui/$(id -u)/com.qaflow.server" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ok "com.qaflow.server loaded (starts at login)"
  else
    step "Installing the systemd user service"
    command -v systemctl >/dev/null || die "--service needs systemd (Linux) or launchd (macOS)"
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat >"$UNIT_DIR/qa-flow.service" <<UNIT_EOF
[Unit]
Description=QA Flow (local AI-to-Playwright test flows)
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/node_modules/tsx/dist/cli.mjs server/index.ts
Environment=PORT=$PORT
Environment=PATH=$SVC_PATH
Restart=on-failure
StandardOutput=append:$DIR/data/server.log
StandardError=append:$DIR/data/server.log

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now qa-flow >/dev/null 2>&1
    systemctl --user restart qa-flow
    ok "qa-flow.service enabled (starts with your session)"
  fi
  START=0
fi

# ---- start ------------------------------------------------------------------------
if [ "$START" = 1 ]; then
  step "Starting"
  if PORT="$PORT" "$DIR/bin/qa-flow" status >/dev/null 2>&1; then
    PORT="$PORT" "$DIR/bin/qa-flow" restart >/dev/null
  else
    PORT="$PORT" "$DIR/bin/qa-flow" start >/dev/null
  fi
  ok "running on http://127.0.0.1:$PORT"
elif [ "$SERVICE" = 1 ]; then
  for _ in $(seq 1 40); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/dashboard" 2>/dev/null && break; sleep 0.25; done
fi

if [ "$MCP" = 1 ]; then
  step "Adding the MCP server to Claude Code"
  if command -v claude >/dev/null; then
    PORT="$PORT" "$DIR/bin/qa-flow" mcp-install >/dev/null && ok "qa-flow → http://127.0.0.1:$PORT/mcp (user scope)"
  else
    warn "claude CLI not found; skipped"
  fi
fi

cat <<EOF

${G}${B}QA Flow is installed.${N}

  Dashboard   http://127.0.0.1:$PORT
  MCP         http://127.0.0.1:$PORT/mcp

  qa-flow open          open the dashboard
  qa-flow start|stop    run it in the background
  qa-flow update        update to the latest version
  qa-flow mcp-install   use it from Claude Code

Next: add your Slack token and shared login variables under Settings.
EOF
