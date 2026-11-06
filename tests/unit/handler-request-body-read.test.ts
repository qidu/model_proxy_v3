/**
 * Unit tests for the request-body read at the top of the two handler entry
 * points that can be routed to an `sdk://` target.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7 — "do not
 * call `response.clone().text()` or buffer a second copy". A clone *tees* the
 * body, so the branch nobody reads stays resident for as long as the parse runs.
 * `src/handlers/claude.ts` and `src/handlers/messages.ts` took that clone on the
 * `sdk://` route only — `isSdkUrl(targetUrl) ? await request.clone().json() :
 * await request.json()` — to "preserve body for SDK handler". Nothing read the
 * preserved branch: both files hand every `sdk://` branch `requestBody`, the
 * *parsed* object, and the SDK handlers are stubs that never touch the request
 * they are given. The non-SDK route already consumed the body in place, so the
 * conditional only made the two routes differ in how many copies of the body
 * existed.
 *
 * Both statements are now one plain `await request.json()`, which is what these
 * tests pin. Three properties, each worth its space:
 *
 *  - `Request.prototype.clone()` is called **zero** times, on either route. The
 *    count is what makes the removal observable at all — the handler's answer
 *    (a 501) is identical before and after, so nothing else distinguishes them.
 *  - the body is consumed once, in place: `request.bodyUsed` is true once the
 *    handler has settled, so no live second branch is left behind it.
 *  - the body is still *parsed* on the `sdk://` route: a malformed body fails
 *    with the JSON parse error rather than with the SDK's 501. That is the
 *    behaviour a future "skip the parse when the target is an SDK" change would
 *    silently remove, and this is where it would be noticed.
 *
 * The non-SDK route is not driven here: after this change it takes the very same
 * statement as the `sdk://` route in each file, so one case pins both.
 *
 * Run with: npx tsx --test tests/unit/handler-request-body-read.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleClaudeRequest } from '../../src/handlers/claude.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const SDK_URL = 'sdk://vllm-local';

/** A minimal native-Claude body: enough for the handler to parse and route. */
function claudeBody(): string {
    return JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
}

/** A minimal already-OpenAI body: takes the `/v1/chat/completions` passthrough. */
function openaiBody(): string {
    return JSON.stringify({
        model: 'llama3.1-8B',
        messages: [{ role: 'user', content: 'hi' }],
    });
}

function makeRequest(body: string): Request {
    return new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
}

/**
 * Count `Request.prototype.clone()` calls while `run` executes. Every `sdk://`
 * route fails loud, so `run` is expected to reject: the rejection is returned
 * rather than propagated, and a `run` that resolves is reported as a thrown
 * error by `error === undefined` at the call sites below.
 */
async function countRequestClones(run: () => Promise<unknown>): Promise<{ error: unknown; clones: number }> {
    const original = Request.prototype.clone;
    let clones = 0;
    Request.prototype.clone = function clone(this: Request) {
        clones += 1;
        return original.call(this);
    };
    try {
        let error: unknown;
        try {
            await run();
        } catch (thrown) {
            error = thrown;
        }
        return { error, clones };
    } finally {
        Request.prototype.clone = original;
    }
}

/** The 501 both SDK stubs raise, with the model alias and request id named. */
function assertSdkUnavailable(error: unknown, alias: string, requestId: string): void {
    assert.ok(error instanceof ClaudeProxyError, `expected ClaudeProxyError, got ${(error as Error)?.name}: ${error}`);
    assert.equal(error.status, 501);
    assert.equal(error.type, 'not_implemented');
    assert.match(error.message, /sdk:\/\//);
    assert.match(error.message, new RegExp(alias));
    assert.match(error.message, new RegExp(requestId));
}

describe('§5.7 the handler request-body read never tees the body', () => {
    it('the counter sees a clone when one is made', async () => {
        // The instrument's own power: without this, a silently broken spy would
        // make every zero-count assertion below vacuous.
        const { clones } = await countRequestClones(async () => {
            makeRequest(claudeBody()).clone();
        });
        assert.equal(clones, 1, 'Request.prototype.clone() is counted');
    });

    it('claude.ts reads the body in place on an sdk:// target', async () => {
        const request = makeRequest(claudeBody());

        const { error, clones } = await countRequestClones(() =>
            handleClaudeRequest(request, SDK_URL, {}, 'req_claude_sdk', 'claude-sonnet', ENV));

        assertSdkUnavailable(error, 'claude-sonnet', 'req_claude_sdk');
        assert.equal(clones, 0, 'the body was not teed to preserve it for the SDK handler');
        assert.equal(request.bodyUsed, true, 'the body was consumed in place, so no branch survives the handler');
    });

    it('messages.ts reads the body in place on an sdk:// target (OpenAI format)', async () => {
        const request = makeRequest(openaiBody());

        const { error, clones } = await countRequestClones(() =>
            handleMessagesRequest(request, SDK_URL, {}, 'req_openai_sdk', 'llama3.1-8B', ENV));

        assertSdkUnavailable(error, 'llama3.1-8B', 'req_openai_sdk');
        assert.equal(clones, 0, 'the body was not teed to preserve it for the SDK handler');
        assert.equal(request.bodyUsed, true, 'the body was consumed in place, so no branch survives the handler');
    });

    it('messages.ts reads the body in place on an sdk:// target (Claude format)', async () => {
        // The second `sdk://` branch in the file reaches `handleSdkAnthropicRequest`
        // through validation and conversion rather than straight from the parse.
        const request = makeRequest(claudeBody());

        const { error, clones } = await countRequestClones(() =>
            handleMessagesRequest(request, SDK_URL, {}, 'req_anthropic_sdk', 'claude-sonnet', ENV, undefined, 'anthropic-messages'));

        assertSdkUnavailable(error, 'claude-sonnet', 'req_anthropic_sdk');
        assert.equal(clones, 0, 'the body was not teed to preserve it for the SDK handler');
        assert.equal(request.bodyUsed, true, 'the body was consumed in place, so no branch survives the handler');
    });

    it('parses the body on the sdk:// route, so a malformed body is a parse failure and not the 501', async () => {
        const request = makeRequest('{"model": "claude-sonnet", ');

        const { error, clones } = await countRequestClones(() =>
            handleClaudeRequest(request, SDK_URL, {}, 'req_malformed', 'claude-sonnet', ENV));

        assert.ok(!(error instanceof ClaudeProxyError), `the body was parsed before the SDK branch: got ${error}`);
        assert.match(String(error), /JSON/i, 'the failure is the body parse, not the SDK stub');
        assert.equal(clones, 0);
        assert.equal(request.bodyUsed, true);
    });
});
