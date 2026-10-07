// Product catalogue (data layer). Works in the browser (window.Products) and in Node.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Products = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var PRODUCTS = [
    { id: "p1", name: "กระเป๋าผ้าแคนวาส", category: "กระเป๋า", price: 390, color: "#d8c3a5" },
    { id: "p2", name: "แก้วเซรามิกทำมือ", category: "ของใช้", price: 250, color: "#a3b8a0" },
    { id: "p3", name: "สมุดโน้ตปกแข็ง", category: "เครื่องเขียน", price: 180, color: "#e7a977" },
    { id: "p4", name: "เทียนหอมไม้ซีดาร์", category: "ของใช้", price: 450, color: "#c97b63" },
    { id: "p5", name: "ปากกาหมึกซึม", category: "เครื่องเขียน", price: 690, color: "#6b7f8e" },
    { id: "p6", name: "ผ้าพันคอลินิน", category: "แฟชั่น", price: 820, color: "#9db4c0" },
  ];

  function copy(p) {
    return Object.assign({}, p);
  }

  /** All products, optionally filtered by category. Returns copies. */
  function list(category) {
    return PRODUCTS.filter(function (p) {
      return !category || p.category === category;
    }).map(copy);
  }

  /** One product by id, or null. */
  function find(id) {
    var p = PRODUCTS.find(function (x) {
      return x.id === id;
    });
    return p ? copy(p) : null;
  }

  function categories() {
    return Array.from(new Set(PRODUCTS.map(function (p) { return p.category; })));
  }

  return { list: list, find: find, categories: categories };
});
