import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, safeError } from './config.js';
import { setup, setupImages, chooseGroups } from './setup.js';
import { generate, generateImage } from './provider.js';
import { BotEngine } from './engine.js';
import { ensureBrowser } from './browser.js';
import { applyWhatsAppCompatibility } from './whatsapp-compat.js';
import { loadPersonality } from './personality.js';
import { loadMessageImage } from './media.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
let client;
let config;
let stopping = false;
let startupStage = 'Startup';
let readyTimer;
const controller = new AbortController();

function reportError(error) {
  const detail = safeError(error, [config?.apiKey, config?.imageApiKey]);
  console.error(`${startupStage} failed: ${detail === 'r' ? 'WhatsApp returned its internal r error while reading chat data.' : detail}`);
}

async function stop(code = 0, reason = code ? 'error' : 'finished') {
  if (stopping) return;
  stopping = true;
  clearTimeout(readyTimer);
  controller.abort();
  console.log(`\nStopping WhatBot (${reason})...`);
  const timeout = setTimeout(() => process.exit(code), 5000);
  try { if (client) await client.destroy(); } catch { /* Browser may already be closed. */ }
  clearTimeout(timeout);
  process.exit(code);
}

async function main() {
  const mode = process.argv[2];
  if (mode && !['--setup', '--images', '--groups', '--check'].includes(mode)) throw new Error('Supported options: --setup, --images, --groups, --check');
  config = loadConfig(root);
  if (mode === '--check') {
    if (!config) throw new Error('No configuration yet. Run Start-WhatBot.cmd.');
    const personality = loadPersonality(root, config);
    console.log(`Configuration is valid. ${config.groupIds.length} selected group(s). No API or WhatsApp requests made.`);
    console.log(`Personality: ${personality.custom ? 'data/system-prompt.txt' : 'config/default'}. Image generation: ${config.imageGeneration ? config.imageModel : 'off'}.`);
    return;
  }
  if (!config || mode === '--setup') config = await setup(root, config);
  if (mode === '--setup') { console.log('Next: double-click Start-WhatBot.cmd.'); return; }
  if (mode === '--images') { await setupImages(root, config); return; }
  const personality = loadPersonality(root, config);
  const aiConfig = { ...config, systemPrompt: personality.systemPrompt };
  console.log(personality.custom ? 'Custom personality loaded from data/system-prompt.txt.' : 'Using the default personality. Add data/system-prompt.txt to customize.');

  startupStage = 'Browser setup';
  await ensureBrowser();
  // This must run before importing whatsapp-web.js, which loads Utils.js once.
  applyWhatsAppCompatibility();
  const [{ default: wweb }, { default: qrcode }] = await Promise.all([import('whatsapp-web.js'), import('qrcode-terminal')]);
  client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: join(root, 'data', 'whatsapp'), clientId: 'whatbot' }),
    puppeteer: { headless: true },
    webVersionCache: { type: 'local', path: join(root, 'data', 'web-cache') }
  });
  process.on('SIGINT', () => void stop(0, 'Ctrl+C'));
  process.on('SIGTERM', () => void stop(0, 'termination requested'));
  client.on('qr', qr => {
    console.log('\nOn your phone, switch to the WhatBot account. Open Linked devices > Link a device.\nScan this QR here. Do not share it.\n');
    qrcode.generate(qr, { small: true });
  });
  client.on('authenticated', () => {
    startupStage = 'WhatsApp synchronization';
    console.log('WhatsApp linked. Waiting for chats to load...');
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      reportError(new Error('No ready signal after 2 minutes. Keep the WhatBot phone account online and restart.'));
      void stop(1, 'connection timeout');
    }, 120000);
  });
  client.on('loading_screen', percent => console.log(`Loading WhatsApp: ${percent}%`));
  client.on('auth_failure', () => { console.error('WhatsApp authentication failed. Unlink this device from the WhatBot phone account and try again.'); void stop(1); });
  client.on('disconnected', () => { console.error('WhatsApp disconnected. Start WhatBot again when you want to reconnect.'); void stop(1); });

  let engine;
  let botIds = [];
  client.once('ready', () => void (async () => {
    clearTimeout(readyTimer);
    console.log('WhatsApp is ready.');
    if (mode === '--groups' || !config.groupIds.length) {
      startupStage = 'Group selection';
      await chooseGroups(client, root, config);
    }
    if (mode === '--groups') { console.log('Groups saved. Start WhatBot when you are ready.'); await stop(0, 'groups saved'); return; }
    startupStage = 'Bot identity setup';
    botIds = [client.info.wid._serialized];
    try {
      const aliases = await client.getContactLidAndPhone(botIds);
      for (const alias of aliases) botIds.push(alias.lid, alias.pn);
      botIds = [...new Set(botIds.filter(id => typeof id === 'string'))];
    } catch { console.log('Native mention alias lookup unavailable. !ask remains available.'); }
    engine = new BotEngine({
      config, startedAt: Date.now(), signal: controller.signal,
      generate: messages => generate(aiConfig, messages, { signal: controller.signal }),
      generateImage: prompt => generateImage(aiConfig, prompt, { signal: controller.signal }),
      loadImage: message => loadMessageImage(message.original, { signal: controller.signal }),
      send: (message, text) => message.original.reply(text, undefined, { linkPreview: false, sendSeen: false }),
      sendImage: (message, image, caption) => message.original.reply(new wweb.MessageMedia(image.mimetype, image.data, 'whatbot.png'), undefined, { caption, sendSeen: false }),
      log: value => console.log(value instanceof Error ? safeError(value, [config.apiKey, config.imageApiKey]) : value)
    });
    console.log(`\nWhatBot is ready in ${config.groupIds.length} selected group(s).`);
    console.log('Tag its WhatsApp contact or send !ask followed by a question.');
    console.log('New text/photo questions are handled. Reply to a photo with !ask your question.');
    console.log(`Image generation: ${config.imageGeneration ? `!bild description (${config.imageModel}, max ${config.maxImagesPerSession}/run)` : 'off; run Configure-Images.cmd to enable'}.`);
    console.log('Direct messages and offline backlog are ignored.');
    console.log(`Background context: ${config.backgroundMessages ? `up to ${config.backgroundMessages} messages` : 'off'}. API calls this run are capped at ${config.maxRequestsPerSession}.`);
    console.log('Leave this window open while using the bot. Press Ctrl+C to stop.\n');
  })().catch(error => { reportError(error); void stop(1); }));

  client.on('message', message => void (async () => {
    if (!engine || stopping || message.fromMe || !config.groupIds.includes(message.from)) return;
    let nativeMention = (message.mentionedIds || []).some(id => botIds.includes(id));
    if (!nativeMention && message.mentionedIds?.length) {
      try { nativeMention = (await message.getMentions()).some(contact => contact.isMe); } catch { /* Fail closed; !ask still works. */ }
    }
    await engine.handle({
      original: message, id: message.id?._serialized, groupId: message.from, author: message.author,
      body: message.body, type: message.type, timestamp: message.timestamp,
      hasQuotedMsg: message.hasQuotedMsg, displayName: message.rawData?.notifyName,
      fromMe: message.fromMe, isStatus: message.isStatus, nativeMention, botIds
    });
  })().catch(error => console.error(safeError(error, [config.apiKey, config.imageApiKey]))));

  console.log('\nOpening WhatsApp. The first connection can take a minute...');
  startupStage = 'WhatsApp initialization';
  await client.initialize();
}

main().catch(async error => {
  reportError(error);
  if (client) await stop(1);
  else process.exitCode = 1;
});
