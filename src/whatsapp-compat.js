import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const marker = '// WhatBot: message-key compatibility v1';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('The installed WhatsApp library differs from the supported version. Run npm ci, then restart WhatBot.');
  // A function replacement keeps literal $1 property names intact.
  return source.replace(before, () => after);
}

// Temporary compatibility bridge for the pinned 1.34.7 release. Background:
// https://github.com/wwebjs/whatsapp-web.js/issues/201845
// https://github.com/wwebjs/whatsapp-web.js/pull/201850
// Remove this bridge after testing a release with upstream compatibility fixes.
export function patchUtils(source) {
  if (source.includes(marker)) return source;
  source = replaceOnce(source, '    window.WWebJS = {};', `    window.WWebJS = {};
    ${marker}
    window.WWebJS.whatbotKeyId = (key) => {
        if (typeof key === 'string') return key || undefined;
        for (const value of [key?._serialized, key?.$1]) {
            if (typeof value === 'string' && value) return value;
        }
        return undefined;
    };`);
  source = replaceOnce(source, '.Msg.get(newMsgKey._serialized);', '.Msg.get(window.WWebJS.whatbotKeyId(newMsgKey));');
  source = replaceOnce(source, '.Msg.get(msg.id._serialized);', '.Msg.get(window.WWebJS.whatbotKeyId(msg.id));');
  source = replaceOnce(source, '        const msg = message.serialize();', `        const msg = message.serialize();
        const keyId = window.WWebJS.whatbotKeyId(msg.id) || window.WWebJS.whatbotKeyId(message.id);
        if (msg.id && keyId) msg.id = { ...msg.id, _serialized: keyId };`);
  source = replaceOnce(source, 'remote: msg.id.remote._serialized,', 'remote: window.WWebJS.whatbotKeyId(msg.id.remote),');
  source = replaceOnce(source, `        const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat),
        );
        return await Promise.all(chatPromises);`, `        const results = await Promise.allSettled(chats.map(async (chat) => window.WWebJS.getChatModel(chat)));
        window.WWebJS.whatbotSkippedChats = results.filter(result => result.status === 'rejected').length;
        return results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);`);
  source = replaceOnce(source, '        const model = chat.serialize();', `        const model = chat.serialize();
        const chatKey = window.WWebJS.whatbotKeyId(model.id) || window.WWebJS.whatbotKeyId(chat.id);
        if (model.id && chatKey) model.id = { ...model.id, _serialized: chatKey };`);
  source = replaceOnce(source, '.createWid(chat.id._serialized);', '.createWid(window.WWebJS.whatbotKeyId(chat.id));');
  source = replaceOnce(source, '            await groupMetadata.update(chatWid);', `            try { await groupMetadata.update(chatWid); }
            catch { /* Cached metadata can still describe an otherwise usable LID chat. */ }`);
  const start = source.indexOf('        model.lastMessage = null;');
  const end = source.indexOf('        delete model.msgs;', start);
  if (start < 0 || end < start) throw new Error('Unsupported WhatsApp chat serializer. Run npm ci, then restart.');
  source = source.slice(0, start) + `        model.lastMessage = null;
        const lastId = window.WWebJS.whatbotKeyId(chat.lastReceivedKey);
        if (lastId && model.msgs && model.msgs.length) {
            // Never pass an absent key to IndexedDB. A missing preview must not
            // prevent listing a group or replying to a new message in it.
            try {
                const messages = window.require('WAWebCollections').Msg;
                const last = messages.get(lastId) || (await messages.getMessagesById([lastId]))?.messages?.[0];
                if (last) model.lastMessage = window.WWebJS.getMessageModel(last);
            } catch { /* Last-message previews are optional. */ }
        }

` + source.slice(end);
  new Script(source, { filename: 'whatsapp-web.js/Utils.js' });
  return source;
}

export function applyWhatsAppCompatibility({ log = console.log } = {}) {
  const manifestPath = require.resolve('whatsapp-web.js/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== '1.34.7') throw new Error('WhatBot currently supports whatsapp-web.js 1.34.7. Run npm ci to restore its pinned dependencies.');
  const target = join(dirname(manifestPath), 'src', 'util', 'Injected', 'Utils.js');
  const original = readFileSync(target, 'utf8');
  const patched = patchUtils(original);
  if (patched !== original) {
    // Validate the entire change before replacing the dependency file. The patch
    // is reapplied after npm ci and requires no Git or patch program on Windows.
    const temp = target + '.whatbot.tmp';
    writeFileSync(temp, patched);
    renameSync(temp, target);
  }
  log('WhatsApp compatibility fix active.');
}
