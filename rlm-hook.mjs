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
import { mkdir, readFile, writeFile, stat, rm } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// --version flag
if (process.argv.includes('--version')) {
  console.log('0.1.0');
  process.exit(0);
}

// Configuration — all values overridable via environment variables
const CONFIG = {
  minInputLength: parseInt(process.env.RLM_MIN_LENGTH || '20', 10),
  maxInputLength: parseInt(process.env.RLM_MAX_LENGTH || '4000', 10),
  cacheTTL: parseInt(process.env.RLM_CACHE_TTL || '3600', 10), // seconds
  haikuModel: process.env.RLM_MODEL || 'claude-haiku-4-5-20251001',
  timeout: parseInt(process.env.RLM_TIMEOUT || '60000', 10), // ms
  cacheDir: process.env.RLM_CACHE_DIR || join(homedir(), '.cache', 'rlm-hook'),
  logFile: process.env.RLM_LOG_FILE || join(homedir(), '.local', 'share', 'rlm-hook', 'rlm-hook.log'),
  // Agentic mode: allow Haiku to use tools (Read, Glob, Grep, Write, Bash) to explore the codebase
  agenticMode: process.env.RLM_AGENTIC_MODE !== 'false',
  // Max turns for agentic exploration (each turn = one tool call cycle)
  maxTurns: parseInt(process.env.RLM_MAX_TURNS || '10', 10),
  // Fast mode: concise prompt (~3s) vs detailed (~9s). Default: fast
  fastMode: process.env.RLM_FAST_MODE !== 'false',
  // Context gathering: detect project type, git state, recent files
  gatherContext: process.env.RLM_GATHER_CONTEXT !== 'false',
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
  await writeFile(cacheFile, JSON.stringify(data, null, 2));
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
          const text = entry.message?.content || entry.content || '';
          if (text && typeof text === 'string') {
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
    } else {
      // No tools — pure text analysis
      args.push('--allowedTools', '');
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workingDir || process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
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

  // 3. Any JSON object in the response
  const objectMatch = response.match(/\{[\s\S]*\}/);
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

    // Cache lookup
    const cacheKey = getCacheKey(userMessage);
    const cached = await checkCache(cacheKey);
    if (cached) {
      await log(`Cache hit for ${cacheKey.slice(0, 16)}...`);
      console.log(formatOutput(cached));
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

    // Invoke Haiku
    const prompt = buildRLMPrompt(truncatedMessage, projectContext, conversationContext);
    const response = await invokeHaiku(prompt, cwd);

    // Safety net: clean up scratch file if Haiku didn't delete it
    if (CONFIG.agenticMode && cwd) {
      const scratchFile = join(cwd, '.claude', 'rlm-scratch.md');
      try {
        await rm(scratchFile, { force: true });
      } catch {}
    }

    // Parse and validate
    const analysis = parseHaikuResponse(response);

    if (analysis.skip_rlm || analysis.skip) {
      await log(`RLM skipped by Haiku: ${analysis.skip_reason || analysis.reason}`);
      process.exit(0);
    }

    // Cache and output
    await saveCache(cacheKey, analysis);
    console.log(formatOutput(analysis));

    await log('RLM analysis complete');
  } catch (error) {
    await log(`ERROR: ${error.message}`);
    // Always exit 0 — never block the user's conversation
    process.exit(0);
  }
}

main();
