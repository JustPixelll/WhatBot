import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, requestFor } from '../src/provider.js';
import { defaults, validateConfig, safeError, loadConfig, saveConfig } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { ...defaults, apiKey: 'fake-key-for-tests' };
const messages = [{ role: 'user', content: 'hello' }];

test('OpenAI request uses Responses with storage off and no tools', () => {
  const req = requestFor(config, messages);
  assert.equal(req.url, 'https://api.openai.com/v1/responses');
  assert.equal(req.body.store, false);
  assert.equal(req.body.tools, undefined);
  assert.equal(req.body.input, messages);
  assert.equal(req.headers.Authorization, 'Bearer fake-key-for-tests');
});

test('Claude request sends a separate system prompt and bounded output', () => {
  const req = requestFor({ ...config, provider: 'anthropic', model: 'claude-haiku-5-5' }, messages);
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.body.system, config.systemPrompt);
  assert.equal(req.body.max_tokens, config.maxOutputTokens);
  assert.equal(req.headers['x-api-key'], config.apiKey);
});

test('OpenAI text is extracted from message content after reasoning items', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ output: [
    { type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'A useful answer' }] }
  ] }) });
  assert.equal(await generate(config, messages, { fetchImpl }), 'A useful answer');
});

test('Claude ignores thinking blocks and returns text', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [
    { type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'Answer' }
  ] }) });
  assert.equal(await generate({ ...config, provider: 'anthropic' }, messages, { fetchImpl }), 'Answer');
});

test('HTTP errors never expose provider response bodies', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => { throw new Error('must not read sensitive body'); } });
  await assert.rejects(generate(config, messages, { fetchImpl }), /HTTP 401.*saved API key/);
});

test('network and empty-output errors are actionable', async () => {
  await assert.rejects(generate(config, messages, { fetchImpl: async () => { throw new Error('network'); } }), /internet connection/);
  await assert.rejects(generate(config, messages, { fetchImpl: async () => ({ ok: true, json: async () => ({ output: [] }) }) }), /no text/);
});

test('config rejects invalid bounds and never includes key in validation errors', () => {
  for (const patch of [{ backgroundMessages: -1 }, { groupIds: ['*'] }, { maxRequestsPerSession: 0 }, { model: 'bad model' }, { apiKey: 'short' }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
  assert.doesNotMatch(safeError(new Error('key=fake-key-for-tests\u001b[31m'), config.apiKey), /fake-key|\u001b/);
});

test('configuration saves and loads with group selection intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatbot-test-'));
  try {
    assert.equal(loadConfig(dir), null);
    saveConfig(dir, { ...config, groupIds: ['123@g.us'] });
    assert.deepEqual(loadConfig(dir).groupIds, ['123@g.us']);
    saveConfig(dir, { ...config, groupIds: ['456@g.us'] });
    assert.deepEqual(loadConfig(dir).groupIds, ['456@g.us']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
