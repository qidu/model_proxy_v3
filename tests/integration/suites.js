// Shared suite registry for the integration test runners.
// Paths are relative to TEST_DIR ('./tests/integration').
// Single source of truth: tests/run-integration-tests.js (interactive, spawns
// its own proxy) and tests/run-tests-loop-wrapper.js (unattended runs against
// an already-running proxy, writes a Markdown report) both derive their suite
// list from here so they cannot drift apart.
export const suites = [
  '01_endpoints/messages.test.js',
  '01_endpoints/messages_streaming.test.js',
  '01_endpoints/interactions.test.js',
  '01_endpoints/generateContent.test.js',
  '02_features/thinking.test.js',
  '02_features/tool_use.test.js',
  '02_features/image_input.test.js',
  '03_errors/validation.test.js',
  '04_models/models.test.js',
  '05_upstream_modes/upstream_modes.test.js',
  '06_integration/integration.test.js',
  '07_dashboard/dashboard_api.test.js',
  '08_regression/regression.test.js',
  '09_composite/composite.test.js',
  '10_auth/auth_headers.test.js',
  '11_responses/responses_api.test.js',
  '12_config_validation/config_validation.test.js',
  '13_fusion/fusion.test.js',
  '14_routing/routing.test.js',
  '15_config_parse/config_parse.test.js',
  '16_security/ssrf_dynamic_route.test.js',
  '16_security/privacy_filter.test.js',
  '16_security/kompress.test.js',
  '16_security/conversation_store.test.js',
  '16_security/free_fanout.test.js',
  '16_security/config_loader_pollution.test.js',
  '16_security/schedule_routing.test.js',
  '16_security/dev_pass_through.test.js',
  '16_security/reasoning_effort_conversion.test.js',
  '16_security/openai_responses_routing.test.js',
  '16_security/dev_pass_through_responses.test.js',
  '16_security/target_retry_ladder.test.js',
  '17_token_counting/token_counting.test.js',
];
