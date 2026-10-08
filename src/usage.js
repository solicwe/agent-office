// Token usage: counts every token the provider reports (input + output).
// The providers have no "remaining quota" endpoint, so instead of a budget the
// app shows tokens used, flags "exhausted" when the provider says the quota is
// gone, and starts counting from zero again once the provider works again
// (that means the quota was reset upstream).
//
// Each round from one upstream reset to the next is remembered. A round is only
// "complete" when it began with an upstream reset (the very first round usually
// starts part-way through the quota), so after two rounds the app knows roughly
// how many tokens one round allows and how often the quota resets.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.env.USAGE_FILE || "data/usage.json");
const KEEP = 12;

let state = load();

function fresh() {
  return { used: 0, since: new Date().toISOString(), exhausted: false, exhaustedAt: null, lastReset: null, rounds: [], resets: [] };
}

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    return {
      used: Number(s.used) || 0,
      since: s.since || new Date().toISOString(),
      exhausted: Boolean(s.exhausted),
      exhaustedAt: s.exhaustedAt || null,
      lastReset: s.lastReset || null,
      rounds: Array.isArray(s.rounds) ? s.rounds.filter((r) => Number(r?.used) > 0).slice(-KEEP) : [],
      resets: Array.isArray(s.resets) ? s.resets.filter((t) => !Number.isNaN(Date.parse(t))).slice(-KEEP) : [],
    };
  } catch {
    return fresh();
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

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * What the past rounds tell us. roundLimit: the most tokens one complete round reached
 * (the latest 3 rounds, so a changed quota shows up soon). periodMs: the usual time
 * between upstream resets. Both stay null until a complete round has been seen.
 */
function learned() {
  const recent = state.rounds.slice(-3).map((r) => r.used);
  const times = state.resets.map((t) => Date.parse(t));
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 0);
  const periodMs = gaps.length ? median(gaps.slice(-5)) : null;
  return {
    roundLimit: recent.length ? Math.max(...recent) : null,
    periodMs,
    nextResetAt: periodMs && times.length ? new Date(times.at(-1) + periodMs).toISOString() : null,
    roundsSeen: state.rounds.length,
  };
}

export const snapshot = () => {
  const { rounds, resets, ...rest } = state;
  return { ...rest, ...learned(), rounds: rounds.map((r) => ({ ...r })) };
};

// A small request can still pass while credit is nearly gone, so a success soon after
// "out of tokens" only clears the flag. Only a success after a long gap counts as the
// provider having reset the quota, which restarts the counter.
const RESET_GAP_MS = Number(process.env.QUOTA_RESET_GAP_MS || 30 * 60 * 1000);

/** Record a successful call. */
export function addUsage(input = 0, output = 0) {
  if (state.exhausted) {
    const outFor = Date.now() - new Date(state.exhaustedAt || 0).getTime();
    if (outFor >= RESET_GAP_MS) resetCount("upstream");
    else { state.exhausted = false; state.exhaustedAt = null; }
  }
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

/** Start counting from zero. "upstream" = the provider reset the quota; the past round is remembered. */
export function resetCount(reason = "manual") {
  const now = new Date().toISOString();
  const { rounds, resets } = state;
  if (reason === "upstream") {
    // The round that just ended is complete only if it also began at an upstream reset.
    if (state.lastReset?.reason === "upstream" && state.used > 0) {
      rounds.push({ used: state.used, from: state.since, outAt: state.exhaustedAt, to: now });
    }
    resets.push(now);
  }
  state = { ...fresh(), since: now, lastReset: { at: now, reason }, rounds: rounds.slice(-KEEP), resets: resets.slice(-KEEP) };
  save();
  return snapshot();
}

/** Does this error mean the account is out of tokens/credit (not a short rate limit)? */
export function isQuotaError(err) {
  const status = err?.status;
  const msg = String(err?.message || err || "");
  if (status === 402) return true;
  if (status === 429 && !/quota|credit/i.test(msg)) return false; // a short rate limit, not an empty quota
  return /quota|credit balance|insufficient (funds|credit|balance|quota)|out of (tokens|credits)|usage limit|exceeded your|token limit|insufficient_credit|เครดิต|โควตา/i.test(msg);
}

/** Re-read the usage file (used by tests). */
export function reload() {
  state = load();
}
