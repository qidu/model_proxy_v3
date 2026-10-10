import { isToolBlocked } from './dashboard-stats.js';
import { toolNameOf } from './tool-shapes.js';
import type { Logger } from '../types/shared.js';

export type EraseResult = {
  erasedNames: string[];
  toolChoiceReset: boolean;
};

/**
 * Remove blocked tools from the request body before forwarding to upstream.
 * Mutates `body` in place. Also resets `tool_choice` to 'auto' if it forces
 * a blocked tool (so the request still succeeds with a tool the model picks).
 *
 * Supports the three tool shapes the proxy sees on the wire:
 *   - Claude:    body.tools[i] = { name, description?, input_schema }
 *   - OpenAI:    body.tools[i] = { type: 'function', function: { name, ... } }
 *   - Gemini:    body.tools[i] = { functionDeclarations: [{ name, ... }] }
 *
 * If the filtered tools array becomes empty, the field is deleted (some
 * upstreams reject tools: []). Past `tool_use` / `tool_result` blocks in
 * message history are intentionally left alone — only the tool schema is
 * removed.
 *
 * @param sidecarEraseNames - Optional set of tool names to erase from sidecar judge decision.
 *   These are merged with the static blocklist (dashboard stats).
 * @param sidecarEraseFactors - Optional map of sidecar-erased tool name to the
 *   judge's confidence factor, used only to enrich the debug log.
 */
export function eraseBlockedTools(
  body: Record<string, unknown>,
  log: Logger | undefined,
  requestId: string,
  sidecarEraseNames: string[] = [],
  sidecarEraseFactors?: Record<string, number>,
): EraseResult {
  const result: EraseResult = { erasedNames: [], toolChoiceReset: false };
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    sanitizeToolChoice(body, result, sidecarEraseNames);
    return result;
  }

  // Convert sidecar names to a Set for O(1) lookup
  const sidecarBlocked = new Set(sidecarEraseNames);

  const eraseSource = (name: string): string => {
    if (isToolBlocked(name)) return 'static blocklist';
    const factor = sidecarEraseFactors?.[name];
    return factor !== undefined
      ? `judge sidecar, confidence=${factor.toFixed(4)}`
      : 'judge sidecar';
  };

  const filtered: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      filtered.push(tool);
      continue;
    }
    const t = tool as Record<string, unknown>;
    // Gemini native shape: { functionDeclarations: [{ name, ... }] }
    if (Array.isArray(t.functionDeclarations)) {
      const newDecls = t.functionDeclarations.filter((d) => {
        if (!d || typeof d !== 'object') return true;
        const name = (d as Record<string, unknown>).name;
        if (typeof name === 'string' && (isToolBlocked(name) || sidecarBlocked.has(name))) {
          result.erasedNames.push(name);
          log?.debug(requestId, `Erasing tool '${name}' (${eraseSource(name)})`);
          return false;
        }
        return true;
      });
      if (newDecls.length === 0) {
        // No surviving declarations — drop the wrapper entirely
        continue;
      }
      filtered.push({ ...t, functionDeclarations: newDecls });
      continue;
    }
    // Claude / OpenAI / Responses shape
    const name = toolNameOf(t);
    if (name && (isToolBlocked(name) || sidecarBlocked.has(name))) {
      result.erasedNames.push(name);
      log?.debug(requestId, `Erasing tool '${name}' (${eraseSource(name)})`);
      continue;
    }
    filtered.push(tool);
  }

  if (result.erasedNames.length > 0) {
    if (filtered.length === 0) {
      delete body.tools;
    } else {
      body.tools = filtered;
    }
  }

  sanitizeToolChoice(body, result, sidecarEraseNames);

  if (result.erasedNames.length > 0) {
    log?.info(requestId, `Erased blocked tools from request: ${result.erasedNames.join(', ')}`);
  }
  if (result.toolChoiceReset) {
    log?.info(requestId, `Reset tool_choice to 'auto' (was forcing a blocked tool)`);
  }

  return result;
}

function sanitizeToolChoice(
  body: Record<string, unknown>,
  result: EraseResult,
  sidecarEraseNames: string[],
): void {
  const tc = body.tool_choice;
  if (!tc || typeof tc !== 'object') return;
  const choice = tc as Record<string, unknown>;
  let referenced: string | undefined;
  if (typeof choice.name === 'string') {
    referenced = choice.name;
  } else if (choice.function && typeof choice.function === 'object') {
    const fn = choice.function as Record<string, unknown>;
    if (typeof fn.name === 'string') referenced = fn.name;
  }
  if (referenced && (isToolBlocked(referenced) || sidecarEraseNames.includes(referenced))) {
    body.tool_choice = 'auto';
    result.toolChoiceReset = true;
  }
}

