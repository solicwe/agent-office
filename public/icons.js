/* Tiny wrapper around Lucide's icon data: icon("Bug") -> inline SVG string. */
(() => {
  function attrs(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}="${v}"`).join(" ");
  }
  function render(node) {
    const [tag, a, children] = node;
    return `<${tag} ${attrs(a || {})}>${(children || []).map(render).join("")}</${tag}>`;
  }
  window.icon = function icon(name, size = 16, cls = "") {
    const data = window.lucide && window.lucide.icons && window.lucide.icons[name];
    if (!data) return `<span class="ico-missing" style="width:${size}px;height:${size}px"></span>`;
    const children = Array.isArray(data[2]) ? data[2] : data;
    return `<svg class="ico ${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children.map(render).join("")}</svg>`;
  };
  /** Replace every <i data-icon="Name"> placeholder in a root element. */
  window.hydrateIcons = function (root = document) {
    root.querySelectorAll("i[data-icon]").forEach((el) => {
      el.outerHTML = window.icon(el.dataset.icon, Number(el.dataset.size) || 16, el.className);
    });
  };
})();
