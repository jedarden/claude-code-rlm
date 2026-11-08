#!/usr/bin/env bash
# install.sh — installs the RLM hook into ~/.claude/hooks/
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
HOOK_DIR="${HOME}/.claude/hooks"
CACHE_DIR="${HOME}/.cache/rlm-hook"
LOG_DIR="${HOME}/.local/share/rlm-hook"

echo "Installing RLM hook..."

# Create directories
mkdir -p "${HOOK_DIR}/bench" "${CACHE_DIR}" "${LOG_DIR}"

# Copy hook files
cp "${SCRIPT_DIR}/rlm-hook.mjs" "${HOOK_DIR}/rlm-hook.mjs"
cp "${SCRIPT_DIR}/rlm-hook.sh"  "${HOOK_DIR}/rlm-hook.sh"
# Copy the local modules imported by the hook. Keeping this small runtime
# graph next to the entrypoint lets the installed hook run outside the repo.
cp "${SCRIPT_DIR}/rlm-config.mjs" "${HOOK_DIR}/rlm-config.mjs"
cp "${SCRIPT_DIR}/preresearch-schema.mjs" "${HOOK_DIR}/preresearch-schema.mjs"
cp "${SCRIPT_DIR}/rotating-log.mjs" "${HOOK_DIR}/rotating-log.mjs"
cp "${SCRIPT_DIR}/bench/parse-log.mjs" "${HOOK_DIR}/bench/parse-log.mjs"

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
  echo "To enable SDK mode, set RLM_USE_SDK=true and supply ANTHROPIC_API_KEY"
  echo "by reference: keep the key in a secret store (e.g. an OpenBao path like"
  echo "secret/<cluster>/claude-code-rlm/anthropic_api_key) or a mode-600 env"
  echo "file that the shell launching Claude Code sources. Do not paste the key"
  echo "into a command line, a shell rc file, or a settings.json env block."
  echo "See README.md, 'Supplying credentials', for recipes and verification."
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
echo "To disable preresearch temporarily without uninstalling, set RLM_ENABLED=false"
echo "(or RLM_DISABLED=true) in your environment."
echo "To uninstall, run: bash uninstall.sh"
