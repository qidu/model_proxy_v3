---
generated_by: pi-agent-core inside proxy v3 for testing
audience: public reviewer
status: agent-test material
---

<!--
  NOTE — provenance & audience
  ----------------------------
  This document is generated material produced during internal **pi-agent testing**
  of the model proxy. It is NOT a hand-curated public-facing reference.

  Audience: internal engineers and the pi-agent test harness only.
  Do not publish or link to this file from public docs (README, GitHub Pages,
  release notes) without review.

  It complements (but does not replace) the hand-maintained reference docs:
    - api-endpoints.md             (narrative endpoint details)
    - configuration-reference.md   (full proxy_config.toml schema)
    - transforms-reference.md      (rewrite DSL)
    - routing-and-aliases.md       (composite / fallback / fusion / schedule)
    - interactions.md              (Gemini Interactions wire shape)

  Regenerate / re-verify after any of:
    - src/server.ts route mounting changes
    - src/types/*.ts schema additions or renames
    - src/converters/*.ts direction table changes
    - src/handlers/*.ts handler reshuffles
    - proxy_config.toml top-level section additions
-->

# 📚 Docs Category Index

> Source: `/Users/chris/dev/bot/model_proxy_v3/docs`
> Nothing was moved; this is a flat categorization only.

---

## 📂 1. Core / High-level Project Docs (README, plans, overviews)
1. `README_DETAILS.md`
2. `readme_update_summary.md`
3. `proxy_plan_for_v3.md`
4. `design_and_plan_of_coordinator.md`
5. `proxy_impementation.md`
6. `IMPLEMENTATION_SUMMARY.md`
7. `revision_complete_summary.md`
8. `CONSOLIDATION.md`

---

## 📂 2. Architecture / Design / Proposals
1. `design_fusion_composite_alias.md`
2. `design_request_transform_hooks.md`
3. `implementation_of_request_transform_hooks.md`
4. `proposal-deepseek-harness-llm-split.md`
5. `proposal-zod-schema-validation.md`
6. `plan-llm-as-a-verifier-plugin.md`
7. `plan-opf-privacy-filter-plugin.md`
8. `plan-split-cloudflare-worker-vs-local.md`
9. `plan-to-refactor-divide-proxy-for-local-side-and-server-side.md`

---

## 📂 3. Configuration & Routing
1. `configuration-guide.md`
2. `configuration-reference.md`
3. `config_loader.md`
4. `config_env_removal.md`
5. `routing-and-aliases.md`
6. `routing_refactor.md`
7. `routing_config_revision.md`
8. `routing-review.md`
9. `model_routing_implementation.md`
10. `model_alias_native_mode_fix.md`
11. `fusion_compare.md`
12. `todo-composite-fusion-toml-spec-compliance.md`
13. `multiple_upstream_analysis.md`
14. `Refactor_gemini_interactions_to_openai_compatible.md`

---

## 📂 4. Transforms / Hooks / Implementation Reviews
1. `transforms-reference.md`
2. `review_of_transforms_hooks_about_endpoint_readin_vs_before_conversion.md`
3. `review_of_transforms_hooks_implementation.md`
4. `review_readme_and_impl.md`
5. `review_of_thinking_converting.md`
6. `review_proxy_thinking.md`
7. `review_of_antigravity_gemini_with_ds_tools.md`
8. `proxy_tests.md`

---

## 📂 5. API Reference / Schema / Endpoints
1. `api-endpoints.md`
2. `api_and_schema_listing.md`
3. `TEST_API_DOCUMENTATION.md`
4. `API_COMPLIANCE_CHECK.md`
5. `Evaluation_Report_of_API.md`

---

## 📂 6. Auth / Security / Stats
1. `auth_header_extraction.md`
2. `auth-stats-protocol.md`
3. `live-stats.md`
4. `security-review.md`
5. `security-review-2.md`
6. `security-review-3.md`
7. `security-review-4.md`
8. `consul-server.md`

---

## 📂 7. Claude (Anthropic) API Docs

**Top-level:**
1. `claude-api-reference.md`
2. `claude-beta-headers.md`
3. `claude-adaptive-thinking.md`
4. `claude-extended-thinking.md`
5. `claude-token-pricing.md`
6. `claude_api_test_cases.md`

**In `claude_api_docs/`:**
7. `authentication.md`
8. `batches-api.md`
9. `client-sdks.md`
10. `files-api.md`
11. `messages-api.md`
12. `messages-count-tokens.md`
13. `messages-create.md`
14. `models-api.md`
15. `overview.md`
16. `rate-limits.md`
17. `README.md`
18. `skills-api.md`
19. `token-counting-api.md`
20. `versioning.md`

**Subdir `claude_api_docs/examples/`:**
21. `python_basic.py`
22. `examples/README.md`

---

## 📂 8. Gemini / Vertex AI Docs
1. `gemini-api-reference.md`
2. `gemini-sse-stream-examples.md`
3. `vertex-ai-gemini-api.md`
4. `implementation_of_gemini_interactions_api.md`
5. `interactions_sse_spec_review.md`
6. `interactions.md`
7. `generatecontent_sse_flow_analysis.md`
8. `streamgeneratecontent_analysis.md`
9. `streamgeneratecontent_implementation_summary.md`
10. `streamgeneratecontent_simplified_final.md`
11. `upstream_sse_support_review.md`
12. `sse_streaming_review.md`
13. `cached_content_support.md`
14. `implementation_cached_content.md`
15. `gemini_interactions_streaming_fix.md`
16. `gemini_messages_streaming_fix.md`
17. `messages_streaming_fix.md`
18. `gemini_generatecontent_review.md`

---

## 📂 9. OpenAI / OpenRouter Docs
1. `openai-api-reference.md`
2. `openai-prompt-caching.md`
3. `openai-response-token-counting.md`
4. `openai-response.md` *(very large)*
5. `openrouter_skill.md`
6. `openrouter_tool_calling.md`
7. `token_counting.md`

---

## 📂 10. Agents (subdirectory + related)

**In `agents/`:**
1. `copilot-cli.md`
2. `crewai.md`
3. `google-antigravity.md`
4. `harness-agent.md`
5. `langgraph.md`
6. `opencode.md`
7. `proxy-as-provider-for-deepseek-harness.md`

**Top-level agent-related:**
8. `auth_header_extraction.md` *(overlaps with Auth category)*

---

## 📂 11. Thinking / Reasoning Models
1. `claude-extended-thinking.md`
2. `claude-adaptive-thinking.md`
3. `deepseek_thinking.md`
4. `mono-thinking.md`
5. `test_thinking_models_all_results.md`
6. `thinking_models_final_test_results.md`
7. `thinking_models_stream_test_results.md`
8. `review_proxy_thinking.md`

---

## 📂 12. Test Results — Claude
1. `test_claude_4_5_sonnet_results.md`
2. `test_claude_haiku_4_5_results.md`
3. `test_claude_haiku_alias_results.md`
4. `test_claude_haiku_both_modes_results.md`
5. `test_claude_opus_results.md`
6. `test_claude_sonnet_4_5_results.md`
7. `test_claude_sonnet_both_modes_results.md`
8. `test_claude_sonnet_current_config_results.md`
9. `test_claude_sonnet_native_results.md`
10. `test_claude_sonnet_results.md`

---

## 📂 13. Test Results — Gemini
1. `gemini_both_modes_test_results.md`
2. `gemini3_flash_preview_test_results.md`
3. `gemini3_models_direct_qnaigc_test.md`
4. `gemini3_models_openai_upstream_test.md`
5. `gemini3_models_proxy_bug_fix.md`
6. `gemini31_pro_direct_upstream_test.md`
7. `gemini31_pro_preview_test_results.md`
8. `test_gemini_2_0_flash_results.md`
9. `test_gemini_claude_comprehensive_results.md`
10. `test_gemini_sse_both_modes_results.md`
11. `streamgeneratecontent_native_test_results.md`
12. `streamgeneratecontent_test_results.md`

---

## 📂 14. Test Results — DeepSeek & Other Models
1. `deepseek_models_test_results.md`
2. `test_deepseek_v3_2_results.md`
3. `glm5_test_results.md`
4. `minimax_model_test_results.md`
5. `oversea_models_test_results.md`
6. `failed_models_final_retest_results.md`
7. `failed_models_retest_results.md`
8. `all_models_test_results.md`
9. `test_results_summary.md`
10. `test_results_after_refactoring.md`
11. `test_results_unconfigured_models.md`
12. `test_with_config_results.md`
13. `test_2_models_final_results.md`
14. `test_3_models_results.md`
15. `test_random_3_models_results.md`
16. `test_random_3_models_round2_results.md`
17. `test_rest_models_results.md`
18. `two_models_both_modes_test_results.md`
19. `analysis_gemini_model_alias_broken.md`
20. `analysis_gemini_model_alias.md`

---

## 📂 15. Performance / Optimization
1. `cpu-optimization-advices.md`
2. `review-of-performace-1.md`

---

## 📂 16. Tools / Misc Data
1. `tools_in_resp_examples.md`
2. `random_prompts.json`
3. `TOOL_ID_MISS_CHECK.diff`

---

## 📂 17. Logs / Token Traces
1. `model_proxy_tokens.jsonl` *(~42 MB)*

---

## 📂 18. Nginx Config (subdirectory)

**In `nginx_conf/`:**
1. `nginx_lua_auth/auth_keys.json`
2. `nginx_lua_auth/auth.lua`
3. `nginx_lua_auth/USAGE.md`
4. `nginx_plain_auth/nginx_auth_map.conf`
5. `nginx_plain_auth/nginx_http.conf`
6. `nginx_plain_auth/USAGE.md`

---

## 📂 19. Embedding / SDK Tests
1. `test_embeding.md`
2. `test_llama3_sdk.md`
3. `test_of_sdk.md`
4. `test_guideline.md`

---

## Summary counts

- **Top-level docs (root):** ~115
- **`claude_api_docs/`:** 20 files
- **`agents/`:** 7 files
- **`nginx_conf/`:** 6 files
- **`claude_api_docs/examples/`:** 2 files
- **Total tracked:** ~150

---
