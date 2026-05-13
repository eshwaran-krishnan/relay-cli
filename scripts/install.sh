#!/usr/bin/env sh
# relay-cli installer — downloads the prebuilt dist/index.js from GitHub
# and drops it at ~/.relay/bin/relay (or $RELAY_INSTALL_DIR).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/eshwaran-krishnan/relay-cli/main/scripts/install.sh | sh
#   curl -fsSL https://relaymesh.io/install | sh                # (once /install is wired on the hub)
#
# Requires: Node ≥ 18 on PATH, plus curl or wget.

set -e

REPO="eshwaran-krishnan/relay-cli"
REF="${RELAY_INSTALL_REF:-main}"
SRC_URL="https://raw.githubusercontent.com/${REPO}/${REF}/dist/index.js"
INSTALL_DIR="${RELAY_INSTALL_DIR:-$HOME/.relay/bin}"
INSTALL_PATH="$INSTALL_DIR/relay"

red()    { printf '\033[31m%s\033[0m\n' "$1" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$1"; }
gray()   { printf '\033[90m%s\033[0m\n' "$1"; }

# --- preflight -------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  red "Error: 'node' not found on PATH."
  red "       Relay's CLI is a Node binary; install Node ≥ 18 first:"
  red "         https://nodejs.org/  •  brew install node  •  fnm/nvm/volta"
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo "0")"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  red "Error: Node ≥ 18 required (found $(node --version 2>/dev/null || echo unknown))."
  exit 1
fi

# Pick a downloader.
if command -v curl >/dev/null 2>&1; then
  DL_CMD="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  DL_CMD="wget -qO-"
else
  red "Error: neither curl nor wget found. Install one and retry."
  exit 1
fi

# --- install ---------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

gray "Downloading $SRC_URL"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
$DL_CMD "$SRC_URL" > "$TMP"

# Sanity check — the file should start with the shebang.
if ! head -1 "$TMP" | grep -q "^#!/usr/bin/env node$"; then
  red "Error: downloaded artifact doesn't look like the relay CLI."
  red "       (expected first line: #!/usr/bin/env node)"
  red "       Got:"
  head -3 "$TMP" | sed 's/^/         /' >&2
  exit 1
fi

mv "$TMP" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"
trap - EXIT

green "✓ Installed relay → $INSTALL_PATH"

# --- PATH hint -------------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    echo
    echo "Add $INSTALL_DIR to your PATH:"
    echo
    echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc"
    echo "  source ~/.zshrc"
    echo
    ;;
esac

echo
echo "Try:"
echo "  relay --version"
echo "  relay login"
