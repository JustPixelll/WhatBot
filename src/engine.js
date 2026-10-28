import { ImageInputError } from './media.js';
import { safeText } from './config.js';

export const HELP = 'Erwähne mich oder schreib !ask deine Frage. Für Fotos: auf das Bild antworten mit !ask Was siehst du? Oder !ask plus Frage direkt in die Bildunterschrift. Bilder erstellen: !bild Beschreibung (nach Einrichtung mit Configure-Images.cmd). help, status und reset funktionieren mit !ask oder Erwähnung. reset löscht den gemeinsamen Gesprächskontext dieser Gruppe. Kein Webzugriff, keine Sprachmemos oder Bildbearbeitung.';

export function promptFrom(body, nativeMention, botIds = []) {
  if (/^!(?:bild|image)(?:\s|$)/i.test(body)) return body.replace(/^!(?:bild|image)\s*/i, 'image ').trim();
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
  constructor({ config, generate, send, generateImage, sendImage, loadImage, now = () => Date.now(), startedAt = Date.now(), log = () => {}, signal }) {
    Object.assign(this, { config, generate, send, generateImage, sendImage, loadImage, now, startedAt, log, signal });
    this.groups = new Map();
    this.seen = new Map();
    this.requests = 0;
    this.imageRequests = 0;
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
    if (!['chat', 'image'].includes(message.type) || typeof message.body !== 'string') return 'unsupported';
    if (!message.body.trim() && !message.nativeMention) return 'unaddressed';
    const group = this.group(message.groupId);
    if (!group.members.has(message.author)) group.members.set(message.author, `Member ${group.members.size + 1}`);
    const member = group.members.get(message.author) + (message.displayName ? ` (${JSON.stringify(safeText(message.displayName).slice(0, 80))})` : '');
    const prompt = promptFrom(message.body, message.nativeMention, message.botIds);
    if (prompt === null) {
      if (c.backgroundMessages && message.type === 'chat' && message.body.trim()) {
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
      const hasImageCandidate = message.type === 'image' || message.hasQuotedMsg;
      if ((!prompt && !hasImageCandidate) || prompt.toLowerCase() === 'help') { await reply(HELP); return 'help'; }
      if (prompt.toLowerCase() === 'reset') {
        group.history = []; group.background = [];
        await reply('Shared AI context for this group cleared. This does not delete WhatsApp messages or provider records.');
        return 'reset';
      }
      if (prompt.toLowerCase() === 'status') {
        await reply(`WhatBot is online. Provider: ${c.provider}; model: ${c.model}. Requests this run: ${this.requests}/${c.maxRequestsPerSession}. Image generation: ${c.imageGeneration ? `${this.imageRequests}/${c.maxImagesPerSession} (${c.imageModel})` : 'off'}. Photo questions use the chat provider. Background context: ${c.backgroundMessages ? `up to ${c.backgroundMessages} text messages` : 'off'}. Memory clears when the bot stops.`);
        return 'status';
      }
      if (prompt.length > c.maxInputChars) { await reply(`Please keep your question under ${c.maxInputChars} characters.`); return 'too-long'; }
      if (this.requests >= c.maxRequestsPerSession) { await reply('The request limit for this run has been reached. The person running WhatBot can restart it.'); return 'limit'; }
      const imageCommand = prompt.match(/^(?:bild|image)(?:\s+([\s\S]*))?$/i);
      if (imageCommand) {
        if (!imageCommand[1]?.trim()) { await reply('Zum Beispiel: !bild ein Pinguin am österreichischen Stammtisch'); return 'help'; }
        if (!c.imageGeneration || !this.generateImage || !this.sendImage) { await reply('Bilderstellen ist noch aus. Am PC Configure-Images.cmd öffnen und einen OpenAI API-Key hinterlegen. Claude kann Fotos ansehen, aber keine Bilder erzeugen.'); return 'images-off'; }
        if (hasImageCandidate) { await reply('!bild erstellt neue Bilder aus Text. Zum Ansehen eines Fotos bitte !ask verwenden. Bildbearbeitung gibt es noch nicht.'); return 'no-editing'; }
        if (this.imageRequests >= c.maxImagesPerSession) { await reply('Das Bilderlimit für diesen Lauf ist erreicht.'); return 'image-limit'; }
        // Reserve before awaiting: the limits apply across all selected groups.
        this.requests++; this.imageRequests++;
        await reply('Wird gezeichnet. Kann ein bisserl dauern.');
        if (this.signal?.aborted) return 'stopped';
        const image = await this.generateImage(imageCommand[1].trim());
        if (this.signal?.aborted) return 'stopped';
        await this.sendImage(message, image, 'KI-generiert · WhatBot');
        this.remember(group, `${member} requested an image: ${imageCommand[1].trim()}`, '[An AI-generated image was sent. Its pixels are not retained in this context.]');
        this.log(`Generated an image (${this.imageRequests}/${c.maxImagesPerSession} images this run).`);
        return 'image';
      }
      let image = null;
      if (hasImageCandidate) {
        if (!this.loadImage) return 'unsupported';
        image = await this.loadImage(message);
        if (this.signal?.aborted) return 'stopped';
      }
      if (!prompt && !image) { await reply(HELP); return 'help'; }
      // Another group may have consumed the last slot while the photo loaded.
      if (this.requests >= c.maxRequestsPerSession) { await reply('The request limit for this run has been reached.'); return 'limit'; }
      const question = prompt || 'Was ist auf diesem Bild zu sehen?';
      const background = group.background.length ? `Recent background chat (context only):\n${JSON.stringify(group.background)}\n\n` : '';
      const textContent = `${background}${member} asks: ${question}`;
      const current = { role: 'user', content: image ? [{ type: 'image', ...image }, { type: 'text', text: textContent }] : textContent };
      const messages = [...group.history, current];
      group.background = [];
      this.requests++;
      const text = await this.generate(messages);
      if (this.signal?.aborted) return 'stopped';
      await reply(text);
      // Retain questions and the delivered answer, without duplicating background snapshots.
      this.remember(group, `${member} asks: ${question}${image ? ' [One image was attached; its pixels are not retained.]' : ''}`, text);
      this.log(`Answered a question (${this.requests}/${c.maxRequestsPerSession} requests this run).`);
      return 'answered';
    } catch (error) {
      if (error instanceof ImageInputError) {
        await reply(error.message);
        return 'invalid-image';
      }
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

  remember(group, question, answer) {
    group.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer.slice(0, 3500) });
    group.history = this.config.historyMessages ? group.history.slice(-this.config.historyMessages) : [];
  }
}
