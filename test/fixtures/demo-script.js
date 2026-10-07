// Scripted replies for demo mode: the team builds a small online shop.
// The first cart.js has a real bug (adding an item twice replaces the quantity),
// so the real QA lab fails it and the team goes through an actual debug -> fix loop.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo-project");
const read = (p) => readFileSync(path.join(dir, p), "utf8");
const file = (p, content = read(p)) => `<file path="${p}">\n${content}</file>`;

const GOOD_LINE = "      existing.qty = Math.min(MAX_QTY, existing.qty + qty);";
const BUGGY_CART = read("js/cart.js").replace(GOOD_LINE, "      existing.qty = qty;");

export const DEMO_TASK =
  "สร้างเว็บไซต์ร้านค้าออนไลน์ (e-commerce) ขายของใช้: หน้ารวมสินค้าแยกหมวด ตะกร้าสินค้า ปรับจำนวนได้ โค้ดส่วนลด SAVE10 ลด 10% ส่งฟรีเมื่อครบ 1,000 บาท และจำตะกร้าไว้เมื่อรีเฟรชหน้า";

export const DEMO_SCRIPT = {
  analyze: `<say>ลูกค้าอยากได้ร้านค้าออนไลน์ขนาดเล็กค่ะ หัวใจคือตะกร้ากับการคิดเงิน ฉันระบุกฎส่วนลดกับค่าส่งไว้ชัดๆ แล้ว เพราะจุดนี้ผิดทีลูกค้าเสียเงินจริง</say>
<spec>## เป้าหมาย
ร้านค้าออนไลน์ขนาดเล็ก ให้ลูกค้าเลือกสินค้า ใส่ตะกร้า และสั่งซื้อได้

## User stories
- ในฐานะลูกค้า ฉันอยากดูสินค้าแยกตามหมวด เพื่อหาของได้เร็ว
- ในฐานะลูกค้า ฉันอยากเพิ่ม/ลด/ลบสินค้าในตะกร้า
- ในฐานะลูกค้า ฉันอยากใส่โค้ดส่วนลดและเห็นยอดสุทธิก่อนสั่งซื้อ
- ในฐานะลูกค้า ฉันอยากให้ตะกร้ายังอยู่เมื่อรีเฟรชหน้า

## กฎทางธุรกิจ
- โค้ด SAVE10 ลด 10% ของยอดสินค้า (ไม่สนตัวพิมพ์เล็ก/ใหญ่)
- ส่งฟรีเมื่อยอดหลังหักส่วนลดตั้งแต่ 1,000 บาท ไม่ถึงคิด 50 บาท
- จำนวนต่อสินค้า 1-99 ชิ้น

## นอกขอบเขต
ระบบชำระเงินจริง, บัญชีผู้ใช้

## Acceptance criteria
1. แสดงสินค้าทั้งหมดและกรองตามหมวดได้
2. กดใส่ตะกร้าสินค้าเดิมซ้ำ จำนวนต้องเพิ่มขึ้น ไม่สร้างรายการซ้ำ
3. ปรับจำนวนได้ จำนวน 0 คือลบออก และไม่เกิน 99
4. คำนวณยอดสินค้า ส่วนลด ค่าส่ง ยอดสุทธิถูกต้องตามกฎ
5. โค้ดผิดต้องแจ้งเตือนและไม่ได้ส่วนลด
6. ตะกร้าคงอยู่หลังรีเฟรช ข้อมูลเสียต้องไม่ทำให้หน้าพัง
7. ใช้งานบนมือถือได้</spec>`,

  plan: `<say>แบ่งเป็น 3 งานครับ Ben ทำ data กับ logic ตะกร้า Mia ทำหน้าเว็บกับสไตล์พร้อมกันได้เลย แล้วค่อยต่อ app.js เมื่อ logic เสร็จ contract อยู่ในเอกสาร design</say>
<design>## โครงสร้างไฟล์
- index.html, css/style.css
- js/products.js → window.Products
- js/cart.js → window.Cart
- js/app.js (UI, ต่อ DOM)

## Products API
- \`list(category?)\` คืนสำเนาสินค้า
- \`find(id)\` คืนสำเนาหรือ null
- \`categories()\`

## Cart API (pure functions คืน object ใหม่เสมอ)
- \`empty()\` → { items: [] }
- \`add(cart, product, qty = 1)\` สินค้าเดิมให้บวกจำนวน (สูงสุด 99), qty ไม่ถูกต้อง throw RangeError
- \`setQty(cart, id, qty)\` qty 0 = ลบ
- \`remove(cart, id)\`, \`count(cart)\`
- \`totals(cart, code)\` → { subtotal, discount, shipping, total, codeValid }
- \`save(storage, cart)\`, \`load(storage)\` key "shop.cart"

## DOM ids
filters, productGrid, cartButton, cartCount, cartPanel, cartItems, codeForm, codeInput, subtotal, discount, shipping, total, checkoutBtn

## หมายเหตุสำหรับ QA
เน้นเคสเพิ่มสินค้าซ้ำ ขอบเขต 99 ชิ้น และค่าส่งหลังหักส่วนลด</design>
<plan>{"tasks":[
{"id":"T1","title":"ข้อมูลสินค้าและ logic ตะกร้า","owner":"backend","files":["js/products.js","js/cart.js"],"depends":[],"details":"Products and Cart modules exactly as in the design."},
{"id":"T2","title":"โครงหน้าเว็บและสไตล์","owner":"frontend","files":["index.html","css/style.css"],"depends":[],"details":"Page layout with the DOM ids from the design, responsive grid, cart drawer."},
{"id":"T3","title":"ต่อ UI กับ logic","owner":"frontend","files":["js/app.js"],"depends":["T1","T2"],"details":"Render products, filters and cart; persist to localStorage."}
]}</plan>`,

  "implement:T1": `<say>เสร็จแล้วครับ products.js กับ cart.js เป็น pure function ทั้งหมด ทดสอบได้ใน Node ทันที</say>
${file("js/products.js")}
${file("js/cart.js", BUGGY_CART)}`,

  "implement:T2": `<say>โครงหน้าเว็บกับ CSS เสร็จแล้วค่ะ ใช้ id ตาม design ครบ รองรับมือถือด้วย</say>
${file("index.html")}
${file("css/style.css")}`,

  "implement:T3": `<say>ต่อ UI กับ Cart แล้วค่ะ escape ชื่อสินค้าก่อนใส่ innerHTML ด้วย กดใส่ตะกร้า ปรับจำนวน และใช้โค้ดได้ครบ</say>
${file("js/app.js")}`,

  tests: `<say>เขียนเทสต์ 19 เคสค่ะ เน้นเคสเพิ่มสินค้าซ้ำกับค่าส่งหลังหักส่วนลดตามที่ Archie เตือน ไปรันที่แล็บก่อนนะคะ</say>
${file("tests/cart.test.js")}
${file("tests/products.test.js")}`,

  debug: `<say>เจอแล้วครับ Ben ใน Cart.add ตอนเจอสินค้าเดิมเขียนทับจำนวนแทนที่จะบวกเพิ่ม เลยพัง 3 เคส แก้บรรทัดเดียวใน js/cart.js</say>
<assign>backend</assign>
<analysis>## เทสต์ที่ไม่ผ่าน
- เพิ่มสินค้าเดิมซ้ำ จำนวนต้องบวกเพิ่ม (ได้ 1 แทน 3)
- count รวมจำนวนชิ้นทั้งหมด (ได้ 2 แทน 4)
- จำนวนสูงสุดต่อสินค้าคือ 99 (ได้ 5 แทน 99)

## Root cause
\`js/cart.js\` ฟังก์ชัน \`add\`: \`existing.qty = qty\` เขียนทับค่าเดิม

## วิธีแก้ (Ben)
เปลี่ยนเป็น \`existing.qty = Math.min(MAX_QTY, existing.qty + qty)\`</analysis>`,

  "fix:backend": `<say>ขอบคุณครับ Max แก้แล้ว บวกจำนวนเพิ่มและจำกัดไม่เกิน 99 ตาม spec</say>
${file("js/cart.js")}`,

  review: `<say>รีวิวทั้งโปรเจกต์แล้วผ่านครับ logic แยกจาก UI ชัด มีการ escape HTML และเทสต์ครอบคลุมกฎเงิน Approve</say>
<verdict>APPROVE</verdict>
<review>## จุดดี
- แยก logic (cart.js) ออกจาก UI ทดสอบได้ครบ
- escape ข้อมูลก่อนใส่ innerHTML
- ตะกร้าทนต่อข้อมูลเสียใน localStorage

## ข้อเสนอแนะ
- [minor] js/app.js: อาจเพิ่มหน้าสรุปคำสั่งซื้อแทน toast (frontend)
- [minor] js/products.js: อนาคตควรโหลดสินค้าจาก API จริง (backend)</review>
<frontend></frontend>
<backend></backend>`,

  final: `<say>เยี่ยมมากทีม! ผ่านทุกเทสต์และรีวิว ส่งมอบร้านค้าให้ลูกค้าได้เลยค่ะ เปิดดูได้ที่แท็บ Preview</say>
<summary>## สิ่งที่ส่งมอบ
เว็บร้านค้าออนไลน์ Little Goods แบบ static เปิดได้ทันทีไม่ต้อง build

## โครงสร้าง
- \`index.html\`, \`css/style.css\` หน้าเว็บ
- \`js/products.js\` ข้อมูลสินค้า
- \`js/cart.js\` logic ตะกร้า ส่วนลด ค่าส่ง
- \`js/app.js\` ต่อ UI
- \`tests/\` เทสต์อัตโนมัติ

## วิธีใช้
เปิด \`index.html\` ในเบราว์เซอร์ หรือดูที่แท็บ Preview

## ผลทดสอบ
ผ่านทั้งหมด (พบและแก้บั๊กการเพิ่มสินค้าซ้ำ 1 รอบ)

## ข้อจำกัดและขั้นต่อไป
ยังไม่มีระบบชำระเงินจริงและหลังบ้านจัดการสินค้า</summary>`,
};
