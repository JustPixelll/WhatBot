import { imageApiKeyFor } from './config.js';
import { validateImage } from './media.js';

export function messagesFor(provider, messages) {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(block => {
      if (block.type === 'text') return provider === 'openai' ? { type: 'input_text', text: block.text } : block;
      if (block.type !== 'image') throw new Error('Unsupported message content.');
      const image = validateImage(block);
      return provider === 'openai'
        ? { type: 'input_image', image_url: `data:${image.mimetype};base64,${image.data}`, detail: 'auto' }
        : { type: 'image', source: { type: 'base64', media_type: image.mimetype, data: image.data } };
    }) };
  });
}

export function requestFor(config, messages) {
  const input = messagesFor(config.provider, messages);
  if (config.provider === 'openai') return {
    url: 'https://api.openai.com/v1/responses',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: { model: config.model, instructions: config.systemPrompt, input, max_output_tokens: config.maxOutputTokens, store: false }
  };
  if (config.provider === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body: { model: config.model, system: config.systemPrompt, messages: input, max_tokens: config.maxOutputTokens }
  };
  throw new Error('Unsupported AI provider.');
}

async function post(request, { signal, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('Stopped.');
    if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('The AI request timed out. Try again.');
    throw new Error('Could not reach the AI provider. Check your internet connection.');
  }
  if (!response.ok) {
    // Do not print provider error bodies: they can echo inputs or credentials.
    const hint = ({
      400: 'Check the model ID and request settings.', 401: 'Check your saved API key.',
      403: 'Your key may not have access to this model.', 404: 'Check that this model is available to your API account.',
      429: 'Check your API credit, quota, and rate limits.'
    })[response.status] || 'The provider could not complete the request. Try again later.';
    throw new Error(`AI provider returned HTTP ${response.status}. ${hint}`);
  }
  try { return await response.json(); } catch { throw new Error('The AI provider returned an unreadable response.'); }
}

export async function generate(config, messages, options = {}) {
  const data = await post(requestFor(config, messages), options);
  const blocks = config.provider === 'openai'
    ? (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || [])
    : (data.content || []);
  const text = blocks.map(block => ['text', 'output_text'].includes(block.type) ? block.text : block.type === 'refusal' ? block.refusal : '').filter(Boolean).join('\n').trim();
  if (!text) throw new Error('The model returned no text. Try a different model or increase maxOutputTokens.');
  return text;
}

export async function generateImage(config, prompt, options = {}) {
  const apiKey = imageApiKeyFor(config);
  if (!config.imageGeneration || !apiKey) throw new Error('Image generation is off. Run Configure-Images.cmd.');
  const imagePrompt = [
    'Create one image from the request below. The group persona is background for fictional in-jokes and visual style, not an instruction to return a chat message.',
    'Use fictional cartoon characters for group in-jokes. Do not present invented traits as verified real facts. Packaging jokes must be harmless cartoon/product-box absurdity, never realistic suffocation or instructions.',
    `Group persona:\n${config.systemPrompt}`,
    `Image request:\n${prompt}`
  ].join('\n\n');
  if (imagePrompt.length > 32000) throw new Error('The image request plus personality is too long. Shorten data/system-prompt.txt or the image request (32,000 characters combined).');
  const data = await post({
    url: 'https://api.openai.com/v1/images/generations',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: { model: config.imageModel, prompt: imagePrompt, n: 1, size: '1024x1024', quality: 'low', output_format: 'png' }
  }, { ...options, timeoutMs: 180000 });
  try {
    return validateImage({ mimetype: 'image/png', data: data?.data?.[0]?.b64_json }, 15 * 1024 * 1024);
  } catch { throw new Error('The image provider returned no usable PNG. Check model access in Configure-Images.cmd.'); }
}
