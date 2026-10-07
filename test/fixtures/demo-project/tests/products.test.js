const Products = require("../js/products.js");

test("มีสินค้า 6 รายการ", () => {
  assert.equal(Products.list().length, 6);
});

test("กรองตามหมวดหมู่ได้", () => {
  const items = Products.list("เครื่องเขียน");
  assert.ok(items.length > 0);
  assert.ok(items.every((p) => p.category === "เครื่องเขียน"));
});

test("find สินค้าที่ไม่มีคืน null", () => {
  assert.equal(Products.find("nope"), null);
});

test("find คืนสำเนา แก้ไขแล้วไม่กระทบข้อมูลจริง", () => {
  const p = Products.find("p1");
  p.price = 1;
  assert.equal(Products.find("p1").price, 390);
});
