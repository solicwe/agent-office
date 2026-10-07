// Cart business logic. Pure functions: every call returns a new cart object.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Cart = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var STORAGE_KEY = "shop.cart";
  var MAX_QTY = 99;
  var FREE_SHIPPING_MIN = 1000;
  var SHIPPING_FEE = 50;
  var CODES = { SAVE10: 0.1 };

  function empty() {
    return { items: [] };
  }

  function cloneItems(cart) {
    return cart.items.map(function (i) { return Object.assign({}, i); });
  }

  function checkQty(qty) {
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
      throw new RangeError("qty must be an integer between 0 and " + MAX_QTY);
    }
  }

  function add(cart, product, qty) {
    if (qty === undefined) qty = 1;
    if (!product || !product.id || typeof product.price !== "number") {
      throw new TypeError("invalid product");
    }
    checkQty(qty);
    if (qty === 0) throw new RangeError("qty must be at least 1");
    var items = cloneItems(cart);
    var existing = items.find(function (i) { return i.id === product.id; });
    if (existing) {
      existing.qty = Math.min(MAX_QTY, existing.qty + qty);
    } else {
      items.push({ id: product.id, name: product.name, price: product.price, qty: qty });
    }
    return { items: items };
  }

  function setQty(cart, id, qty) {
    checkQty(qty);
    var items = cloneItems(cart).map(function (i) {
      if (i.id === id) i.qty = qty;
      return i;
    });
    return { items: items.filter(function (i) { return i.qty > 0; }) };
  }

  function remove(cart, id) {
    return { items: cloneItems(cart).filter(function (i) { return i.id !== id; }) };
  }

  function count(cart) {
    return cart.items.reduce(function (n, i) { return n + i.qty; }, 0);
  }

  function discountRate(code) {
    if (!code) return 0;
    return CODES[String(code).trim().toUpperCase()] || 0;
  }

  /** Money totals in baht. Free shipping when the discounted subtotal reaches 1,000. */
  function totals(cart, code) {
    var subtotal = cart.items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var rate = discountRate(code);
    var discount = Math.round(subtotal * rate);
    var afterDiscount = subtotal - discount;
    var shipping = subtotal === 0 || afterDiscount >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
    return { subtotal: subtotal, discount: discount, shipping: shipping, total: afterDiscount + shipping, codeValid: rate > 0 };
  }

  function save(storage, cart) {
    storage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }

  function load(storage) {
    try {
      var c = JSON.parse(storage.getItem(STORAGE_KEY));
      if (c && Array.isArray(c.items)) return c;
    } catch (e) {
      /* corrupted data: start fresh */
    }
    return empty();
  }

  return {
    empty: empty, add: add, setQty: setQty, remove: remove, count: count,
    totals: totals, discountRate: discountRate, save: save, load: load,
    FREE_SHIPPING_MIN: FREE_SHIPPING_MIN, SHIPPING_FEE: SHIPPING_FEE,
  };
});
