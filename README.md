# Agent Office

หน้าต่างที่เปิดข้าง **Claude Code**: กำหนดทีม agent ด้วยไฟล์ Markdown ดูตัวการ์ตูนทำงานตามที่ Claude ทำจริงแบบสด และเก็บ audit log แบบ hash chain ที่ยึดกับ GitHub เพื่อพิสูจน์การทำงานได้

```
คุณพิมพ์ใน Claude Code
   │
   ▼
Claude Code (Orchestrator) ── อ่าน .claude/agents/*.md ── เลือก role เอง (กี่ตัว ตัวไหน ต่อกันหรือพร้อมกัน)
   │ hooks (http, ไม่ทำให้ Claude ช้าลง)
   ▼
Agent Office (localhost:3000, ในเครื่องเท่านั้น)
   ├─ ตัวการ์ตูน: คิด → เดินไปมอบงาน → พิมพ์ที่โต๊ะ → ส่งงานคืน → เสร็จ   (ในเบราว์เซอร์ 0 โทเค็น)
   └─ Audit log: logs/<session>.jsonl (hash chain) → hash ล่าสุด commit ลง branch audit-log แล้ว push
```

## เริ่มใช้

1. Node.js 20+ และ Claude Code
2. `start.bat` (Windows) / `start.command` (Mac) / `./start.sh` (Linux) → เปิด http://localhost:3000
3. เปิด Claude Code ในโฟลเดอร์นี้ แล้วสั่งงานตามปกติ

คู่มือเต็ม (สร้าง role, ส่ง log ให้อาจารย์, ตั้งค่า): [TEAM_GUIDE.md](TEAM_GUIDE.md)

## โครงสร้าง

```
.claude/agents/*.md     role ของทีม (Claude Code ใช้เป็น subagent, Agent Office ใช้วาดตัวละคร)
.claude/settings.json   hooks ที่ส่ง event ของ Claude Code มาที่ Agent Office
docs/agent-template.md  แม่แบบ role ใหม่
server.js               รับ hooks, ส่ง event ให้หน้าเว็บ (SSE), API ของ audit log
src/agents.js           อ่านและตรวจไฟล์ .md
src/flow.js             แปลง hook → audit entry + event ของตัวละคร
src/transcript.js       อ่านโทเค็นจริงและเหตุผลของ Claude จาก transcript
src/audit.js            hash chain + ตรวจสอบ
src/anchor.js           commit hash ลง branch audit-log (git plumbing ไม่แตะไฟล์ที่ทำอยู่)
src/report.js           export .json / .md
public/                 หน้าต่าง: ออฟฟิศ ตัวละคร แท็บ สด / Audit log / Roles
scripts/verify.js       ตรวจ log เอง: npm run verify -- <file>
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
| Stop | TASK_COMPLETE | ทุกคนกระโดด มีพลุ แล้วยึด hash ขึ้น GitHub |

subagent ในตัวของ Claude Code (Explore, Plan, general-purpose) นั่งที่โต๊ะ Helper

เวอร์ชันเดิม (ระบบสร้างเว็บที่เรียก AI เอง) อยู่ที่ branch `v1-web-builder`
