// Fire-and-forget AI usage logger -> home.example.com dashboard. NEVER throws / blocks.
// Copied from /Users/charlespatterson/Projects/_ops/ai-usage-log.js and converted to ESM
// so it compiles cleanly under this project's tsc (rootDir: src).
const ENDPOINT = process.env.AI_LOG_ENDPOINT || 'http://localhost:4860/api/ai-log';
const TOKEN = process.env.AI_LOG_TOKEN || '';

export function logAiUsage(args: {
  app: string;
  feature?: string;
  user?: string;
  model?: string;
  // `any` so it accepts the Anthropic SDK `Usage` type verbatim (its token
  // fields are `number | null`), without coupling to the SDK's types.
  usage?: any;
}): void {
  try {
    const { app, feature, user, model, usage } = args;
    if (!TOKEN || !usage) return;
    const body = JSON.stringify({
      token: TOKEN,
      app,
      feature: feature || '',
      user: user || 'unknown',
      model: model || '',
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    });
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  } catch {
    /* logging must never break the app */
  }
}
