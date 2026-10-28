import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, safeError } from './config.js';
import { setup, chooseGroups } from './setup.js';
import { generate } from './provider.js';
import { BotEngine } from './engine.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
let client;
let config;
let stopping = false;
const controller = new AbortController();

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  controller.abort();
  console.log('\nStopping WhatBot...');
  const timeout = setTimeout(() => process.exit(code), 5000);
  try { if (client) await client.destroy(); } catch { /* Browser may already be closed. */ }
  clearTimeout(timeout);
  process.exit(code);
}

async function main() {
  const mode = process.argv[2];
  if (mode && !['--setup', '--groups', '--check'].includes(mode)) throw new Error('Supported options: --setup, --groups, --check');
  config = loadConfig(root);
  if (mode === '--check') {
    if (!config) throw new Error('No configuration yet. Run Start-WhatBot.cmd.');
    console.log(`Configuration is valid. ${config.groupIds.length} selected group(s). No API or WhatsApp requests made.`);
    return;
  }
  if (!config || mode === '--setup') config = await setup(root, config);
  if (mode === '--setup') { console.log('Next: double-click Start-WhatBot.cmd.'); return; }

  const [{ default: wweb }, { default: qrcode }] = await Promise.all([import('whatsapp-web.js'), import('qrcode-terminal')]);
  client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: join(root, 'data', 'whatsapp'), clientId: 'whatbot' }),
    puppeteer: { headless: true },
    webVersionCache: { type: 'local', path: join(root, 'data', 'web-cache') }
  });
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  client.on('qr', qr => {
    console.log('\nOn your phone, switch to the WhatBot account. Open Linked devices > Link a device.\nScan this QR here. Do not share it.\n');
    qrcode.generate(qr, { small: true });
  });
  client.on('authenticated', () => console.log('WhatsApp linked. Waiting for chats to load...'));
  client.on('auth_failure', () => { console.error('WhatsApp authentication failed. Unlink this device from the WhatBot phone account and try again.'); void stop(1); });
  client.on('disconnected', () => { console.error('WhatsApp disconnected. Start WhatBot again when you want to reconnect.'); void stop(1); });

  let engine;
  let botIds = [];
  client.once('ready', () => void (async () => {
    botIds = [client.info.wid._serialized];
    try {
      const aliases = await client.getContactLidAndPhone(botIds);
      for (const alias of aliases) botIds.push(alias.lid, alias.pn);
      botIds = [...new Set(botIds.filter(id => typeof id === 'string'))];
    } catch { console.log('Native mention alias lookup unavailable. !ask remains available.'); }
    if (mode === '--groups' || !config.groupIds.length) await chooseGroups(client, root, config);
    if (mode === '--groups') { console.log('Groups saved. Start WhatBot when you are ready.'); await stop(); return; }
    engine = new BotEngine({
      config, startedAt: Date.now(), signal: controller.signal,
      generate: messages => generate(config, messages, { signal: controller.signal }),
      send: (message, text) => message.original.reply(text, undefined, { linkPreview: false, sendSeen: false }),
      log: value => console.log(value instanceof Error ? safeError(value, config.apiKey) : value)
    });
    console.log(`\nWhatBot is ready in ${config.groupIds.length} selected group(s).`);
    console.log('Tag its WhatsApp contact or send !ask followed by a question.');
    console.log('Only new text messages are handled. Direct messages and offline backlog are ignored.');
    console.log(`Background context: ${config.backgroundMessages ? `up to ${config.backgroundMessages} messages` : 'off'}. API calls this run are capped at ${config.maxRequestsPerSession}.`);
    console.log('Leave this window open while using the bot. Press Ctrl+C to stop.\n');
  })().catch(error => { console.error(safeError(error, config.apiKey)); void stop(1); }));

  client.on('message', message => void (async () => {
    if (!engine || stopping || message.fromMe || !config.groupIds.includes(message.from)) return;
    let nativeMention = (message.mentionedIds || []).some(id => botIds.includes(id));
    if (!nativeMention && message.mentionedIds?.length) {
      try { nativeMention = (await message.getMentions()).some(contact => contact.isMe); } catch { /* Fail closed; !ask still works. */ }
    }
    await engine.handle({
      original: message, id: message.id?._serialized, groupId: message.from, author: message.author,
      body: message.body, type: message.type, timestamp: message.timestamp,
      fromMe: message.fromMe, isStatus: message.isStatus, nativeMention, botIds
    });
  })().catch(error => console.error(safeError(error, config.apiKey))));

  console.log('\nOpening WhatsApp. The first connection can take a minute...');
  await client.initialize();
}

main().catch(async error => {
  console.error(safeError(error, config?.apiKey));
  if (client) await stop(1);
  else process.exitCode = 1;
});
