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
  'gemini-generatecontent',
  'gemini-interactions',
] as const;

export type UpstreamMode = (typeof UPSTREAM_MODES)[number];
