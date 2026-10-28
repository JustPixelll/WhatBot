import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from '../src/setup.js';
import { ensureBrowser } from '../src/browser.js';

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  const destination = new PassThrough();
  destination.columns = 100;
  let output = '';
  destination.on('data', chunk => { output += chunk; });
  const prompts = createPrompter({ input, destination });
  return { input, prompts, output: () => output };
}

test('one terminal session accepts retry, provider, model, hidden key and context answers', async () => {
  const t = terminal();
  try {
    for (const [question, value, secret] of [
      ['Provider: ', 'wrong', false], ['Provider: ', '2', false],
      ['Model ID: ', 'test-model', false], ['API key (hidden): ', 'test-secret-key', true],
      ['Background? ', 'n', false]
    ]) {
      const answer = t.prompts.ask(question, { secret });
      t.input.write(value + '\r\n');
      assert.equal(await answer, value);
    }
    assert.match(t.output(), /Model ID:/);
    assert.match(t.output(), /Background\?/);
    assert.doesNotMatch(t.output(), /test-secret-key/);
  } finally { t.prompts.close(); }
});

test('Ctrl+C cancels a waiting setup question', async () => {
  const t = terminal();
  try {
    const answer = t.prompts.ask('Provider: ');
    t.input.write('\x03');
    await assert.rejects(answer, /cancelled/);
  } finally { t.prompts.close(); }
});

test('browser preflight skips an existing browser', async () => {
  await ensureBrowser({ puppeteer: { executablePath: async () => '/browser' }, exists: () => true,
    install: async () => { assert.fail('Must not download again'); } });
});

test('browser preflight repairs a skipped install script and verifies the download', async () => {
  let installed = false;
  await ensureBrowser({ puppeteer: { executablePath: async () => '/browser' }, exists: () => installed,
    install: async () => { installed = true; }, log: () => {} });
  assert.equal(installed, true);
  await assert.rejects(ensureBrowser({ puppeteer: { executablePath: async () => '/browser' }, exists: () => false,
    install: async () => {}, log: () => {} }), /still missing/);
});
