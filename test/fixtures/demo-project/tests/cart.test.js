const Cart = require("../js/cart.js");
const Products = require("../js/products.js");

const bag = Products.find("p1"); // 390
const mug = Products.find("p2"); // 250
const notebook = Products.find("p3"); // 180
const scarf = Products.find("p6"); // 820

test("ตะกร้าว่าง ยอดรวมและค่าส่งเป็น 0", () => {
  assert.deepEqual(Cart.totals(Cart.empty()), { subtotal: 0, discount: 0, shipping: 0, total: 0, codeValid: false });
});

test("เพิ่มสินค้าใหม่ จำนวนเริ่มต้นเป็น 1", () => {
  const c = Cart.add(Cart.empty(), bag);
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].qty, 1);
});

test("เพิ่มสินค้าเดิมซ้ำ จำนวนต้องบวกเพิ่ม", () => {
  let c = Cart.add(Cart.empty(), bag, 2);
  c = Cart.add(c, bag, 1);
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].qty, 3);
});

test("count รวมจำนวนชิ้นทั้งหมด", () => {
  let c = Cart.add(Cart.empty(), bag, 2);
  c = Cart.add(c, bag, 1);
  c = Cart.add(c, mug);
  assert.equal(Cart.count(c), 4);
});

test("จำนวนสูงสุดต่อสินค้าคือ 99", () => {
  let c = Cart.add(Cart.empty(), bag, 99);
  c = Cart.add(c, bag, 5);
  assert.equal(c.items[0].qty, 99);
});

test("จำนวนไม่ถูกต้องต้อง throw RangeError", () => {
  assert.throws(() => Cart.add(Cart.empty(), bag, -1), RangeError);
  assert.throws(() => Cart.add(Cart.empty(), bag, 1.5), RangeError);
  assert.throws(() => Cart.add(Cart.empty(), bag, 0), RangeError);
});

test("add ไม่แก้ไขตะกร้าเดิม (immutable)", () => {
  const before = Cart.add(Cart.empty(), bag);
  Cart.add(before, bag);
  assert.equal(before.items[0].qty, 1);
});

test("setQty เป็น 0 ลบสินค้าออก", () => {
  const c = Cart.setQty(Cart.add(Cart.empty(), bag), "p1", 0);
  assert.equal(c.items.length, 0);
});

test("remove ลบเฉพาะสินค้าที่ระบุ", () => {
  let c = Cart.add(Cart.add(Cart.empty(), bag), mug);
  c = Cart.remove(c, "p1");
  assert.deepEqual(c.items.map((i) => i.id), ["p2"]);
});

test("ยอดต่ำกว่า 1,000 บาท คิดค่าส่ง 50", () => {
  const t = Cart.totals(Cart.add(Cart.empty(), bag));
  assert.equal(t.shipping, 50);
  assert.equal(t.total, 440);
});

test("ยอดครบ 1,000 บาท ส่งฟรี", () => {
  const c = Cart.add(Cart.add(Cart.empty(), scarf), notebook);
  const t = Cart.totals(c);
  assert.equal(t.subtotal, 1000);
  assert.equal(t.shipping, 0);
});

test("โค้ด SAVE10 ลด 10% และไม่สนตัวพิมพ์เล็กใหญ่", () => {
  const c = Cart.add(Cart.add(Cart.empty(), scarf), notebook);
  const t = Cart.totals(c, " save10 ");
  assert.equal(t.discount, 100);
  assert.equal(t.shipping, 50, "หลังหักส่วนลดเหลือ 900 จึงต้องเสียค่าส่ง");
  assert.equal(t.total, 950);
});

test("โค้ดไม่ถูกต้องไม่ได้ส่วนลด", () => {
  const t = Cart.totals(Cart.add(Cart.empty(), bag), "FREE");
  assert.equal(t.discount, 0);
  assert.equal(t.codeValid, false);
});

test("save/load เก็บและอ่านตะกร้าจาก localStorage", () => {
  localStorage.clear();
  const c = Cart.add(Cart.empty(), mug, 2);
  Cart.save(localStorage, c);
  assert.deepEqual(Cart.load(localStorage), c);
});

test("load ข้อมูลเสียคืนตะกร้าว่าง", () => {
  localStorage.setItem("shop.cart", "{not json");
  assert.deepEqual(Cart.load(localStorage), Cart.empty());
});
