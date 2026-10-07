// Token usage: counts every token the provider reports (input + output).
// The providers have no "remaining quota" endpoint, so instead of a budget the
// app shows tokens used, flags "exhausted" when the provider says the quota is
// gone, and starts counting from zero again once the provider works again
// (that means the quota was reset upstream).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.env.USAGE_FILE || "data/usage.json");

let state = load();

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    return { used: Number(s.used) || 0, since: s.since || new Date().toISOString(), exhausted: Boolean(s.exhausted), exhaustedAt: s.exhaustedAt || null, lastReset: s.lastReset || null };
  } catch {
    return { used: 0, since: new Date().toISOString(), exhausted: false, exhaustedAt: null, lastReset: null };
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

export const snapshot = () => ({ ...state });

/** Record a successful call. If we were out of tokens, the provider has reset: start over. */
export function addUsage(input = 0, output = 0) {
  if (state.exhausted) resetCount("upstream");
  state.used += Math.max(0, input) + Math.max(0, output);
  save();
  return snapshot();
}

export function markExhausted() {
  if (!state.exhausted) {
    state.exhausted = true;
    state.exhaustedAt = new Date().toISOString();
    save();
  }
  return snapshot();
}

export function resetCount(reason = "manual") {
  state = { used: 0, since: new Date().toISOString(), exhausted: false, exhaustedAt: null, lastReset: { at: new Date().toISOString(), reason } };
  save();
  return snapshot();
}

/** Does this error mean the account is out of tokens/credit (not a short rate limit)? */
export function isQuotaError(err) {
  const status = err?.status;
  const msg = String(err?.message || err || "");
  if (status === 402) return true;
  if (status === 429 && !/quota|credit/i.test(msg)) return false; // a short rate limit, not an empty quota
  return /quota|credit balance|insufficient (funds|credit|balance|quota)|out of (tokens|credits)|usage limit|exceeded your|token limit|โควตา/i.test(msg);
}
