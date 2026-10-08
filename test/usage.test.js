import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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

test("quota errors are told apart from short rate limits", () => {
  assert.equal(usage.isQuotaError({ status: 429, message: "rate_limit_error: too many requests" }), false);
  assert.equal(usage.isQuotaError({ status: 429, message: "monthly quota exceeded" }), true);
  assert.equal(usage.isQuotaError({ status: 400, message: "Your credit balance is too low" }), true);
  assert.equal(usage.isQuotaError({ status: 402, message: "" }), true);
  assert.equal(usage.isQuotaError({ status: 500, message: "server error" }), false);
});
