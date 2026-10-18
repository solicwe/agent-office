// Reads Claude Code's own transcript (JSON Lines) for two things the hooks don't carry:
// the real token usage per message, and the text Claude wrote just before it handed
// work to a subagent (its reasoning for that choice).
import { readFileSync, existsSync } from "node:fs";

function lines(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return out;
}

/**
 * Token usage of every assistant message, deduplicated by message id (Claude Code
 * writes one line per content block, all carrying the same usage).
 * `seen` (a Set of message ids) lets the caller count each message only once.
 */
export function usageSince(file, seen = new Set()) {
  const latest = new Map();
  for (const e of lines(file)) {
    const m = e.message;
    if (e.type !== "assistant" || !m?.usage || !m.id) continue;
    latest.set(m.id, { u: m.usage, model: m.model });
  }
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0, models: [] };
  for (const [id, { u, model }] of latest) {
    if (seen.has(id)) continue;
    seen.add(id);
    total.input += u.input_tokens || 0;
    total.output += u.output_tokens || 0;
    total.cache_read += u.cache_read_input_tokens || 0;
    total.cache_write += u.cache_creation_input_tokens || 0;
    total.messages++;
    if (model && !total.models.includes(model)) total.models.push(model);
  }
  return total;
}

/** The assistant text written right before the tool call `toolUseId` (or the latest text). */
export function reasoningBefore(file, toolUseId) {
  const texts = [];
  for (const e of lines(file)) {
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content || []) {
      if (c.type === "text" && c.text?.trim()) texts.push(c.text.trim());
      if (c.type === "tool_use" && toolUseId && c.id === toolUseId) return texts.at(-1) || "";
    }
  }
  return texts.at(-1) || "";
}

/** Rough token estimate when a transcript is not readable: ~4 characters per token. */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);
