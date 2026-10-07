// The office manager: drives the team through
// analyze -> plan -> build (parallel tasks) -> tests -> run -> (debug -> fix -> run)* -> review -> sign-off,
// emitting events the browser turns into walking, talking characters.
import { AGENTS, PROMPTS, systemPrompt } from "./agents.js";
import { runProject, formatReport, isTestFile } from "./runner.js";
import { parseFiles } from "./workspace.js";

const ENGINEERS = ["frontend", "backend"];

export async function runJob({ input, llm, emit, signal, settings = {} }) {
  const maxFix = clamp(settings.maxFixRounds ?? 4, 1, 10);
  const maxReview = clamp(settings.maxReviewRounds ?? 1, 0, 3);
  const files = { ...(input.files || {}) };
  const ctx = { task: input.task, files, spec: "", design: "", planText: "", report: "", analysis: "", review: "" };
  let fixRound = 0;

  const phase = (id, state, note) => emit({ type: "phase", id, state, note });
  const move = (agent, to) => emit({ type: "move", agent, to });
  const say = (from, to, text) => text && emit({ type: "say", from, to, text });
  const doc = (name, content, by) => emit({ type: "doc", name, content, by });
  const putFiles = (list, by) => {
    for (const f of list) {
      files[f.path] = f.content;
      emit({ type: "file", path: f.path, content: f.content, by });
    }
  };

  async function ask(agent, step, extra = {}, key = step) {
    if (signal.aborted) throw new Error("Cancelled");
    emit({ type: "status", agent, state: "thinking", step: key });
    let typing = false;
    try {
      const res = await llm.call({
        step: key,
        system: systemPrompt(agent),
        prompt: PROMPTS[step]({ ...ctx, ...extra }),
        signal,
        onText: (text) => {
          if (!typing) { typing = true; emit({ type: "status", agent, state: "typing" }); }
          emit({ type: "delta", agent, text });
        },
      });
      emit({ type: "usage", agent, ...res.usage });
      return res.text;
    } finally {
      emit({ type: "status", agent, state: "idle" });
    }
  }

  async function runChecks() {
    phase("run", "active", fixRound ? `รอบที่ ${fixRound + 1}` : undefined);
    move("qa", "lab");
    emit({ type: "status", agent: "qa", state: "running" });
    const result = await runProject(files);
    ctx.report = formatReport(result);
    emit({ type: "status", agent: "qa", state: "idle" });
    emit({ type: "test", round: fixRound + 1, ok: result.ok, passed: result.passed, failed: result.failed, total: result.total, testCount: result.testCount, results: result.results });
    doc("report", ctx.report, "qa");
    phase("run", result.ok ? "done" : "failed", `ผ่าน ${result.passed}/${result.total}`);
    return result;
  }

  function filesMentioned(result) {
    const text = result.results.filter((r) => !r.ok).map((r) => `${r.name} ${r.error}`).join("\n");
    return Object.keys(files).filter((p) => text.includes(p) || isTestFile(p));
  }

  async function testUntilGreen() {
    let result = await runChecks();
    while (!result.ok && fixRound < maxFix) {
      fixRound++;
      phase("debug", "active", `รอบแก้ ${fixRound}/${maxFix}`);
      say("qa", ["debugger"], `Max ช่วยดูหน่อยค่ะ ไม่ผ่าน ${result.failed} จาก ${result.total} รายการ`);
      move("debugger", "lab");
      const focus = filesMentioned(result);
      const dbg = await ask("debugger", "debug", { focus }, `debug:${fixRound}`);
      ctx.analysis = tag(dbg, "analysis");
      doc("debug", ctx.analysis, "debugger");
      let owners = tag(dbg, "assign").toLowerCase().split(/[\s,]+/).filter((o) => ["frontend", "backend", "qa"].includes(o));
      if (!owners.length) owners = ["backend"];
      owners = [...new Set(owners)];
      move("debugger", `visit:${owners[0]}`);
      move("qa", "desk");
      say("debugger", owners, tag(dbg, "say"));

      await Promise.all(owners.map(async (owner) => {
        const fix = await ask(owner, "fix", { owner, focus }, `fix:${owner}:${fixRound}`);
        const changed = parseFiles(fix);
        putFiles(changed, owner);
        say(owner, ["debugger"], tag(fix, "say") || `แก้ ${changed.length} ไฟล์แล้ว`);
      }));
      move("debugger", "desk");
      phase("debug", "done", `แก้แล้ว ${fixRound} รอบ`);
      result = await runChecks();
    }
    return result;
  }

  // ---- Kick-off ------------------------------------------------------------
  emit({ type: "init", agents: AGENTS, task: ctx.task, maxFixRounds: maxFix, existing: Object.keys(files) });
  if (Object.keys(files).length) for (const [p, c] of Object.entries(files)) emit({ type: "file", path: p, content: c, by: "client" });
  phase("kickoff", "active");
  for (const id of Object.keys(AGENTS)) move(id, "meeting");
  say("pm", "all", `งานใหม่จากลูกค้าค่ะ: "${truncate(ctx.task, 160)}" ขอวิเคราะห์ requirement ก่อนนะคะ`);
  phase("kickoff", "done");

  // ---- 1. Requirements -----------------------------------------------------
  phase("analyze", "active");
  for (const id of Object.keys(AGENTS)) if (id !== "pm") move(id, "desk");
  move("pm", "board");
  const a = await ask("pm", "analyze");
  ctx.spec = tag(a, "spec");
  doc("spec", ctx.spec, "pm");
  move("pm", "visit:architect");
  say("pm", ["architect"], tag(a, "say"));
  move("pm", "desk");
  phase("analyze", "done");

  // ---- 2. Design + task breakdown -------------------------------------------
  phase("plan", "active");
  move("architect", "board");
  const d = await ask("architect", "plan");
  ctx.design = tag(d, "design");
  doc("design", ctx.design, "architect");
  const tasks = parsePlan(tag(d, "plan"));
  ctx.planText = JSON.stringify({ tasks }, null, 2);
  emit({ type: "tasks", tasks });
  move("architect", "meeting");
  for (const e of ENGINEERS) move(e, "meeting");
  say("architect", ENGINEERS, tag(d, "say"));
  phase("plan", "done", `${tasks.length} งานย่อย`);

  // ---- 3. Build: engineers work through tasks in parallel -------------------
  phase("build", "active");
  move("architect", "desk");
  const done = new Set();
  const ids = new Set(tasks.map((t) => t.id));
  const pending = [...tasks];
  while (pending.length) {
    let ready = pending.filter((t) => t.depends.every((dep) => done.has(dep) || !ids.has(dep)));
    if (!ready.length) ready = [pending[0]];
    const wave = [];
    const busy = new Set();
    for (const t of ready) if (!busy.has(t.owner)) { wave.push(t); busy.add(t.owner); }
    await Promise.all(wave.map(async (t) => {
      move(t.owner, "desk");
      emit({ type: "task", id: t.id, state: "active" });
      const depFiles = tasks.filter((x) => t.depends.includes(x.id)).flatMap((x) => x.files);
      const out = await ask(t.owner, "implement", { task: t, focus: [...t.files, ...depFiles] }, `implement:${t.id}`);
      const produced = parseFiles(out);
      putFiles(produced, t.owner);
      emit({ type: "task", id: t.id, state: produced.length ? "done" : "failed" });
      say(t.owner, ["architect"], tag(out, "say") || `${t.id} เสร็จแล้ว`);
      done.add(t.id);
      pending.splice(pending.indexOf(t), 1);
    }));
    phase("build", "active", `เสร็จ ${done.size}/${tasks.length} งาน`);
  }
  phase("build", "done", `${Object.keys(files).length} ไฟล์`);

  // ---- 4. Tests ------------------------------------------------------------
  phase("tests", "active");
  for (const e of ENGINEERS) move(e, "visit:qa");
  say("backend", ["qa"], "Tessa ครับ โค้ดครบทุกงานแล้ว ฝากเขียนเทสต์ต่อเลยครับ");
  for (const e of ENGINEERS) move(e, "desk");
  const t = await ask("qa", "tests");
  putFiles(parseFiles(t).filter((f) => isTestFile(f.path)), "qa");
  say("qa", "all", tag(t, "say"));
  phase("tests", "done");

  // ---- 5/6. Run + debug loop -------------------------------------------------
  let result = await testUntilGreen();

  // ---- 7. Review ------------------------------------------------------------
  let approved = false;
  if (result.ok) {
    for (let round = 0; round <= maxReview; round++) {
      phase("review", "active", round ? `รอบที่ ${round + 1}` : undefined);
      move("architect", "visit:reviewer");
      say("architect", ["reviewer"], "Rex ครับ ทุกอย่างผ่านเทสต์แล้ว ฝากรีวิวทั้งโปรเจกต์ครับ");
      move("architect", "desk");
      const r = await ask("reviewer", "review", {}, `review:${round}`);
      ctx.review = tag(r, "review");
      doc("review", ctx.review, "reviewer");
      approved = !/CHANGES/i.test(tag(r, "verdict"));
      const issues = { frontend: tag(r, "frontend"), backend: tag(r, "backend") };
      const owners = ENGINEERS.filter((o) => issues[o] && !/^(none|ไม่มี|-|empty)?$/i.test(issues[o].trim()));
      if (approved || round === maxReview || !owners.length) {
        say("reviewer", ["pm"], tag(r, "say"));
        approved = approved || !owners.length;
        phase("review", approved ? "done" : "failed", approved ? "อนุมัติ" : "ยังมีประเด็นค้าง");
        break;
      }
      move("reviewer", `visit:${owners[0]}`);
      say("reviewer", owners, tag(r, "say"));
      move("reviewer", "desk");
      phase("review", "failed", "ขอแก้ไข");
      await Promise.all(owners.map(async (owner) => {
        const v = await ask(owner, "revise", { owner, issues: issues[owner], focus: [] }, `revise:${owner}:${round}`);
        putFiles(parseFiles(v), owner);
        say(owner, ["reviewer"], tag(v, "say"));
      }));
      result = await testUntilGreen();
      if (!result.ok) break;
    }
  } else {
    phase("review", "failed", "ข้าม เพราะยังไม่ผ่าน");
  }

  // ---- 8. Sign-off -----------------------------------------------------------
  const success = result.ok && approved;
  phase("signoff", "active");
  for (const id of Object.keys(AGENTS)) move(id, "meeting");
  const f = await ask("pm", "final", { success });
  const summary = tag(f, "summary");
  doc("summary", summary, "pm");
  say("pm", "all", tag(f, "say"));
  phase("signoff", success ? "done" : "failed");
  emit({ type: "done", success, fixRounds: fixRound, fileCount: Object.keys(files).length, preview: hasPage(files) });
  for (const id of Object.keys(AGENTS)) move(id, "desk");
  return { success, files };
}

export function parsePlan(raw) {
  let tasks = [];
  try {
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    tasks = Array.isArray(json) ? json : json.tasks || [];
  } catch {
    tasks = [];
  }
  tasks = tasks.slice(0, 12).map((t, i) => ({
    id: String(t.id || `T${i + 1}`),
    title: String(t.title || `งาน ${i + 1}`),
    owner: ENGINEERS.includes(t.owner) ? t.owner : "frontend",
    files: Array.isArray(t.files) ? t.files.map(String).slice(0, 6) : [],
    depends: Array.isArray(t.depends) ? t.depends.map(String) : [],
    details: String(t.details || ""),
  }));
  if (!tasks.length) {
    tasks = [{ id: "T1", title: "สร้างโปรเจกต์ตาม design", owner: "frontend", files: [], depends: [], details: "Build the whole project as described in the design." }];
  }
  return tasks;
}

export function hasPage(files) {
  return Object.keys(files).some((p) => p.endsWith(".html"));
}

/** Pull <name>…</name> from a reply; tolerates a missing closing tag. */
export function tag(text, name) {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  if (m) return m[1].trim();
  const open = text.search(new RegExp(`<${name}>`, "i"));
  if (open === -1) return "";
  return text.slice(open + name.length + 2).split(/<\/?(?:say|spec|design|plan|assign|analysis|verdict|review|summary|frontend|backend|file)\b/i)[0].trim();
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || lo));
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
