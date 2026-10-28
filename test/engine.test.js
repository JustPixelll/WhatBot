import test from 'node:test';
import assert from 'node:assert/strict';
import { BotEngine, promptFrom } from '../src/engine.js';
import { defaults } from '../src/config.js';

const groupA = '123456@g.us';
const groupB = '987654@g.us';
function harness(overrides = {}) {
  let clock = 200000;
  const sent = [], requests = [], logs = [];
  const config = { ...defaults, apiKey: 'test-key-only', groupIds: [groupA, groupB], ...overrides.config };
  const engine = new BotEngine({ config, startedAt: 100000, now: () => clock,
    generate: async messages => { requests.push(messages); return 'Hello from the model.'; },
    send: async (message, body) => sent.push({ groupId: message.groupId, body }),
    log: value => logs.push(value), ...overrides, config });
  let serial = 0;
  const message = (fields = {}) => ({ id: String(++serial), groupId: groupA, author: 'person-a', type: 'chat',
    timestamp: clock / 1000, body: '!ask hello', nativeMention: false, botIds: ['111@c.us', '222@lid'], ...fields });
  return { engine, sent, requests, logs, message, advance: () => { clock += 6000; } };
}

test('native phone and LID mentions trigger; unrelated mentions and ordinary text do not', () => {
  assert.equal(promptFrom('@111 hello', true, ['111@c.us']), 'hello');
  assert.equal(promptFrom('@222 hello', true, ['222@lid']), 'hello');
  assert.equal(promptFrom('@1112 hello', true, ['111@c.us']), '@1112 hello');
  assert.equal(promptFrom('whatbot hello', false), null);
  assert.equal(promptFrom('!asking hello', false), null);
  assert.equal(promptFrom('!ask hello', false), 'hello');
});

test('unselected groups, DMs, own messages, statuses and non-text never call AI', async () => {
  const h = harness();
  for (const fields of [{ groupId: '333@g.us' }, { groupId: '123@c.us' }, { fromMe: true }, { isStatus: true }, { type: 'image' }]) await h.engine.handle(h.message(fields));
  assert.equal(h.requests.length, 0);
  assert.equal(h.sent.length, 0);
});

test('empty group allowlist disables all replies', async () => {
  const h = harness({ config: { groupIds: [] } });
  await h.engine.handle(h.message());
  assert.equal(h.requests.length, 0);
});

test('old, pre-start and duplicate messages cannot trigger extra calls', async () => {
  const h = harness();
  assert.equal(await h.engine.handle(h.message({ timestamp: 99 })), 'old');
  assert.equal(await h.engine.handle(h.message({ timestamp: NaN })), 'old');
  const msg = h.message();
  await h.engine.handle(msg);
  h.advance();
  assert.equal(await h.engine.handle(msg), 'duplicate');
  assert.equal(h.requests.length, 1);
});

test('background messages stay out of model requests by default', async () => {
  const h = harness();
  await h.engine.handle(h.message({ body: 'Private unrelated discussion' }));
  await h.engine.handle(h.message());
  assert.equal(JSON.stringify(h.requests).includes('Private unrelated discussion'), false);
});

test('opted-in background context is bounded, cleared after use, and isolated by group', async () => {
  const h = harness({ config: { backgroundMessages: 2 } });
  for (const body of ['discard-me', 'keep-one', 'keep-two']) await h.engine.handle(h.message({ body }));
  await h.engine.handle(h.message({ groupId: groupB, body: 'other-group-secret' }));
  await h.engine.handle(h.message());
  const request = JSON.stringify(h.requests[0]);
  assert.match(request, /keep-one/); assert.match(request, /keep-two/);
  assert.doesNotMatch(request, /discard-me|other-group-secret/);
  h.advance();
  await h.engine.handle(h.message({ body: '!ask follow up' }));
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /keep-one|keep-two/);
});

test('history follows prompted exchanges and stays separate between groups', async () => {
  const h = harness();
  await h.engine.handle(h.message({ body: '!ask first-group-question' }));
  await h.engine.handle(h.message({ groupId: groupB }));
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /first-group-question/);
  h.advance();
  await h.engine.handle(h.message({ body: '!ask follow-up' }));
  assert.match(JSON.stringify(h.requests[2]), /first-group-question/);
  assert.equal(h.requests[2][1].role, 'assistant');
});

test('reset and help do not call the provider; reset clears shared context', async () => {
  const h = harness();
  await h.engine.handle(h.message()); h.advance();
  await h.engine.handle(h.message({ body: '!ask reset' })); h.advance();
  await h.engine.handle(h.message({ body: '!ask help' })); h.advance();
  await h.engine.handle(h.message({ body: '!ask status' })); h.advance();
  await h.engine.handle(h.message({ body: '!ask fresh' }));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].length, 1);
});

test('session request limit and oversized prompts stop billable calls', async () => {
  const h = harness({ config: { maxRequestsPerSession: 1 } });
  assert.equal(await h.engine.handle(h.message({ body: '!ask ' + 'x'.repeat(6001) })), 'too-long'); h.advance();
  await h.engine.handle(h.message()); h.advance();
  assert.equal(await h.engine.handle(h.message()), 'limit');
  assert.equal(h.requests.length, 1);
});

test('one request per group at a time and cooldown suppress burst traffic', async () => {
  let complete;
  const h = harness({ generate: () => new Promise(resolve => { complete = resolve; }) });
  const first = h.engine.handle(h.message());
  assert.equal(await h.engine.handle(h.message()), 'busy');
  complete('Done'); await first;
  assert.equal(await h.engine.handle(h.message()), 'busy');
  assert.equal(h.engine.requests, 1);
});

test('aborting an in-flight generation prevents late WhatsApp replies', async () => {
  let complete;
  const controller = new AbortController();
  const h = harness({ signal: controller.signal, generate: () => new Promise(resolve => { complete = resolve; }) });
  const result = h.engine.handle(h.message());
  controller.abort(); complete('Too late');
  assert.equal(await result, 'stopped');
  assert.equal(h.sent.length, 0);
});

test('provider failures count toward the limit and do not leak error details to WhatsApp', async () => {
  const h = harness({ generate: async () => { throw new Error('sensitive internal detail'); } });
  assert.equal(await h.engine.handle(h.message()), 'error');
  assert.equal(h.engine.requests, 1);
  assert.doesNotMatch(h.sent[0].body, /sensitive/);
});

test('long replies stay within a single bounded WhatsApp message', async () => {
  const h = harness({ generate: async () => 'x'.repeat(9000) });
  await h.engine.handle(h.message());
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].body.length <= 3500);
  assert.match(h.sent[0].body, /Reply shortened/);
});
