// Scripted team replies for a small real app: a notes site with accounts.
// Used to test the whole pipeline for "app" projects without spending tokens.
const file = (p, content) => `<file path="${p}">\n${content}</file>`;

const SERVER = `"use strict";
const path = require("node:path");
const { createApp } = require("./server/lib/http");
const auth = require("./server/lib/auth");

const app = createApp({ publicDir: path.join(__dirname, "public") });

app.post("/api/auth/register", async (req, res) => {
  const body = await req.json();
  const role = auth.users.count() === 0 ? "admin" : "user";
  auth.register({ email: body.email, password: body.password, name: body.name, role });
  res.json({ user: auth.login(res, body.email, body.password) }, 201);
});
app.post("/api/auth/login", async (req, res) => {
  const body = await req.json();
  res.json({ user: auth.login(res, body.email, body.password) });
});
app.post("/api/auth/logout", (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
app.get("/api/auth/me", (req, res) => res.json({ user: auth.currentUser(req) }));

require("./server/routes/notes")(app);

app.listen(undefined, (port) => console.log("App running on http://localhost:" + port));
`;

const NOTES = `"use strict";
const { collection } = require("../lib/db");
const { HttpError } = require("../lib/http");
const { requireUser } = require("../lib/auth");
const notes = collection("notes");

module.exports = (app) => {
  app.get("/api/notes", (req, res) => {
    const user = requireUser(req);
    res.json({ notes: notes.find((n) => n.userId === user.id) });
  });
  app.post("/api/notes", async (req, res) => {
    const user = requireUser(req);
    const { text } = await req.json();
    if (!String(text || "").trim()) throw new HttpError(400, "กรุณาพิมพ์โน้ต");
    res.json({ note: notes.insert({ userId: user.id, text: String(text).trim().slice(0, 500) }) }, 201);
  });
  app.delete("/api/notes/:id", (req, res) => {
    const user = requireUser(req);
    const note = notes.get(req.params.id);
    if (!note || note.userId !== user.id) throw new HttpError(404, "ไม่พบโน้ต");
    notes.remove(note.id);
    res.json({ ok: true });
  });
};
`;

const page = (title, body, script) => `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/css/style.css"></head>
<body><header><a href="/">โน้ตของฉัน</a> <a href="/login.html">เข้าสู่ระบบ</a> <a href="/register.html">สมัครสมาชิก</a></header>
<main>${body}</main><script src="/js/api.js"></script>${script ? `<script src="/js/${script}"></script>` : ""}</body></html>
`;

const TESTS = `function client() {
  let cookie = "";
  return async (method, url, body) => {
    const res = await fetch(BASE_URL + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

test("ยังไม่ login ดูโน้ตไม่ได้", async () => {
  assert.equal((await client()("GET", "/api/notes")).status, 401);
});

test("สมัคร แล้วเพิ่มและดูโน้ตของตัวเอง", async () => {
  const a = client();
  await a("POST", "/api/auth/register", { name: "A", email: "a@example.com", password: "secret123" });
  assert.equal((await a("POST", "/api/notes", { text: "ซื้อนม" })).status, 201);
  const list = await a("GET", "/api/notes");
  assert.deepEqual(list.data.notes.map((n) => n.text), ["ซื้อนม"]);
});

test("คนอื่นมองไม่เห็นและลบโน้ตของเราไม่ได้", async () => {
  const a = client(), b = client();
  await a("POST", "/api/auth/login", { email: "a@example.com", password: "secret123" });
  const mine = (await a("GET", "/api/notes")).data.notes[0];
  await b("POST", "/api/auth/register", { name: "B", email: "b@example.com", password: "secret123" });
  assert.deepEqual((await b("GET", "/api/notes")).data.notes, []);
  assert.equal((await b("DELETE", "/api/notes/" + mine.id)).status, 404);
});

test("โน้ตว่างไม่ได้", async () => {
  const a = client();
  await a("POST", "/api/auth/login", { email: "a@example.com", password: "secret123" });
  assert.equal((await a("POST", "/api/notes", { text: "  " })).status, 400);
});
`;

export const APP_TASK = "เว็บจดโน้ตส่วนตัว มีสมัครสมาชิกและ login จริง แต่ละคนเห็นเฉพาะโน้ตของตัวเอง";

export const APP_SCRIPT = {
  analyze: `<say>ต้องมีบัญชีจริงและแยกข้อมูลของแต่ละคนค่ะ</say>
<spec>## เป้าหมาย\nจดโน้ตส่วนตัว\n## Acceptance criteria\n1. สมัครและ login ได้จริง\n2. เห็นเฉพาะโน้ตของตัวเอง\n3. โน้ตว่างไม่ได้</spec>`,
  plan: `<say>เป็นแอปจริงครับ ใช้ชุดเริ่มต้น เพิ่ม API โน้ตกับหน้าเว็บ</say>
<design>## API\n- GET /api/notes\n- POST /api/notes { text }\n- DELETE /api/notes/:id\n## หน้า\n/, /login.html, /register.html</design>
<kind>app</kind>
<plan>{"tasks":[
{"id":"T1","title":"API โน้ต","owner":"backend","files":["server.js","server/routes/notes.js","server/lib/http.js"],"depends":[]},
{"id":"T2","title":"หน้าเว็บ","owner":"frontend","files":["public/index.html","public/login.html","public/register.html","public/css/style.css"],"depends":[]}
]}</plan>`,
  "implement:T1": `<say>API โน้ตเสร็จแล้วครับ</say>
${file("server.js", SERVER)}
${file("server/routes/notes.js", NOTES)}
${file("server/lib/http.js", "// an agent trying to replace the kit\nmodule.exports = {};\n")}`,
  "implement:T2": `<say>หน้าเว็บเสร็จแล้วค่ะ</say>
${file("public/index.html", page("โน้ตของฉัน", '<ul id="notes"></ul>'))}
${file("public/login.html", page("เข้าสู่ระบบ", "<form id=login></form>"))}
${file("public/register.html", page("สมัครสมาชิก", "<form id=register></form>"))}
${file("public/css/style.css", "body { font-family: sans-serif; }\n")}`,
  tests: `<say>เทสต์ API กับเซิร์ฟเวอร์จริงค่ะ</say>
${file("tests/notes.test.js", TESTS)}`,
  review: `<say>ผ่านครับ</say><verdict>APPROVE</verdict><review>ดี</review><frontend></frontend><backend></backend>`,
  final: `<say>ส่งมอบได้ค่ะ</say><summary>เว็บจดโน้ตพร้อม login จริง</summary>`,
};
