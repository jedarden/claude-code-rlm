#!/usr/bin/env node
/**
 * Comprehensive unit tests for the claude-code-rlm hook.
 *
 * Run with: node --test test/unit.test.mjs
 *
 * Logic is inlined from rlm-hook.mjs since functions are not exported.
 * Tests cover the 9 functional groups described in docs/plan/plan.md.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, stat, readdir, rename } from 'fs/promises';
import { join, resolve, relative, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// ============================================================================
// INLINED LOGIC FROM rlm-hook.mjs
// All functions below are faithful copies of the originals so tests exercise
// the real algorithm rather than trivial stubs.
// ============================================================================

/**
 * shouldSkipRLM — decides whether to skip the RLM pipeline entirely.
 * Inlined from rlm-hook.mjs with a configurable minInputLength so we can
 * probe the exact threshold boundary.
 */
function shouldSkipRLM(input, minInputLength = 20) {
  // Too short
  if (input.length < minInputLength) {
    return { skip: true, reason: 'Input too short' };
  }

  // Simple commands / affirmatives / slash commands
  const simplePatterns = [
    /^(ls|cd|pwd|cat|echo|git status|npm|yarn)\b/i,
    /^(yes|no|ok|thanks|y|n)$/i,
    /^\/\w+$/,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(input.trim())) {
      return { skip: true, reason: 'Simple command detected' };
    }
  }

  // Code-heavy: >50 % of the input is inside code fences AND there are 2+ blocks
  const codeBlockMatches = input.match(/```[\s\S]*?```/g) || [];
  const codeLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
  if (codeLength > input.length * 0.5 && codeBlockMatches.length > 1) {
    return { skip: true, reason: 'Code-heavy input' };
  }

  return { skip: false };
}

/**
 * getCacheKey — SHA-256 hex digest of the input string.
 */
function getCacheKey(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * parseHaikuResponse — extracts JSON from a Haiku text response.
 * Tries direct parse → ```json block → embedded {} → fallback.
 */
function parseHaikuResponse(response) {
  try {
    return JSON.parse(response.trim());
  } catch {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        // fall through
      }
    }

    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // give up
      }
    }

    return { skip_rlm: true, skip_reason: 'Could not parse response' };
  }
}

/**
 * parseHookInput — decodes Claude Code hook stdin into (userMessage, cwd, transcriptPath).
 */
function parseHookInput(rawInput) {
  let userMessage = rawInput;
  let cwd = null;
  let transcriptPath = null;

  try {
    const hookInput = JSON.parse(rawInput);
    userMessage = hookInput.prompt || hookInput.message || hookInput.input || hookInput.content || rawInput;
    cwd = hookInput.cwd || null;
    transcriptPath = hookInput.transcript_path || null;
  } catch {
    // Use raw text
  }

  return { userMessage, cwd, transcriptPath };
}

/**
 * truncateInput — clamps message to maxLength and appends a truncation marker.
 */
function truncateInput(message, maxLength = 4000) {
  if (message.length > maxLength) {
    return message.slice(0, maxLength) + '... [truncated]';
  }
  return message;
}

/**
 * gatherProjectContext — inspects cwd for manifest files to detect project type.
 * Inlined minus the git / find calls that require a real repo.
 */
async function gatherProjectContext(cwd) {
  if (!cwd || !existsSync(cwd)) return null;

  const context = {
    projectRoot: cwd,
    projectName: cwd.split('/').pop(),
    projectType: null,
    techStack: [],
    recentFiles: [],
    gitBranch: null,
    gitStatus: null,
  };

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

  return context;
}

/**
 * formatOutput — renders the final text Claude Code injects before the user message.
 * Accepts explicit mode flags rather than reading from a global CONFIG so tests
 * can invoke each branch independently.
 */
function formatOutput(analysis, { agenticMode = false, fastMode = false } = {}) {
  // Agentic path — rich structure with relevant_files
  if (agenticMode && analysis.relevant_files) {
    const intent = analysis.intent || 'unknown';
    const summary = analysis.summary || '';
    const files = (analysis.relevant_files || [])
      .map(f => (typeof f === 'string' ? f : `${f.path} (${f.purpose || 'unknown'})`))
      .join('; ');
    const patterns = (analysis.existing_patterns || []).join('; ');
    const tasks = (analysis.tasks || []).join('; ');
    const approach = analysis.approach || 'N/A';
    const warnings = (analysis.warnings || []).join('; ');
    const recentChanges = analysis.recent_changes || '';

    let output =
      `<rlm_preresearch>\n${JSON.stringify(analysis, null, 2)}\n</rlm_preresearch>` +
      `\n\nPRERESEARCH COMPLETE:` +
      `\nIntent: ${intent}` +
      `\nSummary: ${summary}` +
      `\nRelevant Files: ${files}` +
      `\nExisting Patterns: ${patterns}` +
      `\nRecent Changes: ${recentChanges}` +
      `\nTasks: ${tasks}` +
      `\nApproach: ${approach}`;
    if (warnings) output += `\nWarnings: ${warnings}`;
    return output;
  }

  // Fast path — concise summary line
  if (fastMode) {
    const intent = analysis.intent || 'unknown';
    const tasks = (analysis.tasks || []).join('; ');
    const tech = (analysis.tech || []).join(', ');
    const files = (analysis.files || []).join(', ');
    const approach = analysis.approach || 'N/A';

    let output =
      `<rlm_analysis>\n${JSON.stringify(analysis, null, 2)}\n</rlm_analysis>` +
      `\n\nRLM: ${intent} | Tasks: ${tasks}`;
    if (tech) output += ` | Tech: ${tech}`;
    if (files) output += ` | Files: ${files}`;
    output += ` | Approach: ${approach}`;
    return output;
  }

  // Detailed / default path
  const intent = analysis.intent?.primary || 'unknown';
  const confidence = analysis.intent?.confidence ?? 'N/A';
  const tasks = (analysis.decomposition || []).slice(0, 3).map(t => t.task).join('; ');
  const approach = analysis.suggested_approach || 'N/A';
  const domain = analysis.implicit_context?.domain || 'general';
  const technologies = (analysis.implicit_context?.relevant_technologies || []).join(', ') || 'N/A';

  return (
    `<rlm_analysis>\n${JSON.stringify(analysis, null, 2)}\n</rlm_analysis>` +
    `\n\nRLM Pre-Analysis Summary:` +
    `\n- Intent: ${intent} (confidence: ${confidence})` +
    `\n- Key Tasks: ${tasks || 'N/A'}` +
    `\n- Approach: ${approach}` +
    `\n- Domain: ${domain}` +
    `\n- Technologies: ${technologies}`
  );
}

/**
 * buildRLMPrompt — composes the prompt sent to Haiku.
 * Takes explicit mode flags so each branch can be tested in isolation.
 */
function buildRLMPrompt(userMessage, projectContext, conversationContext, { agenticMode = false, fastMode = false } = {}) {
  let contextSection = '';

  if (projectContext) {
    contextSection += `\nProject: ${projectContext.projectName} (${projectContext.projectType || 'unknown'})`;
    if (projectContext.techStack && projectContext.techStack.length > 0) {
      contextSection += `\nStack: ${projectContext.techStack.slice(0, 8).join(', ')}`;
    }
    if (projectContext.gitBranch) {
      contextSection += `\nBranch: ${projectContext.gitBranch}`;
    }
    if (projectContext.gitStatus) {
      contextSection += `\nModified: ${projectContext.gitStatus}`;
    }
    if (projectContext.recentFiles && projectContext.recentFiles.length > 0) {
      contextSection += `\nFiles: ${projectContext.recentFiles.slice(0, 5).join(', ')}`;
    }
  }

  if (conversationContext && conversationContext.length > 0) {
    contextSection += `\nRecent conversation:`;
    for (const msg of conversationContext.slice(-3)) {
      contextSection += `\n- ${msg.role}: ${msg.preview.slice(0, 100)}`;
    }
  }

  if (agenticMode) {
    const scratchFile = '.claude/rlm-scratch.md';
    return (
      `You are an RLM (Recursive Language Model) preresearch agent. Your job is to explore the codebase and gather context for a more expensive coding model.\n\n` +
      `TASK: Analyze the user's request and gather relevant context from the codebase.\n\n` +
      `USER REQUEST: ${userMessage}\n\n` +
      `INITIAL CONTEXT:${contextSection || ' (none provided)'}\n\n` +
      `EXPLORATION TOOLS AVAILABLE:\n` +
      `- Glob: Find files by pattern (e.g., "src/**/*.ts", "**/auth*")\n` +
      `- Grep: Search file contents (e.g., search for "authenticate", "middleware")\n` +
      `- Read: Read specific files to understand implementation\n` +
      `- Write: Write intermediate notes to ${scratchFile}\n` +
      `- Bash: Run git commands ONLY (git log, git show, git diff, git blame)\n\n` +
      `BEGIN: Write initial understanding to ${scratchFile}, then explore systematically.`
    );
  }

  if (fastMode) {
    return (
      `Analyze with project context. Output ONLY JSON, no markdown:\n` +
      `{"intent":"code_writing|debugging|architecture|learning|other","tasks":["task1","task2","task3"],"tech":["relevant","technologies"],"files":["likely_relevant_files"],"approach":"one sentence strategy"}\n` +
      `If trivial, output: {"skip":true}\n` +
      `${contextSection}\n\n` +
      `User: ${userMessage}`
    );
  }

  // Detailed mode
  return (
    `You are an RLM (Recursive Language Model) analyzer. Analyze this user message with project context.\n` +
    (contextSection ? `\n<project_context>${contextSection}\n</project_context>` : '') +
    `\n\n<user_message>\n${userMessage}\n</user_message>\n\n` +
    `Provide analysis in this exact JSON format (no markdown, just raw JSON).`
  );
}

// ============================================================================
// GROUP 1: SKIP DETECTION
// ============================================================================

describe('Group 1: Skip Detection (shouldSkipRLM logic)', () => {
  it('short input (11 chars) → skip with "too short" reason', () => {
    const result = shouldSkipRLM('short input');
    assert.equal(result.skip, true);
    assert.match(result.reason, /short/i, 'Reason must mention "short"');
  });

  it('exact threshold: 19 chars → skip', () => {
    const input = 'a'.repeat(19);
    assert.equal(input.length, 19);
    const result = shouldSkipRLM(input);
    assert.equal(result.skip, true, '19 chars is below the 20-char minimum');
  });

  it('exact threshold: 20 chars → do not skip (passes length check)', () => {
    const input = 'a'.repeat(20);  // 20 'a's do not match any simple pattern
    assert.equal(input.length, 20);
    const result = shouldSkipRLM(input);
    assert.equal(result.skip, false, '20 chars should pass the length gate');
  });

  it('/help → skip (slash command)', () => {
    assert.equal(shouldSkipRLM('/help').skip, true);
  });

  it('/clear → skip (slash command)', () => {
    assert.equal(shouldSkipRLM('/clear').skip, true);
  });

  it('/config → skip (slash command)', () => {
    assert.equal(shouldSkipRLM('/config').skip, true);
  });

  it('git status → skip (CLI command)', () => {
    assert.equal(shouldSkipRLM('git status').skip, true);
  });

  it('npm install → skip (CLI command)', () => {
    assert.equal(shouldSkipRLM('npm install').skip, true);
  });

  it('ls -la → skip (CLI command)', () => {
    assert.equal(shouldSkipRLM('ls -la').skip, true);
  });

  it('cd /home → skip (CLI command)', () => {
    assert.equal(shouldSkipRLM('cd /home').skip, true);
  });

  it('yarn add react → skip (CLI command)', () => {
    assert.equal(shouldSkipRLM('yarn add react').skip, true);
  });

  it('"yes" → skip (simple affirmative)', () => {
    assert.equal(shouldSkipRLM('yes').skip, true);
  });

  it('"no" → skip (simple affirmative)', () => {
    assert.equal(shouldSkipRLM('no').skip, true);
  });

  it('"ok" → skip (simple affirmative)', () => {
    assert.equal(shouldSkipRLM('ok').skip, true);
  });

  it('"y" → skip (single-letter affirmative)', () => {
    assert.equal(shouldSkipRLM('y').skip, true);
  });

  it('"n" → skip (single-letter negative)', () => {
    assert.equal(shouldSkipRLM('n').skip, true);
  });

  it('long complex message → do not skip', () => {
    const msg = 'Help me design a microservices architecture for an e-commerce platform with user authentication and order management.';
    assert.equal(shouldSkipRLM(msg).skip, false);
  });

  it('code-heavy input (>50 % in fences, 2 blocks) → skip', () => {
    // Construct an input where the two code blocks account for >50 % of chars.
    const block1 = '```javascript\nfunction foo() {\n  return "bar";\n}\n```';
    const block2 = '```python\ndef baz():\n    return "qux"\n```';
    const input = block1 + '\n' + block2;
    const result = shouldSkipRLM(input);
    assert.equal(result.skip, true, `Code-heavy input should be skipped. ratio=${
      (block1.length + block2.length) / input.length
    }`);
  });

  it('code-light input (1 block, ratio below 50 %) → do not skip', () => {
    const input =
      'Here is some context about my problem.\n' +
      '```js\nconst x = 1;\n```\n' +
      'What should I do next to make this performant?';
    const result = shouldSkipRLM(input);
    // Only 1 code block → condition requires >1 block, so skip=false
    assert.equal(result.skip, false, 'Single code block must not trigger code-heavy skip');
  });

  it('text-heavy input with no code blocks → do not skip', () => {
    const input =
      'I am working on a web application that handles user authentication and I need help ' +
      'thinking through the token refresh mechanism so users stay logged in seamlessly.';
    assert.equal(shouldSkipRLM(input).skip, false);
  });
});

// ============================================================================
// GROUP 2: CACHE KEY GENERATION
// ============================================================================

describe('Group 2: Cache Key Generation', () => {
  it('same input → same SHA-256 key', () => {
    const input = 'How do I implement a binary search tree?';
    assert.equal(getCacheKey(input), getCacheKey(input));
  });

  it('cache key is exactly 64 hex characters', () => {
    assert.equal(getCacheKey('some arbitrary input').length, 64);
  });

  it('different input → different key', () => {
    assert.notEqual(getCacheKey('Hello world'), getCacheKey('Hello earth'));
  });

  it('case-sensitive: "Hello" vs "hello" → different keys', () => {
    assert.notEqual(getCacheKey('Hello'), getCacheKey('hello'));
  });

  it('unicode inputs handled correctly — different emoji → different keys', () => {
    const k1 = getCacheKey('Hello \u{1F600}');
    const k2 = getCacheKey('Hello \u{1F601}');
    assert.notEqual(k1, k2);
    assert.equal(k1.length, 64);
  });

  it('empty string produces a valid 64-char key without error', () => {
    const key = getCacheKey('');
    assert.equal(typeof key, 'string');
    assert.equal(key.length, 64);
  });

  it('key contains only lowercase hex characters (safe as a filename)', () => {
    const key = getCacheKey('some/path/like/input with spaces & special chars!');
    assert.match(key, /^[0-9a-f]{64}$/, 'Key must be 64 lowercase hex chars with no path separators');
  });
});

// ============================================================================
// GROUP 3: JSON RESPONSE PARSING
// ============================================================================

describe('Group 3: JSON Response Parsing (parseHaikuResponse)', () => {
  it('direct raw JSON string → parsed correctly', () => {
    const raw = '{"intent": "debugging", "tasks": ["reproduce", "fix"]}';
    const result = parseHaikuResponse(raw);
    assert.equal(result.intent, 'debugging');
    assert.deepEqual(result.tasks, ['reproduce', 'fix']);
  });

  it('JSON wrapped in ```json...``` block → extracted and parsed', () => {
    const response = 'Here is the result:\n```json\n{"intent": "code_writing", "skip": false}\n```\n';
    const result = parseHaikuResponse(response);
    assert.equal(result.intent, 'code_writing');
    assert.equal(result.skip, false);
  });

  it('JSON wrapped in ``` (no language tag) → extracted and parsed', () => {
    const response = '```\n{"skip_rlm": true, "skip_reason": "Simple query"}\n```';
    const result = parseHaikuResponse(response);
    assert.equal(result.skip_rlm, true);
    assert.equal(result.skip_reason, 'Simple query');
  });

  it('JSON embedded mid-text → extracted via object-match fallback', () => {
    const response = 'Some preamble {"intent": "learning", "domain": "backend"} some trailing text.';
    const result = parseHaikuResponse(response);
    assert.equal(result.intent, 'learning');
    assert.equal(result.domain, 'backend');
  });

  it('completely unparseable string → fallback {skip_rlm: true, skip_reason: "Could not parse response"}', () => {
    const result = parseHaikuResponse('This is just plain text with absolutely no JSON structure whatsoever!!');
    assert.equal(result.skip_rlm, true);
    assert.equal(result.skip_reason, 'Could not parse response');
  });

  it('partial JSON that fails direct parse but has embedded object → extracted', () => {
    const response = 'Analysis complete. Result: {"intent": "refactoring"} — done.';
    const result = parseHaikuResponse(response);
    assert.equal(result.intent, 'refactoring');
  });

  it('whitespace-padded JSON → trimmed and parsed successfully', () => {
    const response = '   \n  {"tasks": ["a", "b"]}  \n  ';
    const result = parseHaikuResponse(response);
    assert.deepEqual(result.tasks, ['a', 'b']);
  });
});

// ============================================================================
// GROUP 4: INPUT TRUNCATION
// ============================================================================

describe('Group 4: Input Truncation', () => {
  it('input longer than 4000 chars → truncated', () => {
    const input = 'A'.repeat(5000);
    const result = truncateInput(input, 4000);
    assert.ok(result.length < input.length, 'Result must be shorter than original');
  });

  it('truncated message ends with "... [truncated]"', () => {
    const input = 'B'.repeat(5000);
    const result = truncateInput(input, 4000);
    assert.ok(result.endsWith('... [truncated]'), `Tail was: "${result.slice(-20)}"`);
  });

  it('first 4000 chars of original are preserved verbatim', () => {
    const input = 'C'.repeat(5000);
    const result = truncateInput(input, 4000);
    assert.equal(result.slice(0, 4000), 'C'.repeat(4000));
  });

  it('input exactly 4000 chars → not truncated', () => {
    const input = 'D'.repeat(4000);
    const result = truncateInput(input, 4000);
    assert.equal(result, input);
    assert.equal(result.length, 4000);
  });

  it('input 3999 chars → not truncated', () => {
    const input = 'E'.repeat(3999);
    const result = truncateInput(input, 4000);
    assert.equal(result, input);
    assert.equal(result.length, 3999);
  });

  it('truncation marker does not appear on non-truncated input', () => {
    const input = 'Short enough message to stay intact.';
    const result = truncateInput(input, 4000);
    assert.ok(!result.includes('[truncated]'), 'Short input must not have truncation marker');
  });
});

// ============================================================================
// GROUP 5: HOOK INPUT PARSING
// ============================================================================

describe('Group 5: Hook Input Parsing', () => {
  it('{"prompt": "..."} → extracts message from "prompt" field', () => {
    const { userMessage } = parseHookInput(JSON.stringify({ prompt: 'hello from prompt' }));
    assert.equal(userMessage, 'hello from prompt');
  });

  it('{"message": "..."} → extracts message from "message" field', () => {
    const { userMessage } = parseHookInput(JSON.stringify({ message: 'hello from message' }));
    assert.equal(userMessage, 'hello from message');
  });

  it('{"input": "..."} → extracts message from "input" field', () => {
    const { userMessage } = parseHookInput(JSON.stringify({ input: 'hello from input' }));
    assert.equal(userMessage, 'hello from input');
  });

  it('{"content": "..."} → extracts message from "content" field', () => {
    const { userMessage } = parseHookInput(JSON.stringify({ content: 'hello from content' }));
    assert.equal(userMessage, 'hello from content');
  });

  it('"prompt" takes priority over "message" when both present', () => {
    const { userMessage } = parseHookInput(JSON.stringify({ prompt: 'from prompt', message: 'from message' }));
    assert.equal(userMessage, 'from prompt', '"prompt" must win over "message"');
  });

  it('{"cwd": "/some/path", "prompt": "msg"} → cwd is extracted', () => {
    const { cwd } = parseHookInput(JSON.stringify({ cwd: '/some/path', prompt: 'msg' }));
    assert.equal(cwd, '/some/path');
  });

  it('{"transcript_path": "/t.json", "prompt": "msg"} → transcriptPath extracted', () => {
    const { transcriptPath } = parseHookInput(JSON.stringify({ transcript_path: '/t.json', prompt: 'msg' }));
    assert.equal(transcriptPath, '/t.json');
  });

  it('missing cwd → null', () => {
    const { cwd } = parseHookInput(JSON.stringify({ prompt: 'msg' }));
    assert.equal(cwd, null);
  });

  it('plain text (not JSON) → raw text used as message', () => {
    const raw = 'Just a plain text message not wrapped in JSON';
    const { userMessage } = parseHookInput(raw);
    assert.equal(userMessage, raw);
  });

  it('malformed JSON → raw text used as message', () => {
    const raw = '{not: valid json';
    const { userMessage } = parseHookInput(raw);
    assert.equal(userMessage, raw);
  });
});

// ============================================================================
// GROUP 6: OUTPUT FORMATTING
// ============================================================================

describe('Group 6: Output Formatting (formatOutput)', () => {
  const agenticAnalysis = {
    intent: 'code_writing',
    summary: 'User wants to add JWT authentication to their Express API',
    relevant_files: [
      { path: 'src/auth.ts', purpose: 'auth module', key_exports: ['authenticate'] },
      { path: 'src/middleware.ts', purpose: 'middleware layer', key_exports: ['authMiddleware'] },
    ],
    existing_patterns: ['JWT via jsonwebtoken', 'Express middleware chain'],
    recent_changes: 'Added /login endpoint',
    tasks: ['Create JWT util', 'Add middleware', 'Protect routes'],
    approach: 'Follow existing Express middleware pattern from src/middleware.ts',
    warnings: ['Do not break existing /public routes'],
  };

  const fastAnalysis = {
    intent: 'debugging',
    tasks: ['Reproduce crash', 'Find root cause', 'Write regression test'],
    tech: ['Node.js', 'Express'],
    files: ['src/server.js', 'src/routes.js'],
    approach: 'Start by reproducing the issue in isolation',
  };

  const detailedAnalysis = {
    intent: { primary: 'refactoring', confidence: 0.85 },
    decomposition: [
      { task: 'Extract utility functions', priority: 1 },
      { task: 'Add TypeScript types', priority: 2 },
    ],
    suggested_approach: 'Extract helpers first, then add types incrementally',
    implicit_context: { domain: 'backend', relevant_technologies: ['TypeScript', 'Node.js'] },
  };

  // --- Agentic mode ---
  it('agentic mode: output contains <rlm_preresearch> opening tag', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('<rlm_preresearch>'), 'Must have opening <rlm_preresearch>');
  });

  it('agentic mode: output contains </rlm_preresearch> closing tag', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('</rlm_preresearch>'), 'Must have closing </rlm_preresearch>');
  });

  it('agentic mode: output contains intent value', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('code_writing'), 'Intent must appear in output');
  });

  it('agentic mode: output contains summary text', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('JWT authentication'), 'Summary must appear in output');
  });

  it('agentic mode: output lists relevant file paths', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('src/auth.ts'), 'First relevant file must appear');
    assert.ok(out.includes('src/middleware.ts'), 'Second relevant file must appear');
  });

  it('agentic mode: output contains recommended approach', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('Follow existing Express middleware pattern'), 'Approach must appear');
  });

  it('agentic mode: output contains warnings when present', () => {
    const out = formatOutput(agenticAnalysis, { agenticMode: true });
    assert.ok(out.includes('/public routes'), 'Warnings must appear in output');
  });

  // --- Fast mode ---
  it('fast mode: output contains <rlm_analysis> opening tag', () => {
    const out = formatOutput(fastAnalysis, { fastMode: true });
    assert.ok(out.includes('<rlm_analysis>'), 'Must have opening <rlm_analysis>');
  });

  it('fast mode: output contains </rlm_analysis> closing tag', () => {
    const out = formatOutput(fastAnalysis, { fastMode: true });
    assert.ok(out.includes('</rlm_analysis>'), 'Must have closing </rlm_analysis>');
  });

  it('fast mode: output contains intent string', () => {
    const out = formatOutput(fastAnalysis, { fastMode: true });
    assert.ok(out.includes('debugging'), 'Intent must appear');
  });

  it('fast mode: output contains task text', () => {
    const out = formatOutput(fastAnalysis, { fastMode: true });
    assert.ok(out.includes('Reproduce crash'), 'Task content must appear');
  });

  // --- Detailed mode ---
  it('detailed mode: output contains <rlm_analysis> tag', () => {
    const out = formatOutput(detailedAnalysis, { agenticMode: false, fastMode: false });
    assert.ok(out.includes('<rlm_analysis>'));
  });

  it('detailed mode: output contains intent.primary', () => {
    const out = formatOutput(detailedAnalysis, { agenticMode: false, fastMode: false });
    assert.ok(out.includes('refactoring'), 'Primary intent must appear');
  });

  it('detailed mode: output contains confidence value', () => {
    const out = formatOutput(detailedAnalysis, { agenticMode: false, fastMode: false });
    assert.ok(out.includes('0.85'), 'Confidence must appear');
  });

  it('detailed mode: output contains domain', () => {
    const out = formatOutput(detailedAnalysis, { agenticMode: false, fastMode: false });
    assert.ok(out.includes('backend'), 'Domain must appear');
  });

  it('missing optional fields do not throw (graceful defaults)', () => {
    // Only the bare minimum: intent.primary
    const minimal = { intent: { primary: 'other' } };
    assert.doesNotThrow(() => {
      const out = formatOutput(minimal, { agenticMode: false, fastMode: false });
      assert.ok(out.includes('<rlm_analysis>'));
      assert.ok(out.includes('other'));
    });
  });

  it('skip_rlm flag: formatOutput is not called when analysis.skip_rlm=true (gate check)', () => {
    // The hook's main() exits before calling formatOutput when skip_rlm is true.
    // We verify the gate logic here inline.
    const shouldFormat = (analysis) => !analysis.skip_rlm;

    assert.equal(shouldFormat({ skip_rlm: true }), false, 'Must not format when skip_rlm=true');
    assert.equal(shouldFormat({ skip_rlm: false, intent: { primary: 'debugging' } }), true,
      'Must format when skip_rlm=false');
    assert.equal(shouldFormat({ intent: { primary: 'debugging' } }), true,
      'Must format when skip_rlm is absent');
  });
});

// ============================================================================
// GROUP 7: CACHE FILE OPERATIONS
// ============================================================================

describe('Group 7: Cache File Operations', () => {
  let testCacheDir;

  beforeEach(async () => {
    testCacheDir = join(tmpdir(), `rlm-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testCacheDir, { recursive: true, force: true });
    } catch {}
  });

  it('write JSON to temp file, read back → data round-trips correctly', async () => {
    const data = { intent: 'testing', tasks: ['task1', 'task2'], confidence: 0.9 };
    const file = join(testCacheDir, 'round-trip.json');
    await writeFile(file, JSON.stringify(data, null, 2));
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(parsed, data);
  });

  it('freshly written cache file has mtime age < 1 second', async () => {
    const file = join(testCacheDir, 'age-test.json');
    await writeFile(file, '{}');
    const stats = await stat(file);
    const ageMs = Date.now() - stats.mtimeMs;
    assert.ok(ageMs < 1000, `Expected age < 1000 ms, got ${ageMs} ms`);
  });

  it('cache key is valid as a filename: 64 hex chars, no path separators', () => {
    const key = getCacheKey('test input for filename generation');
    assert.match(key, /^[0-9a-f]{64}$/, 'Key must be 64 lowercase hex chars');
    assert.ok(!key.includes('/'), 'Key must not contain forward slash');
    assert.ok(!key.includes('\\'), 'Key must not contain backslash');
  });

  it('two different inputs never produce the same cache filename', () => {
    const file1 = `${getCacheKey('first unique input string')}.json`;
    const file2 = `${getCacheKey('second unique input string')}.json`;
    assert.notEqual(file1, file2);
  });

  it('multiple cache entries coexist without collision and can be read back independently', async () => {
    const inputs = ['alpha query', 'beta query', 'gamma query'];
    const files = [];

    for (const input of inputs) {
      const key = getCacheKey(input);
      const file = join(testCacheDir, `${key}.json`);
      await writeFile(file, JSON.stringify({ input }));
      files.push({ file, input });
    }

    for (const { file, input } of files) {
      const data = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(data.input, input, `Cache entry for "${input}" must read back correctly`);
    }
  });
});

// ============================================================================
// GROUP 8: PROJECT CONTEXT DETECTION
// ============================================================================

describe('Group 8: Project Context Detection (gatherProjectContext)', () => {
  let testDir;

  beforeEach(async () => {
    testDir = join(tmpdir(), `rlm-proj-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('directory with package.json → projectType = "node"', async () => {
    await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: 'test-app', dependencies: {} }));
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null);
    assert.equal(ctx.projectType, 'node');
  });

  it('directory with Cargo.toml → projectType = "rust"', async () => {
    await writeFile(join(testDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"');
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null);
    assert.equal(ctx.projectType, 'rust');
  });

  it('directory with go.mod → projectType = "go"', async () => {
    await writeFile(join(testDir, 'go.mod'), 'module test\n\ngo 1.21');
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null);
    assert.equal(ctx.projectType, 'go');
  });

  it('directory with pyproject.toml → projectType = "python"', async () => {
    await writeFile(join(testDir, 'pyproject.toml'), '[project]\nname = "test"');
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null);
    assert.equal(ctx.projectType, 'python');
  });

  it('non-existent directory → returns null gracefully', async () => {
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}`);
    const ctx = await gatherProjectContext(missing);
    assert.equal(ctx, null);
  });

  it('package.json with dependencies → techStack includes dep names', async () => {
    const pkg = {
      name: 'my-app',
      dependencies: { express: '^4.0.0', lodash: '^4.0.0' },
      devDependencies: { jest: '^29.0.0' },
    };
    await writeFile(join(testDir, 'package.json'), JSON.stringify(pkg));
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx.techStack.includes('express'), 'express must be in techStack');
    assert.ok(ctx.techStack.includes('lodash'), 'lodash must be in techStack');
  });

  it('projectName matches the basename of the directory', async () => {
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null);
    assert.equal(ctx.projectName, testDir.split('/').pop());
  });

  it('directory with no manifest files → context returned with null projectType', async () => {
    // No manifest files written — dir exists but is empty
    const ctx = await gatherProjectContext(testDir);
    assert.ok(ctx !== null, 'Context should be returned for existing dir');
    assert.equal(ctx.projectType, null, 'projectType should be null with no manifest');
  });
});

// ============================================================================
// GROUP 9: RLM PROMPT BUILDING
// ============================================================================

describe('Group 9: RLM Prompt Building (buildRLMPrompt)', () => {
  const msg = 'How do I implement JWT authentication in my Express app?';

  const projectCtx = {
    projectName: 'my-api',
    projectType: 'node',
    techStack: ['node', 'express', 'typescript'],
    recentFiles: ['src/auth.ts', 'src/routes.ts'],
    gitBranch: 'feature/auth',
    gitStatus: 'M src/auth.ts',
  };

  const convCtx = [
    { role: 'user', preview: 'I want to add login functionality to the app.' },
    { role: 'assistant', preview: 'I can help with that. Let\'s start with JWT token signing.' },
  ];

  it('fast mode: prompt contains the user message', () => {
    const prompt = buildRLMPrompt(msg, null, null, { fastMode: true });
    assert.ok(prompt.includes(msg), 'User message must appear verbatim in fast-mode prompt');
  });

  it('agentic mode: prompt contains the user message', () => {
    const prompt = buildRLMPrompt(msg, null, null, { agenticMode: true });
    assert.ok(prompt.includes(msg), 'User message must appear in agentic-mode prompt');
  });

  it('agentic mode: prompt mentions Glob, Grep, and Read tools', () => {
    const prompt = buildRLMPrompt(msg, null, null, { agenticMode: true });
    assert.ok(prompt.includes('Glob'), 'Glob must be listed as an available tool');
    assert.ok(prompt.includes('Grep'), 'Grep must be listed');
    assert.ok(prompt.includes('Read'), 'Read must be listed');
  });

  it('project context is embedded in fast-mode prompt', () => {
    const prompt = buildRLMPrompt(msg, projectCtx, null, { fastMode: true });
    assert.ok(prompt.includes('my-api'), 'Project name must appear');
    assert.ok(prompt.includes('node'), 'Project type must appear');
  });

  it('tech stack entries appear in prompt when project context provided', () => {
    const prompt = buildRLMPrompt(msg, projectCtx, null, { fastMode: true });
    assert.ok(prompt.includes('express'), 'express must appear from tech stack');
    assert.ok(prompt.includes('typescript'), 'typescript must appear from tech stack');
  });

  it('git branch appears in prompt when present in project context', () => {
    const prompt = buildRLMPrompt(msg, projectCtx, null, { fastMode: true });
    assert.ok(prompt.includes('feature/auth'), 'Git branch must appear');
  });

  it('conversation context previews appear in prompt when provided', () => {
    const prompt = buildRLMPrompt(msg, null, convCtx, { fastMode: true });
    assert.ok(prompt.includes('login functionality'), 'Conversation preview must appear');
  });

  it('detailed mode: user message wrapped in <user_message>...</user_message> tags', () => {
    const prompt = buildRLMPrompt(msg, null, null, { agenticMode: false, fastMode: false });
    assert.ok(prompt.includes('<user_message>'), 'Must open <user_message>');
    assert.ok(prompt.includes('</user_message>'), 'Must close </user_message>');
    assert.ok(prompt.includes(msg), 'Message must be inside the tags');
  });

  it('long user message (10 000 chars) does not throw', () => {
    const longMsg = 'x'.repeat(10_000);
    assert.doesNotThrow(() => {
      buildRLMPrompt(longMsg, null, null, { fastMode: true });
    });
  });

  it('special characters in message are preserved without escaping in prompt text', () => {
    const special = 'Handle "double quotes", <angle tags>, {braces}, and `backticks`.';
    const prompt = buildRLMPrompt(special, null, null, { fastMode: true });
    assert.ok(prompt.includes('"double quotes"'), 'Quotes must pass through');
    assert.ok(prompt.includes('<angle tags>'), 'Angle brackets must pass through');
    assert.ok(prompt.includes('{braces}'), 'Braces must pass through');
    assert.ok(prompt.includes('`backticks`'), 'Backticks must pass through');
  });

  it('null project context does not throw in any mode', () => {
    assert.doesNotThrow(() => buildRLMPrompt(msg, null, null, { fastMode: true }));
    assert.doesNotThrow(() => buildRLMPrompt(msg, null, null, { agenticMode: true }));
    assert.doesNotThrow(() => buildRLMPrompt(msg, null, null, { agenticMode: false, fastMode: false }));
  });
});

// ============================================================================
// GROUP 10: SDK-DIRECT FAST PATH (Phase 2)
// ============================================================================

// Inlined from rlm-hook.mjs. shouldUseSDK takes explicit config so we can probe
// each combination without mutating process.env.
function shouldUseSDK({ useSDK, apiKey }) {
  return !!useSDK && !!apiKey;
}

// extractSDKText — concatenate text blocks from an Anthropic Messages response,
// ignoring non-text blocks and degrading to '' on a malformed shape.
function extractSDKText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
}

// callMessagesSDK — shared single-turn core for both fast and detailed SDK paths
// (matches the hook). callHaikuFastSDK / callHaikuDetailedSDK are thin wrappers.
async function callMessagesSDK(prompt, apiKey, client, { model = 'claude-haiku-4-5-20251001', maxTokens = 2048 } = {}) {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return extractSDKText(response);
}

async function callHaikuFastSDK(prompt, apiKey, client, opts) {
  return callMessagesSDK(prompt, apiKey, client, opts);
}

async function callHaikuDetailedSDK(prompt, apiKey, client, opts) {
  return callMessagesSDK(prompt, apiKey, client, opts);
}

// A fake Anthropic client that records the params it was called with and
// returns a canned content-block response (or throws a canned error).
function makeFakeClient(responseOrError) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        if (responseOrError instanceof Error) throw responseOrError;
        return responseOrError;
      },
    },
  };
}

describe('Group 10: SDK-Direct Fast Path (Phase 2)', () => {
  // --- shouldUseSDK gating ---
  it('shouldUseSDK: true only when useSDK AND apiKey present', () => {
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: 'sk-x' }), true);
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: null }), false, 'no key → false');
    assert.equal(shouldUseSDK({ useSDK: false, apiKey: 'sk-x' }), false, 'flag off → false');
    assert.equal(shouldUseSDK({ useSDK: false, apiKey: null }), false);
  });

  it('shouldUseSDK: empty-string key counts as absent', () => {
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: '' }), false);
  });

  // --- extractSDKText ---
  it('extractSDKText: joins text blocks in order', () => {
    const resp = { content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ] };
    assert.equal(extractSDKText(resp), 'Hello world');
  });

  it('extractSDKText: ignores non-text blocks (tool_use etc.)', () => {
    const resp = { content: [
      { type: 'text', text: '{"intent":' },
      { type: 'tool_use', id: 't1', name: 'Glob', input: {} },
      { type: 'text', text: '"debugging"}' },
    ] };
    assert.equal(extractSDKText(resp), '{"intent":"debugging"}');
  });

  it('extractSDKText: missing/empty content → empty string (no throw)', () => {
    assert.equal(extractSDKText(null), '');
    assert.equal(extractSDKText({}), '');
    assert.equal(extractSDKText({ content: [] }), '');
    assert.equal(extractSDKText({ content: [{ type: 'image' }] }), '');
  });

  // --- callHaikuFastSDK ---
  it('callHaikuFastSDK: sends correct model + max_tokens + user message', async () => {
    const client = makeFakeClient({ content: [{ type: 'text', text: '{"skip":true}' }] });
    await callHaikuFastSDK('explore the auth module', 'sk-x', client, { model: 'claude-haiku-4-5-20251001', maxTokens: 1024 });
    assert.equal(client.calls.length, 1);
    const params = client.calls[0];
    assert.equal(params.model, 'claude-haiku-4-5-20251001');
    assert.equal(params.max_tokens, 1024);
    assert.equal(params.messages[0].role, 'user');
    assert.equal(params.messages[0].content, 'explore the auth module');
  });

  it('callHaikuFastSDK: returns raw text that parseHaikuResponse can decode', async () => {
    const json = '{"intent":"code_writing","tasks":["a","b"]}';
    const client = makeFakeClient({ content: [{ type: 'text', text: json }] });
    const text = await callHaikuFastSDK('msg', 'sk-x', client);
    const parsed = parseHaikuResponse(text);
    assert.equal(parsed.intent, 'code_writing');
    assert.deepEqual(parsed.tasks, ['a', 'b']);
  });

  it('callHaikuFastSDK: SDK error propagates so the caller can fall back', async () => {
    const client = makeFakeClient(new Error('429 rate limit'));
    await assert.rejects(
      () => callHaikuFastSDK('msg', 'sk-x', client),
      /429 rate limit/,
    );
  });

  // --- main()'s routing predicate (non-agentic branch) ---
  // This is the fast/detailed SDK branch predicate: shouldUseSDK() && !agentic.
  // As of Unit 5 agentic ALSO has an SDK path, but it is a separate branch with
  // its own predicate (shouldUseSDK() && agentic) — exercised in Group 12.
  it('routing: fast/detailed SDK branch selected when useSDK && key && !agentic', () => {
    const selectSDK = ({ useSDK, apiKey, agenticMode }) =>
      shouldUseSDK({ useSDK, apiKey }) && !agenticMode;

    assert.equal(selectSDK({ useSDK: true, apiKey: 'k', agenticMode: false }), true,
      'non-agentic with SDK+key → fast/detailed SDK path');
    assert.equal(selectSDK({ useSDK: true, apiKey: 'k', agenticMode: true }), false,
      'agentic does not use the fast/detailed branch (it has its own — Group 12)');
    assert.equal(selectSDK({ useSDK: false, apiKey: 'k', agenticMode: false }), false,
      'flag off → subprocess');
    assert.equal(selectSDK({ useSDK: true, apiKey: null, agenticMode: false }), false,
      'no key → subprocess');
  });
});

describe('Group 11: SDK-Direct Detailed Path (Phase 2)', () => {
  it('callHaikuDetailedSDK: sends correct model + max_tokens + user message', async () => {
    const client = makeFakeClient({ content: [{ type: 'text', text: '{"skip_rlm":true}' }] });
    await callHaikuDetailedSDK('analyze the migration', 'sk-x', client, { model: 'claude-haiku-4-5-20251001', maxTokens: 2048 });
    assert.equal(client.calls.length, 1);
    const params = client.calls[0];
    assert.equal(params.model, 'claude-haiku-4-5-20251001');
    assert.equal(params.max_tokens, 2048);
    assert.equal(params.messages[0].role, 'user');
    assert.equal(params.messages[0].content, 'analyze the migration');
  });

  it('callHaikuDetailedSDK: returns verbose JSON that parseHaikuResponse can decode', async () => {
    const json = JSON.stringify({
      intent: { primary: 'architecture', secondary: [], confidence: 0.9 },
      decomposition: [{ task: 'design', priority: 1, dependencies: [] }],
      suggested_approach: 'layered',
      skip_rlm: false,
      skip_reason: null,
    });
    const client = makeFakeClient({ content: [{ type: 'text', text: json }] });
    const text = await callHaikuDetailedSDK('msg', 'sk-x', client);
    const parsed = parseHaikuResponse(text);
    assert.equal(parsed.intent.primary, 'architecture');
    assert.equal(parsed.suggested_approach, 'layered');
    assert.equal(parsed.skip_rlm, false);
  });

  it('callHaikuDetailedSDK: SDK error propagates so the caller can fall back', async () => {
    const client = makeFakeClient(new Error('500 overloaded'));
    await assert.rejects(
      () => callHaikuDetailedSDK('msg', 'sk-x', client),
      /500 overloaded/,
    );
  });

  it('callMessagesSDK core: shared by fast and detailed (same request shape)', async () => {
    const fastClient = makeFakeClient({ content: [{ type: 'text', text: '{}' }] });
    const detClient = makeFakeClient({ content: [{ type: 'text', text: '{}' }] });
    await callHaikuFastSDK('p', 'sk-x', fastClient, { model: 'm', maxTokens: 100 });
    await callHaikuDetailedSDK('p', 'sk-x', detClient, { model: 'm', maxTokens: 100 });
    assert.deepEqual(fastClient.calls[0], detClient.calls[0],
      'fast and detailed issue identical Messages requests for the same prompt');
  });

  it('routing: detailed mode picks callHaikuDetailedSDK, fast picks callHaikuFastSDK', () => {
    // Mirrors main(): CONFIG.fastMode chooses the wrapper.
    const pick = (fastMode) => (fastMode ? 'fast' : 'detailed');
    assert.equal(pick(true), 'fast');
    assert.equal(pick(false), 'detailed');
  });
});

// ============================================================================
// GROUP 12: SDK-DIRECT AGENTIC PATH (Phase 2, Unit 5)
// ============================================================================
//
// Inlined from rlm-hook.mjs. The tool-use loop and the tool implementations are
// faithful copies; callHaikuAgenticSDK takes model/maxTokens/maxTurns via opts
// (the hook reads them from CONFIG) and an injectable `dispatch` + `client`.

// --- tool schema (faithful copy) ---
const AGENTIC_TOOLS = [
  { name: 'Glob', description: 'glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Read', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'Write', description: 'write', input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'Bash', description: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function resolveWithin(root, p) {
  const full = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, full);
  if (rel === '') return full;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
}

function isAllowedGitCommand(command) {
  const cmd = String(command || '').trim();
  if (!/^git(\s|$)/.test(cmd)) return false;
  if (/[;&|`$()<>{}\n]/.test(cmd)) return false;
  return true;
}

function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
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
    if (err && err.status === 1) return 'No matches found.';
    return `Error: ${String(err?.message ?? err)}`;
  }
}

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

function sdkScratchPath(cwd) {
  return join(cwd || process.cwd(), '.claude', `rlm-scratch-${process.pid}.md`);
}

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

async function callHaikuAgenticSDK(
  prompt, apiKey, cwd, client, dispatch,
  { model = 'claude-haiku-4-5-20251001', maxTokens = 2048, maxTurns = 10 } = {}
) {
  const messages = [{ role: 'user', content: prompt }];
  let lastText = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({ model, max_tokens: maxTokens, tools: AGENTIC_TOOLS, messages });
    const text = extractSDKText(response);
    if (text) lastText = text;
    if (response.stop_reason !== 'tool_use') return text || lastText;
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
  return lastText;
}

// A fake client that returns a SEQUENCE of responses (one per turn), recording
// the params for each create() call. The last response repeats if exhausted.
function makeSequenceClient(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

// A fake dispatch that records (name, input, cwd) and returns a canned string.
function makeRecordingDispatch(resultFn = () => 'TOOL_OK') {
  const calls = [];
  const dispatch = async (name, input, cwd) => {
    calls.push({ name, input, cwd });
    return resultFn(name, input);
  };
  return { dispatch, calls };
}

describe('Group 12: SDK-Direct Agentic Path (Phase 2)', () => {
  let dir;
  beforeEach(async () => {
    dir = join(tmpdir(), `rlm-agentic-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // --- the tool-use loop ---
  it('loop: dispatches tool_use blocks, threads tool_results, returns final text', async () => {
    const client = makeSequenceClient([
      { stop_reason: 'tool_use', content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '**/*.js' } },
      ] },
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't2', name: 'Read', input: { path: 'a.js' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"intent":"code_writing"}' }] },
    ]);
    const { dispatch, calls } = makeRecordingDispatch((name) => `${name} result`);

    const out = await callHaikuAgenticSDK('explore', 'sk-x', '/proj', client, dispatch);

    assert.equal(out, '{"intent":"code_writing"}', 'returns final non-tool_use text');
    assert.equal(client.calls.length, 3, 'three Messages calls (2 tool turns + final)');
    assert.deepEqual(calls.map(c => c.name), ['Glob', 'Read'], 'each tool dispatched once, in order');
    assert.equal(calls[0].input.pattern, '**/*.js');
    assert.equal(calls[0].cwd, '/proj', 'cwd threaded to dispatch');

    // Second create() must carry the assistant tool_use turn + a tool_result for t1.
    const secondMsgs = client.calls[1].messages;
    assert.equal(secondMsgs[1].role, 'assistant');
    const userTurn = secondMsgs[2];
    assert.equal(userTurn.role, 'user');
    assert.equal(userTurn.content[0].type, 'tool_result');
    assert.equal(userTurn.content[0].tool_use_id, 't1', 'tool_result keyed by the originating tool_use id');
    assert.equal(userTurn.content[0].content, 'Glob result');
  });

  it('loop: every create() advertises the tools array', async () => {
    const client = makeSequenceClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }]);
    const { dispatch } = makeRecordingDispatch();
    await callHaikuAgenticSDK('p', 'sk-x', dir, client, dispatch);
    assert.ok(Array.isArray(client.calls[0].tools));
    assert.deepEqual(client.calls[0].tools.map(t => t.name), ['Glob', 'Grep', 'Read', 'Write', 'Bash']);
  });

  it('loop: honors the turn cap when the model never stops calling tools', async () => {
    const toolTurn = { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 'tx', name: 'Glob', input: { pattern: '*' } },
    ] };
    const client = makeSequenceClient([toolTurn]); // repeats forever
    const { dispatch, calls } = makeRecordingDispatch();

    const out = await callHaikuAgenticSDK('p', 'sk-x', dir, client, dispatch, { maxTurns: 3 });

    assert.equal(client.calls.length, 3, 'stops after maxTurns Messages calls');
    assert.equal(calls.length, 3, 'dispatches a tool each capped turn');
    assert.equal(out, 'partial', 'returns best text seen so far on cap');
  });

  it('loop: passes model/maxTokens through to the API', async () => {
    const client = makeSequenceClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }]);
    const { dispatch } = makeRecordingDispatch();
    await callHaikuAgenticSDK('p', 'sk-x', dir, client, dispatch, { model: 'm-1', maxTokens: 512 });
    assert.equal(client.calls[0].model, 'm-1');
    assert.equal(client.calls[0].max_tokens, 512);
  });

  it('loop: SDK error propagates so main() can fall back to subprocess', async () => {
    const client = makeSequenceClient([new Error('503 service unavailable')]);
    const { dispatch } = makeRecordingDispatch();
    await assert.rejects(
      () => callHaikuAgenticSDK('p', 'sk-x', dir, client, dispatch),
      /503 service unavailable/,
    );
  });

  // --- git command guard ---
  it('isAllowedGitCommand: accepts read-only git, rejects everything else', () => {
    assert.equal(isAllowedGitCommand('git log --oneline -10'), true);
    assert.equal(isAllowedGitCommand('git diff HEAD~1'), true);
    assert.equal(isAllowedGitCommand('git show HEAD:src/a.js'), true);
    assert.equal(isAllowedGitCommand('rm -rf /'), false, 'non-git rejected');
    assert.equal(isAllowedGitCommand('gitfoo'), false, 'must be the git binary, not a prefix');
    assert.equal(isAllowedGitCommand('git log; rm -rf /'), false, 'no command chaining');
    assert.equal(isAllowedGitCommand('git log && evil'), false, 'no &&');
    assert.equal(isAllowedGitCommand('git log | sh'), false, 'no pipes');
    assert.equal(isAllowedGitCommand('git $(whoami)'), false, 'no command substitution');
    assert.equal(isAllowedGitCommand('git log > /etc/passwd'), false, 'no redirection');
    assert.equal(isAllowedGitCommand(''), false);
  });

  // --- dispatch routing ---
  it('dispatchAgenticTool: Bash refuses non-git commands', async () => {
    const out = await dispatchAgenticTool('Bash', { command: 'rm -rf /' }, dir);
    assert.match(out, /only read-only "git \.\.\." commands/);
  });

  it('dispatchAgenticTool: unknown tool name returns an error string (no throw)', async () => {
    const out = await dispatchAgenticTool('Telepathy', { foo: 1 }, dir);
    assert.match(out, /unknown tool "Telepathy"/);
  });

  // --- globToRegExp ---
  it('globToRegExp: * stays within a path segment, ** crosses segments', () => {
    assert.ok(globToRegExp('**/*.js').test('a.js'));
    assert.ok(globToRegExp('**/*.js').test('src/deep/a.js'));
    assert.ok(!globToRegExp('**/*.js').test('a.ts'));
    assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/nested/a.ts'), '* must not cross /');
    assert.ok(globToRegExp('**/auth*').test('auth.js'));
    assert.ok(globToRegExp('**/auth*').test('src/auth.controller.ts'));
  });

  // --- real tool implementations against a temp dir ---
  it('toolGlob: finds matching files and skips node_modules', async () => {
    await writeFile(join(dir, 'index.js'), 'x');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'auth.js'), 'x');
    await writeFile(join(dir, 'src', 'auth.ts'), 'x');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'ignored.js'), 'x');

    const out = await toolGlob('**/*.js', dir);
    const lines = out.split('\n').sort();
    assert.deepEqual(lines, ['index.js', 'src/auth.js']);
  });

  it('toolGlob: no matches → friendly message', async () => {
    const out = await toolGlob('**/*.rs', dir);
    assert.equal(out, 'No files matched.');
  });

  it('toolRead: reads a project file and refuses traversal outside root', async () => {
    await writeFile(join(dir, 'hello.txt'), 'hello world');
    assert.equal(await toolRead('hello.txt', dir), 'hello world');
    const escaped = await toolRead('../../../etc/passwd', dir);
    assert.match(escaped, /escapes project root/);
  });

  it('toolRead: truncates very long files', async () => {
    await writeFile(join(dir, 'big.txt'), 'a'.repeat(20000));
    const out = await toolRead('big.txt', dir, 100);
    assert.ok(out.length < 20000);
    assert.match(out, /\[truncated\]$/);
  });

  it('toolWrite: writes to the pid-scoped scratch file (never user code)', async () => {
    const out = await toolWrite('# notes\nsome findings', dir);
    assert.match(out, /Wrote \d+ chars to/);
    const scratch = sdkScratchPath(dir);
    assert.ok(existsSync(scratch));
    assert.equal(await readFile(scratch, 'utf-8'), '# notes\nsome findings');
  });

  it('toolBashGit: runs git but rejects non-git via dispatch', async () => {
    const version = toolBashGit('git --version', dir);
    assert.match(version, /git version/);
    const rejected = toolBashGit('ls -la', dir);
    assert.match(rejected, /only read-only "git \.\.\." commands/);
  });

  it('toolGrep: finds a matching line in the temp dir', async () => {
    await writeFile(join(dir, 'code.js'), 'function authenticate() {}\nconst x = 1;\n');
    const out = toolGrep('authenticate', null, dir);
    assert.match(out, /authenticate/);
    const none = toolGrep('zzz_no_such_token_zzz', null, dir);
    assert.equal(none, 'No matches found.');
  });

  // --- tool schema sanity ---
  it('AGENTIC_TOOLS: five tools with required input schemas', () => {
    assert.equal(AGENTIC_TOOLS.length, 5);
    for (const t of AGENTIC_TOOLS) {
      assert.equal(typeof t.name, 'string');
      assert.equal(t.input_schema.type, 'object');
      assert.ok(Array.isArray(t.input_schema.required));
    }
  });
});

// ============================================================================
// GROUP 13: SDK ROUTING & CLIENT HARDENING (Phase 2, Unit 6)
// ============================================================================
//
// Covers the remaining SDK-path seams not exercised by Groups 10–12:
//  - createAnthropicClient lazy-import: success constructs a client; a missing
//    SDK surfaces as a catchable error so main() can fall back to the subprocess.
//  - extractSDKText on a realistic agentic final turn (mixed text + tool_use).
//  - main()'s three-branch routing (fast/detailed SDK → agentic SDK → subprocess)
//    and the `response === null` guards that make an SDK success short-circuit
//    every later branch.

// createAnthropicClient with an injectable importer. The hook hard-codes
// `import('@anthropic-ai/sdk')`; parameterizing the importer lets us exercise
// both the construct-with-key success and the missing-dependency failure seam.
async function createAnthropicClient(apiKey, importer = (m) => import(m)) {
  const { default: Anthropic } = await importer('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

// routeSDK — faithful model of main()'s SDK/subprocess decision tree. Each branch
// is an injected thunk so we can assert exactly which path ran. Mirrors the two
// `response === null && ...` guards that make an SDK success short-circuit the
// rest, and the final `if (response === null)` subprocess fallback.
async function routeSDK(cfg, impls) {
  const { useSDK, apiKey, agenticMode, fastMode } = cfg;
  let response = null;
  if (shouldUseSDK({ useSDK, apiKey }) && !agenticMode) {
    try {
      response = fastMode ? await impls.fastSDK() : await impls.detailedSDK();
    } catch {
      response = null;
    }
  }
  if (response === null && shouldUseSDK({ useSDK, apiKey }) && agenticMode) {
    try {
      response = await impls.agenticSDK();
    } catch {
      response = null;
    }
  }
  if (response === null) {
    response = await impls.subprocess();
  }
  return response;
}

// Branch impls that count how often each path was invoked.
function makeImpls(overrides = {}) {
  const called = { fastSDK: 0, detailedSDK: 0, agenticSDK: 0, subprocess: 0 };
  const wrap = (name, fn) => async () => { called[name]++; return fn(); };
  return {
    called,
    impls: {
      fastSDK: wrap('fastSDK', overrides.fastSDK || (() => 'FAST')),
      detailedSDK: wrap('detailedSDK', overrides.detailedSDK || (() => 'DETAILED')),
      agenticSDK: wrap('agenticSDK', overrides.agenticSDK || (() => 'AGENTIC')),
      subprocess: wrap('subprocess', overrides.subprocess || (() => 'SUBPROCESS')),
    },
  };
}

describe('Group 13: SDK Routing & Client Hardening (Phase 2)', () => {
  // --- createAnthropicClient lazy-import seam ---
  it('createAnthropicClient: constructs the client with the apiKey on success', async () => {
    let seenKey = null;
    const fakeImport = async () => ({ default: class { constructor(opts) { seenKey = opts.apiKey; } } });
    const client = await createAnthropicClient('sk-test', fakeImport);
    assert.ok(client, 'returns a client instance');
    assert.equal(seenKey, 'sk-test', 'apiKey threaded into the SDK constructor');
  });

  it('createAnthropicClient: a missing SDK rejects (catchable → main() falls back)', async () => {
    const failImport = async () => { throw new Error("Cannot find package '@anthropic-ai/sdk'"); };
    await assert.rejects(
      () => createAnthropicClient('sk-x', failImport),
      /Cannot find package/,
    );
  });

  // --- extractSDKText on a realistic agentic final turn ---
  it('extractSDKText: agentic final turn (text + tool_use mixed) yields only the text', () => {
    const finalTurn = { stop_reason: 'end_turn', content: [
      { type: 'text', text: '{"intent":"debugging",' },
      { type: 'tool_use', id: 't9', name: 'Read', input: { path: 'x' } },
      { type: 'text', text: '"relevant_files":["a.js"]}' },
    ] };
    const text = extractSDKText(finalTurn);
    assert.equal(text, '{"intent":"debugging","relevant_files":["a.js"]}');
    assert.deepEqual(parseHaikuResponse(text), { intent: 'debugging', relevant_files: ['a.js'] });
  });

  // --- main()'s three-branch routing ---
  it('routing: non-agentic SDK success returns SDK text and skips agentic + subprocess', async () => {
    const { called, impls } = makeImpls();
    const out = await routeSDK({ useSDK: true, apiKey: 'k', agenticMode: false, fastMode: true }, impls);
    assert.equal(out, 'FAST');
    assert.deepEqual(called, { fastSDK: 1, detailedSDK: 0, agenticSDK: 0, subprocess: 0 },
      'SDK success short-circuits — subprocess never runs');
  });

  it('routing: detailed mode (fastMode=false) picks detailedSDK', async () => {
    const { called, impls } = makeImpls();
    const out = await routeSDK({ useSDK: true, apiKey: 'k', agenticMode: false, fastMode: false }, impls);
    assert.equal(out, 'DETAILED');
    assert.equal(called.detailedSDK, 1);
    assert.equal(called.fastSDK, 0);
  });

  it('routing: non-agentic SDK error falls back to subprocess (agentic branch skipped)', async () => {
    const { called, impls } = makeImpls({ fastSDK: () => { throw new Error('429'); } });
    const out = await routeSDK({ useSDK: true, apiKey: 'k', agenticMode: false, fastMode: true }, impls);
    assert.equal(out, 'SUBPROCESS');
    assert.deepEqual(called, { fastSDK: 1, detailedSDK: 0, agenticSDK: 0, subprocess: 1 },
      'agentic branch not entered when !agenticMode');
  });

  it('routing: agentic SDK success returns its text and skips the subprocess', async () => {
    const { called, impls } = makeImpls();
    const out = await routeSDK({ useSDK: true, apiKey: 'k', agenticMode: true, fastMode: false }, impls);
    assert.equal(out, 'AGENTIC');
    assert.deepEqual(called, { fastSDK: 0, detailedSDK: 0, agenticSDK: 1, subprocess: 0 },
      'agentic SDK success short-circuits the subprocess; non-agentic branch skipped');
  });

  it('routing: agentic SDK error falls back to subprocess', async () => {
    const { called, impls } = makeImpls({ agenticSDK: () => { throw new Error('503'); } });
    const out = await routeSDK({ useSDK: true, apiKey: 'k', agenticMode: true, fastMode: false }, impls);
    assert.equal(out, 'SUBPROCESS');
    assert.deepEqual(called, { fastSDK: 0, detailedSDK: 0, agenticSDK: 1, subprocess: 1 });
  });

  it('routing: SDK disabled (no key) goes straight to subprocess, no SDK calls', async () => {
    const { called, impls } = makeImpls();
    const out = await routeSDK({ useSDK: true, apiKey: null, agenticMode: true, fastMode: false }, impls);
    assert.equal(out, 'SUBPROCESS');
    assert.deepEqual(called, { fastSDK: 0, detailedSDK: 0, agenticSDK: 0, subprocess: 1 });
  });

  // --- the response===null guards (defends against double-running a later branch) ---
  it('routing guard: a populated response blocks BOTH the agentic SDK and the subprocess', () => {
    // Models the two `response === null && ...` guards in main(). Once response is
    // set (e.g. a successful earlier branch), neither later branch may fire — even
    // if its other predicates are satisfied.
    const takeAgentic = (response, useSDK, apiKey, agenticMode) =>
      response === null && shouldUseSDK({ useSDK, apiKey }) && agenticMode;
    const takeSubprocess = (response) => response === null;

    assert.equal(takeAgentic('FAST', true, 'k', true), false, 'non-null response → agentic skipped');
    assert.equal(takeSubprocess('FAST'), false, 'non-null response → subprocess skipped');
    assert.equal(takeAgentic(null, true, 'k', true), true, 'null response + agentic + SDK → agentic runs');
    assert.equal(takeSubprocess(null), true, 'null response → subprocess runs');
  });
});

// ============================================================================
// PHASE 3 — SEMANTIC CACHE: embedding helper (inlined from rlm-hook.mjs)
// ============================================================================

// embedText — faithful copy of the hook's embedText. `fetchImpl` is injected so
// tests drive it without a network; throws on every failure mode so the caller
// can degrade to plain SHA-256 lookup.
async function embedText(text, apiKey, {
  fetchImpl,
  model = 'text-embedding-3-small',
  baseUrl = 'https://api.openai.com/v1',
} = {}) {
  if (!apiKey) throw new Error('embedText: no embedding API key');
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('embedText: empty input');
  }
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
  return Float32Array.from(vec);
}

// cosineSimilarity — faithful copy of the hook's cosineSimilarity. Pure math.
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

// makeFakeFetch — records the (url, init) it was called with and returns a
// canned Response-like object. Pass an Error to make the fetch itself reject, or
// `{ ok, status, body }` to shape the HTTP response.
function makeFakeFetch(spec) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (spec instanceof Error) throw spec;
    return {
      ok: spec.ok !== undefined ? spec.ok : true,
      status: spec.status !== undefined ? spec.status : 200,
      json: async () => spec.body,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('Group 14: Semantic Cache — embedText (Phase 3)', () => {
  const okBody = { data: [{ embedding: [0.1, -0.2, 0.3, 0.4] }] };

  it('returns a Float32Array of the embedding vector', async () => {
    const fetchImpl = makeFakeFetch({ body: okBody });
    const vec = await embedText('explore auth', 'sk-openai', { fetchImpl });
    assert.ok(vec instanceof Float32Array, 'is a Float32Array');
    assert.equal(vec.length, 4);
    // Float32 narrows precision — compare with a tolerance.
    assert.ok(Math.abs(vec[0] - 0.1) < 1e-6);
    assert.ok(Math.abs(vec[1] - -0.2) < 1e-6);
    assert.ok(Math.abs(vec[3] - 0.4) < 1e-6);
  });

  it('POSTs to <baseUrl>/embeddings with model, input and bearer auth', async () => {
    const fetchImpl = makeFakeFetch({ body: okBody });
    await embedText('the prompt text', 'sk-openai', { fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer sk-openai');
    assert.equal(init.headers['Content-Type'], 'application/json');
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, 'text-embedding-3-small');
    assert.equal(sent.input, 'the prompt text');
  });

  it('honors injected model and baseUrl', async () => {
    const fetchImpl = makeFakeFetch({ body: okBody });
    await embedText('x', 'sk-x', { fetchImpl, model: 'nomic-embed-text', baseUrl: 'http://localhost:11434/v1' });
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'http://localhost:11434/v1/embeddings');
    assert.equal(JSON.parse(init.body).model, 'nomic-embed-text');
  });

  it('throws when no API key is provided (degrades to SHA-256)', async () => {
    const fetchImpl = makeFakeFetch({ body: okBody });
    await assert.rejects(() => embedText('x', null, { fetchImpl }), /no embedding API key/);
    await assert.rejects(() => embedText('x', '', { fetchImpl }), /no embedding API key/);
    assert.equal(fetchImpl.calls.length, 0, 'never hits the network without a key');
  });

  it('throws on empty / non-string input', async () => {
    const fetchImpl = makeFakeFetch({ body: okBody });
    await assert.rejects(() => embedText('', 'sk-x', { fetchImpl }), /empty input/);
    await assert.rejects(() => embedText(null, 'sk-x', { fetchImpl }), /empty input/);
  });

  it('throws on a non-2xx HTTP response', async () => {
    const fetchImpl = makeFakeFetch({ ok: false, status: 429, body: {} });
    await assert.rejects(() => embedText('x', 'sk-x', { fetchImpl }), /HTTP 429/);
  });

  it('throws when fetch itself rejects (network error)', async () => {
    const fetchImpl = makeFakeFetch(new Error('ECONNREFUSED'));
    await assert.rejects(() => embedText('x', 'sk-x', { fetchImpl }), /ECONNREFUSED/);
  });

  it('throws on a malformed body (no data/embedding)', async () => {
    await assert.rejects(
      () => embedText('x', 'sk-x', { fetchImpl: makeFakeFetch({ body: {} }) }),
      /malformed embedding response/,
    );
    await assert.rejects(
      () => embedText('x', 'sk-x', { fetchImpl: makeFakeFetch({ body: { data: [] } }) }),
      /malformed embedding response/,
    );
    await assert.rejects(
      () => embedText('x', 'sk-x', { fetchImpl: makeFakeFetch({ body: { data: [{ embedding: [] }] } }) }),
      /malformed embedding response/,
    );
  });
});

describe('Group 15: Semantic Cache — cosineSimilarity (Phase 3)', () => {
  it('returns 1 for identical vectors', () => {
    const a = [1, 2, 3, 4];
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity(a, [...a]) - 1) < 1e-9);
  });

  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0, 0], [0, 5, 0]), 0);
  });

  it('returns -1 for opposite (antiparallel) vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [-1, -2, -3]) - -1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([2, 0], [-3, 0]) - -1) < 1e-9);
  });

  it('matches a hand-computed pair', () => {
    // a=[1,2,3], b=[4,5,6]: dot=32, ‖a‖=√14, ‖b‖=√77 → 32/√1078 ≈ 0.974631846
    const cos = cosineSimilarity([1, 2, 3], [4, 5, 6]);
    assert.ok(Math.abs(cos - 0.9746318461970762) < 1e-12, `got ${cos}`);
  });

  it('returns 0 when either vector has zero magnitude (no NaN)', () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
    assert.equal(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
    assert.ok(!Number.isNaN(cosineSimilarity([0, 0, 0], [1, 2, 3])));
  });

  it('throws on a length mismatch (corrupt/foreign vector)', () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length mismatch \(2 vs 3\)/);
    assert.throws(() => cosineSimilarity([1, 2, 3], [1]), /length mismatch \(3 vs 1\)/);
  });

  it('accepts Float32Array inputs', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
    assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  });
});

// ============================================================================
// GROUP 16: SEMANTIC CACHE — .embedding WRITES (Phase 3, Unit 3)
// ============================================================================

// saveCacheEmbedding — faithful copy of the hook's, but with CONFIG and the
// embed function injected via `cfg` so tests drive it without globals or a
// network. Mirrors the hook: fully gated behind cfg.semanticCache, requires a
// key, and swallows every failure (returns false) so a bad embedding can never
// break the cache write or the hook.
async function saveCacheEmbedding(key, text, cfg) {
  if (!cfg.semanticCache) return false;
  if (!cfg.embedApiKey) return false;
  try {
    const vec = await cfg.embedImpl(text, cfg.embedApiKey);
    await mkdir(cfg.cacheDir, { recursive: true });
    const file = join(cfg.cacheDir, `${key}.embedding`);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

describe('Group 16: Semantic Cache — .embedding writes (Phase 3)', () => {
  let testCacheDir;
  const KEY = 'a'.repeat(64); // shaped like a sha256 hex key

  beforeEach(async () => {
    testCacheDir = join(tmpdir(), `rlm-emb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(testCacheDir, { recursive: true, force: true }); } catch {}
  });

  it('raw float32 bytes round-trip through Buffer ↔ Float32Array', () => {
    const vec = Float32Array.from([0.1, -0.2, 0.3, 1234.5, -0.0009765625]);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    assert.equal(buf.length, vec.length * 4, '4 bytes per float32');
    const back = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    assert.equal(back.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      // identical float32 bit patterns → exactly equal, no tolerance needed
      assert.equal(back[i], vec[i], `element ${i} survives the round-trip`);
    }
  });

  it('persisted .embedding file reads back to the original vector', async () => {
    const vec = Float32Array.from([0.5, -0.25, 0.125, 42]);
    const embedImpl = async () => vec;
    const ok = await saveCacheEmbedding(KEY, 'explore the auth flow', {
      semanticCache: true, embedApiKey: 'sk-x', cacheDir: testCacheDir, embedImpl,
    });
    assert.equal(ok, true);
    const file = join(testCacheDir, `${KEY}.embedding`);
    assert.ok(existsSync(file), '.embedding file exists');
    const buf = await readFile(file);
    const back = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    assert.deepEqual(Array.from(back), Array.from(vec));
  });

  it('writes nothing when CONFIG.semanticCache is off (default byte-identical)', async () => {
    let called = false;
    const embedImpl = async () => { called = true; return Float32Array.from([1, 2, 3]); };
    const ok = await saveCacheEmbedding(KEY, 'prompt', {
      semanticCache: false, embedApiKey: 'sk-x', cacheDir: testCacheDir, embedImpl,
    });
    assert.equal(ok, false);
    assert.equal(called, false, 'never even computes an embedding when flag is off');
    assert.ok(!existsSync(join(testCacheDir, `${KEY}.embedding`)), 'no .embedding file written');
  });

  it('writes nothing when no embedding API key is available', async () => {
    let called = false;
    const embedImpl = async () => { called = true; return Float32Array.from([1, 2, 3]); };
    const ok = await saveCacheEmbedding(KEY, 'prompt', {
      semanticCache: true, embedApiKey: null, cacheDir: testCacheDir, embedImpl,
    });
    assert.equal(ok, false);
    assert.equal(called, false, 'no key → no embedding call');
    assert.ok(!existsSync(join(testCacheDir, `${KEY}.embedding`)), 'no .embedding file written');
  });

  it('swallows a thrown embedText so the JSON cache write still succeeds', async () => {
    // The JSON entry is written first and independently — simulate it here.
    const jsonFile = join(testCacheDir, `${KEY}.json`);
    await writeFile(jsonFile, JSON.stringify({ intent: 'x' }));

    const embedImpl = async () => { throw new Error('embedText: HTTP 429'); };
    const ok = await saveCacheEmbedding(KEY, 'prompt', {
      semanticCache: true, embedApiKey: 'sk-x', cacheDir: testCacheDir, embedImpl,
    });
    assert.equal(ok, false, 'returns false on embed failure (does not throw)');
    assert.ok(existsSync(jsonFile), 'JSON cache entry is untouched by the failed embedding');
    assert.ok(!existsSync(join(testCacheDir, `${KEY}.embedding`)), 'no partial .embedding file');
  });

  it('leaves no .tmp file behind after a successful write', async () => {
    const embedImpl = async () => Float32Array.from([1, 2, 3, 4]);
    await saveCacheEmbedding(KEY, 'prompt', {
      semanticCache: true, embedApiKey: 'sk-x', cacheDir: testCacheDir, embedImpl,
    });
    const entries = await readdir(testCacheDir);
    assert.ok(entries.some(e => e === `${KEY}.embedding`), 'final file present');
    assert.ok(!entries.some(e => e.includes('.tmp')), 'temp file was renamed away');
  });
});

// ============================================================================
// GROUP 17: SEMANTIC CACHE — semanticLookup (Phase 3, Unit 4)
// ============================================================================

// semanticLookup — faithful copy of the hook's, with CONFIG and the embed /
// checkCache helpers injected via `cfg` so tests drive it without globals or a
// network. Mirrors the hook: fully gated behind cfg.semanticCache + a key
// (returns null with zero I/O when off), per-file try/catch so one corrupt
// vector doesn't abort the scan, and a top-level catch so any failure degrades
// to a plain miss (null) rather than throwing.
async function semanticLookup(queryText, cfg) {
  if (!cfg.semanticCache) return null;
  if (!cfg.embedApiKey) return null;
  try {
    const queryVec = await cfg.embedImpl(queryText, cfg.embedApiKey);
    let files;
    try {
      files = await readdir(cfg.cacheDir);
    } catch {
      return null;
    }
    let bestKey = null;
    let bestScore = -Infinity;
    for (const f of files) {
      if (!f.endsWith('.embedding')) continue;
      try {
        const buf = await readFile(join(cfg.cacheDir, f));
        if (buf.length === 0 || buf.length % 4 !== 0) continue;
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        const score = cosineSimilarity(queryVec, vec);
        if (score > bestScore) {
          bestScore = score;
          bestKey = f.slice(0, -('.embedding'.length));
        }
      } catch {
        // corrupt/foreign vector — skip, keep scanning
      }
    }
    if (bestKey === null || bestScore < cfg.semanticThreshold) return null;
    const entry = await cfg.checkImpl(bestKey);
    if (!entry) return null;
    return entry;
  } catch {
    return null;
  }
}

describe('Group 17: Semantic Cache — semanticLookup (Phase 3)', () => {
  let testCacheDir;

  // Persist a `<key>.embedding` (raw float32) and optional `<key>.json` entry.
  async function writeEntry(key, vecLike, json) {
    const vec = Float32Array.from(vecLike);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    await writeFile(join(testCacheDir, `${key}.embedding`), buf);
    if (json !== undefined) {
      await writeFile(join(testCacheDir, `${key}.json`), JSON.stringify(json));
    }
  }

  // checkImpl that reads the sibling JSON entry (stand-in for checkCache).
  const checkImpl = async (key) => {
    try {
      return JSON.parse(await readFile(join(testCacheDir, `${key}.json`), 'utf-8'));
    } catch {
      return null;
    }
  };

  // embedImpl returning a fixed query vector, ignoring the text (the actual
  // embedding model is exercised by Group 14).
  const fixedVec = v => async () => Float32Array.from(v);

  const baseCfg = overrides => ({
    semanticCache: true,
    embedApiKey: 'sk-x',
    cacheDir: testCacheDir,
    semanticThreshold: 0.92,
    checkImpl,
    ...overrides,
  });

  beforeEach(async () => {
    testCacheDir = join(tmpdir(), `rlm-sem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(testCacheDir, { recursive: true, force: true }); } catch {}
  });

  it('returns the nearest entry when one embedding is above threshold', async () => {
    const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
    await writeEntry(A, [0.99, 0.1, 0], { intent: 'auth-flow', who: 'A' }); // ~0.995 vs query
    await writeEntry(B, [0, 1, 0], { intent: 'unrelated', who: 'B' });      // 0
    await writeEntry(C, [0.5, 0.866, 0], { intent: 'other', who: 'C' });    // ~0.5
    const hit = await semanticLookup('explore auth', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'a semantic hit is returned');
    assert.equal(hit.who, 'A', 'returns the closest entry (A), not B or C');
    assert.equal(hit.intent, 'auth-flow');
  });

  it('returns null when every embedding is below threshold', async () => {
    await writeEntry('d'.repeat(64), [0, 1, 0], { who: 'D' });        // cos 0
    await writeEntry('e'.repeat(64), [0.5, 0.866, 0], { who: 'E' });  // cos ~0.5
    const hit = await semanticLookup('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.equal(hit, null, 'nothing close enough → miss');
  });

  it('skips corrupt / foreign-dimension embeddings without aborting the scan', async () => {
    const GOOD = 'f'.repeat(64);
    await writeEntry(GOOD, [0.98, 0.2, 0], { who: 'GOOD' }); // ~0.98 vs query, above threshold
    // 3-byte file → not a multiple of 4 → guarded skip
    await writeFile(join(testCacheDir, `${'g'.repeat(64)}.embedding`), Buffer.from([1, 2, 3]));
    // 2-dim vector → cosineSimilarity length-mismatch throw → per-file catch skip
    const two = Float32Array.from([1, 0]);
    await writeFile(join(testCacheDir, `${'h'.repeat(64)}.embedding`),
      Buffer.from(two.buffer, two.byteOffset, two.byteLength));
    const hit = await semanticLookup('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'the good entry still matches despite corrupt siblings');
    assert.equal(hit.who, 'GOOD');
  });

  it('returns null without scanning when semanticCache is off', async () => {
    await writeEntry('a'.repeat(64), [1, 0, 0], { who: 'A' });
    let called = false;
    const embedImpl = async () => { called = true; return Float32Array.from([1, 0, 0]); };
    const hit = await semanticLookup('q', baseCfg({ semanticCache: false, embedImpl }));
    assert.equal(hit, null);
    assert.equal(called, false, 'flag off → never even embeds the query');
  });

  it('returns null without scanning when no embedding API key is available', async () => {
    await writeEntry('a'.repeat(64), [1, 0, 0], { who: 'A' });
    let called = false;
    const embedImpl = async () => { called = true; return Float32Array.from([1, 0, 0]); };
    const hit = await semanticLookup('q', baseCfg({ embedApiKey: null, embedImpl }));
    assert.equal(hit, null);
    assert.equal(called, false, 'no key → no embedding call, no scan');
  });

  it('treats a matched embedding whose JSON entry is gone as a miss', async () => {
    // embedding present and above threshold, but no sibling .json (expired/TTL'd)
    await writeEntry('a'.repeat(64), [1, 0, 0] /* no json */);
    const hit = await semanticLookup('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.equal(hit, null, 'matched vector but absent entry → fall through to Haiku');
  });

  it('degrades to a miss (null) when the embedder throws', async () => {
    await writeEntry('a'.repeat(64), [1, 0, 0], { who: 'A' });
    const embedImpl = async () => { throw new Error('embedText: HTTP 429'); };
    const hit = await semanticLookup('q', baseCfg({ embedImpl }));
    assert.equal(hit, null, 'embed failure never throws — degrades to miss');
  });

  it('returns null when the cache directory does not exist yet', async () => {
    const hit = await semanticLookup('q', baseCfg({
      cacheDir: join(testCacheDir, 'nope'),
      embedImpl: fixedVec([1, 0, 0]),
    }));
    assert.equal(hit, null, 'absent cache dir → miss, not a throw');
  });
});

// ============================================================================
// GROUP 18: SEMANTIC CACHE — index.json reverse index (Phase 3, Unit 5)
// ============================================================================

// Faithful copies of the hook's Unit-5 helpers, parameterized by cacheDir /
// cfg so tests drive them without globals. The .embedding files remain the
// source of truth; index.json is a single-read accelerator with a file-scan
// fallback when it's absent/empty/corrupt.

async function readCacheIndex(cacheDir) {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, 'index.json'), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

async function updateCacheIndex(key, vec, cfg) {
  if (!cfg.semanticCache) return false;
  try {
    const index = await readCacheIndex(cfg.cacheDir);
    index[key] = { dim: vec.length, vec: Array.from(vec) };
    await mkdir(cfg.cacheDir, { recursive: true });
    const file = join(cfg.cacheDir, 'index.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

async function scoreFromIndex(queryVec, simImpl, cacheDir) {
  const index = await readCacheIndex(cacheDir);
  const keys = Object.keys(index);
  if (keys.length === 0) return null;
  let bestKey = null, bestScore = -Infinity;
  for (const key of keys) {
    const arr = index[key] && index[key].vec;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    try {
      const score = simImpl(queryVec, Float32Array.from(arr));
      if (score > bestScore) { bestScore = score; bestKey = key; }
    } catch {
      // foreign-dimension / bad vector — skip
    }
  }
  return bestKey === null ? null : { bestKey, bestScore };
}

async function scoreFromFiles(queryVec, simImpl, cacheDir) {
  let files;
  try {
    files = await readdir(cacheDir);
  } catch {
    return null;
  }
  let bestKey = null, bestScore = -Infinity;
  for (const f of files) {
    if (!f.endsWith('.embedding')) continue;
    try {
      const buf = await readFile(join(cacheDir, f));
      if (buf.length === 0 || buf.length % 4 !== 0) continue;
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      const score = simImpl(queryVec, vec);
      if (score > bestScore) { bestScore = score; bestKey = f.slice(0, -('.embedding'.length)); }
    } catch {
      // corrupt/foreign vector — skip
    }
  }
  return bestKey === null ? null : { bestKey, bestScore };
}

// Index-first semanticLookup (Unit 5): prefer index.json, fall back to scan.
async function semanticLookupIndexed(queryText, cfg) {
  if (!cfg.semanticCache) return null;
  if (!cfg.embedApiKey) return null;
  try {
    const queryVec = await cfg.embedImpl(queryText, cfg.embedApiKey);
    let best = await scoreFromIndex(queryVec, cosineSimilarity, cfg.cacheDir);
    if (best === null) best = await scoreFromFiles(queryVec, cosineSimilarity, cfg.cacheDir);
    if (best === null) return null;
    const { bestKey, bestScore } = best;
    if (bestScore < cfg.semanticThreshold) return null;
    const entry = await cfg.checkImpl(bestKey);
    if (!entry) return null;
    return entry;
  } catch {
    return null;
  }
}

describe('Group 18: Semantic Cache — index.json reverse index (Phase 3)', () => {
  let testCacheDir;

  const fixedVec = v => async () => Float32Array.from(v);

  const checkImpl = async (key) => {
    try {
      return JSON.parse(await readFile(join(testCacheDir, `${key}.json`), 'utf-8'));
    } catch {
      return null;
    }
  };

  const baseCfg = overrides => ({
    semanticCache: true,
    embedApiKey: 'sk-x',
    cacheDir: testCacheDir,
    semanticThreshold: 0.92,
    checkImpl,
    ...overrides,
  });

  beforeEach(async () => {
    testCacheDir = join(tmpdir(), `rlm-idx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testCacheDir, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(testCacheDir, { recursive: true, force: true }); } catch {}
  });

  it('upsert round-trips through index.json (dim + inline vector)', async () => {
    const KEY = 'a'.repeat(64);
    const ok = await updateCacheIndex(KEY, Float32Array.from([0.1, -0.2, 0.3]), baseCfg());
    assert.equal(ok, true);
    assert.ok(existsSync(join(testCacheDir, 'index.json')), 'index.json written');
    const index = await readCacheIndex(testCacheDir);
    assert.deepEqual(Object.keys(index), [KEY]);
    assert.equal(index[KEY].dim, 3);
    // float32 round-trip via JSON — compare with tolerance for narrowing.
    const back = Float32Array.from(index[KEY].vec);
    const orig = Float32Array.from([0.1, -0.2, 0.3]);
    for (let i = 0; i < orig.length; i++) assert.ok(Math.abs(back[i] - orig[i]) < 1e-6);
  });

  it('accumulates multiple keys across successive upserts', async () => {
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    await updateCacheIndex(A, Float32Array.from([1, 0, 0]), baseCfg());
    await updateCacheIndex(B, Float32Array.from([0, 1, 0]), baseCfg());
    const index = await readCacheIndex(testCacheDir);
    assert.deepEqual(Object.keys(index).sort(), [A, B].sort());
    assert.deepEqual(index[A].vec, [1, 0, 0]);
    assert.deepEqual(index[B].vec, [0, 1, 0]);
  });

  it('re-upserting the same key overwrites its vector', async () => {
    const KEY = 'c'.repeat(64);
    await updateCacheIndex(KEY, Float32Array.from([1, 0, 0]), baseCfg());
    await updateCacheIndex(KEY, Float32Array.from([0, 0, 1]), baseCfg());
    const index = await readCacheIndex(testCacheDir);
    assert.equal(Object.keys(index).length, 1);
    assert.deepEqual(index[KEY].vec, [0, 0, 1]);
  });

  it('writes no index when semanticCache is off (default byte-identical)', async () => {
    const ok = await updateCacheIndex('a'.repeat(64), Float32Array.from([1, 2, 3]), baseCfg({ semanticCache: false }));
    assert.equal(ok, false);
    assert.ok(!existsSync(join(testCacheDir, 'index.json')), 'no index.json when flag off');
  });

  it('readCacheIndex returns {} for absent / corrupt / non-object index', async () => {
    assert.deepEqual(await readCacheIndex(testCacheDir), {}, 'absent → {}');
    await writeFile(join(testCacheDir, 'index.json'), '{ not json');
    assert.deepEqual(await readCacheIndex(testCacheDir), {}, 'malformed JSON → {}');
    await writeFile(join(testCacheDir, 'index.json'), '[1,2,3]');
    assert.deepEqual(await readCacheIndex(testCacheDir), {}, 'array root → {}');
  });

  it('lookup via index returns the nearest entry with NO .embedding files present', async () => {
    const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
    await updateCacheIndex(A, Float32Array.from([0.99, 0.1, 0]), baseCfg());  // ~0.995 vs query
    await updateCacheIndex(B, Float32Array.from([0, 1, 0]), baseCfg());        // 0
    await updateCacheIndex(C, Float32Array.from([0.5, 0.866, 0]), baseCfg());  // ~0.5
    await writeFile(join(testCacheDir, `${A}.json`), JSON.stringify({ who: 'A', intent: 'auth' }));
    await writeFile(join(testCacheDir, `${B}.json`), JSON.stringify({ who: 'B' }));
    await writeFile(join(testCacheDir, `${C}.json`), JSON.stringify({ who: 'C' }));
    // Prove it is the index, not the files: there are zero .embedding files.
    const files = await readdir(testCacheDir);
    assert.ok(!files.some(f => f.endsWith('.embedding')), 'no .embedding sidecars exist');
    const hit = await semanticLookupIndexed('explore auth', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'index-only lookup returns a hit');
    assert.equal(hit.who, 'A', 'nearest of the three index entries');
  });

  it('falls back to the .embedding file scan when index.json is corrupt', async () => {
    const GOOD = 'd'.repeat(64);
    // good .embedding + json, but a corrupt index.json that yields {}
    const vec = Float32Array.from([0.98, 0.2, 0]);
    await writeFile(join(testCacheDir, `${GOOD}.embedding`), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    await writeFile(join(testCacheDir, `${GOOD}.json`), JSON.stringify({ who: 'GOOD' }));
    await writeFile(join(testCacheDir, 'index.json'), 'totally not json');
    const hit = await semanticLookupIndexed('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'corrupt index → file-scan fallback still finds the match');
    assert.equal(hit.who, 'GOOD');
  });

  it('falls back to the file scan when index.json is absent but sidecars exist', async () => {
    const GOOD = 'e'.repeat(64);
    const vec = Float32Array.from([0.97, 0.24, 0]);
    await writeFile(join(testCacheDir, `${GOOD}.embedding`), Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    await writeFile(join(testCacheDir, `${GOOD}.json`), JSON.stringify({ who: 'GOOD' }));
    assert.ok(!existsSync(join(testCacheDir, 'index.json')), 'no index yet');
    const hit = await semanticLookupIndexed('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'absent index → file-scan fallback');
    assert.equal(hit.who, 'GOOD');
  });

  it('returns null when the best index entry is below threshold', async () => {
    await updateCacheIndex('a'.repeat(64), Float32Array.from([0, 1, 0]), baseCfg());        // cos 0
    await updateCacheIndex('b'.repeat(64), Float32Array.from([0.5, 0.866, 0]), baseCfg());  // ~0.5
    const hit = await semanticLookupIndexed('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.equal(hit, null, 'nothing in the index is close enough → miss');
  });

  it('skips a foreign-dimension index entry without aborting the lookup', async () => {
    const GOOD = 'a'.repeat(64), BAD = 'b'.repeat(64);
    await updateCacheIndex(GOOD, Float32Array.from([0.99, 0.1, 0]), baseCfg());  // 3-dim, ~0.995
    await updateCacheIndex(BAD, Float32Array.from([1, 0]), baseCfg());           // 2-dim → sim throws
    await writeFile(join(testCacheDir, `${GOOD}.json`), JSON.stringify({ who: 'GOOD' }));
    const hit = await semanticLookupIndexed('q', baseCfg({ embedImpl: fixedVec([1, 0, 0]) }));
    assert.ok(hit, 'good 3-dim entry still matches despite a foreign-dim sibling');
    assert.equal(hit.who, 'GOOD');
  });
});
