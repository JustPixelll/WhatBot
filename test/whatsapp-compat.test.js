import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { patchUtils } from '../src/whatsapp-compat.js';

const require = createRequire(import.meta.url);
const original = readFileSync(require.resolve('whatsapp-web.js/src/util/Injected/Utils.js'), 'utf8');

function fixture({ key = { $1: 'message-123' }, metadataFails = false, badChat = false, previewFails = false } = {}) {
  const lookups = [];
  const message = {
    id: key,
    serialize: () => ({ id: { ...key, remote: { _serialized: '123@g.us' } }, body: 'hello' })
  };
  const group = {
    id: { _serialized: '123@g.us' }, formattedTitle: 'Friends 🥳🍕', mute: { expiration: 0 },
    lastReceivedKey: key,
    groupMetadata: { serialize: () => ({ participants: [] }), announce: false },
    serialize: () => ({ id: { _serialized: '123@g.us' }, msgs: [{}] })
  };
  const collections = {
    Chat: { getModelsArray: () => badChat ? [{ serialize() { throw new Error('broken chat'); } }, group] : [group] },
    GroupMetadata: { update: async () => { if (metadataFails) throw new Error('r'); } },
    Msg: {
      get: id => { lookups.push(id); if (!id || previewFails) throw new Error('r'); return message; },
      getMessagesById: async ids => { lookups.push(...ids); if (ids.some(id => !id)) throw new Error('r'); return { messages: [message] }; }
    }
  };
  const modules = {
    WAWebCollections: collections,
    WAWebWidFactory: { createWid: id => { assert.ok(id); return id; } },
    WAWebLidMigrationUtils: { toPn: id => id },
    WALinkify: { findLinks: () => [] }
  };
  const context = createContext({ exports: {}, window: { require: name => modules[name] } });
  new Script(patchUtils(original)).runInContext(context);
  context.exports.LoadUtils();
  return { api: context.window.WWebJS, group, message, lookups };
}

test('actual library serializer accepts renamed message keys and emoji group names', async () => {
  const f = fixture();
  const groups = await f.api.getChats();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].formattedTitle, 'Friends 🥳🍕');
  assert.equal(groups[0].id._serialized, '123@g.us');
  assert.equal(groups[0].lastMessage.id._serialized, 'message-123');
  assert.deepEqual(f.lookups, ['message-123']);
});

test('legacy message keys continue to work and take precedence', async () => {
  const f = fixture({ key: { _serialized: 'legacy', $1: 'renamed' } });
  const groups = await f.api.getChats();
  assert.equal(groups[0].lastMessage.id._serialized, 'legacy');
  assert.deepEqual(f.lookups, ['legacy']);
});

test('an absent last-message key never reaches IndexedDB', async () => {
  const f = fixture({ key: {} });
  const groups = await f.api.getChats();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lastMessage, null);
  assert.deepEqual(f.lookups, []);
});

test('bad previews and metadata refreshes do not remove usable groups', async () => {
  const f = fixture({ previewFails: true, metadataFails: true });
  const groups = await f.api.getChats();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isGroup, true);
  assert.equal(groups[0].lastMessage, null);
});

test('one malformed chat does not discard the entire chat list', async () => {
  const f = fixture({ badChat: true });
  assert.equal((await f.api.getChats()).length, 1);
  assert.equal(f.api.whatbotSkippedChats, 1);
});

test('incoming message normalization preserves source objects', () => {
  const f = fixture();
  const normalized = f.api.getMessageModel(f.message);
  assert.equal(normalized.id._serialized, 'message-123');
  assert.equal(normalized.id.remote, '123@g.us');
  assert.equal(f.message.id._serialized, undefined);
});

test('patch is idempotent and rejects unexpected dependency source', () => {
  const patched = patchUtils(original);
  assert.equal(patchUtils(patched), patched);
  assert.throws(() => patchUtils('different implementation'), /installed WhatsApp library differs/);
});
