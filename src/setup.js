import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { defaults, saveConfig, safeText } from './config.js';

export async function ask(question, { secret = false } = {}) {
  if (!process.stdin.isTTY) throw new Error('Please run WhatBot in an interactive terminal or double-click its launcher.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  let cancel;
  try {
    process.stdout.write(question);
    muted = secret;
    return await Promise.race([
      rl.question(''),
      new Promise((resolve, reject) => {
        cancel = () => reject(new Error('Setup cancelled.'));
        rl.once('SIGINT', cancel);
        rl.once('close', cancel);
      })
    ]);
  } finally {
    muted = false;
    rl.removeListener('SIGINT', cancel);
    rl.removeListener('close', cancel);
    rl.close();
    if (secret) process.stdout.write('\n');
  }
}

export async function setup(root, existing) {
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
  const config = { ...current, provider, model, apiKey, backgroundMessages };
  saveConfig(root, config);
  console.log('\nSettings saved. API usage is billed by your selected provider.');
  return config;
}

export async function chooseGroups(client, root, config) {
  for (;;) {
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
