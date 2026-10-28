export function requestFor(config, messages) {
  if (config.provider === 'openai') return {
    url: 'https://api.openai.com/v1/responses',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: { model: config.model, instructions: config.systemPrompt, input: messages, max_output_tokens: config.maxOutputTokens, store: false }
  };
  if (config.provider === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body: { model: config.model, system: config.systemPrompt, messages, max_tokens: config.maxOutputTokens }
  };
  throw new Error('Unsupported AI provider.');
}

export async function generate(config, messages, { signal, fetchImpl = fetch } = {}) {
  const request = requestFor(config, messages);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
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
  let data;
  try { data = await response.json(); } catch { throw new Error('The AI provider returned an unreadable response.'); }
  const blocks = config.provider === 'openai'
    ? (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || [])
    : (data.content || []);
  const text = blocks.map(block => ['text', 'output_text'].includes(block.type) ? block.text : block.type === 'refusal' ? block.refusal : '').filter(Boolean).join('\n').trim();
  if (!text) throw new Error('The model returned no text. Try a different model or increase maxOutputTokens.');
  return text;
}
