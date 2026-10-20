# Agent Office

หน้าต่างดู **Codex และ Claude Code** ทำงานบนเครื่องคุณ พร้อมบันทึก audit log แบบ hash chain ส่วน ChatGPT / Gemini บนเว็บใช้วิธีนำเข้า `team-log` ภายหลัง

แต่ละคนใช้บัญชี AI ของตัวเอง Agent Office ไม่เรียกโมเดลเพิ่ม และเก็บ log ในเครื่องโดยไม่ push hash ขึ้น GitHub เป็นค่าเริ่มต้น

## เริ่มใช้งานจาก Git

ติดตั้ง Git, Node.js 20+ และโปรแกรม AI ที่คุณลงชื่อเข้าใช้ไว้แล้ว จากนั้น:

```bash
git clone https://github.com/solicwe/agent-office.git
cd agent-office
npm install
npm run setup
npm start
```

เลือก AI และโฟลเดอร์งานใน setup เปิด **http://localhost:3000** แล้วสั่งงานรอบใหม่ใน AI ภายในโฟลเดอร์ที่เลือก

ครั้งต่อไปเปิดด้วย `npm start` หรือใช้ `start.command` (Mac), `start.bat` (Windows), `bash start.sh` (Linux) ตัวเปิดโปรแกรมจะถาม setup เฉพาะครั้งที่ยังไม่มีค่าเครื่องนี้

**[อ่านคู่มือการใช้งานฉบับเต็ม → docs/USAGE.md](docs/USAGE.md)**

- การติดตั้ง ตั้งค่า และเชื่อม AI ของแต่ละคน
- ดูเหตุการณ์สด นำเข้า log และส่งออกรายงาน
- เปลี่ยนโปรเจกต์ อัปเดตจาก Git และแก้ปัญหาเบื้องต้น
- ค่าเฉพาะเครื่อง ขอบเขตการอ่านข้อมูล และข้อจำกัดของ Codex

คู่มือสร้าง role และรายละเอียด audit: [TEAM_GUIDE.md](TEAM_GUIDE.md)

## โครงสร้าง

```
.claude/agents/*.md     role ของทีม (Claude Code ใช้เป็น subagent, Agent Office ใช้วาดตัวละคร)
.claude/settings.json   hooks ที่ส่ง event ของ Claude Code มาที่ Agent Office
docs/agent-template.md  แม่แบบ role ใหม่
server.js               รับ hooks, ส่ง event ให้หน้าเว็บ (SSE), API ของ audit log
src/agents.js           อ่านและตรวจไฟล์ .md
src/codex.js            อ่าน session Codex ที่ตรงกับโฟลเดอร์งาน
src/config.js           อ่าน office.local.json ของเครื่องนี้
scripts/setup.js        เลือก AI และโฟลเดอร์งาน
docs/USAGE.md           คู่มือใช้งานจาก Git
src/flow.js             แปลง hook → audit entry + event ของตัวละคร
src/transcript.js       อ่านโทเค็นจริงและเหตุผลของ Claude จาก transcript
src/audit.js            hash chain + ตรวจสอบ
src/anchor.js           commit hash ลง branch audit-log (git plumbing ไม่แตะไฟล์ที่ทำอยู่)
src/report.js           export .json / .md
public/                 หน้าต่าง: ออฟฟิศ ตัวละคร แท็บ สด / Audit log / Roles
scripts/verify.js       ตรวจ log เอง: npm run verify -- <file>
scripts/attach.js       ใช้ทีมกับ repo อื่น: npm run attach -- <repo> / npm run detach -- <repo>
scripts/export-team.js  สร้าง share/ (role สำหรับเพื่อนที่ไม่ได้เปิด Agent Office): npm run export-team
src/importer.js         นำเข้า log จากแชททั่วไป (Gemini, ChatGPT) ที่ใช้ share/TEAM_PROMPT.md
share/                  ไฟล์ role พร้อมใช้กับ Claude Code, แชททั่วไป, Codex/Cursor
test/                   npm test
```

## Event ของตัวละคร

| Hook ของ Claude Code | Event | ตัวละครทำอะไร |
|---|---|---|
| UserPromptSubmit | ORCHESTRATOR_THINKING | Claude เดินไปที่กระดาน มีฟองความคิด |
| PreToolUse (Agent) | AGENT_ASSIGNED | Claude เดินไปโต๊ะของ role นั้นแล้วบอกงาน |
| PreToolUse (เครื่องมืออื่น) | AGENT_WORKING | คนที่ทำอยู่พิมพ์ พร้อมป้ายว่ากำลังทำอะไร เช่น "แก้ cart.html" |
| PostToolUse (Agent) | AGENT_HANDOFF | role นั้นเดินเอางานไปส่ง Claude |
| SubagentStop | AGENT_DONE | กลับไปว่าง |
| Stop | TASK_COMPLETE | ทุกคนกระโดด มีพลุ และยึด hash เมื่อเปิดใช้งาน |

subagent ในตัวของ Claude Code (Explore, Plan, general-purpose) นั่งที่โต๊ะ Helper

เวอร์ชันเดิม (ระบบสร้างเว็บที่เรียก AI เอง) อยู่ที่ branch `v1-web-builder`

## ดู Codex ทำงานสด (บนเครื่องเดียวกัน)

เปิด Agent Office ด้วย `npm start` หรือ `start.command` ตามเดิม แล้วสั่งงานใน Codex Desktop/CLI ในโฟลเดอร์งานที่เลือกใน setup ไม่ต้องคัดลอก `team-log` หรือเพิ่ม hooks ของ Claude ให้ Codex ตัวเชื่อมอ่านไฟล์ session ที่ Codex เขียนใน `~/.codex/sessions` ทุก 1 วินาที และแสดง Codex ทำงานที่โต๊ะผู้ช่วยหลัก เมื่อมีการใช้เครื่องมือ รันคำสั่ง แก้ไฟล์ และจบงาน จะมีเหตุการณ์และ audit log แหล่งที่มา `codex` แยกจาก log แชทที่ AI รายงานเอง

- อ่านเฉพาะ session ที่ `cwd` ตรงกับโฟลเดอร์งานที่เลือกใน setup เปิด Office ก่อนส่งคำสั่งรอบใหม่เพื่อเก็บครบ
- ตอนเปิดครั้งแรกข้ามประวัติเก่า เก็บตำแหน่งอ่านใน `logs/.codex-cursors.json` เพื่ออ่านต่อหลัง restart ได้
- แสดง subagent ที่ Codex เรียกจริงจาก metadata `thread_spawn` พร้อมงาน เครื่องมือ และส่งงานกลับใน session ของผู้สั่งหลัก ชื่อ task `pm`, `architect`, `backend`, `frontend`, `qa`, `debugger`, `reviewer` ตรงกับโต๊ะทีม ชื่ออื่นใช้ Helper โดยไม่เดาบทบาทจากคำสั่ง ไม่แสดง worker ตรวจ permission ภายใน
- Codex log เก็บในเครื่องเป็นค่าเริ่มต้น หากต้องการยึด hash ตาม `AUDIT_ANCHOR` ให้ตั้ง `CODEX_ANCHOR=on` (โหมด github จะ push hash ไป origin) ไม่รายงาน token ถ้าไม่มีการคำนวณจากข้อมูลจริง
- รูปแบบ rollout เป็นข้อมูลภายในของ Codex ที่อาจเปลี่ยนได้ รองรับรูปแบบที่ตรวจพบในเครื่องนี้ ไม่ใช่การสมัครรับเหตุการณ์ผ่าน API ทางการ และเหตุการณ์จะปรากฏหลัง Codex เขียนไฟล์แล้ว

ดูสถานะตัวเชื่อม: `http://localhost:3000/api/codex` (`files` คือจำนวนไฟล์ session ที่ตรงกับ workspace, `error` คือปัญหาการอ่าน)

ตัวแปรเพิ่มเติม:

```bash
# ดู Codex ของโปรเจกต์อื่น โดยเก็บ log ไว้ใน Agent Office ตามเดิม
CODEX_WORKSPACE=/absolute/path/to/project npm start

# ปิดตัวเชื่อม Codex
CODEX_WATCH=off npm start

# กำหนดโฟลเดอร์ session เอง
CODEX_SESSIONS_DIR=/absolute/path/to/sessions npm start
```

ไฟล์ Codex ต้นฉบับไม่ถูกแก้ไข ไม่ต้องใช้ API key เพิ่ม และไม่ส่งข้อความหรือผลเครื่องมือไปบริการภายนอกโดยตัวเชื่อมนี้
