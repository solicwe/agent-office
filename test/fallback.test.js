import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackLLM } from "../src/fallback.js";

const quotaErr = () => Object.assign(new Error("insufficient_credit"), { status: 402, quota: true });
const fake = (name, fail) => ({
  model: name,
  calls: 0,
  async call() { this.calls++; if (fail?.(this.calls)) throw fail.err(); return { text: name, usage: { input: 1, output: 2 } }; },
});

test("uses the owner's tokens while they last", async () => {
  const owner = fake("owner"), mine = fake("mine");
  const llm = new FallbackLLM({ primary: owner, fallback: mine });
  const r = await llm.call({});
  assert.equal(r.text, "owner");
  assert.equal(r.usage.own, undefined);
  assert.equal(llm.onOwnKey, false);
});

test("when the owner's tokens run out mid-job, the same call goes to the friend's key and stays there", async () => {
  const owner = fake("owner", Object.assign((n) => n >= 2, { err: quotaErr }));
  const mine = fake("mine");
  const switched = [];
  const llm = new FallbackLLM({ primary: owner, fallback: mine, onSwitch: (why) => switched.push(why) });
  assert.equal((await llm.call({})).text, "owner");
  const r = await llm.call({});
  assert.equal(r.text, "mine");
  assert.equal(r.usage.own, true, "tokens on the friend's key are marked as theirs");
  assert.deepEqual(switched, ["owner"]);
  assert.equal((await llm.call({})).text, "mine");
  assert.equal(owner.calls, 2, "no going back to the empty owner key");
  assert.equal(llm.model, "mine");
});

test("when the friend's share of the owner's tokens is used up, it switches before calling", async () => {
  let out = false;
  const owner = fake("owner"), mine = fake("mine");
  const switched = [];
  const llm = new FallbackLLM({ primary: owner, fallback: mine, primaryOut: () => out, onSwitch: (w) => switched.push(w) });
  await llm.call({});
  out = true;
  assert.equal((await llm.call({})).text, "mine");
  assert.equal(owner.calls, 1);
  assert.deepEqual(switched, ["share"]);
});

test("other errors are not hidden by switching keys", async () => {
  const owner = fake("owner", Object.assign(() => true, { err: () => Object.assign(new Error("boom"), { status: 500 }) }));
  const llm = new FallbackLLM({ primary: owner, fallback: fake("mine") });
  await assert.rejects(llm.call({}), /boom/);
  assert.equal(llm.onOwnKey, false);
});

test("without a key of their own, running out stops the job as before", async () => {
  const llm = new FallbackLLM({ primary: fake("owner", Object.assign(() => true, { err: quotaErr })) });
  await assert.rejects(llm.call({}), (err) => err.quota === true && !err.ownKey);
});

test("when the friend's own key runs out too, the error says so", async () => {
  const mine = fake("mine", Object.assign(() => true, { err: () => Object.assign(new Error("credit balance is too low"), { status: 400 }) }));
  const llm = new FallbackLLM({ primary: null, fallback: mine, isQuota: (e) => /credit/.test(e.message) });
  assert.equal(llm.onOwnKey, true, "friend chose their own key from the start");
  await assert.rejects(llm.call({}), (err) => err.quota === true && err.ownKey === true);
});
