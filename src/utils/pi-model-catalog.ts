/**
 * Dependency-free description of this proxy's own pi-ai model entries.
 *
 * agent-session.ts needs a pi-ai `Model<'anthropic-messages'>` per configured
 * alias, and the CLI (`--export-pi-models`) needs the same shape. agent-session
 * statically imports `@earendil-works/pi-ai` (a devDependency not shipped in
 * the production image), so the CLI cannot import the builder from there —
 * this module holds it instead, and the returned object is structurally
 * assignable to pi-ai's `Model` without importing the type.
 */

export const PROXY_PROVIDER_ID = 'model-proxy-v3';

export interface ProxyPiModel {
  id: string;
  name: string;
  api: 'anthropic-messages';
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Build the pi-ai model entry for a proxy alias served at `baseUrl`.
 * `baseUrl` is this proxy's own origin (loopback) — pi-ai appends the
 * /v1/messages path for the 'anthropic-messages' api.
 */
export function buildProxyPiModel(id: string, baseUrl: string): ProxyPiModel {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider: PROXY_PROVIDER_ID,
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

/** Loopback origin this proxy is reachable at, from the PORT env (default 8788). */
export function proxyLoopbackBaseUrl(port: string | number | undefined): string {
  const parsed = typeof port === 'number' ? port : parseInt(port ?? '', 10);
  const safePort = Number.isFinite(parsed) && parsed > 0 ? parsed : 8788;
  return `http://127.0.0.1:${safePort}`;
}
