/**
 * Shared walking of the three tool shapes the proxy sees on the wire:
 *   - Claude:  { name, description?, input_schema }
 *   - OpenAI:  { type: 'function', function: { name, parameters } }
 *   - Gemini:  { functionDeclarations: [{ name, parameters }] }
 *
 * `name` wins over `function.name` when both are present, and the schema comes
 * from the same branch as the name — a flat `name` is never paired with the
 * nested `function.parameters`. The OpenAI branch is not gated on
 * `type: 'function'` — an entry that names a function is a tool even when the
 * tag is missing, and skipping it dropped it silently.
 *
 * Nothing here trims. Callers that need trimming (the dashboard) do it
 * themselves, so the judge keeps receiving names exactly as sent.
 */

export interface ToolRecord {
  name: string;
  /** Parameter schema, kept whole — the judge serializes it into the state text. */
  schema: Record<string, unknown>;
}

function asSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** One Claude/OpenAI/Responses entry, or undefined when it names no tool. */
function flatRecord(tool: unknown): ToolRecord | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const t = tool as Record<string, unknown>;

  // Claude, and the flat Responses shape: { name, input_schema?, parameters? }
  if (typeof t.name === 'string' && t.name.length > 0) {
    return { name: t.name, schema: asSchema(t.input_schema ?? t.parameters) };
  }

  // OpenAI / Responses: { type: 'function', function: { name, parameters } }
  if (t.function && typeof t.function === 'object') {
    const fn = t.function as Record<string, unknown>;
    if (typeof fn.name === 'string' && fn.name.length > 0) {
      return { name: fn.name, schema: asSchema(fn.parameters) };
    }
  }

  return undefined;
}

/**
 * The name of a single Claude/OpenAI/Responses tool entry. A Gemini wrapper
 * carries one name per declaration and is not one tool — walk it with
 * extractToolRecords instead.
 */
export function toolNameOf(tool: unknown): string | undefined {
  return flatRecord(tool)?.name;
}

/** Every tool a single `body.tools[i]` entry contributes (Gemini: many). */
function recordsOf(tool: unknown): ToolRecord[] {
  if (!tool || typeof tool !== 'object') return [];
  const t = tool as Record<string, unknown>;

  // Gemini native body: { functionDeclarations: [{ name, parameters }] }
  if (Array.isArray(t.functionDeclarations)) {
    const out: ToolRecord[] = [];
    for (const decl of t.functionDeclarations) {
      if (!decl || typeof decl !== 'object') continue;
      const d = decl as Record<string, unknown>;
      if (typeof d.name !== 'string' || d.name.length === 0) continue;
      out.push({ name: d.name, schema: asSchema(d.parameters) });
    }
    return out;
  }

  const flat = flatRecord(t);
  return flat ? [flat] : [];
}

/**
 * Every tool named in a request body, each with the schema it will be sent
 * with. Duplicate names collapse to their first occurrence, preserving order —
 * the judge addresses tools by name, so a repeated name is a single question.
 */
export function extractToolRecords(body: Record<string, unknown> | undefined): ToolRecord[] {
  if (!body) return [];
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];

  const found: ToolRecord[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const record of recordsOf(tool)) {
      if (seen.has(record.name)) continue;
      seen.add(record.name);
      found.push(record);
    }
  }
  return found;
}
