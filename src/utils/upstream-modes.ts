/**
 * Single source of truth for the `upstream_mode` values the proxy accepts.
 *
 * Consumed by the config loader (model-target authoring / validation), the
 * remote retry ladder (`target-retry.ts`), and the dashboard's embedded client
 * script. Order is the authoring/default order — the wizard defaults a new
 * target to the first entry.
 */
export const UPSTREAM_MODES = [
  'openai-completions',
  'anthropic-messages',
  'openai-responses',
  // Open Responses spec (openresponses.org) — wire-compatible with
  // openai-responses; resolveUpstreamTarget canonicalizes it to that mode.
  'open-responses',
  'gemini-generatecontent',
  'gemini-interactions',
] as const;

export type UpstreamMode = (typeof UPSTREAM_MODES)[number];

/**
 * Accepted `upstream_mode` values for the `[models.EMBEDDING]` category only.
 *
 * Kept separate from `UPSTREAM_MODES` on purpose: `/v1/embeddings` is a fixed
 * route, not a target list, so these values never reach the retry ladder or the
 * dashboard's target wizard. Unlike the inference categories — where
 * `upstream_mode` selects the request converter — here it selects the upstream
 * wire shape: `openai-completions` posts to `/v1/embeddings`,
 * `ollama-embed` posts to Ollama's native `/api/embed` and the handler converts
 * both directions.
 */
export const EMBEDDING_UPSTREAM_MODES = ['openai-completions', 'ollama-embed'] as const;

export type EmbeddingUpstreamMode = (typeof EMBEDDING_UPSTREAM_MODES)[number];
