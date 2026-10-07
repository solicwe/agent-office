// UI layer: renders products and the cart using window.Products and window.Cart.
(function () {
  var cart = Cart.load(localStorage);
  var code = "";
  var activeCategory = "";
  var $ = function (id) { return document.getElementById(id); };

  function baht(n) {
    return n.toLocaleString("th-TH") + " บาท";
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function persist() {
    Cart.save(localStorage, cart);
    renderCart();
  }

  function renderFilters() {
    var cats = [""].concat(Products.categories());
    $("filters").innerHTML = cats.map(function (c) {
      return '<button data-cat="' + esc(c) + '" class="' + (c === activeCategory ? "active" : "") + '">' + (c ? esc(c) : "ทั้งหมด") + "</button>";
    }).join("");
  }

  function renderProducts() {
    $("productGrid").innerHTML = Products.list(activeCategory).map(function (p) {
      return '<article class="product">' +
        '<div class="thumb" style="background:' + esc(p.color) + '">' + esc(p.name.charAt(0)) + "</div>" +
        '<div class="info"><span class="cat">' + esc(p.category) + '</span><span class="name">' + esc(p.name) + "</span>" +
        '<div class="price"><b>' + baht(p.price) + '</b><button data-add="' + esc(p.id) + '">ใส่ตะกร้า</button></div></div>' +
        "</article>";
    }).join("");
  }

  function renderCart() {
    $("cartCount").textContent = Cart.count(cart);
    $("emptyMsg").hidden = cart.items.length > 0;
    $("cartItems").innerHTML = cart.items.map(function (i) {
      return '<li><span>' + esc(i.name) + "</span><b>" + baht(i.price * i.qty) + "</b>" +
        '<div class="qty"><button data-dec="' + esc(i.id) + '" aria-label="ลดจำนวน">-</button><span>' + i.qty + '</span><button data-inc="' + esc(i.id) + '" aria-label="เพิ่มจำนวน">+</button></div>' +
        '<button class="link" data-remove="' + esc(i.id) + '">ลบ</button></li>';
    }).join("");
    var t = Cart.totals(cart, code);
    $("subtotal").textContent = baht(t.subtotal);
    $("discount").textContent = t.discount ? "-" + baht(t.discount) : baht(0);
    $("shipping").textContent = t.shipping ? baht(t.shipping) : "ฟรี";
    $("total").textContent = baht(t.total);
  }

  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  function openCart(open) {
    $("cartPanel").classList.toggle("open", open);
    $("cartPanel").setAttribute("aria-hidden", String(!open));
    $("cartButton").setAttribute("aria-expanded", String(open));
    $("overlay").hidden = !open;
  }

  $("filters").addEventListener("click", function (e) {
    var b = e.target.closest("[data-cat]");
    if (!b) return;
    activeCategory = b.getAttribute("data-cat");
    renderFilters();
    renderProducts();
  });

  $("productGrid").addEventListener("click", function (e) {
    var b = e.target.closest("[data-add]");
    if (!b) return;
    var p = Products.find(b.getAttribute("data-add"));
    cart = Cart.add(cart, p, 1);
    persist();
    toast("เพิ่ม " + p.name + " แล้ว");
  });

  $("cartItems").addEventListener("click", function (e) {
    var t = e.target;
    var id = t.getAttribute("data-inc") || t.getAttribute("data-dec") || t.getAttribute("data-remove");
    if (!id) return;
    var item = cart.items.find(function (i) { return i.id === id; });
    if (t.hasAttribute("data-remove")) cart = Cart.remove(cart, id);
    else if (t.hasAttribute("data-inc")) cart = Cart.setQty(cart, id, Math.min(99, item.qty + 1));
    else cart = Cart.setQty(cart, id, item.qty - 1);
    persist();
  });

  $("codeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var value = $("codeInput").value;
    var ok = Cart.discountRate(value) > 0;
    code = ok ? value : "";
    $("codeMsg").textContent = ok ? "ใช้โค้ดส่วนลดแล้ว" : "โค้ดไม่ถูกต้อง";
    $("codeMsg").classList.toggle("bad", !ok);
    renderCart();
  });

  $("checkoutBtn").addEventListener("click", function () {
    if (!cart.items.length) return toast("ตะกร้ายังว่างอยู่");
    var total = Cart.totals(cart, code).total;
    cart = Cart.empty();
    code = "";
    persist();
    openCart(false);
    toast("สั่งซื้อสำเร็จ ยอดชำระ " + baht(total));
  });

  $("cartButton").addEventListener("click", function () { openCart(true); });
  $("closeCart").addEventListener("click", function () { openCart(false); });
  $("overlay").addEventListener("click", function () { openCart(false); });

  renderFilters();
  renderProducts();
  renderCart();
})();
