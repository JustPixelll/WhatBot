import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, loadConfig, saveConfig, safeError } from '../src/config.js';
import { requestFor, generateImage } from '../src/provider.js';
import { loadMessageImage, validateImage, MAX_IMAGE_BYTES, ImageInputError } from '../src/media.js';
import { BotEngine, promptFrom } from '../src/engine.js';
import { loadPersonality } from '../src/personality.js';
import { setupImagesWithPrompt } from '../src/setup.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const photo = { mimetype: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
const config = { ...defaults, provider: 'anthropic', apiKey: 'test-claude-key', imageApiKey: 'test-image-key', imageGeneration: true, groupIds: ['123@g.us', '456@g.us'] };
const temp = () => mkdtempSync(join(tmpdir(), 'whatbot-images-'));
function harness(extra = {}) {
  let clock = 200000, id = 0;
  const sent = [], calls = [], generated = [];
  const engine = new BotEngine({ config: { ...config, ...extra.config }, startedAt: 100000, now: () => clock,
    generate: async messages => { calls.push(messages); return 'Ein Bild.'; },
    generateImage: async prompt => { generated.push(prompt); return photo; },
    send: async (msg, text) => sent.push({ type: 'text', text }),
    sendImage: async (msg, image, caption) => sent.push({ type: 'image', image, caption }),
    ...extra, config: { ...config, ...extra.config } });
  const message = (fields = {}) => ({ id: String(++id), groupId: '123@g.us', author: 'member', type: 'chat', timestamp: clock / 1000, body: '!ask was siehst du?', ...fields });
  return { engine, sent, calls, generated, message, advance: () => { clock += 6000; } };
}

test('Claude photo payload uses its own key and base64 image blocks; OpenAI uses data URLs', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', ...photo }, { type: 'text', text: 'Describe' }] }];
  const claude = requestFor(config, messages);
  assert.deepEqual(claude.body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: photo.data } });
  assert.equal(claude.headers['x-api-key'], config.apiKey);
  assert.doesNotMatch(JSON.stringify(claude), /test-image-key/);
  const openai = requestFor({ ...config, provider: 'openai' }, messages);
  assert.equal(openai.body.input[0].content[0].image_url, `data:image/png;base64,${photo.data}`);
  assert.equal(openai.body.input[0].content[1].type, 'input_text');
  assert.equal(openai.body.store, false);
});

test('image generation uses only the OpenAI image key and returns sendable media', async () => {
  let request;
  const image = await generateImage(config, 'a cartoon penguin', { fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ data: [{ b64_json: photo.data }] }) };
  } });
  assert.deepEqual(image, photo);
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(request.headers.Authorization, 'Bearer test-image-key');
  assert.doesNotMatch(JSON.stringify(request), /test-claude-key/);
  assert.equal(request.body.n, 1);
  assert.equal(request.body.quality, 'low');
  assert.equal(request.body.size, '1024x1024');
  assert.match(request.body.prompt, /a cartoon penguin/);
  assert.match(request.body.prompt, /Group persona/);
});

test('missing image keys never send Claude credentials to OpenAI; disabled means zero calls', async () => {
  const fetchImpl = async () => assert.fail('No request allowed');
  await assert.rejects(generateImage({ ...config, imageApiKey: '' }, 'cat', { fetchImpl }), /off/);
  await assert.rejects(generateImage({ ...config, imageGeneration: false }, 'cat', { fetchImpl }), /off/);
});

test('OpenAI chat keys can be explicitly reused for generation without a second stored key', async () => {
  const reuse = { ...config, provider: 'openai', imageApiKey: '' };
  await generateImage(reuse, 'cat', { fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${reuse.apiKey}`);
    return { ok: true, json: async () => ({ data: [{ b64_json: photo.data }] }) };
  } });
});

test('image provider errors and malformed output never echo credentials or request bodies', async () => {
  await assert.rejects(generateImage(config, 'cat', { fetchImpl: async () => ({ ok: false, status: 403, json: () => assert.fail('Do not read body') }) }), /HTTP 403/);
  await assert.rejects(generateImage(config, 'cat', { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ url: 'https://untrusted.example/' }] }) }) }), /no usable PNG/);
  assert.doesNotMatch(safeError(new Error('test-claude-key test-image-key'), [config.apiKey, config.imageApiKey]), /test-/);
});

test('input validation rejects oversized, unsupported, and spoofed image content', () => {
  assert.deepEqual(validateImage(photo), photo);
  for (const media of [undefined, { ...photo, mimetype: 'image/svg+xml' }, { ...photo, data: 'dGV4dA==' }, { ...photo, data: 'bad!' }, { ...photo, data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) }]) {
    assert.throws(() => validateImage(media), ImageInputError);
  }
});

test('loads captioned photos and explicitly quoted group photos, including own generated photos', async () => {
  const original = { type: 'image', from: '123@g.us', hasMedia: true, downloadMedia: async () => photo };
  assert.deepEqual(await loadMessageImage(original), photo);
  for (const quoted of [original, { ...original, from: 'bot@c.us', to: '123@g.us' }]) {
    assert.deepEqual(await loadMessageImage({ type: 'chat', from: '123@g.us', hasQuotedMsg: true, getQuotedMessage: async () => quoted }), photo);
  }
});

test('view-once, cross-group, missing, unsupported and timed-out media cannot go to AI', async () => {
  const base = { type: 'image', hasMedia: true, from: '123@g.us', downloadMedia: async () => photo };
  await assert.rejects(loadMessageImage({ ...base, rawData: { isViewOnce: true }, downloadMedia: () => assert.fail() }), /Einmalansicht/);
  await assert.rejects(loadMessageImage({ ...base, rawData: { size: MAX_IMAGE_BYTES + 1 }, downloadMedia: () => assert.fail() }), /5 MB/);
  await assert.rejects(loadMessageImage({ ...base, hasMedia: false }), /verfügbar/);
  await assert.rejects(loadMessageImage({ type: 'chat', from: '456@g.us', hasQuotedMsg: true, getQuotedMessage: async () => base }), /dieser Gruppe/);
  await assert.rejects(loadMessageImage({ type: 'chat', hasQuotedMsg: true, getQuotedMessage: async () => ({ type: 'video', hasMedia: true }) }), /Videos/);
  await assert.rejects(loadMessageImage({ ...base, downloadMedia: () => new Promise(() => {}) }, { timeoutMs: 10 }), /rechtzeitig/);
});

test('untagged images, wrong groups, stale messages, commands and exhausted budgets never load photos', async () => {
  let loads = 0;
  const h = harness({ loadImage: async () => { loads++; return photo; } });
  for (const fields of [{ body: 'ordinary caption', type: 'image' }, { groupId: '999@g.us', type: 'image' }, { timestamp: 99, type: 'image' }, { fromMe: true, type: 'image' }, { body: '!ask help', type: 'image' }]) {
    await h.engine.handle(h.message(fields)); h.advance();
  }
  h.engine.requests = config.maxRequestsPerSession;
  await h.engine.handle(h.message({ type: 'image' }));
  assert.equal(loads, 0);
  assert.equal(h.calls.length, 0);
});

test('image bytes go only to the current vision call, never history or unrelated follow-ups', async () => {
  const h = harness({ loadImage: async () => photo });
  assert.equal(await h.engine.handle(h.message({ hasQuotedMsg: true, displayName: 'Guest' })), 'answered');
  assert.match(JSON.stringify(h.calls[0]), new RegExp(photo.data.slice(0, 20)));
  assert.match(JSON.stringify(h.calls[0]), /Guest/);
  assert.doesNotMatch(JSON.stringify(h.engine.group('123@g.us')), new RegExp(photo.data.slice(0, 20)));
  h.advance();
  await h.engine.handle(h.message({ body: '!ask follow-up' }));
  assert.doesNotMatch(JSON.stringify(h.calls[1]), new RegExp(photo.data.slice(0, 20)));
  assert.match(JSON.stringify(h.calls[1]), /pixels are not retained/);
});

test('a bare mention in a photo caption gets a description; failed photos do not hallucinate an answer', async () => {
  const h = harness({ loadImage: async () => photo });
  assert.equal(await h.engine.handle(h.message({ type: 'image', body: '@111', nativeMention: true, botIds: ['111@c.us'] })), 'answered');
  const broken = harness({ loadImage: async () => { throw new ImageInputError('Please resend photo'); } });
  assert.equal(await broken.engine.handle(broken.message({ type: 'image' })), 'invalid-image');
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.engine.requests, 0);
  assert.match(broken.sent[0].text, /resend/);
});

test('photo loading cannot race the last global budget slot or deliver after abort', async () => {
  let finish;
  const h = harness({ config: { maxRequestsPerSession: 1 }, loadImage: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.engine.handle(h.message({ type: 'image' }));
  await h.engine.handle(h.message({ groupId: '456@g.us' }));
  finish(photo);
  assert.equal(await pending, 'limit');
  assert.equal(h.calls.length, 1);
  const controller = new AbortController();
  const other = harness({ signal: controller.signal, loadImage: () => new Promise(resolve => { finish = resolve; }) });
  const pending2 = other.engine.handle(other.message({ type: 'image' }));
  controller.abort(); finish(photo);
  assert.equal(await pending2, 'stopped');
  assert.equal(other.calls.length, 0);
  assert.equal(other.sent.length, 0);
});

test('German and English image commands return real media and share request limits', async () => {
  assert.equal(promptFrom('!bild ein Pinguin', false), 'image ein Pinguin');
  assert.equal(promptFrom('!image a penguin', false), 'image a penguin');
  assert.equal(promptFrom('!bilder cat', false), null);
  const h = harness({ config: { maxImagesPerSession: 1 } });
  assert.equal(await h.engine.handle(h.message({ body: '!bild ein Pinguin' })), 'image');
  assert.equal(h.sent[1].type, 'image');
  assert.match(h.sent[1].caption, /KI-generiert/);
  assert.equal(h.engine.requests, 1);
  assert.equal(h.calls.length, 0);
  h.advance();
  assert.equal(await h.engine.handle(h.message({ body: '!image another penguin' })), 'image-limit');
  assert.equal(h.generated.length, 1);
  assert.doesNotMatch(JSON.stringify(h.engine.group('123@g.us')), new RegExp(photo.data.slice(0, 20)));
});

test('disabled generation and image editing attempts cannot create billable calls', async () => {
  const off = harness({ config: { imageGeneration: false } });
  assert.equal(await off.engine.handle(off.message({ body: '!bild cat' })), 'images-off');
  assert.equal(off.generated.length, 0);
  const edit = harness();
  assert.equal(await edit.engine.handle(edit.message({ body: '!bild edit it', hasQuotedMsg: true })), 'no-editing');
  assert.equal(edit.generated.length, 0);
});

test('image failures count once and stop prevents late media delivery', async () => {
  const failed = harness({ generateImage: async () => { throw new Error('secret'); } });
  assert.equal(await failed.engine.handle(failed.message({ body: '!bild cat' })), 'error');
  assert.equal(failed.engine.imageRequests, 1);
  assert.equal(failed.engine.requests, 1);
  assert.doesNotMatch(JSON.stringify(failed.sent), /secret/);
  let finish;
  const controller = new AbortController();
  const h = harness({ signal: controller.signal, generateImage: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.engine.handle(h.message({ body: '!bild cat' }));
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(); finish(photo);
  assert.equal(await pending, 'stopped');
  assert.equal(h.sent.filter(s => s.type === 'image').length, 0);
});

test('long private UTF-8/BOM prompts override defaults without leaking into saved configuration', () => {
  const root = temp();
  try {
    saveConfig(root, config);
    assert.equal(loadPersonality(root, config).custom, false);
    const prompt = 'Österreichischer Schmäh 🥳\n'.repeat(800);
    writeFileSync(join(root, 'data', 'system-prompt.txt'), '\uFEFF' + prompt);
    const result = loadPersonality(root, config);
    assert.equal(result.custom, true);
    assert.ok(result.systemPrompt.startsWith(prompt.trim()));
    assert.doesNotMatch(readFileSync(join(root, 'data', 'config.json'), 'utf8'), /Schmäh/);
    writeFileSync(join(root, 'data', 'system-prompt.txt'), ' ');
    assert.throws(() => loadPersonality(root, config), /must contain/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing config migrates with images disabled and preserves the chat key and groups', () => {
  const root = temp();
  try {
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'config.json'), JSON.stringify({ provider: 'anthropic', model: 'test-model', apiKey: 'old-test-key', groupIds: ['123@g.us'] }));
    const loaded = loadConfig(root);
    assert.equal(loaded.apiKey, 'old-test-key');
    assert.equal(loaded.imageGeneration, false);
    assert.deepEqual(loaded.groupIds, ['123@g.us']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('image setup stores a separate key while preserving chat settings and can turn off', async () => {
  const root = temp();
  try {
    const answers = ['y', 'sk-ant-wrong-provider', 'new-openai-test-key', ''];
    const configured = await setupImagesWithPrompt(root, { ...config, imageGeneration: false, imageApiKey: '' }, async () => answers.shift());
    assert.equal(configured.apiKey, config.apiKey);
    assert.equal(configured.provider, 'anthropic');
    assert.equal(configured.imageApiKey, 'new-openai-test-key');
    assert.deepEqual(configured.groupIds, config.groupIds);
    assert.equal(loadConfig(root).imageGeneration, true);
    await setupImagesWithPrompt(root, configured, async () => 'n');
    assert.equal(loadConfig(root).imageGeneration, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
