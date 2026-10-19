// Exports of one session: the raw chain as JSON (re-verifiable by anyone) and a
// readable Markdown report grouped by round: prompt -> reasoning -> agents -> answer.
import { verify } from "./audit.js";

export function rounds(entries) {
  const out = [];
  let cur = null;
  for (const e of entries) {
    if (e.type === "user_prompt") {
      // Entries logged before the "automatic" field existed are recognised by their text (display only; the entry is untouched).
      const automatic = e.automatic ?? /^\s*<(task-notification|system-reminder)\b/.test(String(e.prompt || ""));
      cur = { prompt: { ...e, automatic }, steps: [], tools: 0, final: null, anchors: [] };
      out.push(cur);
      continue;
    }
    // Steps whose command arrived while the window was closed still belong to a round.
    if (!cur) {
      if (["session_start", "session_end", "anchored", "import_raw"].includes(e.type)) continue;
      cur = { prompt: { ts: e.ts, prompt: null, missed: true }, steps: [], tools: 0, final: null, anchors: [] };
      out.push(cur);
    }
    if (e.type === "agent_assigned") cur.steps.push({ assigned: e, result: null, finished: null });
    else if (e.type === "agent_result") { const s = [...cur.steps].reverse().find((x) => x.assigned.agent === e.agent && !x.result) || cur.steps.at(-1); if (s) s.result = e; }
    else if (e.type === "agent_finished") { const s = [...cur.steps].reverse().find((x) => x.assigned.agent === e.agent && !x.finished); if (s) s.finished = e; }
    else if (e.type === "tool_call") cur.tools++;
    else if (e.type === "final_response") cur.final = e;
    else if (e.type === "anchored") cur.anchors.push(e);
  }
  return out;
}

export function exportJson(sessionId, entries) {
  return {
    format: "agent-office-audit/1",
    session_id: sessionId,
    exported_at: new Date().toISOString(),
    verification: verify(entries),
    how_to_verify: "hash = sha256(canonical JSON of the entry without 'hash', keys sorted); prev = previous entry's hash; the first prev is 64 zeros. Anchored heads are in branch audit-log, file anchors.jsonl.",
    entries,
  };
}

export const MISSED = "(ไม่ได้บันทึกคำสั่ง: Agent Office ยังไม่เปิดตอนที่ส่งคำสั่งนี้ ขั้นตอนหลังจากนั้นบันทึกครบ)";
const fence = (t) => "```\n" + String(t ?? "").replace(/```/g, "ˋˋˋ") + "\n```";
const tok = (t) => (t ? `${t.total ?? (t.input || 0) + (t.output || 0)} (input ${t.input || 0}, output ${t.output || 0}, cache read ${t.cache_read || 0}, cache write ${t.cache_write || 0}; ${t.source === "estimate" ? "ประมาณ" : "จริงจาก transcript"})` : "-");

export function exportMarkdown(sessionId, entries) {
  const v = verify(entries);
  const start = entries.find((e) => e.type === "session_start");
  const md = [
    `# Audit report: session ${sessionId}`,
    "",
    `- ส่งออกเมื่อ: ${new Date().toISOString()}`,
    `- เริ่ม session: ${entries[0]?.ts || "-"}${start?.model ? ` · model ${start.model}` : ""}`,
    `- จำนวน entry: ${entries.length}`,
    ...(start?.source === "codex" ? ["- **ที่มา: Codex local rollout** อ่านเหตุการณ์จากไฟล์ session ในเครื่อง ไม่ใช่ log ที่ AI เขียนรายงานเอง อาจเริ่มจับกลางรอบและยังไม่มีข้อมูลความสัมพันธ์ subagent หรือโทเค็น"] : []),
    ...(start?.imported ? [`- **ที่มา: นำเข้าจากแชท ${start.source}${start.friend ? ` ของ ${start.friend}` : ""}** ข้อมูลในรอบเหล่านี้ AI ในแชทรายงานเอง (ไม่ได้จับจาก hook ของ Claude Code) hash chain พิสูจน์ได้ว่าไม่ถูกแก้หลังนำเข้า และต้นฉบับข้อความทั้งหมดมี sha256 \`${start.raw_sha256}\``] : []),
    `- ตรวจ hash chain: ${v.ok ? `**ผ่าน** (head \`${v.head}\`)` : `**ไม่ผ่าน** ที่ entry ${v.at}: ${v.reason}`}`,
    "",
  ];
  rounds(entries).forEach((r, i) => {
    md.push(`## รอบที่ ${i + 1} · ${r.prompt.ts}`, "", "### 1. คำสั่งของผู้ใช้", r.prompt.missed ? MISSED : r.prompt.automatic ? "(ข้อความอัตโนมัติจาก Claude Code เช่นงานเบื้องหลังเสร็จ ไม่ใช่คำสั่งของผู้ใช้)\n" + fence(r.prompt.prompt) : fence(r.prompt.prompt), "");
    md.push("### 2. Orchestrator ตัดสินใจ", "");
    if (!r.steps.length) md.push("ไม่ได้เรียก agent ย่อย (ผู้ช่วยหลักตอบเองทั้งหมด)", "");
    else {
      md.push(`เลือก ${r.steps.length} งาน: ${r.steps.map((s) => s.assigned.agent).join(", ")}`, "");
      md.push("| # | Agent | ไฟล์ .md (sha256) | งาน | แบบ | เวลา | tokens |", "|---|---|---|---|---|---|---|");
      r.steps.forEach((s, j) => {
        const a = s.assigned;
        md.push(`| ${j + 1} | ${a.agent} | ${a.md_file ? `${a.md_file} (\`${a.md_sha256.slice(0, 12)}…\`)` : "built-in"} | ${String(a.subtask).replace(/\|/g, "/")} | ${a.execution} | ${s.result?.duration_ms != null ? (s.result.duration_ms / 1000).toFixed(1) + " วิ" : "-"} | ${s.finished ? tok(s.finished.tokens) : "-"} |`);
      });
      md.push("");
    }
    md.push("### 3. แต่ละ agent ทำงาน", "");
    r.steps.forEach((s, j) => {
      md.push(`#### ${j + 1}. ${s.assigned.agent}`, "");
      if (s.assigned.reasoning) md.push("เหตุผลที่ Orchestrator เลือก:", fence(s.assigned.reasoning), "");
      md.push("Input ที่ได้รับ:", fence(s.assigned.input), "", "Output:", fence(s.result?.output ?? "(ยังไม่จบ)"), "");
    });
    md.push(`เครื่องมือที่ใช้ทั้งหมดในรอบนี้: ${r.tools} ครั้ง`, "");
    md.push("### 4. คำตอบสุดท้าย", fence(r.final?.text ?? "(รอบนี้ยังไม่จบ)"), "");
    if (r.final) md.push(`- tokens ทั้งรอบ: ${tok(r.final.tokens_round_total)}`, `- เวลา: ${(r.final.duration_ms / 1000).toFixed(1)} วินาที`, "");
    for (const a of r.anchors) md.push(`- ยึด hash ลง git: commit \`${a.commit || "-"}\` branch \`${a.branch || "-"}\` ${a.pushed ? "(ขึ้น GitHub แล้ว)" : `(ยังไม่ขึ้น GitHub${a.error ? `: ${a.error}` : ""})`}`);
    md.push("");
  });
  md.push("---", "ตรวจเองได้: แต่ละ entry มี `hash = sha256(JSON ของ entry ที่เรียง key แล้ว ไม่รวม hash)` และ `prev` = hash ของ entry ก่อนหน้า (entry แรก prev = 0 x64) ไฟล์ .json ที่ส่งออกพร้อมกันมีข้อมูลดิบครบ", "");
  return md.join("\n");
}
