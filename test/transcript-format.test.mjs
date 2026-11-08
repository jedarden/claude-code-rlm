/**
 * Compatibility checks for observed Claude Code transcript JSONL shapes.
 * Fixtures are anonymized projections of real records; see architecture.md.
 * These tests call the hook's parser, rather than a copied implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTranscriptText } from '../rlm-hook.mjs';
import { summarize } from '../bench/parse-log.mjs';
import { renderHTML } from '../bench/dashboard.mjs';

async function fixture(name) {
  return readFile(new URL(`./fixtures/transcripts/${name}`, import.meta.url), 'utf8');
}

describe('Claude Code transcript format compatibility', () => {
  it('reads 2.1.319 string and block content with per-record timestamps', async () => {
    const parsed = parseTranscriptText(await fixture('current-2.1.319.jsonl'), { window: 2 });
    assert.equal(parsed.parseIssue, null);
    assert.deepEqual(parsed.messages.map((message) => message.role), ['assistant', 'user']);
    assert.match(parsed.messages[0].preview, /parser reads recent turns/);
    assert.deepEqual(parsed.priorBlocks.map((block) => ({
      intent: block.intent,
      files: block.relevant_files,
      ts: block.ts,
    })), [{
      intent: 'debugging',
      files: ['src/parser.js'],
      ts: Date.parse('2026-11-08T12:00:03.000Z'),
    }]);
  });

  it('reads 2.1.223 records with legacy queue metadata and analysis blocks', async () => {
    const parsed = parseTranscriptText(await fixture('legacy-2.1.223.jsonl'), { window: 2 });
    assert.equal(parsed.parseIssue, null);
    assert.deepEqual(parsed.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(parsed.priorBlocks.length, 1);
    assert.equal(parsed.priorBlocks[0].intent, 'learning');
    assert.deepEqual(parsed.priorBlocks[0].relevant_files, ['legacy.js']);
    assert.equal(parsed.priorBlocks[0].ts, Date.parse('2026-07-01T09:00:01.000Z'));
  });

  it('counts conversation turns despite metadata-heavy tails and a partial final write', async () => {
    const text = await fixture('current-2.1.319.jsonl');
    const tail = Array.from({ length: 8 }, () => JSON.stringify({ type: 'system' })).join('\n');
    const parsed = parseTranscriptText(`${text}${tail}\n{"type":"assistant"`, { window: 2 });
    assert.equal(parsed.parseIssue, null);
    assert.deepEqual(parsed.messages.map((message) => message.role), ['assistant', 'user']);
    assert.equal(parsed.priorBlocks.length, 1);
  });

  it('flags a transcript with no JSONL records', () => {
    const parsed = parseTranscriptText('unrecognized transcript bytes\n{broken', { window: 2 });
    assert.equal(parsed.parseIssue, 'no_jsonl_records');
    assert.deepEqual(parsed.messages, []);
  });

  it('flags a changed conversation content shape without copying its content', () => {
    const parsed = parseTranscriptText(JSON.stringify({
      type: 'user', message: { content: { parts: ['private text'] } },
    }), { window: 2 });
    assert.equal(parsed.parseIssue, 'unsupported_content');
    assert.deepEqual(parsed.messages, []);
  });

  it('flags a renamed text field inside a text block', () => {
    const parsed = parseTranscriptText(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', value: 'private text' }] },
    }));
    assert.equal(parsed.parseIssue, 'unsupported_content');
  });

  it('flags metadata-only JSONL as lacking conversation records', () => {
    const parsed = parseTranscriptText('{"type":"system"}\n{"type":"queue-operation"}\n');
    assert.equal(parsed.parseIssue, 'no_conversation_records');
  });

  it('shows transcript parse errors in the existing metrics dashboard', () => {
    const overall = summarize([
      { event: 'transcript_parse_error', reason: 'unsupported_content' },
      { event: 'cache_hit', cache_hit: true },
    ]);
    assert.equal(overall.events.transcript_parse_error, 1);
    assert.equal(overall.hit_rate, 1, 'diagnostics must not dilute outcome rates');
    assert.match(renderHTML({ overall, days: [] }), /Transcript parse errors<\/div><div class="value">1/);
  });

  it('treats an empty transcript as no prior context', () => {
    const parsed = parseTranscriptText('', { window: 2 });
    assert.equal(parsed.parseIssue, null);
    assert.deepEqual(parsed.messages, []);
  });
});
