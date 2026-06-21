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
import { mkdir, rm, writeFile, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

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
