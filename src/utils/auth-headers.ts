// Strip a single leading `Bearer ` prefix (case-insensitive) from an auth header value.
export function stripBearerPrefix(value: string | undefined | null): string {
  return value?.replace(/^Bearer\s+/i, '') ?? '';
}

// First non-null, non-empty source wins (legacy truthiness semantics: an empty
// header falls through to the next source); returns null only when every source
// is absent or empty. A non-empty source that strips to '' (e.g. 'Bearer ')
// still wins — callers treat the empty result as "no usable key".
export function pickRawApiKey(sources: Array<string | null | undefined>): string | null {
  for (const source of sources) {
    if (source) return stripBearerPrefix(source);
  }
  return null;
}

export type RawCredentialHeaderOrder = 'authorization-first' | 'goog-api-key-first';

// Extract the raw API key from the auth headers: the Authorization header (either case)
// bearer-stripped, and/or the x-goog-api-key header. `authorization-first` matches the
// legacy index.ts behavior (x-goog-api-key returned unstripped); `goog-api-key-first`
// matches the legacy passthrough.ts priority (both stripped).
export function extractRawCredential(
  authHeaders: Record<string, string>,
  order: RawCredentialHeaderOrder = 'authorization-first',
): string | undefined {
  const authorization = authHeaders['Authorization'] || authHeaders['authorization'];
  const googApiKey = authHeaders['x-goog-api-key'];
  if (order === 'goog-api-key-first') {
    return stripBearerPrefix(googApiKey) || stripBearerPrefix(authorization) || undefined;
  }
  return stripBearerPrefix(authorization) || googApiKey || undefined;
}

// Recover an incoming credential from raw request headers (Authorization bearer-stripped,
// then x-api-key raw, then x-goog-api-key bearer-stripped). Empty string when none.
export function resolveIncomingAuthorization(rawHeaders: Headers): string {
  const authorization = rawHeaders.get('Authorization');
  const apiKey = rawHeaders.get('x-api-key');
  const googApiKey = rawHeaders.get('x-goog-api-key');
  return (authorization ? stripBearerPrefix(authorization) : '') || apiKey || (googApiKey ? stripBearerPrefix(googApiKey) : '');
}

// Repack an `Authorization: Bearer <key>` header into the target header (e.g. x-api-key,
// x-goog-api-key) when the target is not already present; removes the Authorization header.
export function repackBearerCredential(headers: Record<string, string>, targetHeader: string): void {
  const authorization = headers['Authorization'];
  if (authorization && !headers[targetHeader]) {
    headers[targetHeader] = stripBearerPrefix(authorization);
    delete headers['Authorization'];
  }
}

// Fold Azure OpenAI auth headers into a single `api-key` header (api-key > x-api-key >
// bearer-stripped Authorization). Non-Azure URLs pass through unchanged.
export function normalizeOpenAIAuthHeaders(authHeaders: Record<string, string>, targetUrl: string): Record<string, string> {
  const url = targetUrl.toLowerCase();
  if (!url.includes('.cognitiveservices.azure.com') && !url.includes('.openai.azure.com')) {
    return authHeaders;
  }

  const authorization = authHeaders['Authorization'] || authHeaders['authorization'];
  const rawKey = authHeaders['api-key'] || authHeaders['x-api-key'] || (authorization ? stripBearerPrefix(authorization) : undefined);
  if (!rawKey) return authHeaders;

  const normalized: Record<string, string> = { ...authHeaders, 'api-key': rawKey };
  delete normalized['Authorization'];
  delete normalized['authorization'];
  delete normalized['x-api-key'];
  return normalized;
}
