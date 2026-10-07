import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob, isTransient } from "../src/orchestrator.js";
import { parseFiles } from "../src/workspace.js";
import { ScriptedLLM } from "./fixtures/scripted-llm.js";
import { DEMO_SCRIPT, DEMO_TASK } from "./fixtures/demo-script.js";

/** Scripted team with hooks to break specific steps. */
class FlakyLLM extends ScriptedLLM {
  constructor(hooks) {
    super();
    this.hooks = hooks;
    this.calls = [];
  }
  async call(opts) {
    this.calls.push(opts.step);
    const hook = this.hooks[opts.step];
    if (hook) {
      const out = hook(this.calls.filter((s) => s === opts.step).length);
      if (out instanceof Error) throw out;
      if (out) return { usage: { input: 1, output: 1 }, ...out };
    }
    return super.call(opts);
  }
}

const run = (llm, input = { task: DEMO_TASK, files: {} }) => {
  const events = [];
  return runJob({ input, llm, emit: (e) => events.push(e), signal: new AbortController().signal }).then((r) => ({ ...r, events }));
};

test("a cut-off answer keeps complete files and asks again only for the missing ones", { timeout: 120_000 }, async () => {
  const full = DEMO_SCRIPT["implement:T2"];
  const cut = full.slice(0, full.indexOf('<file path="css/style.css">') + 200); // style.css unfinished
  const llm = new FlakyLLM({ "implement:T2": () => ({ text: cut, truncated: true }) });
  const { success, files, events } = await run(llm);
  assert.ok(llm.calls.includes("implement:T2:more1"), "asked for the missing file");
  assert.ok(files["css/style.css"].includes(".toast"), "the complete stylesheet arrived on the second try");
  assert.ok(events.some((e) => e.type === "notice" && /style\.css/.test(e.message)));
  assert.equal(success, true);
});

test("a transient failure is retried and the job still finishes", { timeout: 120_000 }, async () => {
  const llm = new FlakyLLM({ "implement:T3": (n) => (n === 1 ? Object.assign(new Error("socket hang up"), { transient: true }) : null) });
  const { success, events } = await run(llm);
  assert.equal(llm.calls.filter((s) => s === "implement:T3").length, 2);
  assert.ok(events.some((e) => e.type === "notice" && /ลองใหม่/.test(e.message)));
  assert.equal(success, true);
});

test("one task failing for good does not stop the whole site", { timeout: 120_000 }, async () => {
  const llm = new FlakyLLM({ "implement:T3": () => new Error("model returned garbage") });
  const { events } = await run(llm);
  assert.ok(events.some((e) => e.type === "task" && e.id === "T3" && e.state === "failed"));
  assert.ok(events.some((e) => e.type === "test"), "the team still went on to testing");
  assert.ok(events.some((e) => e.type === "done"));
});

test("resume continues from the unfinished tasks without redoing spec, design or done work", { timeout: 120_000 }, async () => {
  const tasks = JSON.parse(DEMO_SCRIPT.plan.match(/<plan>([\s\S]*?)<\/plan>/)[1]).tasks.map((t) => ({ depends: [], details: "", ...t }));
  const files = Object.fromEntries([...parseFiles(DEMO_SCRIPT["implement:T1"]), ...parseFiles(DEMO_SCRIPT["implement:T2"])].map((f) => [f.path, f.content]));
  const llm = new FlakyLLM({});
  const { events } = await run(llm, { task: DEMO_TASK, files, resume: { spec: "spec", design: "design", tasks, done: ["T1", "T2"] } });
  assert.ok(!llm.calls.includes("analyze") && !llm.calls.includes("plan"));
  assert.ok(!llm.calls.includes("implement:T1") && !llm.calls.includes("implement:T2"));
  assert.ok(llm.calls.includes("implement:T3"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("parseFiles drops an unfinished last file only when the answer was cut off", () => {
  const text = '<file path="a.js">1</file><file path="b.js">half';
  assert.deepEqual(parseFiles(text).map((f) => f.path), ["a.js", "b.js"]);
  assert.deepEqual(parseFiles(text, { dropUnclosed: true }).map((f) => f.path), ["a.js"]);
});

test("transient errors are recognised", () => {
  assert.equal(isTransient({ status: 529 }), true);
  assert.equal(isTransient({ message: "fetch failed" }), true);
  assert.equal(isTransient({ status: 400, message: "bad request" }), false);
});
