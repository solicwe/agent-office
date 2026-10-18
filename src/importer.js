// Logs from friends who use a plain chat (Gemini, ChatGPT, claude.ai) with
// share/TEAM_PROMPT.md. The prompt makes the AI end every answer with a ```team-log
// block; the friend pastes the conversation here and each block becomes one round.
// These rounds are self-reported by the chat AI, so they are marked "imported" and
// never mixed up with rounds captured live from Claude Code hooks.
import { createHash, randomBytes } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s ?? "")).digest("hex");
const MAX_RAW = 2_000_000;
export const EXAMPLE_REQUEST = "the user's request in one sentence";

/** Every ```team-log {json} ``` block in the text (tolerates chat apps that drop the fence language). */
export function findLogBlocks(text) {
  const blocks = [];
  // Walk the lines like a Markdown reader: a ``` line opens a block (with an optional
  // language) and the next bare ``` line closes it, so other code blocks never get mixed in.
  let open = null;
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*```+\s*([\w-]*)\s*$/);
    if (!open) {
      if (m) open = { lang: m[1].toLowerCase(), body: [] };
      continue;
    }
    if (m && !m[1]) {
      let data = null;
      try { data = JSON.parse(open.body.join("\n").trim()); } catch { /* not JSON */ }
      const looksLikeLog = data && typeof data === "object" && "roles" in data && ("request" in data || "final" in data);
      if (data && (open.lang === "team-log" || ((open.lang === "json" || !open.lang) && looksLikeLog))) blocks.push(data);
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

/** Turn one block into a clean round; anything odd is dropped rather than trusted. */
function cleanRound(b) {
  const str = (v, n = 20_000) => String(v ?? "").slice(0, n);
  const roles = (Array.isArray(b.roles) ? b.roles : []).slice(0, 20).map((r) => ({
    id: str(r?.id, 64).toLowerCase().replace(/[^a-z0-9-]/g, "") || "unknown",
    why: str(r?.why, 2000),
    task: str(r?.task || r?.subtask, 2000),
    summary: str(r?.summary || r?.output, 20_000),
  }));
  return { request: str(b.request), roles, order: b.order === "parallel" ? "parallel" : "sequential", final: str(b.final) };
}

/**
 * Write the pasted conversation into a new audit session.
 * @returns {{ session_id: string, rounds: number }}
 */
export function importChat(audit, pool, { text, source = "chat", friend = "" }) {
  const raw = String(text || "");
  if (!raw.trim()) throw Object.assign(new Error("ไม่มีข้อความให้นำเข้า"), { status: 400 });
  if (raw.length > MAX_RAW) throw Object.assign(new Error("ข้อความยาวเกินไป (เกิน 2 ล้านตัวอักษร)"), { status: 413 });
  const rounds = findLogBlocks(raw)
    .filter((b) => b.request !== EXAMPLE_REQUEST) // the example inside TEAM_PROMPT.md itself, when the prompt is pasted too
    .map(cleanRound)
    .filter((r) => r.roles.length || r.final);
  if (!rounds.length) {
    throw Object.assign(new Error("ไม่พบบล็อก team-log ในข้อความ ตรวจว่าใช้ TEAM_PROMPT.md ฉบับใหม่ และคัดลอกคำตอบของ AI มาครบ (รวมบล็อกโค้ดท้ายคำตอบ)"), { status: 422 });
  }
  const sid = `import-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;
  const src = String(source).slice(0, 40) || "chat";
  const who = String(friend).slice(0, 60);
  const log = (type, data) => audit.append(sid, type, { imported: true, source: src, ...data });
  log("session_start", { friend: who, raw_sha256: sha(raw), raw_chars: raw.length, model: `${src} (รายงานเอง)` });
  log("import_raw", { text: raw.slice(0, 200_000), truncated: raw.length > 200_000 });
  for (const r of rounds) {
    log("user_prompt", { prompt: r.request || "(AI ไม่ได้ใส่คำขอในบล็อก)", prompt_sha256: sha(r.request), automatic: false });
    for (const role of r.roles) {
      const def = pool().agents.find((a) => a.id === role.id);
      log("agent_assigned", {
        agent: role.id,
        md_file: def ? `.claude/agents/${def.file}` : null,
        md_sha256: def?.sha256 || null, // the local version of that role, for reference
        built_in: !def,
        subtask: role.task || role.why,
        input: role.task,
        execution: r.order,
        reasoning: role.why,
      });
      log("agent_result", { agent: role.id, output: role.summary, output_sha256: sha(role.summary), duration_ms: null });
    }
    log("final_response", { text: r.final, text_sha256: sha(r.final), agents_used: r.roles.map((x) => x.id), agent_count: r.roles.length, duration_ms: null });
  }
  return { session_id: sid, rounds: rounds.length };
}
