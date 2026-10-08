// Brief assistant: Nina (PM) interviews a user who doesn't know what to ask for,
// one question at a time with clickable options, then writes the brief.

const KINDS = {
  shop: "เว็บไซต์ร้านค้าออนไลน์",
  booking: "เว็บจองคิว / จองห้อง",
  dashboard: "ระบบหลังบ้าน / แดชบอร์ด",
  landing: "เว็บแนะนำธุรกิจ / พอร์ตโฟลิโอ",
  game: "เกมเล็กๆ บนเว็บ",
  tool: "เครื่องมือคำนวณ / ฟังก์ชัน",
};

const FEATURES = {
  shop: ["หน้ารวมสินค้าแยกหมวด", "ค้นหาและกรองสินค้า", "ตะกร้าสินค้า", "โค้ดส่วนลด", "หน้าชำระเงิน", "ประวัติคำสั่งซื้อ", "รีวิวสินค้า"],
  booking: ["ปฏิทินเลือกวัน", "เลือกช่วงเวลา", "ห้ามจองซ้อน", "ยกเลิกการจอง", "สรุปการจองรายสัปดาห์", "แจ้งเตือนบนหน้าเว็บ"],
  dashboard: ["ตารางข้อมูลค้นหาได้", "เพิ่ม/แก้/ลบข้อมูล", "กราฟสรุป", "ส่งออก CSV", "ตัวกรองตามวันที่", "สิทธิ์ผู้ใช้หลายระดับ"],
  landing: ["หน้าแรกพร้อมจุดเด่น", "ผลงาน/บริการ", "ราคา", "รีวิวลูกค้า", "ฟอร์มติดต่อ", "คำถามที่พบบ่อย"],
  game: ["ระบบคะแนน", "ระดับความยาก", "ตารางคะแนนสูงสุด", "เล่นบนมือถือได้", "เสียงประกอบ", "หยุดชั่วคราว"],
  tool: ["รับข้อมูลจากฟอร์ม", "ตรวจสอบข้อมูลผิดพลาด", "แสดงผลเป็นตาราง", "บันทึกประวัติการคำนวณ", "คัดลอกผลลัพธ์"],
};

const OFFLINE = [
  { key: "kind", question: "อยากได้โปรแกรมแบบไหนคะ", options: Object.values(KINDS), multi: false },
  { key: "users", question: "ใครเป็นคนใช้งานหลัก", options: ["ลูกค้าทั่วไป", "พนักงานในองค์กร", "นักเรียน / นักศึกษา", "ตัวฉันเอง"], multi: true },
  { key: "features", question: "ต้องมีฟีเจอร์อะไรบ้าง (เลือกได้หลายข้อ)", options: null, multi: true },
  { key: "style", question: "อยากได้หน้าตาสไตล์ไหน", options: ["เรียบหรู โทนขาวดำ", "สดใส เป็นกันเอง", "มืออาชีพแบบองค์กร", "มินิมอล อ่านง่ายบนมือถือ"], multi: false },
  { key: "lang", question: "ข้อความบนหน้าเว็บใช้ภาษาอะไร", options: ["ภาษาไทย", "ภาษาอังกฤษ", "ไทยและอังกฤษ"], multi: false },
  { key: "extra", question: "มีรายละเอียดอื่นที่อยากบอกไหม เช่น ชื่อร้าน สินค้า สีแบรนด์ (พิมพ์ได้เลย หรือกดข้าม)", options: [], multi: false },
];

function kindKey(answer) {
  return Object.keys(KINDS).find((k) => String(answer || "").includes(KINDS[k])) || "shop";
}

/** Offline interview: fixed questions, brief composed locally. */
// Follow-up questions when a project is already open: what to change, not what to build.
const FOLLOWUP = [
  { key: "what", question: "อยากให้ทีมทำอะไรกับโปรเจกต์นี้ต่อคะ", options: ["เพิ่มฟีเจอร์ใหม่", "เพิ่มระบบสมาชิก / login จริง", "แก้บั๊กหรือส่วนที่ใช้งานไม่ได้", "ปรับหน้าตาให้สวยและใช้ง่ายขึ้น", "เพิ่มหน้าใหม่", "ทำให้ใช้งานบนมือถือดีขึ้น"], multi: true },
  { key: "detail", question: "เล่ารายละเอียดเพิ่มหน่อยค่ะ เช่น หน้าไหน ปุ่มไหน อยากให้ทำงานแบบไหน (พิมพ์ได้เลย)", options: [], multi: false },
  { key: "who", question: "ส่วนนี้ใครเป็นคนใช้", options: ["ลูกค้าทั่วไป", "สมาชิกที่ login แล้ว", "แอดมิน / เจ้าของร้าน", "ทุกคน"], multi: true },
];

function followupStep(project, answers, finish) {
  const i = answers.length;
  if (i < FOLLOWUP.length && !finish) {
    const q = FOLLOWUP[i];
    return { done: false, question: q.question, options: q.options, multi: q.multi, brief: "", projectName: "" };
  }
  const a = Object.fromEntries(FOLLOWUP.map((q, idx) => [q.key, answers[idx]?.answer || ""]));
  const lines = [
    `แก้ไขและต่อยอดโปรเจกต์ "${project.name}" จากไฟล์ล่าสุด (ไม่ต้องเริ่มใหม่)`,
    a.what && `สิ่งที่ต้องทำ: ${a.what}`,
    a.detail && a.detail !== "ข้าม" && `รายละเอียด: ${a.detail}`,
    a.who && `ผู้ใช้ส่วนนี้: ${a.who}`,
    "ทุกหน้าและทุกปุ่มต้องกดใช้งานได้จริง ข้อมูลต้องบันทึกไว้และไม่หายเมื่อเปลี่ยนหน้า",
  ].filter(Boolean);
  return { done: true, question: "", options: [], multi: false, brief: lines.join("\n"), projectName: project.slug };
}

export function offlineStep(idea, answers, finish = false, project = null) {
  if (project) return followupStep(project, answers, finish);
  const i = answers.length;
  if (i < OFFLINE.length && !finish) {
    const q = OFFLINE[i];
    const kind = kindKey(answers[0]?.answer);
    return { done: false, question: q.question, options: q.options ?? FEATURES[kind], multi: q.multi, brief: "", projectName: "" };
  }
  const a = Object.fromEntries(OFFLINE.map((q, idx) => [q.key, answers[idx]?.answer || ""]));
  const kind = kindKey(a.kind);
  const lines = [
    `สร้าง${KINDS[kind]}${idea ? ` สำหรับ: ${idea}` : ""}`,
    a.users && `ผู้ใช้หลัก: ${a.users}`,
    a.features && `ฟีเจอร์ที่ต้องมี: ${a.features}`,
    a.style && `สไตล์หน้าตา: ${a.style} รองรับมือถือ`,
    a.lang && `ภาษาบนหน้าเว็บ: ${a.lang}`,
    a.extra && a.extra !== "ข้าม" && `รายละเอียดเพิ่มเติม: ${a.extra}`,
    "ต้องมีการตรวจสอบข้อมูลที่ผู้ใช้กรอก ทุกหน้าและทุกปุ่มต้องใช้งานได้จริง และข้อมูลต้องบันทึกไว้ไม่หายเมื่อเปลี่ยนหน้า",
  ].filter(Boolean);
  return { done: true, question: "", options: [], multi: false, brief: lines.join("\n"), projectName: { shop: "online-shop", booking: "booking", dashboard: "dashboard", landing: "landing-page", game: "web-game", tool: "calculator" }[kind] };
}

export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    multi: { type: "boolean" },
    brief: { type: "string" },
    projectName: { type: "string" },
  },
  required: ["done", "question", "options", "multi", "brief", "projectName"],
  additionalProperties: false,
};

export const BRIEF_SYSTEM = `You are Nina, the Product Manager of "Agent Office", an AI software team that builds real web apps (Node server, database, real login) and small programs.
Your client may not be technical and may not know what to ask for. Interview them in Thai, friendly and short.
Rules:
- Ask exactly ONE question per turn, with 3-6 short clickable options (Thai, under 40 characters each). Set multi=true when several options can apply.
- Ask about the most important unknowns first: what kind of app, who uses it, must-have features, look and feel, content/data, anything special. Never ask about technology choices.
- Stop after at most 6 questions, or earlier once you have enough. Then set done=true and write "brief": a clear Thai request for the engineering team (5-12 lines: goal, users, features as bullet-like lines, look and feel, data, edge cases), and "projectName": a short lowercase latin folder name with hyphens.
- While not done, brief and projectName are empty strings. When done, question is empty and options is [].
- If an EXISTING PROJECT is given, the client wants to change or extend it. Never ask what kind of app it is; build on what it already has. Ask what to add, change or fix, where, and for whom. The brief must be a change request for that project, naming the pages and features involved, and projectName is the existing project's folder name.`;

export function briefPrompt(idea, answers, finish = false, project = null) {
  const qa = answers.map((x, i) => `Q${i + 1}: ${x.question}\nA${i + 1}: ${x.answer}`).join("\n\n");
  const next = finish || answers.length >= 6
    ? "Finish now with done=true. Fill any gaps with sensible choices for a first version."
    : "Ask the next question, or finish if you have enough.";
  const ctx = project
    ? `EXISTING PROJECT "${project.name}" (folder ${project.slug}).\nWhat it is so far:\n${project.summary || project.spec || "(no summary)"}\n\nFiles:\n${project.tree || "(none)"}\n\n`
    : "";
  const first = idea || (project ? "(nothing yet, they don't know what to ask for)" : "(nothing yet, they don't know what to build)");
  return `${ctx}Client's first message: ${first}\n\n${qa || "(no answers yet)"}\n\n${next}`;
}
