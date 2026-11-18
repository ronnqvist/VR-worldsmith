/**
 * LLM envelope: build the chat messages and parse/validate the JSON reply.
 * Pure functions — no DOM, no A-Frame, no Three.js (unit-tested under Node).
 */
import { LIMITS } from '../core/config.js';
import { UserFacingError } from '../core/errors.js';

const ACTIONS = new Set(['create_world', 'update_world']);

/**
 * @param {object} p
 * @param {string} p.systemPrompt
 * @param {string} p.prompt               the user's request
 * @param {{text:string, truncated:boolean, entities:number}} p.world  serialized current world
 * @param {Array<{prompt:string, narration?:string}>} [p.recent]  recent exchanges, oldest first
 * @param {'vr'|'ar'} [p.mode]
 */
export function buildMessages({ systemPrompt, prompt, world, recent = [], mode = 'vr' }) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const ex of recent) {
    if (!ex?.prompt) continue;
    messages.push({ role: 'user', content: ex.prompt });
    messages.push({ role: 'assistant', content: JSON.stringify({ note: 'applied', narration: ex.narration || '' }) });
  }
  const hasWorld = world && world.entities > 0;
  const worldBlock = hasWorld
    ? `CURRENT WORLD (${world.entities} elements${world.truncated ? ', partially summarised' : ''}):\n${world.text}`
    : 'CURRENT WORLD: (empty — use "create_world")';
  messages.push({
    role: 'user',
    content: `${worldBlock}\n\nSESSION MODE: ${mode === 'ar' ? 'mixed reality passthrough' : 'virtual reality'}\n\nREQUEST: ${prompt}\n\nReply with the JSON object only.`
  });
  return messages;
}

/** Extracts the first balanced top-level {...} block, string-aware. */
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * Parses the model's content into a validated envelope.
 * Tolerates ```json fences, leading prose and <think> blocks; rejects bad shapes.
 * @returns {{action:'create_world'|'update_world', markup:string, removed_ids:string[], narration:string}}
 */
export function parseEnvelope(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new UserFacingError('The model returned an empty reply. Try again or pick another model.', { code: 'empty' });
  }
  let text = content.trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const block = extractJsonObject(text);
    if (!block) throw new UserFacingError('The model reply was not valid JSON. Your world is unchanged.', { code: 'json' });
    try { data = JSON.parse(block); } catch {
      throw new UserFacingError('The model reply was not valid JSON. Your world is unchanged.', { code: 'json' });
    }
  }
  return validateEnvelope(data);
}

export function validateEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UserFacingError('The model reply had the wrong shape. Your world is unchanged.', { code: 'shape' });
  }
  const action = typeof data.action === 'string' ? data.action.trim() : '';
  if (!ACTIONS.has(action)) {
    throw new UserFacingError(`The model used an unknown action "${String(data.action).slice(0, 30)}".`, { code: 'shape' });
  }
  if (typeof data.markup !== 'string') {
    throw new UserFacingError('The model reply had no markup. Your world is unchanged.', { code: 'shape' });
  }
  if (data.markup.length > LIMITS.maxMarkupChars) {
    throw new UserFacingError('The generated world was too large. Try a simpler request.', { code: 'size' });
  }
  let removed = data.removed_ids ?? [];
  if (!Array.isArray(removed)) removed = [];
  removed = removed.filter((x) => typeof x === 'string' && /^[A-Za-z][\w-]{0,63}$/.test(x)).slice(0, 500);
  let narration = typeof data.narration === 'string' ? data.narration : '';
  // eslint-disable-next-line no-control-regex
  narration = narration.replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxNarrationChars);
  if (action === 'create_world' && !data.markup.trim()) {
    throw new UserFacingError('The model returned an empty world. Your world is unchanged.', { code: 'shape' });
  }
  return { action, markup: data.markup, removed_ids: removed, narration };
}
