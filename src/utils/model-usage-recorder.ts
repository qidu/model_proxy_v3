import type { Logger } from '../types/shared.js';
import type { UsageStats } from './dashboard-stats.js';

export interface ModelUsageRecordPayload {
  request_id: string;
  timestamp: string;
  endpoint: string;
  user_key: string;
  model: string;
  /**
   * HTTP status of the upstream response. 0 means no response was obtained.
   * Non-2xx statuses are recorded with all token counters at 0 (the upstream
   * typically returns an error body rather than usage), plus the error body
   * in `response_body` when `[remote] record_response_body = true`.
   */
  response_status: number;
  input_tokens: number;
  cached_tokens: number;
  cache_written_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /**
   * Only present when `[remote] record_response_body = true`. For JSON responses
   * this is the parsed response body object; for streaming (text/event-stream)
   * responses this is the accumulated raw SSE text (all events concatenated).
   * For non-2xx responses it carries the upstream's constructed error body.
   */
  response_body?: unknown;
}

function toSafeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildModelUsageRecordPayload(
  requestId: string,
  endpoint: string,
  userKey: string,
  model: string,
  usage: UsageStats,
  responseStatus: number,
  responseBody?: unknown,
): ModelUsageRecordPayload {
  const payload: ModelUsageRecordPayload = {
    request_id: requestId,
    timestamp: new Date().toISOString(),
    endpoint,
    user_key: userKey,
    model,
    response_status: responseStatus,
    input_tokens: toSafeNumber(usage.input_tokens),
    cached_tokens: toSafeNumber(usage.cached_tokens),
    cache_written_tokens: toSafeNumber(usage.cache_written_tokens),
    output_tokens: toSafeNumber(usage.output_tokens),
    total_tokens: toSafeNumber(usage.total_tokens),
  };
  if (responseBody !== undefined) payload.response_body = responseBody;
  return payload;
}

export function recordModelUsageToRemote(
  recordUrl: string | undefined,
  payload: ModelUsageRecordPayload,
  logger?: Logger,
  oneTimeAuthCode?: string,
  extraHeaders?: Record<string, string>,
): void {
  if (!recordUrl) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (oneTimeAuthCode) headers.one_time_auth_code = oneTimeAuthCode;
  if (extraHeaders) Object.assign(headers, extraHeaders);

  void fetch(recordUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }).then(response => {
    if (!response.ok) {
      logger?.warn(payload.request_id, `Model usage recorder returned HTTP ${response.status}`);
    }
  }).catch(error => {
    logger?.warn(payload.request_id, `Model usage recorder failed: ${(error as Error).message}`);
  });
}
