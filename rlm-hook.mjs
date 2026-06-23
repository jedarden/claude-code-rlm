#!/usr/bin/env node
/**
 * RLM (Recursive Language Model) Hook for Claude Code
 *
 * Preresearch hook: runs Haiku before Opus/Sonnet to explore the codebase
 * and inject relevant context into the conversation.
 *
 * Usage:
 *   echo '{"prompt":"...","cwd":"/path/to/project"}' | node rlm-hook.mjs
 *   node rlm-hook.mjs --version
 *
 * chmod +x rlm-hook.mjs
 */

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, stat, rm, rename, readdir } from 'fs/promises';
import { join, basename, resolve, relative, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// --version flag
if (process.argv.includes('--version')) {
  console.log('0.1.0');
  process.exit(0);
}

// Expand leading ~/ to the home directory (Node.js does not do shell tilde expansion)
const expandTilde = p => (p && p.startsWith('~/')) ? join(homedir(), p.slice(2)) : p;

// Configuration — all values overridable via environment variables
const CONFIG = {
  minInputLength: parseInt(process.env.RLM_MIN_LENGTH || '20', 10),
  maxInputLength: parseInt(process.env.RLM_MAX_LENGTH || '4000', 10),
  cacheTTL: parseInt(process.env.RLM_CACHE_TTL || '3600', 10), // seconds
  haikuModel: process.env.RLM_MODEL || 'claude-haiku-4-5-20251001',
  timeout: parseInt(process.env.RLM_TIMEOUT || '60000', 10), // ms
  cacheDir: expandTilde(process.env.RLM_CACHE_DIR) || join(homedir(), '.cache', 'rlm-hook'),
  logFile: expandTilde(process.env.RLM_LOG_FILE) || join(homedir(), '.local', 'share', 'rlm-hook', 'rlm-hook.log'),
  // Agentic mode: allow Haiku to use tools (Read, Glob, Grep, Write, Bash) to explore the codebase
  agenticMode: process.env.RLM_AGENTIC_MODE !== 'false',
  // Max turns for agentic exploration (each turn = one tool call cycle)
  maxTurns: parseInt(process.env.RLM_MAX_TURNS || '10', 10),
  // Fast mode: concise prompt (~3s) vs detailed (~9s). Default: fast
  fastMode: process.env.RLM_FAST_MODE !== 'false',
  // Context gathering: detect project type, git state, recent files
  gatherContext: process.env.RLM_GATHER_CONTEXT !== 'false',
  // SDK-Direct mode (Phase 2): call the Anthropic API directly instead of the
  // `claude` subprocess. Requires RLM_USE_SDK=true AND ANTHROPIC_API_KEY set —
  // otherwise we fall back to the subprocess path (unchanged behavior).
  useSDK: process.env.RLM_USE_SDK === 'true',
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  sdkMaxTokens: parseInt(process.env.RLM_SDK_MAX_TOKENS || '2048', 10),
  // Semantic caching (Phase 3): reuse a cached analysis when a new prompt is
  // cosine-similar (not just SHA-256 identical) to a cached one. Gated behind
  // RLM_SEMANTIC_CACHE=true; default off until embedding latency/quality are
  // validated. Embeddings come from an OpenAI-compatible endpoint
  // (text-embedding-3-small) using OPENAI_API_KEY — the Anthropic SDK does not
  // expose embeddings. Whenever embedding is unavailable or fails, the cache
  // layer degrades to plain SHA-256 lookup (the hook never breaks).
  semanticCache: process.env.RLM_SEMANTIC_CACHE === 'true',
  semanticThreshold: parseFloat(process.env.RLM_SEMANTIC_THRESHOLD || '0.92'),
  embedModel: process.env.RLM_EMBED_MODEL || 'text-embedding-3-small',
  embedApiKey: process.env.OPENAI_API_KEY || null,
  embedBaseUrl: process.env.RLM_EMBED_BASE_URL || 'https://api.openai.com/v1',
  // Debug mode
  debug: process.env.RLM_DEBUG === 'true',
};

// =============================================================================
// LOGGING
// =============================================================================

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  try {
    const logDir = join(homedir(), '.local', 'share', 'rlm-hook');
    await mkdir(logDir, { recursive: true });
    await writeFile(CONFIG.logFile, entry, { flag: 'a' });
  } catch {
    // Ignore logging errors — never block the conversation
  }
}

// =============================================================================
// CACHE
// =============================================================================

function getCacheKey(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function checkCache(key) {
  const cacheFile = join(CONFIG.cacheDir, `${key}.json`);
  try {
    const stats = await stat(cacheFile);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    if (ageSeconds < CONFIG.cacheTTL) {
      const content = await readFile(cacheFile, 'utf-8');
      return JSON.parse(content);
    }
    await rm(cacheFile, { force: true });
  } catch {
    // Cache miss
  }
  return null;
}

async function saveCache(key, data) {
  await mkdir(CONFIG.cacheDir, { recursive: true });
  const cacheFile = join(CONFIG.cacheDir, `${key}.json`);
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, cacheFile);
}

// =============================================================================
// SKIP DETECTION
// =============================================================================

function shouldSkipRLM(input) {
  if (input.length < CONFIG.minInputLength) {
    return { skip: true, reason: 'Input too short' };
  }

  // Simple commands and single-word responses
  const simplePatterns = [
    /^(ls|cd|pwd|cat|echo|git status|npm|yarn)\b/i,
    /^(yes|no|ok|thanks|y|n)$/i,
    /^\/\w+$/,  // Slash commands like /help
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(input.trim())) {
      return { skip: true, reason: 'Simple command detected' };
    }
  }

  // Code-heavy inputs (>50% code blocks with multiple blocks) — already structured
  const codeBlockMatches = input.match(/```[\s\S]*?```/g) || [];
  const codeLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
  if (codeLength > input.length * 0.5 && codeBlockMatches.length > 1) {
    return { skip: true, reason: 'Code-heavy input' };
  }

  return { skip: false };
}

// =============================================================================
// CONTEXT GATHERING
// =============================================================================

async function gatherProjectContext(cwd) {
  if (!cwd || !existsSync(cwd)) return null;

  const context = {
    projectRoot: cwd,
    projectName: basename(cwd),
    projectType: null,
    techStack: [],
    recentFiles: [],
    gitBranch: null,
    gitStatus: null,
  };

  try {
    const manifestFiles = {
      'package.json': 'node',
      'Cargo.toml': 'rust',
      'go.mod': 'go',
      'pyproject.toml': 'python',
      'requirements.txt': 'python',
      'pom.xml': 'java',
      'build.gradle': 'java',
      'Gemfile': 'ruby',
      'composer.json': 'php',
    };

    for (const [file, type] of Object.entries(manifestFiles)) {
      if (existsSync(join(cwd, file))) {
        context.projectType = type;
        context.techStack.push(type);

        if (file === 'package.json') {
          try {
            const pkg = JSON.parse(await readFile(join(cwd, file), 'utf-8'));
            const deps = Object.keys(pkg.dependencies || {}).slice(0, 10);
            const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 5);
            context.techStack.push(...deps, ...devDeps);
          } catch {}
        }
        break;
      }
    }

    // Git info (fast ops only)
    try {
      context.gitBranch = execSync('git branch --show-current 2>/dev/null', { cwd, timeout: 1000 })
        .toString().trim();
      context.gitStatus = execSync('git status --porcelain 2>/dev/null', { cwd, timeout: 1000 })
        .toString().trim().split('\n').slice(0, 5).join(', ');
    } catch {}

    // Recent source files (fast find, no node_modules)
    try {
      const found = execSync(
        'find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" -o -name "*.py" -o -name "*.rs" -o -name "*.go" \\) 2>/dev/null | grep -v node_modules | head -20',
        { cwd, timeout: 2000 }
      ).toString().trim().split('\n').filter(Boolean);
      context.recentFiles = found.slice(0, 10);
    } catch {}

  } catch (err) {
    await log(`Context gathering error: ${err.message}`);
  }

  return context;
}

async function gatherConversationContext(transcriptPath, maxMessages = 5) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  try {
    const content = await readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').slice(-maxMessages * 2);

    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' || entry.type === 'assistant') {
          const raw = entry.message?.content || entry.content || '';
          const text = Array.isArray(raw)
            ? raw.filter(b => b.type === 'text').map(b => b.text).join(' ')
            : (typeof raw === 'string' ? raw : '');
          if (text) {
            messages.push({
              role: entry.type,
              preview: text.slice(0, 200) + (text.length > 200 ? '...' : '')
            });
          }
        }
      } catch {}
    }

    return messages.slice(-maxMessages);
  } catch (err) {
    await log(`Transcript read error: ${err.message}`);
    return null;
  }
}

// =============================================================================
// PROMPT BUILDING
// =============================================================================

function buildRLMPrompt(userMessage, projectContext, conversationContext) {
  let contextSection = '';

  if (projectContext) {
    contextSection += `\nProject: ${projectContext.projectName} (${projectContext.projectType || 'unknown'})`;
    if (projectContext.techStack.length > 0) {
      contextSection += `\nStack: ${projectContext.techStack.slice(0, 8).join(', ')}`;
    }
    if (projectContext.gitBranch) {
      contextSection += `\nBranch: ${projectContext.gitBranch}`;
    }
    if (projectContext.gitStatus) {
      contextSection += `\nModified: ${projectContext.gitStatus}`;
    }
    if (projectContext.recentFiles.length > 0) {
      contextSection += `\nFiles: ${projectContext.recentFiles.slice(0, 5).join(', ')}`;
    }
  }

  if (conversationContext && conversationContext.length > 0) {
    contextSection += `\nRecent conversation:`;
    for (const msg of conversationContext.slice(-3)) {
      contextSection += `\n- ${msg.role}: ${msg.preview.slice(0, 100)}`;
    }
  }

  // Agentic mode: Haiku explores the codebase with tools and writes structured notes
  if (CONFIG.agenticMode) {
    const scratchFile = '.claude/rlm-scratch.md';

    return `You are an RLM (Recursive Language Model) preresearch agent. Your job is to explore the codebase and gather context for a more expensive coding model.

TASK: Analyze the user's request and gather relevant context from the codebase.

USER REQUEST: ${userMessage}

INITIAL CONTEXT:${contextSection || ' (none provided)'}

EXPLORATION TOOLS AVAILABLE:
- Glob: Find files by pattern (e.g., "src/**/*.ts", "**/auth*")
- Grep: Search file contents (e.g., search for "authenticate", "middleware")
- Read: Read specific files to understand implementation
- Write: Write intermediate notes to ${scratchFile}
- Bash: Run git commands ONLY (git log, git show, git diff, git blame)

EXPLORATION WORKFLOW:
1. Start by writing your initial understanding to ${scratchFile}
2. Use Glob to find potentially relevant files — write findings to notes
3. Use Grep to search for key terms, function names, patterns — append to notes
4. Use Read to examine the most relevant files (max 3-5 files) — append key findings
5. Use git log/diff to see recent changes — append to notes
6. Read back your ${scratchFile} notes
7. Synthesize everything into a final structured JSON summary
8. Delete ${scratchFile} using Bash: rm ${scratchFile}

NOTES FORMAT (${scratchFile}):
\`\`\`markdown
# RLM Preresearch Notes

## Initial Understanding
[What I think the user wants]

## File Discovery
[Results from Glob searches]

## Code Patterns Found
[Results from Grep searches]

## Key File Analysis
[Important findings from Read]

## Git History
[Relevant recent changes]

## Open Questions
[Things that need clarification]
\`\`\`

CONSTRAINTS:
- Write notes incrementally as you explore — don't try to remember everything
- Read back your notes before synthesizing
- Focus on: entry points, interfaces, existing patterns, recent changes
- For large files, note structure and key exports rather than full content

FINAL OUTPUT (after deleting scratch file):
Output ONLY this JSON structure (no markdown, no explanation):
{
  "intent": "code_writing|debugging|refactoring|architecture|learning|other",
  "summary": "One paragraph summary synthesized from your notes",
  "relevant_files": [
    {"path": "file/path.ts", "purpose": "what this file does", "key_exports": ["func1", "Class1"]}
  ],
  "existing_patterns": ["pattern1 used in codebase", "pattern2"],
  "recent_changes": "summary of relevant git history",
  "dependencies": ["relevant deps from package.json etc"],
  "tasks": ["step1", "step2", "step3"],
  "approach": "recommended implementation approach based on existing patterns",
  "warnings": ["potential issues or considerations"]
}

If the request is trivial (simple command, greeting, etc.), skip exploration and output: {"skip": true, "reason": "explanation"}

BEGIN: Write initial understanding to ${scratchFile}, then explore systematically.`;
  }

  if (CONFIG.fastMode) {
    // Concise prompt for low-latency non-agentic analysis (~3s response)
    return `Analyze with project context. Output ONLY JSON, no markdown:
{"intent":"code_writing|debugging|architecture|learning|other","tasks":["task1","task2","task3"],"tech":["relevant","technologies"],"files":["likely_relevant_files"],"approach":"one sentence strategy"}
If trivial, output: {"skip":true}
${contextSection}

User: ${userMessage}`;
  }

  // Detailed non-agentic prompt (~9s response)
  return `You are an RLM (Recursive Language Model) analyzer. Analyze this user message with project context.
${contextSection ? `\n<project_context>${contextSection}\n</project_context>` : ''}

<user_message>
${userMessage}
</user_message>

Provide analysis in this exact JSON format (no markdown, just raw JSON):
{
  "intent": {
    "primary": "code_writing|debugging|code_review|architecture|documentation|learning|configuration|other",
    "secondary": [],
    "confidence": 0.0-1.0
  },
  "decomposition": [
    {"task": "description", "priority": 1-5, "dependencies": []}
  ],
  "implicit_context": {
    "domain": "web|backend|devops|data|ml|mobile|other",
    "assumed_knowledge": [],
    "relevant_technologies": []
  },
  "ambiguities": [
    {"aspect": "what's unclear", "interpretations": [], "suggested_default": ""}
  ],
  "success_criteria": [],
  "suggested_approach": "high-level strategy",
  "skip_rlm": false,
  "skip_reason": null
}

If the query is too simple for this analysis, return: {"skip_rlm": true, "skip_reason": "reason"}

Output ONLY valid JSON, nothing else.`;
}

// =============================================================================
// HAIKU INVOCATION
// =============================================================================

async function invokeHaiku(prompt, workingDir = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const args = [
      '-p', prompt,
      '--model', CONFIG.haikuModel,
      '--output-format', 'text',
    ];

    if (workingDir) {
      args.push('--add-dir', workingDir);
    }

    // Always bypass permissions — this is a preresearch subprocess, not an interactive session
    args.push('--permission-mode', 'bypassPermissions');

    if (CONFIG.agenticMode) {
      // Enable file exploration tools + git + scratch file cleanup
      args.push('--allowedTools', 'Read,Glob,Grep,Write,Bash(git:*),Bash(rm:*)');
      args.push('--max-turns', String(CONFIG.maxTurns));
    }
    // Non-agentic: omit --allowedTools entirely — absence means no tools allowed

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDir || process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
      reject(new Error('Haiku invocation timed out'));
    }, CONFIG.timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latency = Date.now() - startTime;
      log(`Haiku completed in ${latency}ms with exit code ${code}`);

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Haiku failed (exit ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    proc.stdin.end();
  });
}

// =============================================================================
// SDK-DIRECT INVOCATION (Phase 2)
// =============================================================================

/**
 * shouldUseSDK — true only when SDK-Direct mode is explicitly enabled AND an
 * API key is present. Anything else routes through the subprocess path so the
 * hook keeps working with a bare Max subscription (no key on disk).
 */
function shouldUseSDK() {
  return CONFIG.useSDK && !!CONFIG.apiKey;
}

/**
 * extractSDKText — concatenate the text from an Anthropic Messages response.
 * The API returns `content` as an array of typed blocks; we want only the
 * `text` blocks joined in order. Defensive against missing/partial shapes so a
 * malformed response degrades to '' rather than throwing.
 */
function extractSDKText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
}

/**
 * createAnthropicClient — lazily import the SDK and construct a client. Kept
 * separate so callers can inject a fake client in tests instead of importing
 * the dependency. Throws if the SDK is not installed (caught by the caller,
 * which falls back to the subprocess path).
 */
async function createAnthropicClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * callMessagesSDK — shared single-turn, tool-free Messages call used by both the
 * fast and detailed SDK paths (they differ only in the prompt buildRLMPrompt
 * produced and the log label). Mirrors invokeHaiku's contract: returns the raw
 * model text, which main() hands to parseHaikuResponse. `client` is injectable
 * for testing; in production it is created lazily.
 */
async function callMessagesSDK(prompt, apiKey, client = null, label = 'single-turn') {
  const startTime = Date.now();
  const c = client || await createAnthropicClient(apiKey);
  const response = await c.messages.create({
    model: CONFIG.haikuModel,
    max_tokens: CONFIG.sdkMaxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  await log(`Haiku SDK (${label}) completed in ${Date.now() - startTime}ms`);
  return extractSDKText(response);
}

/**
 * callHaikuFastSDK — single-turn fast-mode analysis via the SDK.
 */
async function callHaikuFastSDK(prompt, apiKey, client = null) {
  return callMessagesSDK(prompt, apiKey, client, 'fast');
}

/**
 * callHaikuDetailedSDK — single-turn detailed (verbose) analysis via the SDK.
 * Mechanically identical to the fast path; the verbosity lives in the prompt.
 */
async function callHaikuDetailedSDK(prompt, apiKey, client = null) {
  return callMessagesSDK(prompt, apiKey, client, 'detailed');
}

// =============================================================================
// SDK AGENTIC MODE — TOOL DISPATCH (Phase 2, Unit 5)
// =============================================================================
//
// In agentic mode the CLI runs the tool-use loop for us; via the SDK we have to
// drive it explicitly: send a `tools` array, and whenever Haiku replies with
// `tool_use` blocks, run each tool locally and feed back a matching
// `tool_result`. Tools are dependency-free Node built-ins (Glob/Read/Write) plus
// `child_process` (Grep/git), constrained so the preresearch agent can only read
// the project and run git — never mutate the working tree (Write goes to a
// pid-scoped scratch file) or run arbitrary shell.

/** The tool schema advertised to Haiku. Mirrors the agentic prompt's tool list. */
const AGENTIC_TOOLS = [
  {
    name: 'Glob',
    description: 'Find files by glob pattern (e.g. "src/**/*.ts", "**/auth*"). Returns matching paths relative to the project root.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents for a pattern (fixed string or regex). Returns matching lines with file:line prefixes.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Optional sub-path to scope the search' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file (relative to the project root). Long files are truncated.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path to read' } },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description: 'Append/overwrite intermediate research notes to a scratch file. Pass the full note content; the path is managed for you.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'Note content to write' } },
      required: ['content'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a read-only git command ONLY (e.g. "git log --oneline -10", "git diff", "git show", "git blame"). Non-git commands are rejected.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'A git command' } },
      required: ['command'],
    },
  },
];

/** Single-quote a string for safe use as one shell argument. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * resolveWithin — resolve `p` against `root` and refuse anything that escapes
 * the project root (path traversal / absolute paths pointing elsewhere).
 * Returns the absolute path, or null if it escapes.
 */
function resolveWithin(root, p) {
  const full = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, full);
  if (rel === '' ) return full;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

/**
 * isAllowedGitCommand — the Bash tool only permits read-only git invocations.
 * The command must start with `git` and contain no shell metacharacters that
 * would allow chaining, redirection, or substitution (the command is run via a
 * shell, so this guard is what prevents `git log; rm -rf /`).
 */
function isAllowedGitCommand(command) {
  const cmd = String(command || '').trim();
  if (!/^git(\s|$)/.test(cmd)) return false;
  if (/[;&|`$()<>{}\n]/.test(cmd)) return false;
  return true;
}

/** glob → anchored RegExp. `**` crosses directory separators, `*`/`?` do not. */
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // "**/x" should also match "x" at the root
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

const GLOB_SKIP_DIRS = new Set(['node_modules', '.git']);

/** Glob tool — recursive readdir (fs.glob is Node 22+; we target Node 20). */
async function toolGlob(pattern, cwd, limit = 100) {
  if (!pattern) return 'Error: Glob requires a pattern';
  const root = cwd || process.cwd();
  const re = globToRegExp(pattern);
  const matches = [];
  async function walk(dir, rel) {
    if (matches.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (matches.length >= limit) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (GLOB_SKIP_DIRS.has(ent.name)) continue;
        await walk(join(dir, ent.name), relPath);
      } else if (ent.isFile() && re.test(relPath)) {
        matches.push(relPath);
      }
    }
  }
  await walk(root, '');
  return matches.length ? matches.join('\n') : 'No files matched.';
}

/** Grep tool — delegates to system grep (recursive, skipping node_modules/.git). */
function toolGrep(pattern, path, cwd) {
  if (!pattern) return 'Error: Grep requires a pattern';
  const root = cwd || process.cwd();
  const target = path ? (resolveWithin(root, path) || root) : root;
  try {
    const out = execSync(
      `grep -rn --exclude-dir=node_modules --exclude-dir=.git -e ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -50`,
      { timeout: 5000, maxBuffer: 1024 * 1024 }
    ).toString().trim();
    return out || 'No matches found.';
  } catch (err) {
    // grep exits 1 on no matches; the head pipe usually masks this, but be safe.
    if (err && err.status === 1) return 'No matches found.';
    return `Error: ${String(err?.message ?? err)}`;
  }
}

/** Read tool — read a file inside the project root, truncating long content. */
async function toolRead(path, cwd, maxBytes = 16000) {
  if (!path) return 'Error: Read requires a path';
  const root = cwd || process.cwd();
  const full = resolveWithin(root, path);
  if (!full) return `Error: path escapes project root: ${path}`;
  try {
    let content = await readFile(full, 'utf-8');
    if (content.length > maxBytes) content = content.slice(0, maxBytes) + '\n... [truncated]';
    return content;
  } catch (err) {
    return `Error: ${String(err?.message ?? err)}`;
  }
}

/** pid-scoped scratch path — avoids collisions between concurrent hook runs. */
function sdkScratchPath(cwd) {
  return join(cwd || process.cwd(), '.claude', `rlm-scratch-${process.pid}.md`);
}

/** Write tool — always targets the pid-scoped scratch file (never user code). */
async function toolWrite(content, cwd) {
  const root = cwd || process.cwd();
  const scratch = sdkScratchPath(root);
  const text = String(content ?? '');
  try {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(scratch, text);
    return `Wrote ${text.length} chars to ${scratch}`;
  } catch (err) {
    return `Error: ${String(err?.message ?? err)}`;
  }
}

/** Bash tool — read-only git commands only. */
function toolBashGit(command, cwd) {
  if (!command) return 'Error: Bash requires a command';
  if (!isAllowedGitCommand(command)) {
    return `Error: only read-only "git ..." commands are permitted (rejected: ${String(command).trim().slice(0, 60)})`;
  }
  try {
    const out = execSync(String(command).trim(), {
      cwd: cwd || process.cwd(),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).toString();
    return out.slice(0, 8000) || '(no output)';
  } catch (err) {
    return `Error: ${String(err?.message ?? err)}`;
  }
}

/**
 * dispatchAgenticTool — route a single tool_use block to its implementation and
 * return a string result for the tool_result block. Never throws: any failure
 * becomes an "Error: ..." string so the loop can continue and Haiku can react.
 */
async function dispatchAgenticTool(name, input, cwd) {
  const args = input || {};
  try {
    switch (name) {
      case 'Glob': return await toolGlob(args.pattern, cwd);
      case 'Grep': return toolGrep(args.pattern, args.path, cwd);
      case 'Read': return await toolRead(args.path, cwd);
      case 'Write': return await toolWrite(args.content, cwd);
      case 'Bash': return toolBashGit(args.command, cwd);
      default: return `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${String(err?.message ?? err)}`;
  }
}

/**
 * callHaikuAgenticSDK — the explicit tool-use loop. Sends the agentic prompt with
 * the AGENTIC_TOOLS schema; while Haiku replies with `tool_use`, run each tool
 * and feed back a `tool_result` keyed by `tool_use_id`, then re-call. Stops when
 * `stop_reason !== 'tool_use'` (returns that turn's text) or when CONFIG.maxTurns
 * is hit (returns the best text seen so far). `client` and `dispatch` are
 * injectable for tests; in production they default to the real implementations.
 */
async function callHaikuAgenticSDK(prompt, apiKey, cwd, client = null, dispatch = dispatchAgenticTool) {
  const startTime = Date.now();
  const c = client || await createAnthropicClient(apiKey);
  const messages = [{ role: 'user', content: prompt }];
  let lastText = '';

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await c.messages.create({
      model: CONFIG.haikuModel,
      max_tokens: CONFIG.sdkMaxTokens,
      tools: AGENTIC_TOOLS,
      messages,
    });

    const text = extractSDKText(response);
    if (text) lastText = text;

    if (response.stop_reason !== 'tool_use') {
      await log(`Haiku SDK (agentic) completed in ${Date.now() - startTime}ms over ${turn + 1} turn(s)`);
      return text || lastText;
    }

    // Echo the assistant's tool_use turn back, then answer each tool call.
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const block of response.content || []) {
      if (block && block.type === 'tool_use') {
        const result = await dispatch(block.name, block.input, cwd);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  await log(`Haiku SDK (agentic) hit turn cap (${CONFIG.maxTurns}) in ${Date.now() - startTime}ms`);
  return lastText;
}

// =============================================================================
// SEMANTIC CACHE — EMBEDDINGS (Phase 3, Unit 1)
// =============================================================================

/**
 * embedText — embed `text` into a vector via an OpenAI-compatible embeddings
 * endpoint (default model text-embedding-3-small). Returns a Float32Array.
 *
 * The Anthropic SDK does not expose embeddings, so this hits the OpenAI HTTP API
 * directly with `fetch` (global in Node 18+) and an `OPENAI_API_KEY`. `fetchImpl`
 * is injectable so unit tests can drive it without a network. THROWS on any
 * failure (no key, non-2xx, malformed body) — the semantic-cache layer catches
 * the throw and degrades to plain SHA-256 lookup, so the hook never breaks.
 */
async function embedText(text, apiKey, {
  fetchImpl = fetch,
  model = CONFIG.embedModel,
  baseUrl = CONFIG.embedBaseUrl,
} = {}) {
  if (!apiKey) throw new Error('embedText: no embedding API key');
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('embedText: empty input');
  }
  const startTime = Date.now();
  const res = await fetchImpl(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res || !res.ok) {
    throw new Error(`embedText: HTTP ${res ? res.status : 'no-response'}`);
  }
  const json = await res.json();
  const vec = json && json.data && json.data[0] && json.data[0].embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('embedText: malformed embedding response');
  }
  await log(`Embedding (${model}, dim ${vec.length}) completed in ${Date.now() - startTime}ms`);
  return Float32Array.from(vec);
}

/**
 * cosineSimilarity — cosine of the angle between two equal-length numeric
 * vectors: (a · b) / (‖a‖ · ‖b‖). Pure math, no deps; accepts Float32Array or
 * plain number arrays. Returns a value in [-1, 1].
 *
 * Edge-case contract:
 *  - Length mismatch → THROWS. Embeddings are fixed-dimension, so unequal
 *    lengths signal a corrupt or foreign vector; fail loudly rather than
 *    silently scoring a truncated overlap.
 *  - Either vector has zero magnitude → returns 0. The angle is undefined; 0
 *    keeps the pair below any positive similarity threshold instead of NaN.
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * embeddingPath — sibling path of the `<key>.json` cache entry holding its query
 * embedding as raw little-endian float32 bytes.
 */
function embeddingPath(key) {
  return join(CONFIG.cacheDir, `${key}.embedding`);
}

/**
 * indexPath — the single inline-vector reverse index in the cache dir
 * (Phase 3, Unit 5). Maps `<key>` → its embedding so semanticLookup can score
 * every candidate from one read instead of scanning every `.embedding` file.
 */
function indexPath() {
  return join(CONFIG.cacheDir, 'index.json');
}

/**
 * readCacheIndex — load the reverse index, or `{}` on any problem (absent file,
 * malformed JSON, a non-object/array root). Pure read; never throws. Callers
 * treat an empty result as "no index" and fall back to the `.embedding` scan.
 */
async function readCacheIndex() {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

/**
 * updateCacheIndex — best-effort upsert of one key's embedding into index.json
 * (Phase 3, Unit 5). Stores the vector inline as a plain number array so
 * semanticLookup can score all candidates from a single read (no per-file
 * `.embedding` I/O). Read-modify-write with an atomic tmp+rename; the `.embedding`
 * sidecars remain the source of truth, so a failed or stale index is non-fatal —
 * lookup falls back to scanning the files. Gated on semanticCache (zero I/O when
 * off) and wrapped in try/catch so an index failure never breaks the embedding
 * write or the hook. Returns true iff the index was rewritten.
 *
 * Race note: concurrent hook invocations do last-writer-wins on this file (same
 * tradeoff the plan accepts for the JSON cache). A lost update just drops one
 * key from the index until its next save; the file scan still covers it.
 */
async function updateCacheIndex(key, vec) {
  if (!CONFIG.semanticCache) return false;
  try {
    const index = await readCacheIndex();
    index[key] = { dim: vec.length, vec: Array.from(vec) };
    await mkdir(CONFIG.cacheDir, { recursive: true });
    const file = indexPath();
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, file);
    return true;
  } catch (err) {
    await log(`Cache index update failed (lookup will fall back to file scan): ${String(err?.message ?? err)}`);
    return false;
  }
}

/**
 * saveCacheEmbedding — best-effort companion write to saveCache (Phase 3, Unit
 * 3). When semantic caching is enabled and an embedding API key is available,
 * embeds `text` and persists the vector as raw float32 bytes next to the JSON
 * entry so semantic lookup (Unit 4) can score cosine similarity against it.
 *
 * Fully gated behind CONFIG.semanticCache: with the flag off this returns
 * immediately doing zero I/O, so default behavior is byte-identical to before.
 * Every failure mode — no key, embedText throwing (it throws on all errors),
 * write errors — is caught and logged; a failed embedding must NEVER break the
 * cache write or the hook (the JSON entry is written independently before this).
 * `embedImpl` is injectable for tests. Returns true iff an embedding was written.
 */
async function saveCacheEmbedding(key, text, { embedImpl = embedText } = {}) {
  if (!CONFIG.semanticCache) return false;
  if (!CONFIG.embedApiKey) {
    await log('Semantic cache enabled but no embedding API key — skipping embedding write');
    return false;
  }
  try {
    const vec = await embedImpl(text, CONFIG.embedApiKey);
    await mkdir(CONFIG.cacheDir, { recursive: true });
    const file = embeddingPath(key);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
    // Mirror the vector into the reverse index (best-effort; the .embedding
    // file is the source of truth, so an index failure is non-fatal).
    await updateCacheIndex(key, vec);
    await log(`Wrote semantic embedding ${key.slice(0, 16)}... (dim ${vec.length})`);
    return true;
  } catch (err) {
    await log(`Embedding write failed (degrading to SHA-256 cache): ${String(err?.message ?? err)}`);
    return false;
  }
}

/**
 * scoreFromIndex — Phase 3, Unit 5. Score the query vector against every entry
 * in index.json (vectors stored inline), returning `{ bestKey, bestScore }` or
 * null when the index is empty / has no usable vector. A single read replaces
 * the per-file `.embedding` scan. Foreign-dimension vectors throw in `simImpl`
 * and are skipped per-entry; a null return signals the caller to fall back to
 * the file scan (the index may simply not exist yet).
 */
async function scoreFromIndex(queryVec, simImpl) {
  const index = await readCacheIndex();
  const keys = Object.keys(index);
  if (keys.length === 0) return null;
  let bestKey = null;
  let bestScore = -Infinity;
  for (const key of keys) {
    const arr = index[key] && index[key].vec;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    try {
      const score = simImpl(queryVec, Float32Array.from(arr));
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    } catch {
      // foreign-dimension / bad vector — skip this entry
    }
  }
  return bestKey === null ? null : { bestKey, bestScore };
}

/**
 * scoreFromFiles — Phase 3, Unit 5 (the robust fallback, formerly the body of
 * semanticLookup). Read every `<hash>.embedding` sidecar, score it, and return
 * `{ bestKey, bestScore }` or null when none are usable. Per-file try/catch so
 * one corrupt/short/foreign vector is skipped without aborting the scan.
 */
async function scoreFromFiles(queryVec, simImpl) {
  let files;
  try {
    files = await readdir(CONFIG.cacheDir);
  } catch {
    return null; // cache dir absent → nothing to match against
  }
  let bestKey = null;
  let bestScore = -Infinity;
  for (const f of files) {
    if (!f.endsWith('.embedding')) continue;
    try {
      const buf = await readFile(join(CONFIG.cacheDir, f));
      if (buf.length === 0 || buf.length % 4 !== 0) continue; // truncated tail
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      const score = simImpl(queryVec, vec);
      if (score > bestScore) {
        bestScore = score;
        bestKey = f.slice(0, -('.embedding'.length));
      }
    } catch {
      // corrupt/foreign vector — skip this file, keep scanning
    }
  }
  return bestKey === null ? null : { bestKey, bestScore };
}

/**
 * semanticLookup — Phase 3, Unit 4 + 5. On a SHA-256 cache miss, find the
 * best-matching cache entry by cosine similarity and return it when the score
 * meets CONFIG.semanticThreshold (default 0.92). Returns null on any miss or
 * failure, so the caller falls through to invoking Haiku.
 *
 * Unit 5: prefer the single-read inline-vector index.json; fall back to the
 * per-file `.embedding` scan when the index is absent/empty/corrupt (or yields
 * no usable vector). The `.embedding` files remain the source of truth, so the
 * file scan is always a correct backstop if the index lags behind.
 *
 * Fully gated behind CONFIG.semanticCache + an embedding API key: with the flag
 * off (or no key) it returns null immediately doing zero I/O, so default
 * behavior is byte-identical to before. The whole body is best-effort — any
 * failure (embed throw, readdir error, every vector corrupt) degrades to a
 * plain miss and never throws.
 *
 * Per-file robustness: each `.embedding` is read and scored inside its own
 * try/catch, so one corrupt/short/foreign-dimension vector (cosineSimilarity
 * throws on length mismatch) is skipped without aborting the scan.
 *
 * Caveat: embeddings are keyed by `userMessage` only, but cache keys also fold
 * in cwd, so a high-similarity hit can come from a different cwd. Acceptable for
 * now — the analysis is file-pointer guidance the main model re-validates; a
 * cwd sidecar could tighten this later. `embedText` is fed `userMessage` here,
 * matching exactly what saveCacheEmbedding (Unit 3) stored.
 *
 * Injectables (embedImpl / simImpl / checkImpl) keep it unit-testable.
 */
async function semanticLookup(queryText, {
  embedImpl = embedText,
  simImpl = cosineSimilarity,
  checkImpl = checkCache,
} = {}) {
  if (!CONFIG.semanticCache) return null;
  if (!CONFIG.embedApiKey) return null;
  try {
    const queryVec = await embedImpl(queryText, CONFIG.embedApiKey);
    // Index-first (one read), then the robust per-file scan as a fallback.
    let best = await scoreFromIndex(queryVec, simImpl);
    if (best === null) best = await scoreFromFiles(queryVec, simImpl);
    if (best === null) {
      await log('Semantic cache miss (no candidate embeddings)');
      return null;
    }
    const { bestKey, bestScore } = best;
    if (bestScore < CONFIG.semanticThreshold) {
      await log(`Semantic cache miss (best ${bestScore.toFixed(4)} < ${CONFIG.semanticThreshold})`);
      return null;
    }
    const entry = await checkImpl(bestKey);
    if (!entry) {
      // matched an embedding whose JSON expired or vanished — treat as a miss
      await log(`Semantic match ${bestKey.slice(0, 16)}... (${bestScore.toFixed(4)}) but entry gone`);
      return null;
    }
    await log(`Semantic cache hit ${bestKey.slice(0, 16)}... (cosine ${bestScore.toFixed(4)} ≥ ${CONFIG.semanticThreshold})`);
    return entry;
  } catch (err) {
    await log(`Semantic lookup failed (degrading to Haiku): ${String(err?.message ?? err)}`);
    return null;
  }
}

// =============================================================================
// RESPONSE PARSING
// =============================================================================

function parseHaikuResponse(response) {
  // 1. Direct JSON parse
  try {
    return JSON.parse(response.trim());
  } catch {}

  // 2. JSON inside markdown code block
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }

  // 3. Any JSON object in the response (non-greedy to avoid spanning multiple objects)
  const objectMatch = response.match(/\{[\s\S]*?\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  return { skip_rlm: true, skip_reason: 'Could not parse Haiku response' };
}

// =============================================================================
// OUTPUT FORMATTING
// =============================================================================

function formatOutput(analysis) {
  // Agentic mode produces a rich structure with relevant_files
  if (CONFIG.agenticMode && analysis.relevant_files) {
    const intent = analysis.intent || 'unknown';
    const summary = analysis.summary || '';
    const files = (analysis.relevant_files || []).map(f =>
      typeof f === 'string' ? f : `${f.path} (${f.purpose || 'unknown'})`
    ).join('; ');
    const patterns = (analysis.existing_patterns || []).join('; ');
    const tasks = (analysis.tasks || []).join('; ');
    const approach = analysis.approach || 'N/A';
    const warnings = (analysis.warnings || []).join('; ');
    const recentChanges = analysis.recent_changes || '';

    let output = `<rlm_preresearch>
${JSON.stringify(analysis, null, 2)}
</rlm_preresearch>

PRERESEARCH COMPLETE:
Intent: ${intent}
Summary: ${summary}
Relevant Files: ${files}
Existing Patterns: ${patterns}
Recent Changes: ${recentChanges}
Tasks: ${tasks}
Approach: ${approach}`;
    if (warnings) output += `\nWarnings: ${warnings}`;
    return output;
  }

  // Fast mode: compact structure
  if (CONFIG.fastMode) {
    const intent = analysis.intent || 'unknown';
    const tasks = (analysis.tasks || []).join('; ');
    const tech = (analysis.tech || []).join(', ');
    const files = (analysis.files || []).join(', ');
    const approach = analysis.approach || 'N/A';

    let output = `<rlm_analysis>
${JSON.stringify(analysis, null, 2)}
</rlm_analysis>

RLM: ${intent} | Tasks: ${tasks}`;
    if (tech) output += ` | Tech: ${tech}`;
    if (files) output += ` | Files: ${files}`;
    output += ` | Approach: ${approach}`;
    return output;
  }

  // Detailed mode
  const intent = analysis.intent?.primary || 'unknown';
  const confidence = analysis.intent?.confidence || 'N/A';
  const tasks = (analysis.decomposition || [])
    .slice(0, 3)
    .map(t => t.task)
    .join('; ');
  const approach = analysis.suggested_approach || 'N/A';
  const domain = analysis.implicit_context?.domain || 'general';
  const technologies = (analysis.implicit_context?.relevant_technologies || []).join(', ') || 'N/A';

  return `<rlm_analysis>
${JSON.stringify(analysis, null, 2)}
</rlm_analysis>

RLM Pre-Analysis Summary:
- Intent: ${intent} (confidence: ${confidence})
- Key Tasks: ${tasks || 'N/A'}
- Approach: ${approach}
- Domain: ${domain}
- Technologies: ${technologies}`;
}

// =============================================================================
// STDIN READER
// =============================================================================

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  try {
    const input = await readStdin();

    let userMessage = input;
    let cwd = null;
    let transcriptPath = null;

    // Claude Code hook format: JSON with prompt, cwd, transcript_path
    try {
      const hookInput = JSON.parse(input);
      userMessage = hookInput.prompt || hookInput.message || hookInput.input || hookInput.content || input;
      cwd = hookInput.cwd || null;
      transcriptPath = hookInput.transcript_path || null;
    } catch {
      // Fall back to treating raw input as the message
    }

    await log(`Processing input of length ${userMessage.length}${cwd ? ` in ${cwd}` : ''}`);

    // Skip detection (before cache check to avoid hashing)
    const skipCheck = shouldSkipRLM(userMessage);
    if (skipCheck.skip) {
      await log(`Skipping RLM: ${skipCheck.reason}`);
      process.exit(0);
    }

    // Cache lookup — include cwd so the same prompt in different projects doesn't collide
    const cacheKey = getCacheKey(userMessage + '\0' + (cwd || ''));
    const cached = await checkCache(cacheKey);
    if (cached) {
      await log(`Cache hit for ${cacheKey.slice(0, 16)}...`);
      console.log(formatOutput(cached));
      process.exit(0);
    }

    // Semantic cache lookup (Phase 3, Unit 4) — on a SHA-256 miss, score the
    // query against stored embeddings and reuse the nearest analysis above
    // threshold. Fully gated + best-effort: returns null (proceed to Haiku)
    // when semantic caching is off, keyless, or on any failure. Embeds
    // `userMessage` to match what saveCacheEmbedding stored.
    const semanticHit = await semanticLookup(userMessage);
    if (semanticHit) {
      console.log(formatOutput(semanticHit));
      process.exit(0);
    }

    // Truncate long inputs
    let truncatedMessage = userMessage;
    if (userMessage.length > CONFIG.maxInputLength) {
      truncatedMessage = userMessage.slice(0, CONFIG.maxInputLength) + '... [truncated]';
      await log(`Input truncated to ${CONFIG.maxInputLength} characters`);
    }

    // Gather project and conversation context
    const projectContext = CONFIG.gatherContext ? await gatherProjectContext(cwd) : null;
    const conversationContext = CONFIG.gatherContext
      ? await gatherConversationContext(transcriptPath)
      : null;

    if (projectContext) {
      await log(`Project context: ${projectContext.projectType || 'unknown'} with ${projectContext.techStack.length} items in stack`);
    }

    // Invoke Haiku — clean up scratch file in finally so it runs even on throw
    const prompt = buildRLMPrompt(truncatedMessage, projectContext, conversationContext);
    const scratchFile = CONFIG.agenticMode && cwd ? join(cwd, '.claude', 'rlm-scratch.md') : null;

    let response = null;

    // SDK-Direct path (Phase 2): any non-agentic mode (fast or detailed) can skip
    // the subprocess entirely — both are single-turn, tool-free calls that differ
    // only in the prompt. On any SDK error, fall through to the subprocess so the
    // hook never breaks just because the SDK/key path is misconfigured.
    if (shouldUseSDK() && !CONFIG.agenticMode) {
      const label = CONFIG.fastMode ? 'fast' : 'detailed';
      try {
        response = CONFIG.fastMode
          ? await callHaikuFastSDK(prompt, CONFIG.apiKey)
          : await callHaikuDetailedSDK(prompt, CONFIG.apiKey);
        await log(`Used SDK-Direct ${label} path`);
      } catch (err) {
        await log(`SDK ${label} path failed, falling back to subprocess: ${String(err?.message ?? err)}`);
        response = null;
      }
    }

    // SDK-Direct agentic path (Phase 2, Unit 5): drive the tool-use loop directly
    // instead of spawning the CLI. Cleans up its own pid-scoped scratch file. On
    // any SDK error, fall through to the subprocess path below.
    if (response === null && shouldUseSDK() && CONFIG.agenticMode) {
      try {
        response = await callHaikuAgenticSDK(prompt, CONFIG.apiKey, cwd);
        await log('Used SDK-Direct agentic path');
      } catch (err) {
        await log(`SDK agentic path failed, falling back to subprocess: ${String(err?.message ?? err)}`);
        response = null;
      } finally {
        try { await rm(sdkScratchPath(cwd), { force: true }); } catch {}
      }
    }

    if (response === null) {
      try {
        response = await invokeHaiku(prompt, cwd);
      } finally {
        if (scratchFile) {
          try { await rm(scratchFile, { force: true }); } catch {}
        }
      }
    }

    // Parse and validate
    const analysis = parseHaikuResponse(response);

    if (analysis.skip_rlm || analysis.skip) {
      await log(`RLM skipped by Haiku: ${analysis.skip_reason || analysis.reason}`);
      process.exit(0);
    }

    // Cache and output. The embedding write is best-effort and fully gated
    // behind CONFIG.semanticCache — it never blocks output or breaks the hook.
    await saveCache(cacheKey, analysis);
    await saveCacheEmbedding(cacheKey, userMessage);
    console.log(formatOutput(analysis));

    await log('RLM analysis complete');
  } catch (error) {
    await log(`ERROR: ${String(error?.message ?? error)}`);
    // Always exit 0 — never block the user's conversation
    process.exit(0);
  }
}

main();
