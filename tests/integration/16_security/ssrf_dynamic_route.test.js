/**
 * SSRF Dynamic-Route Tests
 * Tests the SSRF guard on dynamic routes (`/http/{host}/...` and `/https/{host}/...`)
 *
 * Coverage:
 * - Disallowed host is rejected with 403 "Target host not allowed."
 * - Allowed host (derived from proxy_config.toml base_urls) is NOT rejected by
 *   the SSRF check (it may still fail for unrelated reasons e.g. auth/upstream)
 * - Malformed dynamic route (too few path segments / no recognizable Claude
 *   endpoint) is rejected with 400 "Invalid dynamic route."
 * - Wildcard-style bypass attempts (e.g. a disallowed host that merely
 *   contains an allowed hostname as a substring) are still rejected
 *
 * Implementation reference (src/index.ts, dynamic-routing block):
 *   isDynamicRoute(path) -> path.startsWith('/http/') || path.startsWith('/https/')
 *   parseDynamicRoute(path) -> { targetConfig, claudeEndpoint, modelId? } or throws
 *     -> on throw: 400 "Invalid dynamic route."
 *   allowedHosts = getAllowedHostsFromConfig(proxyConfig)  // NOT the ALLOWED_HOSTS
 *     env var — hosts are derived from proxy_config.toml's every [models.*].base_url
 *     (including [models.default]) / per-model base_url override, plus every
 *     [models.passthrough] target base.
 *   isHostAllowed(parsedHost, allowedHosts.join(',')) -> false: 403 "Target host not allowed."
 *
 * Reference: src/utils/routing.ts (isHostAllowed, parseDynamicRoute),
 *            src/utils/config-loader.ts (getAllowedHostsFromConfig),
 *            docs/security-review-2.md ("Checked and found SAFE" - SSRF section)
 */

const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-test-key';

/**
 * TC2001: Disallowed Host Rejected with 403
 * A dynamic route targeting an arbitrary external host that is not part of
 * any configured base_url must be rejected before any outbound fetch is made.
 */
async function testSsrfDisallowedHostRejected() {
  const response = await sendRequest({
    endpoint: '/https/evil.example.com/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5
    }
  });

  assert(response.status === 403, `Expected 403, got ${response.status}`);
  assert(
    response.body?.error?.message === 'Target host not allowed.',
    `Expected "Target host not allowed." error, got ${JSON.stringify(response.body)}`
  );
}

/**
 * TC2002: Allowed Host Not Rejected by SSRF Guard
 * Discovers a configured base_url host from the dashboard config (the same
 * config-derived allowlist source as getAllowedHostsFromConfig) and verifies
 * a dynamic route to that host is NOT blocked by the SSRF check. The request
 * may still fail for unrelated reasons (auth, upstream errors) — this test
 * only asserts the SSRF-specific 403 does not fire.
 */
async function testSsrfAllowedHostNotBlocked() {
  const configRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  assert(configRes.status === 200, `Expected 200 from config, got ${configRes.status}`);

  const models = configRes.body?.config?.models || {};
  let host;
  for (const categoryConfig of Object.values(models)) {
    if (categoryConfig && typeof categoryConfig === 'object' && categoryConfig.base_url) {
      try {
        host = new URL(categoryConfig.base_url).host;
        break;
      } catch { /* ignore */ }
    }
  }

  if (!host) {
    console.log('  (skipping - no base_url found in dashboard config)');
    return;
  }

  const response = await sendRequest({
    endpoint: `/https/${host}/v1/messages`,
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5
    }
  });

  assert(
    !(response.status === 403 && response.body?.error?.message === 'Target host not allowed.'),
    `Configured host '${host}' should not be blocked by the SSRF guard; got ${response.status}: ${JSON.stringify(response.body)}`
  );
}

/**
 * TC2003: Malformed Dynamic Route Rejected with 400
 * A path under /https/ with too few segments (no recognizable Claude
 * endpoint) fails to parse and is rejected before the SSRF check even runs.
 */
async function testSsrfMalformedRouteRejected() {
  const response = await fetch(`${PROXY_URL}/https/onlyonesegment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({})
  });

  assert(response.status === 400, `Expected 400, got ${response.status}`);
  const body = await response.json();
  assert(
    body?.error?.message === 'Invalid dynamic route.',
    `Expected "Invalid dynamic route." error, got ${JSON.stringify(body)}`
  );
}

/**
 * TC2004: Suffix-Substring Host Not Confused with Allowed Wildcard
 * isHostAllowed treats "*.domain" entries as suffix matches, but
 * getAllowedHostsFromConfig only ever emits exact hostnames (no wildcards)
 * from base_url entries. A host that merely *contains* an allowed hostname
 * as a substring (not as a proper dot-boundary suffix) must still be
 * rejected — e.g. "evil-api.qnaigc.com.attacker.com" or
 * "notapi.qnaigc.com.evil.com" should not slip past the exact-match check.
 */
async function testSsrfSubstringHostRejected() {
  const response = await sendRequest({
    endpoint: '/https/api.qnaigc.com.evil.com/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5
    }
  });

  assert(response.status === 403, `Expected 403, got ${response.status}`);
  assert(
    response.body?.error?.message === 'Target host not allowed.',
    `Expected "Target host not allowed." error, got ${JSON.stringify(response.body)}`
  );
}

module.exports = {
  testSsrfDisallowedHostRejected,
  testSsrfAllowedHostNotBlocked,
  testSsrfMalformedRouteRejected,
  testSsrfSubstringHostRejected
};

if (require.main === module) {
  runTestSuite('SSRF Dynamic-Route Tests', [
    { name: 'TC2001: Disallowed host rejected 403', fn: testSsrfDisallowedHostRejected },
    { name: 'TC2002: Allowed host not blocked', fn: testSsrfAllowedHostNotBlocked },
    { name: 'TC2003: Malformed route rejected 400', fn: testSsrfMalformedRouteRejected },
    { name: 'TC2004: Substring host rejected 403', fn: testSsrfSubstringHostRejected }
  ]);
}
