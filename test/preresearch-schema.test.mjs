import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRERESEARCH_SCHEMAS,
  normalizePreresearch,
  parsePreresearchResponse,
} from '../preresearch-schema.mjs';

const agentic = {
  intent: 'code_writing',
  summary: 'Add retries to the payment service.',
  relevant_files: [{ path: 'src/payments.ts', purpose: 'Payment service' }],
  existing_patterns: ['withRetry is used by the billing client'],
  recent_changes: 'Added RateLimitError in the last release.',
  dependencies: ['src/utils/retry.ts'],
  tasks: ['Read submitPayment', 'Update its tests'],
  approach: 'Wrap the HTTP call with the existing retry helper.',
  warnings: [],
};

const fast = {
  intent: 'debugging',
  tasks: ['Reproduce the failure', 'Add a regression test'],
  tech: ['Node.js'],
  files: ['src/server.js'],
  approach: 'Trace the request from the route to the failing handler.',
};

const detailed = {
  intent: {
    primary: 'refactoring',
    secondary: ['code_review'],
    confidence: 0.85,
  },
  decomposition: [{ task: 'Extract the shared helper', priority: 1, dependencies: [] }],
  implicit_context: {
    domain: 'backend',
    assumed_knowledge: ['TypeScript'],
    relevant_technologies: ['Node.js'],
  },
  ambiguities: [],
  success_criteria: ['Existing tests continue to pass'],
  suggested_approach: 'Extract the helper, then update callers incrementally.',
  skip_rlm: false,
  skip_reason: null,
};

describe('preresearch schema definitions', () => {
  it('defines required and optional fields for all three modes', () => {
    assert.deepEqual(Object.keys(PRERESEARCH_SCHEMAS), ['agentic', 'fast', 'detailed']);
    for (const schema of Object.values(PRERESEARCH_SCHEMAS)) {
      assert.ok(schema.required.length > 0);
      assert.ok(Array.isArray(schema.optional));
      assert.ok(typeof schema.tag === 'string');
    }
    assert.ok(PRERESEARCH_SCHEMAS.agentic.required.includes('relevant_files'));
    assert.ok(PRERESEARCH_SCHEMAS.fast.optional.includes('skip_reason'));
    assert.ok(PRERESEARCH_SCHEMAS.detailed.required.includes('intent.confidence'));
  });
});

describe('preresearch response parsing', () => {
  it('parses direct JSON for agentic, fast, and detailed shapes', () => {
    assert.deepEqual(parsePreresearchResponse(JSON.stringify(agentic)), agentic);
    assert.deepEqual(parsePreresearchResponse(JSON.stringify(fast)), fast);
    assert.deepEqual(parsePreresearchResponse(JSON.stringify(detailed)), detailed);
  });

  it('parses JSON fenced with json and unlabelled fences', () => {
    assert.deepEqual(
      parsePreresearchResponse(`Explanation\n\`\`\`json\n${JSON.stringify(fast)}\n\`\`\``),
      fast,
    );
    assert.deepEqual(
      parsePreresearchResponse(`\`\`\`\n${JSON.stringify(agentic)}\n\`\`\``),
      agentic,
    );
  });

  it('extracts a nested object from prose with the balanced-object fallback', () => {
    const response = `The analysis is below: ${JSON.stringify(detailed)}\nThat is all.`;
    assert.deepEqual(parsePreresearchResponse(response), detailed);
  });

  it('does not stop regex-style extraction at nested braces or braces in strings', () => {
    const response = `Model output: ${JSON.stringify({
      ...agentic,
      summary: 'Use the {existing} retry pattern.',
      metadata: { source: 'search', count: 2 },
    })}`;
    const parsed = parsePreresearchResponse(response);
    assert.equal(parsed.summary, 'Use the {existing} retry pattern.');
    assert.deepEqual(parsed.metadata, { source: 'search', count: 2 });
  });

  it('returns a skip result for malformed and non-object responses', () => {
    for (const response of ['not JSON', '{"intent":', 'null', '[]', null, undefined]) {
      const parsed = parsePreresearchResponse(response);
      assert.equal(parsed.skip_rlm, true);
      assert.match(parsed.skip_reason, /parse|object/i);
    }
  });
});

describe('preresearch normalization', () => {
  it('preserves valid fields while allowing missing optional fields', () => {
    const normalized = normalizePreresearch({ intent: 'code_writing', tasks: ['Implement it'] });
    assert.equal(normalized.intent, 'code_writing');
    assert.deepEqual(normalized.tasks, ['Implement it']);
    assert.equal('warnings' in normalized, false, 'Missing fields remain absent in serialized JSON');
  });

  it('turns invalid containers and entries into safe empty values', () => {
    const normalized = normalizePreresearch({
      intent: 42,
      relevant_files: 'src/not-an-array.js',
      tasks: [null, 3, 'Keep this task'],
      decomposition: [{ task: 'Keep this item' }, 'invalid', null],
      implicit_context: 'invalid context',
      skip: 'false',
    });

    assert.deepEqual(normalized.intent, {});
    assert.deepEqual(normalized.relevant_files, []);
    assert.deepEqual(normalized.tasks, ['Keep this task']);
    assert.deepEqual(normalized.decomposition, [{ task: 'Keep this item' }]);
    assert.deepEqual(normalized.implicit_context, {});
    assert.equal(normalized.skip, false);
  });

  it('filters malformed relevant-file entries without throwing', () => {
    const normalized = normalizePreresearch({
      relevant_files: [null, 7, { purpose: 'missing path' }, { path: 'src/ok.js', purpose: 4 }, 'src/string.js'],
    });
    assert.deepEqual(normalized.relevant_files, [
      { path: 'src/ok.js' },
      'src/string.js',
    ]);
  });
});
