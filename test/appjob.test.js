import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../src/orchestrator.js";
import { KIT_FILES } from "../src/kit.js";
import { APP_SCRIPT, APP_TASK } from "./fixtures/app-script.js";

class AppTeam {
  constructor() { this.model = "scripted-app"; }
  async call({ step }) {
    const text = APP_SCRIPT[step] ?? APP_SCRIPT[step.split(":").slice(0, 2).join(":")] ?? APP_SCRIPT[step.split(":")[0]];
    if (!text) throw new Error(`no script for ${step}`);
    return { text, usage: { input: 10, output: 10 } };
  }
}

test("a whole 'app' job: kit added, server run live, pages crawled, API tests pass", { timeout: 180_000 }, async () => {
  const events = [];
  const { success, files } = await runJob({
    input: { task: APP_TASK, files: {} },
    llm: new AppTeam(),
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
  });
  const run = events.filter((e) => e.type === "test").at(-1);
  const failed = run.results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
  assert.equal(success, true);

  // The starter kit was added and an agent could not overwrite it.
  for (const p of Object.keys(KIT_FILES)) assert.ok(files[p] != null, `kit file ${p}`);
  assert.equal(files["server/lib/http.js"], KIT_FILES["server/lib/http.js"]);
  assert.ok(events.some((e) => e.type === "notice" && /ชุดเริ่มต้น/.test(e.message)));

  // The QA lab really ran the server, opened the pages and ran API tests against it.
  assert.ok(run.results.some((r) => r.name === "server: เปิดเซิร์ฟเวอร์ได้" && r.ok));
  assert.ok(run.results.some((r) => /^web: เปิดได้ทุกหน้า \(3 หน้า/.test(r.name)));
  const passedTests = (re) => run.results.filter((r) => r.kind === "test" && re.test(r.name) && r.ok).length;
  assert.equal(passedTests(/notes\.test/), 4, "notes API tests against the live server");
  assert.equal(passedTests(/auth\.test/), 4, "login tests against the live server");
});
