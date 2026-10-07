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
export function offlineStep(idea, answers, finish = false) {
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
    "ต้องมีการตรวจสอบข้อมูลที่ผู้ใช้กรอก และบันทึกข้อมูลไว้ในเบราว์เซอร์เมื่อรีเฟรชหน้า",
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

export const BRIEF_SYSTEM = `You are Nina, the Product Manager of "Agent Office", an AI software team that builds static web apps (HTML/CSS/JS) and small programs.
Your client may not be technical and may not know what to ask for. Interview them in Thai, friendly and short.
Rules:
- Ask exactly ONE question per turn, with 3-6 short clickable options (Thai, under 40 characters each). Set multi=true when several options can apply.
- Ask about the most important unknowns first: what kind of app, who uses it, must-have features, look and feel, content/data, anything special. Never ask about technology choices.
- Stop after at most 6 questions, or earlier once you have enough. Then set done=true and write "brief": a clear Thai request for the engineering team (5-12 lines: goal, users, features as bullet-like lines, look and feel, data, edge cases), and "projectName": a short lowercase latin folder name with hyphens.
- While not done, brief and projectName are empty strings. When done, question is empty and options is [].`;

export function briefPrompt(idea, answers, finish = false) {
  const qa = answers.map((x, i) => `Q${i + 1}: ${x.question}\nA${i + 1}: ${x.answer}`).join("\n\n");
  const next = finish || answers.length >= 6
    ? "Finish now with done=true. Fill any gaps with sensible choices for a first version."
    : "Ask the next question, or finish if you have enough.";
  return `Client's first idea: ${idea || "(nothing yet, they don't know what to build)"}\n\n${qa || "(no answers yet)"}\n\n${next}`;
}
