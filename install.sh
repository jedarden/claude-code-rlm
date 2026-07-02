#!/usr/bin/env bash
# install.sh — installs the RLM hook into ~/.claude/hooks/
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
HOOK_DIR="${HOME}/.claude/hooks"
CACHE_DIR="${HOME}/.cache/rlm-hook"
LOG_DIR="${HOME}/.local/share/rlm-hook"

echo "Installing RLM hook..."

# Create directories
mkdir -p "${HOOK_DIR}" "${CACHE_DIR}" "${LOG_DIR}"

# Copy hook files
cp "${SCRIPT_DIR}/rlm-hook.mjs" "${HOOK_DIR}/rlm-hook.mjs"
cp "${SCRIPT_DIR}/rlm-hook.sh"  "${HOOK_DIR}/rlm-hook.sh"

# Make executable
chmod +x "${HOOK_DIR}/rlm-hook.mjs"
chmod +x "${HOOK_DIR}/rlm-hook.sh"

echo "Installed to ${HOOK_DIR}/"

# Check for claude CLI
if ! command -v claude &>/dev/null; then
  echo "WARNING: 'claude' CLI not found in PATH. The hook requires Claude Code CLI to be installed."
  echo "  Install via: npm install -g @anthropic-ai/claude-code"
fi

# Prompt for SDK mode installation
echo ""
echo "SDK-Direct mode (optional):"
echo "  The hook can call the Anthropic API directly (~800ms latency) instead of"
echo "  spawning the claude CLI subprocess (~4s latency). This requires the"
echo "  @anthropic-ai/sdk package and an ANTHROPIC_API_KEY."
echo ""
read -p "Install SDK dependencies for SDK-Direct mode? [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Installing @anthropic-ai/sdk next to the hook..."
  npm install --prefix "${HOOK_DIR}" @anthropic-ai/sdk
  echo "SDK dependencies installed to ${HOOK_DIR}/node_modules/"
  echo ""
  echo "To enable SDK mode, set in your environment or ~/.claude/settings.json:"
  echo "  RLM_USE_SDK=true"
  echo "  ANTHROPIC_API_KEY=sk-ant-..."
  echo ""
else
  echo "Skipping SDK dependencies. The hook will use subprocess mode (default)."
  echo "You can install SDK dependencies later by running:"
  echo "  npm install --prefix ~/.claude/hooks @anthropic-ai/sdk"
  echo ""
fi

# Print settings.json snippet
cat <<'EOF'

Add the following to ~/.claude/settings.json to activate the hook:

{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/rlm-hook.mjs",
            "timeout": 90
          }
        ]
      }
    ]
  }
}

EOF

echo "RLM hook installed successfully"
