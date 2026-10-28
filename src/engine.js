export const HELP = 'Mention WhatBot and ask a question, or use !ask your question. Tag me with help, status, or reset. Reset clears this group\'s shared AI context. I answer text only; I cannot browse the web or run actions.';

export function promptFrom(body, nativeMention, botIds = []) {
  if (/^!ask(?:\s|$)/i.test(body)) return body.replace(/^!ask\s*/i, '').trim();
  if (!nativeMention) return null;
  let prompt = body;
  for (const id of botIds) {
    const user = id.split('@')[0];
    if (/^\d+$/.test(user)) prompt = prompt.replace(new RegExp(`@${user}(?!\\d)`, 'g'), '');
  }
  return prompt.trim();
}

export class BotEngine {
  constructor({ config, generate, send, now = () => Date.now(), startedAt = Date.now(), log = () => {}, signal }) {
    Object.assign(this, { config, generate, send, now, startedAt, log, signal });
    this.groups = new Map();
    this.seen = new Map();
    this.requests = 0;
  }

  group(id) {
    if (!this.groups.has(id)) this.groups.set(id, { history: [], background: [], members: new Map(), busy: false, lastReply: -Infinity });
    return this.groups.get(id);
  }

  async handle(message) {
    const c = this.config;
    if (this.signal?.aborted || message.fromMe || message.isStatus || !message.groupId?.endsWith('@g.us') || !c.groupIds.includes(message.groupId)) return 'ignored';
    if (!Number.isFinite(message.timestamp) || message.timestamp * 1000 < this.startedAt || this.now() - message.timestamp * 1000 > 120000) return 'old';
    if (!message.id || this.seen.has(message.id)) return 'duplicate';
    this.seen.set(message.id, true);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    if (message.type !== 'chat' || typeof message.body !== 'string' || !message.body.trim()) return 'non-text';
    const group = this.group(message.groupId);
    if (!group.members.has(message.author)) group.members.set(message.author, `Member ${group.members.size + 1}`);
    const member = group.members.get(message.author);
    const prompt = promptFrom(message.body, message.nativeMention, message.botIds);
    if (prompt === null) {
      if (c.backgroundMessages) {
        group.background.push(`${member}: ${message.body.slice(0, 1000)}`);
        group.background = group.background.slice(-c.backgroundMessages);
      }
      return 'background';
    }
    if (group.busy || this.now() - group.lastReply < c.cooldownSeconds * 1000) return 'busy';
    group.busy = true;
    const reply = async text => {
      if (!this.signal?.aborted) await this.send(message, text.length > 3500 ? text.slice(0, 3450) + '\n[Reply shortened.]' : text);
    };
    try {
      if (!prompt || prompt.toLowerCase() === 'help') { await reply(HELP); return 'help'; }
      if (prompt.toLowerCase() === 'reset') {
        group.history = []; group.background = [];
        await reply('Shared AI context for this group cleared. This does not delete WhatsApp messages or provider records.');
        return 'reset';
      }
      if (prompt.toLowerCase() === 'status') {
        await reply(`WhatBot is online. Provider: ${c.provider}; model: ${c.model}. Requests this run: ${this.requests}/${c.maxRequestsPerSession}. Background context: ${c.backgroundMessages ? `up to ${c.backgroundMessages} text messages` : 'off'}. Memory clears when the bot stops.`);
        return 'status';
      }
      if (prompt.length > c.maxInputChars) { await reply(`Please keep your question under ${c.maxInputChars} characters.`); return 'too-long'; }
      if (this.requests >= c.maxRequestsPerSession) { await reply('The request limit for this run has been reached. The person running WhatBot can restart it.'); return 'limit'; }
      const background = group.background.length ? `Recent background chat (context only):\n${JSON.stringify(group.background)}\n\n` : '';
      const current = { role: 'user', content: `${background}${member} asks: ${prompt}` };
      const messages = [...group.history, current];
      group.background = [];
      this.requests++;
      const text = await this.generate(messages);
      if (this.signal?.aborted) return 'stopped';
      await reply(text);
      // Retain questions and the delivered answer, without duplicating background snapshots.
      group.history.push({ role: 'user', content: `${member} asks: ${prompt}` }, { role: 'assistant', content: text.slice(0, 3500) });
      group.history = c.historyMessages ? group.history.slice(-c.historyMessages) : [];
      this.log(`Answered a question (${this.requests}/${c.maxRequestsPerSession} requests this run).`);
      return 'answered';
    } catch (error) {
      this.log(error);
      if (!this.signal?.aborted) {
        try { await reply('I could not complete that reply. The WhatBot console has details.'); } catch { this.log('Could not deliver the error message. Check WhatsApp connection.'); }
      }
      return 'error';
    } finally {
      group.busy = false;
      group.lastReply = this.now();
    }
  }
}
