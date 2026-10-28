import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { defaults, saveConfig, safeText } from './config.js';

export function createPrompter({ input = process.stdin, destination = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('Please run WhatBot in an interactive terminal or double-click its launcher.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) destination.write(chunk, encoding);
    callback();
  } });
  Object.defineProperty(output, 'columns', { get: () => destination.columns || 80 });
  output.isTTY = true;
  // Keep one readline interface for the whole wizard. Recreating it after every
  // answer repeatedly pauses stdin and changes Windows console/raw-mode state.
  const rl = createInterface({ input, output, terminal: true });
  let closed = false;
  rl.once('close', () => { closed = true; });
  return {
    async ask(question, { secret = false } = {}) {
      if (closed) throw new Error('Setup cancelled.');
      let cancel;
      try {
        const cancelled = new Promise((resolve, reject) => {
          cancel = () => reject(new Error('Setup cancelled.'));
          rl.once('SIGINT', cancel);
          rl.once('close', cancel);
        });
        // Give visible prompts to readline so redraws preserve the question.
        if (secret) destination.write(question);
        muted = secret;
        rl.resume();
        return await Promise.race([rl.question(secret ? '' : question), cancelled]);
      } finally {
        muted = false;
        rl.removeListener('SIGINT', cancel);
        rl.removeListener('close', cancel);
        if (secret) destination.write('\n');
      }
    },
    close() { rl.close(); }
  };
}

async function withPrompts(callback) {
  const prompts = createPrompter();
  try { return await callback(prompts.ask); }
  finally { prompts.close(); }
}

export async function setup(root, existing) {
  return withPrompts(ask => setupWithPrompt(root, existing, ask));
}

async function setupWithPrompt(root, existing, ask) {
  console.log('\nWhatBot setup\nYour API key is saved only in data/config.json on this PC. Keep data/ private.\n');
  const current = existing || defaults;
  let provider;
  while (!provider) {
    const value = (await ask(`Provider: 1 = OpenAI, 2 = Claude [${current.provider === 'openai' ? '1' : '2'}]: `)).trim();
    if (!value) provider = current.provider;
    else if (value === '1') provider = 'openai';
    else if (value === '2') provider = 'anthropic';
    else console.log('Enter 1 or 2.');
  }
  const suggestedModel = provider === current.provider ? current.model : 'claude-haiku-5-5';
  const modelDefault = provider === 'openai' && current.provider !== 'openai' ? defaults.model : suggestedModel;
  const model = (await ask(`Model ID [${safeText(modelDefault)}]: `)).trim() || modelDefault;
  const previousKey = provider === current.provider ? current.apiKey : '';
  let apiKey = '';
  while (!apiKey) {
    apiKey = (await ask(`API key (hidden${previousKey ? '; Enter keeps saved key' : ''}): `, { secret: true })).trim() || previousKey;
    if (!apiKey) console.log('Paste your API key here on your PC.');
  }
  console.log('\nBy default, only questions directed at WhatBot and its answers go to the AI.');
  console.log('Optional: include up to 20 recent untagged text messages for group summaries.');
  console.log('Tell the group first. These messages go to your chosen AI provider when prompted.');
  let backgroundMessages;
  while (backgroundMessages === undefined) {
    const answer = (await ask(`Include background group context? y/n [${current.backgroundMessages ? 'y' : 'n'}]: `)).trim().toLowerCase();
    if (!answer) backgroundMessages = current.backgroundMessages;
    else if (['y', 'yes'].includes(answer)) backgroundMessages = 20;
    else if (['n', 'no'].includes(answer)) backgroundMessages = 0;
    else console.log('Enter y or n.');
  }
  const imageApiKey = current.imageGeneration && !current.imageApiKey && current.provider === 'openai' && provider !== 'openai'
    ? current.apiKey : current.imageApiKey;
  const config = { ...current, provider, model, apiKey, backgroundMessages, imageApiKey };
  saveConfig(root, config);
  console.log('\nSettings saved. API usage is billed by your selected provider.');
  return config;
}

export async function setupImages(root, config) {
  return withPrompts(ask => setupImagesWithPrompt(root, config, ask));
}

export async function setupImagesWithPrompt(root, config, ask) {
  console.log('\nPhoto understanding already uses your selected chat provider/key.');
  console.log('Generating pictures needs OpenAI. Claude cannot generate pictures.');
  console.log('This enables !bild / !image for everyone in your selected groups.');
  console.log('Images use paid API credit: one 1024x1024 low-quality image per command, at most 10 per run by default.');
  let enabled;
  while (enabled === undefined) {
    const answer = (await ask(`Enable image generation? y/n [${config.imageGeneration ? 'y' : 'n'}]: `)).trim().toLowerCase();
    if (!answer) enabled = config.imageGeneration;
    else if (['y', 'yes'].includes(answer)) enabled = true;
    else if (['n', 'no'].includes(answer)) enabled = false;
    else console.log('Enter y or n.');
  }
  let imageApiKey = config.imageApiKey;
  let imageModel = config.imageModel;
  if (enabled) {
    for (;;) {
      const canKeep = imageApiKey || config.provider === 'openai';
      const value = (await ask(`OpenAI image API key (hidden${canKeep ? '; Enter keeps saved/reuses OpenAI chat key' : ''}): `, { secret: true })).trim();
      if (value.startsWith('sk-ant-')) { console.log('That is a Claude key. Use an OpenAI API key for image generation.'); continue; }
      if (value && (value.length < 10 || /\s/.test(value))) { console.log('Paste a valid OpenAI API key.'); continue; }
      if (!value && !canKeep) { console.log('An OpenAI key is needed. Ctrl+C cancels without changing settings.'); continue; }
      imageApiKey = value || imageApiKey;
      break;
    }
    for (;;) {
      imageModel = (await ask(`Image model ID [${safeText(config.imageModel)}]: `)).trim() || config.imageModel;
      if (/^[a-zA-Z0-9._:-]{1,100}$/.test(imageModel)) break;
      console.log('Enter a model ID without spaces.');
    }
  }
  const updated = { ...config, imageGeneration: enabled, imageApiKey, imageModel };
  saveConfig(root, updated);
  console.log(`Image generation ${enabled ? 'enabled' : 'disabled'}. Chat settings and WhatsApp login are preserved.`);
  return updated;
}

export async function chooseGroups(client, root, config) {
  return withPrompts(ask => chooseGroupsWithPrompt(client, root, config, ask));
}

async function chooseGroupsWithPrompt(client, root, config, ask) {
  for (;;) {
    console.log('\nReading your WhatsApp groups...');
    const groups = (await client.getChats()).filter(chat => chat.isGroup).sort((a, b) => a.name.localeCompare(b.name));
    console.log('\nChoose groups WhatBot may answer in. It ignores all others and all direct messages.');
    groups.forEach((group, index) => console.log(`  ${index + 1}. ${safeText(group.name)}${config.groupIds.includes(group.id._serialized) ? ' [selected]' : ''}`));
    if (!groups.length) console.log('No groups yet. Add the WhatBot phone account to a test group on your phone.');
    const value = (await ask('Group numbers separated by commas, R to refresh, or Q to quit: ')).trim();
    if (/^q$/i.test(value)) throw new Error('Group selection cancelled. No groups enabled.');
    if (/^r$/i.test(value)) continue;
    if (!/^\d+(\s*,\s*\d+)*$/.test(value)) { console.log('Enter one or more listed numbers.'); continue; }
    const indexes = [...new Set(value.split(',').map(s => Number(s.trim()) - 1))];
    if (indexes.some(i => i < 0 || i >= groups.length)) { console.log('One of those groups is not listed.'); continue; }
    config.groupIds = indexes.map(i => groups[i].id._serialized);
    saveConfig(root, config);
    return;
  }
}
