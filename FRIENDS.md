# เริ่มใช้ Agent Office กับ AI ของคุณ

คู่มือฉบับเต็มสำหรับผู้ที่ clone จาก Git อยู่ที่ **[docs/USAGE.md](docs/USAGE.md)** ครอบคลุม Mac, Windows และ Linux การเชื่อม Codex/Claude Code การนำเข้า log จากแชทเว็บ การส่งออกรายงาน และการแก้ปัญหา

เริ่มต้นโดยติดตั้ง Git, Node.js 20+ และโปรแกรม AI ที่ลงชื่อเข้าใช้บัญชีของคุณเอง จากนั้นรัน:

```bash
git clone https://github.com/solicwe/agent-office.git
cd agent-office
npm install
npm run setup
npm start
```

เลือก AI และโฟลเดอร์งานของเครื่องคุณในขั้นตอน setup แล้วเปิด **http://localhost:3000** ก่อนสั่งงานรอบใหม่ใน AI

ไม่ต้องใช้ ZIP หรือบัญชีของผู้ส่ง ค่าเริ่มต้นเก็บ log ในเครื่องและไม่ push hash ขึ้น GitHub
