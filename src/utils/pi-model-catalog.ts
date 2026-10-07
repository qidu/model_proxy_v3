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

// Supported endpoint schemas/API types for the proxy loopback
export type ProxyApiType =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'google-generative-ai'
  | 'pi-messages';

export interface ProxyPiModel {
  id: string;
  name: string;
  api: ProxyApiType;
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
 * `baseUrl` must already carry the version segment for the selected api,
 * because no single base URL works for all of them — see proxyBaseUrlForApi.
 */
export function buildProxyPiModel(id: string, baseUrl: string, api: ProxyApiType = 'anthropic-messages'): ProxyPiModel {
  return {
    id,
    name: id,
    api,
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

/**
 * Base URL to hand a client SDK for one endpoint schema: the proxy origin plus
 * whatever version segment that SDK does not append itself.
 *
 * The SDKs disagree about where the version lives, so one base URL cannot serve
 * all of them:
 *   - anthropic-messages: the Anthropic SDK posts to `v1/messages` (version in
 *     the path), so the origin is already correct.
 *   - openai-completions / openai-responses: the OpenAI SDK posts to
 *     `/chat/completions` and `/responses` (version in its own default base
 *     URL), so the base must supply `/v1`.
 *   - google-generative-ai: pi-ai sets `apiVersion = ''` and lets the SDK post
 *     to `/models/{model}:generateContent`, so the base must supply `/v1beta`.
 *   - pi-messages: pi-ai posts to `<baseUrl>/messages` with no version segment,
 *     so the origin yields `/messages`. The proxy does not serve that path (nor
 *     the pi `{model, context, options}` wire body), so this pair is listed for
 *     completeness rather than because it works — see the callers in
 *     agent-session.ts.
 *
 * A bare origin therefore makes every api but anthropic-messages request an
 * unversioned path, which the proxy rejects as an unsupported fixed route.
 */
export function proxyBaseUrlForApi(port: string | number | undefined, api: ProxyApiType): string {
  const origin = proxyLoopbackBaseUrl(port);
  switch (api) {
    case 'openai-completions':
    case 'openai-responses':
      return `${origin}/v1`;
    case 'google-generative-ai':
      return `${origin}/v1beta`;
    case 'anthropic-messages':
    case 'pi-messages':
      return origin;
  }
}
