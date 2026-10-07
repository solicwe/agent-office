// Token budget: the API has no "remaining credit" endpoint, so the app keeps its
// own budget and counts every token Claude reports (input + output).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.env.USAGE_FILE || "data/usage.json");
const DEFAULT_BUDGET = Number(process.env.TOKEN_BUDGET || 2_000_000);

let state = load();

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    return { budget: Number(s.budget) || DEFAULT_BUDGET, used: Number(s.used) || 0, since: s.since || new Date().toISOString(), syncedAt: s.syncedAt || null };
  } catch {
    return { budget: DEFAULT_BUDGET, used: 0, since: new Date().toISOString() };
  }
}

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[usage]", err.message);
  }
}

export function snapshot() {
  return { ...state, remaining: Math.max(0, state.budget - state.used) };
}

export function addUsage(input = 0, output = 0) {
  state.used += Math.max(0, input) + Math.max(0, output);
  save();
  return snapshot();
}

/**
 * budget: total quota. remaining: the real balance shown by the provider's website
 * right now; the budget is set so "remaining" matches it exactly from here on.
 */
export function configure({ budget, reset, remaining } = {}) {
  if (Number.isFinite(Number(budget)) && Number(budget) > 0) state.budget = Math.round(Number(budget));
  if (reset) { state.used = 0; state.since = new Date().toISOString(); }
  if (remaining !== undefined && remaining !== "" && Number.isFinite(Number(remaining)) && Number(remaining) >= 0) {
    state.budget = state.used + Math.round(Number(remaining));
    state.syncedAt = new Date().toISOString();
  }
  save();
  return snapshot();
}
