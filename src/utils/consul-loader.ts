/**
 * Consul KV config loader.
 *
 * Reads proxy config from a Consul KV store under the `model-proxy-v3/` key
 * prefix (recurse). Extracted from config-loader.ts so the config-loader file
 * only carries TOML parsing + the source-dispatch logic.
 *
 * The Consul meta URL is supplied via the PROXY_CONFIG_CONSUL env var.
 * `buildConsulKvUrl()` enforces that the host is loopback or a private/LAN
 * address (SSRF guard); Apollo's meta server is typically public, so the
 * Apollo loader does not reuse this guard.
 */

import type { ProxyConfig } from './config-loader.js';
import { isInternalHost } from './routing.js';

export type ConsulKvEntry = {
  Key: string;
  Value?: string | null;
};

const CONSUL_CONFIG_PREFIX = 'model-proxy-v3';

function decodeBase64(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64').toString('utf-8');
  }

  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function parseConsulArrayValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [value];
  }

  const inner = trimmed.slice(1, -1);
  const elements: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      elements.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }

  elements.push(current.trim().replace(/^"|"$/g, ''));
  return elements;
}

function parseConsulScalarValue(value: string): string | number {
  if (value === '') {
    return '';
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value.trim() !== '') {
    return numeric;
  }

  return value;
}

export function buildConsulKvUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`PROXY_CONFIG_CONSUL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`PROXY_CONFIG_CONSUL must use http or https, got: ${parsed.protocol}`);
  }
  if (!isInternalHost(parsed.hostname)) {
    throw new Error(`PROXY_CONFIG_CONSUL must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
  }
  // Reconstruct from parsed URL to prevent path traversal / injection via the raw string
  const origin = parsed.origin; // scheme + host + port, no path
  return `${origin}/v1/kv/${CONSUL_CONFIG_PREFIX}?recurse=true`;
}

function applyConsulKvEntry(config: ProxyConfig, entry: ConsulKvEntry): void {
  if (!entry.Value) {
    return;
  }

  const relativeKey = entry.Key.startsWith(`${CONSUL_CONFIG_PREFIX}/`)
    ? entry.Key.slice(CONSUL_CONFIG_PREFIX.length + 1)
    : entry.Key;
  const parts = relativeKey.split('/').filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  const rawValue = decodeBase64(entry.Value).trim();
  const section = parts[0];

  if (section === 'general' && parts.length >= 2) {
    config.general ??= {};
    const key = parts.slice(1).join('/');
    (config.general as any)[key] = parseConsulScalarValue(rawValue);
    return;
  }

  if (section === 'defaults' && parts.length >= 2) {
    config.defaults ??= {};
    const key = parts.slice(1).join('/');
    (config.defaults as any)[key] = rawValue;
    return;
  }

  if (section === 'models' && parts.length >= 3) {
    config.models ??= {};
    const categoryName = parts[1];
    const key = parts.slice(2).join('/');
    const category = (config.models[categoryName] ??= {});

    if (Array.isArray(category)) {
      return;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      category[key] = parseConsulArrayValue(rawValue);
      return;
    }

    category[key] = rawValue;
  }
}

export function parseConsulConfig(entries: ConsulKvEntry[]): ProxyConfig {
  const config: ProxyConfig = {};
  for (const entry of entries) {
    applyConsulKvEntry(config, entry);
  }
  return config;
}
