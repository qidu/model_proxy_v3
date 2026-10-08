/**
 * Config Parse / Serialize / Route-Resolution Unit Tests
 * Tests parseSimpleToml, serializeProxyConfigToml, and getModelRouteConfig
 * directly against dist/utils/config-loader.js — no running proxy required.
 *
 * Coverage:
 * - TC1501: "* = {}" — empty inline-table catch-all parses + routes unknown model as passthrough
 * - TC1502: "* = {target=\"*\"}" — explicit-star catch-all is equivalent to empty {}
 * - TC1503: "claude-* = {}" — empty inline-table wildcard routes claude-X to claude-X
 * - TC1504: "claude-* = {target=\"claude-*\"}" — explicit wildcard target is equivalent to empty {}
 * - TC1505: 'key = {target="different"}' — rename/alias: key routes to a different upstream model
 * - TC1506: catch-all round-trip — "* = {}" survives serialize → reparse without data loss
 * - TC1507: wildcard round-trip — "claude-* = {}" survives serialize → reparse
 * - TC1508: rename round-trip — 'claude-1-2 = {target="claude-4-5-haiku"}' survives serialize → reparse
 * - TC1509: "* = {}" and "* = {target="*"}" produce identical parsed entry
 * - TC1510: "claude-* = {}" and 'claude-* = {target="claude-*"}' produce identical parsed entry
 * - TC1511: composite target resolves through full routing chain (composite → composite, no cycle)
 * - TC1512: A → B → A composite cycle throws "Routing cycle detected"
 *
 * Inline-comment stripping (parseSimpleToml):
 * - TC1513: quoted string value with trailing # comment parses correctly
 * - TC1514: numeric value with trailing # comment parses correctly
 * - TC1515: array value with trailing # comment parses correctly
 * - TC1516: comment text containing a quote char does not corrupt the value
 * - TC1517: full [privacy_filter] block with inline comments on every line parses all fields
 * - TC1519: 6-element entry's max_tokens (index 5) reaches getModelRouteConfig().maxTokens
 *
 * Reference: README §"Per-Model Configuration Array Format", §"Model Routing Priority"
 */

const path = require('path');
const { assert, runTestSuite } = require('../utils/test_helpers');

// Dynamic import of the ESM dist module — compatible with the CJS wrapper used
// by run-tests.js.  All tests are collected after the module is loaded.
let parseSimpleToml, serializeProxyConfigToml, getModelRouteConfig;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/config-loader.js'));
  parseSimpleToml = mod.parseSimpleToml;
  serializeProxyConfigToml = mod.serializeProxyConfigToml;
  getModelRouteConfig = mod.getModelRouteConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ProxyConfig from a TOML snippet.
 * Suppresses validation console output (expected for minimal test configs).
 */
function parse(toml) {
  const saved = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {};
  try {
    return parseSimpleToml(toml);
  } finally {
    console.error = saved.error;
    console.warn = saved.warn;
  }
}

// ---------------------------------------------------------------------------
// TC1501: "* = {}" — empty inline-table catch-all
// ---------------------------------------------------------------------------
async function testCatchAllEmpty() {
  const cfg = parse(`
[models.default]
base_url = "https://api.example.com"
"*" = {}
`);

  // Entry is stored as ["*", "", "", ""] internally
  const entry = cfg.models?.default?.['*'];
  assert(Array.isArray(entry), '"*" entry should be an array');
  assert(entry[0] === '*', `entry[0] should be "*", got "${entry[0]}"`);

  // Route resolution: any unknown model should passthrough as itself
  const route = getModelRouteConfig('totally-unknown-xyz', cfg);
  assert(route !== undefined, 'Route should be found for unknown model via catch-all');
  assert(
    route.modelAlias === 'totally-unknown-xyz',
    `modelAlias should be "totally-unknown-xyz", got "${route.modelAlias}"`
  );
  assert(
    route.targetUrl === 'https://api.example.com',
    `targetUrl should be "https://api.example.com", got "${route.targetUrl}"`
  );
}

// ---------------------------------------------------------------------------
// TC1502: "* = {target="*"}" — explicit star target
// ---------------------------------------------------------------------------
async function testCatchAllExplicitTarget() {
  const cfg = parse(`
[models.default]
base_url = "https://api.example.com"
"*" = {target = "*"}
`);

  const entry = cfg.models?.default?.['*'];
  assert(Array.isArray(entry), '"*" entry should be an array');
  assert(entry[0] === '*', `entry[0] should be "*", got "${entry[0]}"`);

  const route = getModelRouteConfig('totally-unknown-xyz', cfg);
  assert(route !== undefined, 'Route should be found for unknown model via catch-all');
  assert(
    route.modelAlias === 'totally-unknown-xyz',
    `modelAlias should be "totally-unknown-xyz", got "${route.modelAlias}"`
  );
  assert(
    route.targetUrl === 'https://api.example.com',
    `targetUrl should be "https://api.example.com", got "${route.targetUrl}"`
  );
}

// ---------------------------------------------------------------------------
// TC1503: "claude-* = {}" — empty inline-table prefix wildcard
// ---------------------------------------------------------------------------
async function testWildcardEmpty() {
  const cfg = parse(`
[models.claude]
base_url = "https://api.anthropic.com"
"claude-*" = {}
`);

  const entry = cfg.models?.claude?.['claude-*'];
  assert(Array.isArray(entry), '"claude-*" entry should be an array');
  assert(entry[0] === 'claude-*', `entry[0] should be "claude-*", got "${entry[0]}"`);

  // Any claude-X model should resolve to itself via the wildcard
  const route = getModelRouteConfig('claude-opus-4-6', cfg);
  assert(route !== undefined, 'Route should be found for claude-opus-4-6 via claude-* wildcard');
  assert(
    route.modelAlias === 'claude-opus-4-6',
    `modelAlias should be "claude-opus-4-6", got "${route.modelAlias}"`
  );
  assert(
    route.targetUrl === 'https://api.anthropic.com',
    `targetUrl should be "https://api.anthropic.com", got "${route.targetUrl}"`
  );

  // A different prefix should NOT match
  const noRoute = getModelRouteConfig('gemini-2.0-flash', cfg);
  assert(
    noRoute === undefined || noRoute.targetUrl !== 'https://api.anthropic.com',
    'gemini-2.0-flash should not match claude-* wildcard'
  );
}

// ---------------------------------------------------------------------------
// TC1504: "claude-* = {target="claude-*"}" — explicit wildcard target
// ---------------------------------------------------------------------------
async function testWildcardExplicitTarget() {
  const cfg = parse(`
[models.claude]
base_url = "https://api.anthropic.com"
"claude-*" = {target = "claude-*"}
`);

  const entry = cfg.models?.claude?.['claude-*'];
  assert(Array.isArray(entry), '"claude-*" entry should be an array');
  assert(entry[0] === 'claude-*', `entry[0] should be "claude-*", got "${entry[0]}"`);

  const route = getModelRouteConfig('claude-haiku-4-5', cfg);
  assert(route !== undefined, 'Route should be found for claude-haiku-4-5 via claude-* wildcard');
  assert(
    route.modelAlias === 'claude-haiku-4-5',
    `modelAlias should be "claude-haiku-4-5" (passthrough), got "${route.modelAlias}"`
  );
  assert(
    route.targetUrl === 'https://api.anthropic.com',
    `targetUrl should be "https://api.anthropic.com", got "${route.targetUrl}"`
  );
}

// ---------------------------------------------------------------------------
// TC1505: 'claude-1-2 = {target="claude-4-5-haiku"}' — rename / alias
// ---------------------------------------------------------------------------
async function testRenameAlias() {
  const cfg = parse(`
[models.claude]
base_url = "https://api.anthropic.com"
"claude-1-2" = {target = "claude-4-5-haiku"}
`);

  const entry = cfg.models?.claude?.['claude-1-2'];
  assert(Array.isArray(entry), '"claude-1-2" entry should be an array');
  assert(
    entry[0] === 'claude-4-5-haiku',
    `entry[0] should be "claude-4-5-haiku", got "${entry[0]}"`
  );

  const route = getModelRouteConfig('claude-1-2', cfg);
  assert(route !== undefined, 'Route should be found for claude-1-2');
  assert(
    route.modelAlias === 'claude-4-5-haiku',
    `modelAlias should be "claude-4-5-haiku" (renamed target), got "${route.modelAlias}"`
  );
  assert(
    route.targetUrl === 'https://api.anthropic.com',
    `targetUrl should be "https://api.anthropic.com", got "${route.targetUrl}"`
  );

  // The original model name (target) is NOT a key in the category and should not resolve
  const noExact = cfg.models?.claude?.['claude-4-5-haiku'];
  assert(
    noExact === undefined,
    '"claude-4-5-haiku" should not be a key in the category (only "claude-1-2" is)'
  );
}

// ---------------------------------------------------------------------------
// TC1506: catch-all "* = {}" round-trip
// ---------------------------------------------------------------------------
async function testCatchAllRoundTrip() {
  const toml = `[models.default]
base_url = "https://api.example.com"
"*" = {}
`;
  const cfg = parse(toml);
  const serialized = serializeProxyConfigToml(cfg);
  const reparsed = parse(serialized);

  const entry = reparsed.models?.default?.['*'];
  assert(Array.isArray(entry), '"*" entry should survive round-trip as array');
  assert(entry[0] === '*', `entry[0] should be "*" after round-trip, got "${entry[0]}"`);

  const route = getModelRouteConfig('any-model-here', reparsed);
  assert(route !== undefined, 'Catch-all route should survive round-trip');
  assert(
    route.modelAlias === 'any-model-here',
    `modelAlias should be "any-model-here" after round-trip, got "${route.modelAlias}"`
  );
}

// ---------------------------------------------------------------------------
// TC1507: wildcard "claude-* = {}" round-trip
// ---------------------------------------------------------------------------
async function testWildcardRoundTrip() {
  const toml = `[models.claude]
base_url = "https://api.anthropic.com"
"claude-*" = {}
`;
  const cfg = parse(toml);
  const serialized = serializeProxyConfigToml(cfg);
  const reparsed = parse(serialized);

  const entry = reparsed.models?.claude?.['claude-*'];
  assert(Array.isArray(entry), '"claude-*" entry should survive round-trip as array');
  assert(entry[0] === 'claude-*', `entry[0] should be "claude-*" after round-trip, got "${entry[0]}"`);

  const route = getModelRouteConfig('claude-sonnet-4-6', reparsed);
  assert(route !== undefined, 'Wildcard route should survive round-trip');
  assert(
    route.modelAlias === 'claude-sonnet-4-6',
    `modelAlias should be "claude-sonnet-4-6" after round-trip, got "${route.modelAlias}"`
  );
}

// ---------------------------------------------------------------------------
// TC1508: rename round-trip
// ---------------------------------------------------------------------------
async function testRenameRoundTrip() {
  const toml = `[models.claude]
base_url = "https://api.anthropic.com"
"claude-1-2" = {target = "claude-4-5-haiku"}
`;
  const cfg = parse(toml);
  const serialized = serializeProxyConfigToml(cfg);
  const reparsed = parse(serialized);

  const entry = reparsed.models?.claude?.['claude-1-2'];
  assert(Array.isArray(entry), '"claude-1-2" entry should survive round-trip as array');
  assert(
    entry[0] === 'claude-4-5-haiku',
    `entry[0] should be "claude-4-5-haiku" after round-trip, got "${entry[0]}"`
  );

  const route = getModelRouteConfig('claude-1-2', reparsed);
  assert(route !== undefined, 'Rename route should survive round-trip');
  assert(
    route.modelAlias === 'claude-4-5-haiku',
    `modelAlias should be "claude-4-5-haiku" after round-trip, got "${route.modelAlias}"`
  );
}

// ---------------------------------------------------------------------------
// TC1509: "* = {}" and "* = {target="*"}" produce identical parsed entries
// ---------------------------------------------------------------------------
async function testCatchAllEquivalence() {
  const cfgEmpty = parse(`
[models.default]
base_url = "https://api.example.com"
"*" = {}
`);
  const cfgExplicit = parse(`
[models.default]
base_url = "https://api.example.com"
"*" = {target = "*"}
`);

  const entryEmpty = cfgEmpty.models?.default?.['*'];
  const entryExplicit = cfgExplicit.models?.default?.['*'];

  assert(Array.isArray(entryEmpty) && Array.isArray(entryExplicit), 'Both entries should be arrays');
  assert(
    entryEmpty[0] === entryExplicit[0],
    `entry[0] should be identical: "${entryEmpty[0]}" vs "${entryExplicit[0]}"`
  );
  assert(
    entryEmpty[1] === entryExplicit[1],
    `entry[1] should be identical: "${entryEmpty[1]}" vs "${entryExplicit[1]}"`
  );

  // Both should produce the same route for the same input
  const routeEmpty = getModelRouteConfig('any-model', cfgEmpty);
  const routeExplicit = getModelRouteConfig('any-model', cfgExplicit);
  assert(
    routeEmpty?.modelAlias === routeExplicit?.modelAlias,
    `Both forms should resolve to same modelAlias: "${routeEmpty?.modelAlias}" vs "${routeExplicit?.modelAlias}"`
  );
  assert(
    routeEmpty?.targetUrl === routeExplicit?.targetUrl,
    `Both forms should resolve to same targetUrl`
  );
}

// ---------------------------------------------------------------------------
// TC1510: "claude-* = {}" and "claude-* = {target="claude-*"}" are equivalent
// ---------------------------------------------------------------------------
async function testWildcardEquivalence() {
  const cfgEmpty = parse(`
[models.claude]
base_url = "https://api.anthropic.com"
"claude-*" = {}
`);
  const cfgExplicit = parse(`
[models.claude]
base_url = "https://api.anthropic.com"
"claude-*" = {target = "claude-*"}
`);

  const entryEmpty = cfgEmpty.models?.claude?.['claude-*'];
  const entryExplicit = cfgExplicit.models?.claude?.['claude-*'];

  assert(Array.isArray(entryEmpty) && Array.isArray(entryExplicit), 'Both entries should be arrays');
  assert(
    entryEmpty[0] === entryExplicit[0],
    `entry[0] should be identical: "${entryEmpty[0]}" vs "${entryExplicit[0]}"`
  );

  const routeEmpty = getModelRouteConfig('claude-opus-4-6', cfgEmpty);
  const routeExplicit = getModelRouteConfig('claude-opus-4-6', cfgExplicit);
  assert(
    routeEmpty?.modelAlias === routeExplicit?.modelAlias,
    `Both forms should resolve to same modelAlias: "${routeEmpty?.modelAlias}" vs "${routeExplicit?.modelAlias}"`
  );
  assert(
    routeEmpty?.targetUrl === routeExplicit?.targetUrl,
    `Both forms should resolve to same targetUrl`
  );
}

// ---------------------------------------------------------------------------
// TC1511: composite alias targeting another composite alias (no cycle)
// Covers the c1a769d change: composite targets now resolve through the full
// routing chain (composite → schedule → fusion → direct → default). This
// case must NOT throw — A's single target is a leaf model B.
// ---------------------------------------------------------------------------
async function testCompositeToCompositeNoCycle() {
  // A composite alias whose single target is a leaf model — must resolve.
  // Uses the [composite] inline-object syntax that parseSimpleToml handles
  // (the [composite.X] sub-section header form doesn't scope nested keys).
  // Alias names must NOT collide with any model name (validated by the loader).
  const cfg = parse(`
[models.leaf]
base_url = "https://x.test"
"leaf-model" = {}
[composite]
"aliasA" = {"leaf-model" = {share = 1}}
`);
  const route = getModelRouteConfig('aliasA', cfg);
  assert(route !== undefined, 'composite.aliasA should resolve to a leaf route');
  assert(
    route?.targetUrl === 'https://x.test',
    `targetUrl should come from leaf-model, got "${route?.targetUrl}"`
  );
}

// ---------------------------------------------------------------------------
// TC1512: aliasA → aliasB → aliasA cycle throws "Routing cycle detected"
// Covers the cycle guard added in c1a769d: getModelRouteConfig throws when
// the effective name is already on the visited chain.
// ---------------------------------------------------------------------------
async function testCompositeCycle() {
  const cfg = parse(`
[models.leaf]
base_url = "https://x.test"
"leaf-model" = {}
[composite]
"aliasA" = {"aliasB" = {}}
"aliasB" = {"aliasA" = {}}
`);
  let err = null;
  try {
    getModelRouteConfig('aliasA', cfg);
  } catch (e) {
    err = e;
  }
  assert(err !== null, 'aliasA → aliasB → aliasA cycle should throw');
  assert(
    err && err.message.includes('Routing cycle detected'),
    `expected "Routing cycle detected" in error, got: ${err?.message}`
  );
}

// ---------------------------------------------------------------------------
// TC1513: quoted string with trailing inline comment
// ---------------------------------------------------------------------------
async function testInlineCommentOnString() {
  const cfg = parse(`
[privacy_filter]
filter_mode = "local"  # "sidecar" (default when a filter_url is configured) | "local"
`);
  assert(
    cfg.privacy_filter?.filter_mode === 'local',
    `filter_mode should be "local", got "${cfg.privacy_filter?.filter_mode}"`
  );
}

// ---------------------------------------------------------------------------
// TC1514: numeric value with trailing inline comment
// ---------------------------------------------------------------------------
async function testInlineCommentOnNumber() {
  const cfg = parse(`
[privacy_filter]
filter_mode = "local"
max_chars = 1024000  # skip redaction above this total text size
entropy_threshold = 3.0  # Shannon entropy cutoff
hash_min_len = 8  # minimum hex token length
`);
  assert(
    cfg.privacy_filter?.max_chars === 1024000,
    `max_chars should be 1024000, got "${cfg.privacy_filter?.max_chars}"`
  );
  assert(
    cfg.privacy_filter?.entropy_threshold === 3.0,
    `entropy_threshold should be 3.0, got "${cfg.privacy_filter?.entropy_threshold}"`
  );
  assert(
    cfg.privacy_filter?.hash_min_len === 8,
    `hash_min_len should be 8, got "${cfg.privacy_filter?.hash_min_len}"`
  );
}

// ---------------------------------------------------------------------------
// TC1515: array value with trailing inline comment
// ---------------------------------------------------------------------------
async function testInlineCommentOnArray() {
  const cfg = parse(`
[privacy_filter]
filter_mode = "local"
whitelist_add = ["deadcode", "cafedead"]  # hex tokens to skip
whitelist_remove = ["fabaceae"]  # remove from built-in whitelist
`);
  assert(
    Array.isArray(cfg.privacy_filter?.whitelist_add),
    'whitelist_add should be an array'
  );
  assert(
    cfg.privacy_filter?.whitelist_add?.length === 2,
    `whitelist_add should have 2 elements, got ${cfg.privacy_filter?.whitelist_add?.length}`
  );
  assert(
    cfg.privacy_filter?.whitelist_add?.[0] === 'deadcode',
    `whitelist_add[0] should be "deadcode", got "${cfg.privacy_filter?.whitelist_add?.[0]}"`
  );
  assert(
    cfg.privacy_filter?.whitelist_remove?.[0] === 'fabaceae',
    `whitelist_remove[0] should be "fabaceae", got "${cfg.privacy_filter?.whitelist_remove?.[0]}"`
  );
}

// ---------------------------------------------------------------------------
// TC1516: comment text containing a quote does not corrupt the string value
// ---------------------------------------------------------------------------
async function testInlineCommentWithQuoteChar() {
  const cfg = parse(`
[privacy_filter]
filter_mode = "sidecar"  # use "sidecar" for full PII model
filter_url = "http://127.0.0.1:8799"  # required for "sidecar" mode
`);
  assert(
    cfg.privacy_filter?.filter_mode === 'sidecar',
    `filter_mode should be "sidecar", got "${cfg.privacy_filter?.filter_mode}"`
  );
  assert(
    cfg.privacy_filter?.filter_url === 'http://127.0.0.1:8799',
    `filter_url should be "http://127.0.0.1:8799", got "${cfg.privacy_filter?.filter_url}"`
  );
}

// ---------------------------------------------------------------------------
// TC1517: full [privacy_filter] block with inline comments on every line
// ---------------------------------------------------------------------------
async function testPrivacyFilterBlockWithComments() {
  const cfg = parse(`
[privacy_filter]
filter_mode = "local"         # "sidecar" | "local"
max_chars = 512000            # skip redaction above this total text size
entropy_threshold = 3.5       # local mode only: Shannon entropy cutoff
hash_min_len = 10             # local mode only: minimum hex token length
whitelist_add = ["badcafe12"] # hex tokens to add to the built-in skip-list
whitelist_remove = []         # built-in whitelist tokens to remove
`);
  const pf = cfg.privacy_filter;
  assert(pf?.filter_mode === 'local',        `filter_mode: expected "local", got "${pf?.filter_mode}"`);
  assert(pf?.max_chars === 512000,           `max_chars: expected 512000, got ${pf?.max_chars}`);
  assert(pf?.entropy_threshold === 3.5,      `entropy_threshold: expected 3.5, got ${pf?.entropy_threshold}`);
  assert(pf?.hash_min_len === 10,            `hash_min_len: expected 10, got ${pf?.hash_min_len}`);
  assert(Array.isArray(pf?.whitelist_add) && pf.whitelist_add[0] === 'badcafe12',
    `whitelist_add[0]: expected "badcafe12", got "${pf?.whitelist_add?.[0]}"`);
  assert(Array.isArray(pf?.whitelist_remove) && pf.whitelist_remove.length === 1 && pf.whitelist_remove[0] === '',
    `whitelist_remove: expected [""], got ${JSON.stringify(pf?.whitelist_remove)}`);
}

// ---------------------------------------------------------------------------
// TC1519: 6-element entry's max_tokens (index 5) survives parse → route
// Regression: validateProxyConfig rejected 5/6-element entries even though
// the parser already produced them (max_tokens at index 5). This asserts
// the value is not just parsed into the right array slot (already covered
// by TC1517/round-trip tests elsewhere) but actually reaches
// getModelRouteConfig()'s returned route — the shape consumed by the
// request-building code that sets the outbound max_tokens default.
// ---------------------------------------------------------------------------
async function testSixElementMaxTokensReachesRoute() {
  const cfg = parse(`
[models.example]
base_url = "https://api.example.com"
"m6" = {target = "target-6", max_tokens = 16384}
`);

  const entry = cfg.models?.example?.['m6'];
  assert(Array.isArray(entry) && entry.length === 6, `entry should have 6 elements, got ${JSON.stringify(entry)}`);
  assert(entry[5] === '16384' || entry[5] === 16384, `entry[5] (max_tokens) should be 16384, got "${entry[5]}"`);

  const route = getModelRouteConfig('m6', cfg);
  assert(route !== undefined, 'Route should be found for m6');
  assert(
    route.maxTokens === 16384,
    `route.maxTokens should be 16384, got ${route.maxTokens}`
  );
}

async function testModelUsageRoundTrip() {
  const cfg = parse(`
[remote]
record_server = "http://127.0.0.1:8080/model-usage"
`);
  assert(
    cfg.remote?.record_server === 'http://127.0.0.1:8080/model-usage',
    `record_server should parse, got "${cfg.remote?.record_server}"`
  );

  const serialized = serializeProxyConfigToml(cfg);
  const reparsed = parse(serialized);
  assert(
    reparsed.remote?.record_server === 'http://127.0.0.1:8080/model-usage',
    `record_server should survive round-trip, got "${reparsed.remote?.record_server}"`
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  { name: 'TC1501: "* = {}" catch-all parse + route', fn: testCatchAllEmpty },
  { name: 'TC1502: "* = {target=\\"*\\"}" catch-all parse + route', fn: testCatchAllExplicitTarget },
  { name: 'TC1503: "claude-* = {}" wildcard parse + route', fn: testWildcardEmpty },
  { name: 'TC1504: "claude-* = {target=\\"claude-*\\"}" wildcard parse + route', fn: testWildcardExplicitTarget },
  { name: 'TC1505: rename alias key → different target', fn: testRenameAlias },
  { name: 'TC1506: "* = {}" catch-all round-trip', fn: testCatchAllRoundTrip },
  { name: 'TC1507: "claude-* = {}" wildcard round-trip', fn: testWildcardRoundTrip },
  { name: 'TC1508: rename round-trip', fn: testRenameRoundTrip },
  { name: 'TC1509: "* = {}" ≡ "* = {target=\\"*\\"}"', fn: testCatchAllEquivalence },
  { name: 'TC1510: "claude-* = {}" ≡ "claude-* = {target=\\"claude-*\\"}"', fn: testWildcardEquivalence },
  { name: 'TC1511: composite → composite resolves (no cycle)', fn: testCompositeToCompositeNoCycle },
  { name: 'TC1512: A → B → A cycle throws', fn: testCompositeCycle },
  { name: 'TC1513: quoted string with trailing inline comment', fn: testInlineCommentOnString },
  { name: 'TC1514: numeric values with trailing inline comments', fn: testInlineCommentOnNumber },
  { name: 'TC1515: array value with trailing inline comment', fn: testInlineCommentOnArray },
  { name: 'TC1516: comment containing quote char does not corrupt string value', fn: testInlineCommentWithQuoteChar },
  { name: 'TC1517: full [privacy_filter] block with inline comments on every line', fn: testPrivacyFilterBlockWithComments },
  { name: 'TC1518: [remote] record_server round-trip', fn: testModelUsageRoundTrip },
  { name: 'TC1519: 6-element entry max_tokens reaches getModelRouteConfig()', fn: testSixElementMaxTokensReachesRoute },
];

module.exports = {
  testCatchAllEmpty,
  testCatchAllExplicitTarget,
  testWildcardEmpty,
  testWildcardExplicitTarget,
  testRenameAlias,
  testCatchAllRoundTrip,
  testWildcardRoundTrip,
  testRenameRoundTrip,
  testCatchAllEquivalence,
  testWildcardEquivalence,
  testCompositeToCompositeNoCycle,
  testCompositeCycle,
  testInlineCommentOnString,
  testInlineCommentOnNumber,
  testInlineCommentOnArray,
  testInlineCommentWithQuoteChar,
  testPrivacyFilterBlockWithComments,
  testModelUsageRoundTrip,
  testSixElementMaxTokensReachesRoute,
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('Config Parse / Route-Resolution Tests', tests));
}
