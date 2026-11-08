#!/usr/bin/env bash
# uninstall.sh — removes the RLM hook installed by install.sh
#
# Removes:
#   - the hook runtime files install.sh copied into ~/.claude/hooks/
#   - SDK dependencies installed into ~/.claude/hooks/ — but only when that
#     package.json was created by install.sh, i.e. it declares nothing but
#     @anthropic-ai/sdk
#   - the UserPromptSubmit registration referencing rlm-hook from
#     ~/.claude/settings.json (unrelated hooks and settings are preserved)
#   - the hook's cache (~/.cache/rlm-hook) and logs (~/.local/share/rlm-hook)
#
# Never touches other files in ~/.claude/hooks/ or unrelated settings.json
# content, and leaves a malformed settings.json untouched rather than
# destroying it. Safe to run repeatedly and when nothing is installed.
#
# To turn preresearch off temporarily without uninstalling, set
# RLM_ENABLED=false (or RLM_DISABLED=true) in your environment — the hook
# then exits immediately without exploring, caching, or calling Haiku.
set -euo pipefail

HOOK_DIR="${HOME}/.claude/hooks"
SETTINGS_FILE="${HOME}/.claude/settings.json"
CACHE_DIR="${HOME}/.cache/rlm-hook"
LOG_DIR="${HOME}/.local/share/rlm-hook"

# Exactly the runtime graph install.sh copies. Nothing else in HOOK_DIR is
# deleted — the hooks directory is shared with other tools' hooks.
HOOK_FILES=(
  rlm-hook.mjs
  rlm-hook.sh
  rlm-config.mjs
  preresearch-schema.mjs
  rotating-log.mjs
  bench/parse-log.mjs
)

echo "Uninstalling RLM hook..."

for file in "${HOOK_FILES[@]}"; do
  if [ -e "${HOOK_DIR}/${file}" ]; then
    rm -f "${HOOK_DIR}/${file}"
    echo "  removed ${HOOK_DIR}/${file}"
  fi
done

# bench/ exists only to hold parse-log.mjs; drop it (and the hooks directory
# itself) when nothing else lives there anymore. rmdir never recurses, so a
# foreign file in either place keeps it — and keeps the foreign file.
rmdir "${HOOK_DIR}/bench" 2>/dev/null || true
rmdir "${HOOK_DIR}" 2>/dev/null || true

# Strip the RLM registration from settings.json, preserving everything else.
# The node helper exits nonzero on invalid JSON or an unwritable file; in that
# case warn and continue so the rest of the uninstall still happens.
if [ -f "${SETTINGS_FILE}" ]; then
  if ! RLM_UNINSTALL_SETTINGS="${SETTINGS_FILE}" node --input-type=module - <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';

const path = process.env.RLM_UNINSTALL_SETTINGS;
let raw;
try {
  raw = await readFile(path, 'utf8');
} catch {
  process.exit(0); // vanished between the check and here — nothing to revert
}

// A registration is any hook command that invokes the hook by its file name,
// so absolute-path variants (~/.claude/hooks/... or /home/x/.claude/hooks/...)
// are covered as well as the documented tilde form.
const isRlmCommand = (command) =>
  typeof command === 'string' && /rlm-hook\.(mjs|sh)\b/.test(command);

let settings;
try {
  settings = JSON.parse(raw);
} catch (error) {
  console.error(`${path} is not valid JSON (${error.message}); leaving it untouched`);
  process.exit(1);
}

let removed = 0;
const groups = settings?.hooks;
if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
  for (const [event, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries)) continue; // foreign shape: preserve
    const kept = entries.filter((entry) => {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return true;
      const withoutRlm = entry.hooks.filter((hook) => !isRlmCommand(hook?.command));
      if (withoutRlm.length === entry.hooks.length) return true; // no RLM refs: preserve
      removed += entry.hooks.length - withoutRlm.length;
      return withoutRlm.length > 0; // drop only entries this run emptied
    });
    if (kept.length === entries.length) continue;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

if (removed === 0) {
  console.log('  no RLM hook registration found in settings.json');
  process.exit(0);
}
await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`  removed ${removed} RLM hook registration(s) from ${path}`);
NODE
  then :; else
    echo "WARNING: could not update ${SETTINGS_FILE}; remove the RLM hook entry manually." >&2
  fi
fi

# Remove SDK dependencies only when install.sh created them: a package.json
# declaring @anthropic-ai/sdk as its single dependency. Any other package.json
# (shared with another tool) is left completely alone.
if [ -f "${HOOK_DIR}/package.json" ]; then
  if RLM_UNINSTALL_PKG="${HOOK_DIR}/package.json" node --input-type=module - <<'NODE'
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(process.env.RLM_UNINSTALL_PKG, 'utf8'));
const deps = Object.keys({
  ...(pkg?.dependencies ?? {}),
  ...(pkg?.optionalDependencies ?? {}),
});
process.exit(deps.length === 1 && deps[0] === '@anthropic-ai/sdk' ? 0 : 1);
NODE
  then
    rm -rf "${HOOK_DIR}/node_modules" "${HOOK_DIR}/package.json" "${HOOK_DIR}/package-lock.json"
    echo "  removed SDK dependencies from ${HOOK_DIR}"
  fi
fi

# Cache and log directories are wholly owned by the hook.
if [ -d "${CACHE_DIR}" ] || [ -d "${LOG_DIR}" ]; then
  rm -rf "${CACHE_DIR}" "${LOG_DIR}"
  echo "  removed ${CACHE_DIR} and ${LOG_DIR}"
fi

echo "RLM hook uninstalled. If a settings.json elsewhere (e.g. a project's"
echo ".claude/settings.json) still references rlm-hook, remove that entry manually."
