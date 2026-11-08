# SDK Agent-Tool Contracts (Phase 2, Unit 5)

Specification of the five tools the SDK-Direct agentic path
(`callHaikuAgenticSDK` in `rlm-hook.mjs`) advertises to Haiku and executes
locally: **Glob, Grep, Read, Write, Bash**. Every claim here is asserted by
`test/sdk-tool-contracts.test.mjs`, which binds to the real exported
implementations.

The same tool menu governs the subprocess path (`invokeHaiku`): the CLI runs
its own native tools behind the same contract — the same allowlist, the same
project-root boundary, the same scratch-only Write. Compatibility is defined
at the *policy* and *pipeline* level, not byte level (CLI-native tools format
results differently); see [Cross-mode compatibility](#cross-mode-compatibility).

## 0. Shared semantics (all five tools)

| Property | Contract |
|---|---|
| Result value | Always a plain string — no structured payloads, no error objects |
| Throwing | `dispatchAgenticTool` never throws; any internal failure becomes an `Error: …` string |
| Error shape | String prefixed `Error: `; fed back verbatim as `tool_result.content` (no `is_error` flag is set — the model reacts to the text) |
| Path base | All relative paths resolve against the project root = the `cwd` passed to `callHaikuAgenticSDK` |
| Truncation | Grep: first 50 lines, 1 MiB buffer, 5 s timeout · Read: 16 000 chars · Bash: 8 000 chars output, 5 s timeout, 1 MiB buffer · Glob: 100 entries |
| Ordering | One `tool_result` per `tool_use` block, in block order, keyed by `tool_use_id` |

## 1. Glob

**Input** (`input_schema` in `AGENTIC_TOOLS`): `{"pattern": string}` — `pattern` required.

**Behavior**: recursive `readdir` from the project root. Skips `node_modules`
and `.git` at every level. Files only (directories never match). Returns
newline-joined paths **relative to the root**, in `readdir` order (not
sorted); capped at 100 matches with no overflow marker.

**Pattern language** (`globToRegExp`): `**` matches any characters including
`/` (and `**/x` also matches `x` at the root); `*` and `?` never cross `/`;
regex metacharacters in the pattern are escaped. Case-sensitive.

**Errors** (exact strings):
- Missing/empty `pattern` → `Error: Glob requires a pattern`
- Non-string, absolute, leading `~`, or any `..` in the pattern →
  `Error: Glob pattern escapes project root`
- Unreadable subdirectories are skipped silently (no error).

## 2. Grep

**Input**: `{"pattern": string (required), "path": string (optional sub-path)}`.

**Behavior**: `grep -rnH --exclude-dir=node_modules --exclude-dir=.git -e
<shell-quoted pattern> <shell-quoted resolved target> | head -50` (5 s
timeout, 1 MiB buffer; `-H` keeps the filename prefix even for a single-file
target). `pattern` is passed to grep **unmodified** — it is a POSIX basic
regular expression (BRE, plus GNU extensions such as `\w`), not PCRE; regex
metacharacters are *not* escaped by the hook.

**Output**: `path:line:text` lines, where `path` is the **resolved absolute**
target path (grep receives an absolute path). Trimmed; more than 50 lines are
cut at 50 with no continuation marker. Note the inconsistency with Glob
(relative paths) — it is intentional to document, not to paper over.

**Errors**:
- Missing/empty `pattern` → `Error: Grep requires a pattern`
- `path` missing from the input → searches the whole project root
- `path` that cannot be resolved inside the root (outside root, `..`,
  non-existent, or through a symlink that lands outside) →
  `Error: path escapes project root: <path>`
- No matches (grep exit 1) → `No matches found.`

Symlink behavior: the SDK tool itself only checks the *target* (`resolveWithin`);
`grep -r` does not follow symlinks met during recursion, so the walk stays
inside the root. The subprocess-mode PreToolUse guard additionally refuses a
whole search when the tree contains a symlink escaping the root
(`searchTreeStaysWithin`), which the SDK path does not.

## 3. Read

**Input**: `{"path": string}` — `path` required. Note the input key is
`path` in SDK mode; the CLI-native Read tool used by the subprocess path
takes `file_path` (the guard `isAllowedAgenticRead` reads
`event.tool_input.file_path`). A `file_path` key sent to the SDK dispatch is
ignored and yields the missing-path error.

**Behavior**: the path is resolved through symlinks on both sides
(`resolveWithin`: `realpath(root)` and `realpath(resolve(root, p))`), read as
UTF-8, and truncated at 16 000 chars with a trailing `\n... [truncated]`
marker. No line numbering (unlike CLI-native Read). No binary detection: a
binary file is returned as lossy UTF-8 text, not an error.

**Errors**:
- Missing/empty `path` → `Error: Read requires a path`
- Outside root / `..` / non-existent / symlink escape →
  `Error: path escapes project root: <path>`
- Unreadable (permissions) → `Error: <fs error message>`

## 4. Write

**Input**: `{"content": string}` — there is **no path input**. The target is
structurally fixed: `<root>/.claude/rlm-scratch-<pid>.md`, where `<pid>` is
the hook process's pid. The `.claude` directory is created on demand.

**Behavior**: **overwrite** semantics (`writeFile`), despite the agentic
prompt's "append to notes" wording — each Write replaces the whole file, so
the model must resend full note content. Known prompt/tool wording mismatch,
documented here rather than papered over.

**Output**: `Wrote <N> chars to <absolute scratch path>` where `N` is
`content.length` after `String(content ?? '')`.

**Errors**: filesystem failures only — `Error: <fs error message>`. There is
no path-restriction error surface: the model cannot choose a path.

Cross-mode note: in subprocess mode the CLI's Write tool takes a real
`file_path`, and the PreToolUse guard (`--guard-agentic-tool`) denies every
path except the exact pid-scoped scratch path. SDK mode enforces the same
restriction structurally (no path parameter at all).

## 5. Bash

**Input**: `{"command": string}`.

### 5.1 Gate (`isAllowedGitCommand`) — the allowed-command contract

A command executes only if **all** of the following hold:

1. **Git prefix**: the trimmed command matches `/^git(\s|$)/`.
2. **No shell metacharacters**: none of `; & | ` ` $ ( ) < > { } \n` anywhere
   in the command (it runs through a shell, so this blocks chaining,
   redirection, command substitution).
3. **Allowlisted subcommand**: the first word after `git` is one of
   `status`, `log`, `diff`, `show`, `branch`, `ls-files`, `remote`
   (`READ_ONLY_GIT_SUBCOMMANDS`). This rejects `git reset`, `git clean`,
   `git push` and every other subcommand, and rejects global options placed
   before the subcommand (`git -C /etc log`, `git --version`).
4. **No mutating long flags**: `--delete`, `--move`, `--copy`,
   `--edit-description`, `--set-upstream`, `--set-upstream-to`,
   `--unset-upstream`, `--output=<file>` / bare `--output`, and `--ext-diff`
   are rejected on every allowlisted subcommand (`--output-indicator-*`
   remains allowed — it only changes diff marker characters).
5. **`branch` extras**: mutating short flags (any of `d D m M c C u`, even
   inside a cluster such as `-avD`) are rejected, and a bare positional
   argument is rejected (the `git branch <name>` creation form) unless a
   read-only value flag — `--contains`, `--no-contains`, `--points-at`,
   `--list` — justifies it.
6. **`remote` extras**: only `-v`/`--verbose`, `--all`, `show`, `get-url` are
   accepted after the subcommand, and any further argument (the remote name)
   only after `show`/`get-url` (`add`, `rename`, `remove`, `rm`, `set-head`,
   `set-branches`, `set-url`, `prune` — which mutate config or tracking refs
   — are rejected).

A read-only first word was not sufficient: before rule 4–6 existed,
`git branch -D x`, `git branch newbranch`, and `git remote add x url`
executed under the "read-only" contract. `git reset/clean/push` were closed
by the subcommand allowlist; rules 4–6 close the flag-level mutations.

### 5.2 Execution

`execSync(command, { cwd: root, timeout: 5000, maxBuffer: 1 MiB })`.

**Output**: stdout, sliced to 8 000 chars; empty stdout → `(no output)`.

**Errors**:
- Gate rejection →
  `Error: only read-only "git ..." commands are permitted (rejected: <first 60 chars of the command>)`
- Non-zero exit / spawn failure → `Error: <execSync error message>` — the
  message embeds stderr (e.g. `fatal: ... not a git repository`, `fatal:
  your current branch ... does not have any commits`), so distinct git
  failure modes are distinguishable by text.

### 5.3 Cross-mode

Subprocess mode runs the *same* gate function twice: the CLI's
`--allowedTools` permission rules (`Bash(git status:*)` …, derived from
`READ_ONLY_GIT_SUBCOMMANDS` via `agenticAllowedTools()`, so the two modes
cannot drift) and the PreToolUse guard (`--guard-agentic-tool`, which calls
`isAllowedGitCommand` directly). The guard additionally allows exactly one
non-git command: `rm .claude/<scratchName>` for scratch cleanup.

## 6. Continuation semantics (`callHaikuAgenticSDK`)

- **Request shape**: `messages.create({ model: CONFIG.haikuModel, max_tokens:
  CONFIG.sdkMaxTokens (default 2048), tools: AGENTIC_TOOLS, messages })`.
  `AGENTIC_TOOLS` is passed by reference every turn — the advertised schema
  never changes mid-loop.
- **Turn loop**: at most `CONFIG.maxTurns` requests (default 10,
  `RLM_MAX_TURNS`).
- **Per turn**: text blocks are concatenated by `extractSDKText`; usage is
  summed across turns by `extractSDKUsage` (null if no turn reports usable
  usage).
- **Final response**: `stop_reason !== 'tool_use'` → return
  `{ text: text || lastText, usage }` and log the elapsed/turn count. Text
  from earlier tool-use turns is preserved via `lastText` as a fallback.
- **Tool-use turn**: the assistant content is echoed back **verbatim**, then
  each `tool_use` block is dispatched sequentially, producing one
  `{ type: 'tool_result', tool_use_id: <block.id>, content: <string> }` per
  block, pushed as a single `user` message. The loop continues.
- **Turn cap**: exhausted without a final response → return
  `{ text: lastText, usage }`; the run is logged as "hit turn cap".
- **Never throws into the hook**: the caller wraps the loop in try/finally;
  the `finally` removes the pid-scoped scratch file. An SDK error mid-loop
  falls through to the subprocess path (`response = null`).
- **Final output**: the returned text enters the *same* pipeline as the
  subprocess response string — `responseText` → `parseHaikuResponse`
  (`parsePreresearchResponse`) → `normalizePreresearch` → skip-check → cache
  → `formatOutput` → stdout `<rlm_preresearch>` block. Identical final text
  therefore produces byte-identical injected output in both modes; tool
  exploration shapes the text, never the pipeline.

## Cross-mode compatibility

| Aspect | SDK mode | Subprocess mode | Compatibility rule |
|---|---|---|---|
| Tool executor | `dispatchAgenticTool` | CLI-native tools | same menu, same policy |
| Read input key | `path` | `file_path` | dispatch key differs by mode |
| Read result | raw UTF-8, no line numbers | CLI `cat -n` style | policy-level compat only |
| Grep result | absolute paths | CLI format | policy-level compat only |
| Bash gate | `isAllowedGitCommand` | CLI rules + PreToolUse guard (same function) | identical surface |
| Bash allowlist | `READ_ONLY_GIT_SUBCOMMANDS` | `agenticAllowedTools()` derived from the same set | structurally equal |
| Write restriction | structural (no path input) | guard-enforced (exact scratch path only) | scratch-only in both |
| Scratch cleanup | hook `finally` after the loop | model `rm` (allowlisted) + hook `finally` | same end state |
| Final preresearch output | `{text, usage}` → shared pipeline | stdout string → shared pipeline | byte-identical for identical text |

## Residual limitations (documented, accepted)

- Grep patterns are BRE + GNU extensions; regex metacharacters pass through.
- Read has no binary detection; truncation is char-based and can split a
  surrogate pair.
- Grep's 50-line cap has no continuation marker; Glob's 100-entry cap
  likewise.
- `git status`/read-only porcelain commands may refresh the index stat cache
  (a benign, bounded write).
- External diff drivers from repo config could execute during `git diff` if
  the config were writable — it is not reachable through this tool surface
  (Write is scratch-only), and `--ext-diff` is explicitly rejected.
- Scratch Write overwrites rather than appends, matching the CLI-native
  Write tool but not the prompt's "append" wording.

## Testing map

`test/sdk-tool-contracts.test.mjs` covers: schema advertisement, per-tool
input/output/error strings, path restriction (including symlink escapes),
the full Bash allowed/rejected matrix, gate cross-mode guard IPC (real
`--guard-agentic-tool` subprocess), loop continuation semantics with an
injected fake client (echo, keying, turn cap, usage summation, lastText),
and byte-identical final preresearch output across modes.
