import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "agent-office-usage-"));
process.env.USAGE_FILE = path.join(dir, "usage.json");
const usage = await import("../src/usage.js");
test.after(() => rm(dir, { recursive: true, force: true }));

test("counts the tokens the provider reports", () => {
  usage.addUsage(1200, 300);
  usage.addUsage(500, 0);
  assert.equal(usage.snapshot().used, 2000);
  assert.equal(usage.snapshot().exhausted, false);
});

test("a success right after 'out of tokens' only clears the flag (credit was low, not reset)", () => {
  const before = usage.snapshot().used;
  usage.markExhausted();
  assert.equal(usage.snapshot().exhausted, true);
  usage.addUsage(10, 5);
  const s = usage.snapshot();
  assert.equal(s.exhausted, false);
  assert.equal(s.used, before + 15, "keeps counting");
});

test("a success long after 'out of tokens' means the provider reset: counter restarts", () => {
  usage.markExhausted();
  writeFileSync(process.env.USAGE_FILE, JSON.stringify({ ...usage.snapshot(), exhaustedAt: new Date(Date.now() - 2 * 3600e3).toISOString() }));
  usage.reload();
  usage.addUsage(10, 5);
  const s = usage.snapshot();
  assert.equal(s.used, 15, "counter restarted from zero");
  assert.equal(s.lastReset.reason, "upstream");
});

/** Pretend time passed: edit the saved file, then reload it. */
function rewrite(change) {
  const s = JSON.parse(readFileSync(process.env.USAGE_FILE, "utf8"));
  change(s);
  writeFileSync(process.env.USAGE_FILE, JSON.stringify(s));
  usage.reload();
}
const runOut = () => { usage.markExhausted(); rewrite((s) => { s.exhaustedAt = new Date(Date.now() - 2 * 3600e3).toISOString(); }); };

test("after two rounds (out of tokens, then reset) it knows the limit per round", () => {
  // The first round began part-way through the quota, so it does not count.
  assert.equal(usage.snapshot().roundLimit, null);
  usage.addUsage(985, 0); // this round began at an upstream reset: 1000 tokens in all
  runOut();
  rewrite((s) => { s.resets[0] = new Date(Date.now() - 24 * 3600e3).toISOString(); });
  usage.addUsage(10, 0); // the quota is back: a new round starts
  const s = usage.snapshot();
  assert.equal(s.used, 10, "the counter restarts as before");
  assert.equal(s.roundLimit, 1000, "learned: about 1000 tokens per round");
  assert.equal(s.roundsSeen, 1);
  assert.ok(Math.abs(s.periodMs - 24 * 3600e3) < 60e3, "resets about once a day");
  assert.ok(Date.parse(s.nextResetAt) > Date.now() + 23 * 3600e3, "next reset expected about a day from now");
});

test("a manual reset keeps what was learned but its round does not count", () => {
  usage.resetCount("manual");
  usage.addUsage(50, 0);
  runOut();
  usage.addUsage(1, 0);
  const s = usage.snapshot();
  assert.equal(s.roundLimit, 1000, "the round after a manual reset is not a full round");
  assert.equal(s.roundsSeen, 1);
});

test("quota errors are told apart from short rate limits", () => {
  assert.equal(usage.isQuotaError({ status: 429, message: "rate_limit_error: too many requests" }), false);
  assert.equal(usage.isQuotaError({ status: 429, message: "monthly quota exceeded" }), true);
  assert.equal(usage.isQuotaError({ status: 400, message: "Your credit balance is too low" }), true);
  assert.equal(usage.isQuotaError({ status: 402, message: "" }), true);
  assert.equal(usage.isQuotaError({ status: 500, message: "server error" }), false);
});
