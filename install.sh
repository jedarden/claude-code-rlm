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
            "timeout": 30
          }
        ]
      }
    ]
  }
}

EOF

echo "RLM hook installed successfully"
