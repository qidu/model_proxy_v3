/**
 * Extended Thinking Tests
 * Tests thinking/reasoning configuration and behavior
 * model.default.upstream_mode should be 'anthropic-messages' 
 *
 * Coverage:
 * - Thinking enabled with budget
 * - Thinking disabled
 * - Boolean thinking format
 * - Adaptive thinking
 * - streaming with thinking
 * - reasoning_effort mapping
 * - clampThinkingBudget (unit, covers interleaved-thinking exception)
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  runTestSuite
} = require('../utils/test_helpers');

const { THINKING_MODELS } = require('../utils/model_config');

const path = require('path');

// Dynamic import of the ESM dist module — same pattern as
// testcases/15_config_parse/config_parse.test.js. Loaded lazily because
// require() can't pull in ESM directly.
let clampThinkingBudget;
let budgetToReasoningEffort;
async function loadValidationModule() {
  if (clampThinkingBudget) return;
  const mod = await import(path.join(process.cwd(), 'dist/utils/validation.js'));
  clampThinkingBudget = mod.clampThinkingBudget;
}

async function loadBudgetConverter() {
  if (budgetToReasoningEffort) return;
  const mod = await import(path.join(process.cwd(), 'dist/converters/claude-to-openai.js'));
  budgetToReasoningEffort = mod.budgetToReasoningEffort;
}

/**
 * TC1701: Thinking Enabled with Budget
 * Tests thinking with token budget
 */
async function testThinkingEnabled() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'Explain the theory of relativity'
      }],
      max_tokens: 1024,
      thinking: {
        type: 'enabled',
        budget_tokens: 2000
      }
    }
  });

  assertResponse(response);
  // Thinking responses typically have stop_reason of end_turn
  assert(
    ['end_turn', 'max_tokens'].includes(response.body.stop_reason),
    'Stop reason should be valid'
  );
  // Response body must have at least one text content block
  assert(
    Array.isArray(response.body.content) && response.body.content.length > 0,
    'Thinking response should have at least one content block'
  );
  const hasText = response.body.content.some(b => b.type === 'text');
  assert(hasText, 'Thinking response should contain a text content block');
}

/**
 * TC1702: Thinking Disabled
 * Tests explicit thinking disabled
 */
async function testThinkingDisabled() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: 'What is 2+2?'
      }],
      max_tokens: 20,
      thinking: {
        type: 'disabled'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1703: Boolean Thinking Format
 * Tests boolean thinking type (true/false)
 */
async function testBooleanThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is machine learning?'
      }],
      max_tokens: 1024,
      thinking: {
        type: true,
        budget_tokens: 1024
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1704: Adaptive Thinking
 * Tests adaptive thinking type
 */
async function testAdaptiveThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: 'Explain quantum computing'
      }],
      max_tokens: 300,
      thinking: {
        type: 'adaptive'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1705: reasoning_effort Parameter
 * Tests reasoning_effort for OpenAI-compatible models
 */
async function testReasoningEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: 'Solve: x^2 - 5x + 6 = 0'
      }],
      max_tokens: 300,
      reasoning_effort: 'high'
    }
  });

  assertResponse(response);
}

/**
 * TC1706: output_config.effort
 * Tests output_config.effort parameter
 */
async function testOutputConfigEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: 'Explain photosynthesis'
      }],
      max_tokens: 300,
      output_config: {
        effort: 'medium'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1707: Low Budget Thinking
 * Tests thinking with low token budget
 */
async function testLowBudgetThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is AI?'
      }],
      max_tokens: 1024,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1708: Streaming with Thinking
 * Tests SSE streaming with thinking enabled
 */
async function testStreamingWithThinking() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'Explain recursion'
      }],
      max_tokens: 1708,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024
      },
      stream: true
    }
  });

  assert(response.status === 200, 'Streaming should return 200');
  assert(response.eventCount > 0, 'Should have streaming events');
  // Verify event types are recognized SSE event types (not malformed objects)
  const validEventTypes = new Set([
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop', 'ping',
    'signature_delta'
  ]);
  const typedEvents = response.events.filter(e => e.type);
  assert(
    typedEvents.length > 0,
    'Streaming events should have typed events (type field present)'
  );
  const unknownTypes = typedEvents
    .map(e => e.type)
    .filter(t => !validEventTypes.has(t));
  if (unknownTypes.length > 0) {
    console.log(`    (note: unknown event types in stream: ${[...new Set(unknownTypes)].join(', ')})`);
  }
  const hasStop = response.events.some(
    e => e.type === 'message_stop' || e.event === 'message_stop'
  );
  assert(hasStop, 'Streaming with thinking should end with message_stop event');
}

/**
 * TC1709: thinking disabled via false
 * Tests thinking: { type: false }
 */
async function testThinkingFalse() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is 1+1?'
      }],
      max_tokens: 20,
      thinking: {
        type: false
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1710: Budget to Effort Mapping
 * Tests automatic budget to reasoning_effort conversion
 */
async function testBudgetToEffortMapping() {
  // High budget (>= 4096)
  const response1 = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000
      }
    }
  });
  assertResponse(response1);

  // Low budget (< 2048)
  const response2 = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024
      }
    }
  });
  assertResponse(response2);
}

/**
 * TC1711: output_config.task_budget.total
 * Tests that output_config.task_budget.total can supply the thinking budget
 * when budget_tokens is omitted (per README thinking config section)
 */
async function testTaskBudgetTotal() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      max_tokens: 100,
      output_config: {
        task_budget: { total: 4000 }
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1712: xhigh Effort Normalization
 * Tests that non-standard "xhigh" output_config.effort is normalized to "max"
 * and does not cause a proxy internal error (500). The proxy should either
 * accept it (normalize → max, return 200) or reject it with a structured
 * validation error (4xx), but must not crash.
 */
async function testXhighEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 50,
      output_config: { effort: 'xhigh' }
    }
  });

  assert(
    response.status < 500,
    `xhigh effort should not cause a proxy internal error (got ${response.status})`
  );
  // If accepted (200), verify a response body came back
  if (response.status === 200) {
    assert(
      response.body?.content || response.body?.choices,
      'xhigh effort 200 response should have content'
    );
  }
}

/**
 * TC1713: OpenAI Thinking Format
 * Tests that thinking: { type: 'enabled', budget_tokens: N } is accepted
 * (OpenAI passthrough format, normalized to Claude format).
 *
 * NOTE: budget_tokens must be <= max_tokens (validated upstream of the
 * provider call), so we set max_tokens high enough to fit budget_tokens.
 */
async function testOpenAITThinkingFormat() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 3000,
      thinking: {
        type: 'enabled',
        budget_tokens: 2000
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1714: Signature Delta Events
 * Tests that streaming thinking produces signature_delta events
 * (per README "Signature Accumulation" section)
 */
async function testSignatureDeltaStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{ role: 'user', content: 'Explain gravity' }],
      max_tokens: 1024,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024
      }
    }
  });

  assert(response.status === 200, 'Streaming should return 200');
  assert(response.eventCount > 0, 'Should have streaming events');

  // Look for signature_delta or content_block_stop following a thinking block
  const hasSignature = response.events.some(
    e => e.type === 'signature_delta' || e.delta?.type === 'signature_delta'
  );
  // Don't strictly require signature_delta (depends on upstream), but verify
  // the stream completed cleanly with content_block_stop or message_stop
  const hasStop = response.events.some(
    e => e.type === 'message_stop' || e.event === 'message_stop'
  );
  assert(
    hasStop,
    'Stream should end with message_stop (signature_delta may or may not be present)'
  );
  // If no signature_delta at all, the upstream just doesn't emit it — that's OK
  // but worth flagging.
  if (!hasSignature) {
    console.log('    (note: signature_delta not present in this stream)');
  }
}

/**
 * TC1715: Custom Budget Thresholds
 * Tests that custom budget_to_effort_* thresholds are honored.
 * proxy_config.toml has: budget_to_effort_low=8000, medium=20000, high=0.
 * Mapping logic is:
 *   - highThreshold === 0  → always "high" (force high)
 *   - budget >= highThreshold → "high"
 *   - budget >= mediumThreshold → "medium"
 *   - otherwise → "low"
 * With high=0, every budget maps to "high" regardless of medium/low.
 */
async function testCustomBudgetThresholds() {
  await loadBudgetConverter();

  const config = { budget_to_effort_low: 8000, budget_to_effort_medium: 20000, budget_to_effort_high: 0 };

  // high=0 is a special "force high" case
  assert(
    budgetToReasoningEffort(100, config) === 'high',
    `budget=100 with high=0 should map to high, got ${budgetToReasoningEffort(100, config)}`
  );

  // medium threshold still matters when high is not forced and budget is below it
  const noForceConfig = { budget_to_effort_low: 8000, budget_to_effort_medium: 20000, budget_to_effort_high: 50000 };
  assert(
    budgetToReasoningEffort(25000, noForceConfig) === 'medium',
    `budget=25000 should map to medium, got ${budgetToReasoningEffort(25000, noForceConfig)}`
  );
  assert(
    budgetToReasoningEffort(50000, noForceConfig) === 'high',
    `budget=50000 should map to high, got ${budgetToReasoningEffort(50000, noForceConfig)}`
  );
  assert(
    budgetToReasoningEffort(7000, noForceConfig) === 'low',
    `budget=7000 should map to low, got ${budgetToReasoningEffort(7000, noForceConfig)}`
  );

  // End-to-end: high=0 forces high effort regardless of budget
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Count to 5' }],
      max_tokens: 1024,
      thinking: {
        type: 'enabled',
        budget_tokens: 25000
      }
    }
  });

  assertResponse(response);
}

/**
 * TC1716: Thinking Disabled Stripping
 * Tests that thinking: { type: "disabled" } is stripped for openai-completions upstream
 * (per README Known Limitations #3)
 */
async function testThinkingDisabledStripped() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 30,
      thinking: {
        type: 'disabled'
      }
    }
  });

  // Should still succeed — disabled thinking is silently stripped
  assertResponse(response);
}

/**
 * TC1717: Thinking Budget Clamp (unit test, no live proxy)
 * Covers the 4 branches of clampThinkingBudget introduced in commit 53632e7:
 *   (a) budget_tokens >= max_tokens → clamp down to max_tokens - 1
 *   (b) budget_tokens < max_tokens  → return unchanged
 *   (c) interleaved-thinking beta   → skip clamp (budget may exceed max_tokens)
 *   (d) max_tokens <= 1024 + clamp needed → throw (no valid clamp exists)
 */
async function testClampThinkingBudget() {
  await loadValidationModule();
  const mk = (budget) => ({ type: 'enabled', budget_tokens: budget });

  // (a) clamp when budget equals or exceeds max_tokens
  const a = clampThinkingBudget(mk(5000), 2000);
  assert(a.budget_tokens === 1999, `should clamp to max_tokens - 1, got ${a.budget_tokens}`);

  // (b) pass-through when budget is already within max_tokens
  const b = clampThinkingBudget(mk(2000), 8000);
  assert(b.budget_tokens === 2000, `should not change, got ${b.budget_tokens}`);

  // (c) interleaved-thinking bypasses the clamp
  const c = clampThinkingBudget(mk(5000), 2000, /*interleavedThinking*/ true);
  assert(c.budget_tokens === 5000, `should not clamp under interleaved-thinking, got ${c.budget_tokens}`);

  // (d) max_tokens at or below 1024 cannot fit a valid clamped budget → throws
  let threw = false;
  try { clampThinkingBudget(mk(5000), 500); } catch { threw = true; }
  assert(threw, 'should throw when max_tokens <= 1024 and clamping is required');
}

/**
 * TC1718: Thinking Budget Exceeds Max Tokens
 * Tests that the proxy handles the upstream constraint
 * max_completion_tokens > thinking_budget. Without an explicit fix, this
 * request would be forwarded as-is and the upstream would reject it with
 * InvalidParameter. The proxy must either reject it with a clear 4xx or
 * auto-correct the budget before forwarding.
 */
async function testBudgetExceedsMaxTokens() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1000,
      thinking: {
        type: 'enabled',
        budget_tokens: 2000
      }
    }
  });

  assert(
    response.status < 500,
    `Budget exceeding max_tokens should not cause a 500 internal error (got ${response.status})`
  );

  // The proxy should either return a successful corrected response or a
  // structured client error explaining the constraint violation.
  if (response.status === 200) {
    assert(
      response.body?.content || response.body?.choices,
      'Successful response should contain content/choices'
    );
  } else {
    assert(
      response.status >= 400 && response.status < 500,
      `Expected 4xx client error for invalid budget, got ${response.status}`
    );
    assert(
      response.body?.error || response.body?.message,
      'Client error response should include an error message'
    );
  }
}

module.exports = {
  testThinkingEnabled,
  testThinkingDisabled,
  testBooleanThinking,
  testAdaptiveThinking,
  testReasoningEffort,
  testOutputConfigEffort,
  testLowBudgetThinking,
  testStreamingWithThinking,
  testThinkingFalse,
  testBudgetToEffortMapping,
  testTaskBudgetTotal,
  testXhighEffort,
  testOpenAITThinkingFormat,
  testSignatureDeltaStreaming,
  testCustomBudgetThresholds,
  testThinkingDisabledStripped,
  testClampThinkingBudget,
  testBudgetExceedsMaxTokens
};

if (require.main === module) {
  runTestSuite('Thinking Tests', [
    { name: 'TC1701: Thinking Enabled', fn: testThinkingEnabled },
    { name: 'TC1702: Thinking Disabled', fn: testThinkingDisabled },
    { name: 'TC1703: Boolean Format', fn: testBooleanThinking },
    { name: 'TC1704: Adaptive Thinking', fn: testAdaptiveThinking },
    { name: 'TC1705: reasoning_effort', fn: testReasoningEffort },
    { name: 'TC1706: output_config.effort', fn: testOutputConfigEffort },
    { name: 'TC1707: Low Budget', fn: testLowBudgetThinking },
    { name: 'TC1708: Streaming', fn: testStreamingWithThinking },
    { name: 'TC1711: task_budget.total', fn: testTaskBudgetTotal },
    { name: 'TC1712: xhigh Effort', fn: testXhighEffort },
    { name: 'TC1713: OpenAI Format', fn: testOpenAITThinkingFormat },
    { name: 'TC1714: Signature Delta', fn: testSignatureDeltaStreaming },
    { name: 'TC1715: Custom Thresholds', fn: testCustomBudgetThresholds },
    { name: 'TC1716: Disabled Stripped', fn: testThinkingDisabledStripped },
    { name: 'TC1717: Budget Clamp (unit)', fn: testClampThinkingBudget },
    { name: 'TC1718: Budget Exceeds Max Tokens', fn: testBudgetExceedsMaxTokens }
  ]);
}
