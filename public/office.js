/* Agent Office scene: furniture, cartoon agents, walking, speech bubbles.
   World coordinates are a 1000 x 600 grid; everything is placed in % of the scene. */
(() => {
  const W = 1000, H = 600, CORRIDOR_Y = 395, SPEED = 250; // world units per second

  const TEAM = {
    pm:        { name: "Nina",   short: "PM",        th: "ผู้จัดการผลิตภัณฑ์",   icon: "ClipboardList", color: "#c8694f", skin: "#f3cfb0", hair: "#5b3a29", look: "bob" },
    architect: { name: "Archie", short: "Tech Lead", th: "สถาปนิกระบบ",          icon: "LayoutTemplate", color: "#3c8278", skin: "#dca983", hair: "#2b2b2b", look: "hardhat" },
    frontend:  { name: "Mia",    short: "Frontend",  th: "นักพัฒนาหน้าเว็บ",      icon: "MonitorSmartphone", color: "#b5607f", skin: "#f1c27d", hair: "#2e2018", look: "headphones" },
    backend:   { name: "Ben",    short: "Backend",   th: "นักพัฒนาระบบหลังบ้าน",  icon: "Server", color: "#4a6d99", skin: "#b97a4a", hair: "#1d1d1d", look: "cap" },
    qa:        { name: "Tessa",  short: "QA",        th: "ผู้ทดสอบระบบ",          icon: "FlaskConical", color: "#7d65ad", skin: "#f5d6c0", hair: "#3b2a4d", look: "goggles" },
    debugger:  { name: "Max",    short: "Debugger",  th: "นักแก้บั๊ก",            icon: "Bug", color: "#5f8a4f", skin: "#ffdbac", hair: "#7a4a1f", look: "beanie" },
    reviewer:  { name: "Rex",    short: "Reviewer",  th: "ผู้ตรวจโค้ด",           icon: "ScanSearch", color: "#c58d47", skin: "#8d5524", hair: "#9a9a9a", look: "glasses" },
  };
  const ORDER = Object.keys(TEAM);

  const DESKS = {
    pm: { x: 80, y: 300 }, architect: { x: 215, y: 300 }, frontend: { x: 350, y: 300 }, backend: { x: 485, y: 300 },
    qa: { x: 80, y: 490 }, debugger: { x: 215, y: 490 }, reviewer: { x: 350, y: 490 },
  };
  const SEATS = {
    pm: { x: 705, y: 210, back: true }, architect: { x: 765, y: 206, back: true }, frontend: { x: 825, y: 206, back: true }, backend: { x: 885, y: 210, back: true },
    qa: { x: 735, y: 298 }, debugger: { x: 800, y: 302 }, reviewer: { x: 865, y: 298 },
  };
  const SPOTS = {
    board: { x: 148, y: 214 },
    coffee: { x: 560, y: 572 },
    lab: { qa: { x: 800, y: 532 }, debugger: { x: 728, y: 548 }, other: { x: 872, y: 560 } },
  };

  // ---------- helpers ----------
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const place = (node, x, y) => { node.style.left = (x / W * 100) + "%"; node.style.top = (y / H * 100) + "%"; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ic = (name, size) => (window.icon ? window.icon(name, size) : "");

  /** Location name -> { key, point, entry[] } where entry are waypoints from the corridor. */
  function resolve(agentId, name) {
    if (name === "desk") {
      const d = DESKS[agentId];
      return { key: "desk", point: { x: d.x, y: d.y - 10 }, entry: [{ x: d.x + 68, y: d.y - 10 }] };
    }
    if (name.startsWith("visit:")) {
      const d = DESKS[name.slice(6)] || DESKS.pm;
      return { key: name, point: { x: d.x + 68, y: d.y + 28 }, entry: [] };
    }
    if (name === "meeting") {
      const s = SEATS[agentId];
      return { key: "meeting", point: s, entry: s.back ? [{ x: 650, y: 318 }, { x: 650, y: s.y }] : [] };
    }
    if (name === "lab") return { key: "lab", point: SPOTS.lab[agentId] || SPOTS.lab.other, entry: [] };
    if (name === "board") return { key: "board", point: SPOTS.board, entry: [] };
    if (name === "coffee") {
      const i = ORDER.indexOf(agentId);
      return { key: "coffee", point: { x: SPOTS.coffee.x - 45 + (i % 3) * 45, y: SPOTS.coffee.y + Math.floor(i / 3) * 10 }, entry: [] };
    }
    return resolve(agentId, "desk");
  }

  // ---------- character art ----------
  function hairSVG(t) {
    const h = t.hair;
    switch (t.look) {
      case "bob": return `<path d="M13 30 Q11 7 30 7 Q49 7 47 30 L47 38 Q45 24 39 16 Q31 21 21 16 Q15 24 13 38Z" fill="${h}"/>`;
      case "hardhat": return `<path d="M15 20 Q18 8 30 8 Q42 8 45 20Z" fill="#f2c14e"/><rect x="11" y="18" width="38" height="5" rx="2.5" fill="#dca935"/><rect x="28" y="8" width="4" height="11" rx="2" fill="#dca935"/>`;
      case "headphones": return `<path d="M14 26 Q13 8 30 8 Q47 8 46 26 Q42 15 30 15 Q18 15 14 26Z" fill="${h}"/><path d="M44 14 Q54 20 50 34" stroke="${h}" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M13 27 Q13 5 30 5 Q47 5 47 27" stroke="#3a3f47" stroke-width="3" fill="none"/><rect x="9" y="22" width="7" height="11" rx="3" fill="#e9a6b8"/><rect x="44" y="22" width="7" height="11" rx="3" fill="#e9a6b8"/>`;
      case "cap": return `<path d="M14 22 Q14 7 30 7 Q46 7 46 22Z" fill="#2f4858"/><rect x="12" y="19" width="36" height="4" rx="2" fill="#24394a"/><path d="M38 20 Q50 19 52 23 L40 23Z" fill="#24394a"/>`;
      case "goggles": return `<circle cx="30" cy="7" r="6" fill="${h}"/><path d="M14 24 Q14 9 30 9 Q46 9 46 24 Q40 14 30 15 Q20 14 14 24Z" fill="${h}"/><circle cx="24" cy="17" r="4.2" fill="#cfe3f5" stroke="#4b3a72" stroke-width="1.6"/><circle cx="36" cy="17" r="4.2" fill="#cfe3f5" stroke="#4b3a72" stroke-width="1.6"/><rect x="27.5" y="16" width="5" height="2" fill="#4b3a72"/>`;
      case "glasses": return `<path d="M14 24 Q13 9 30 9 Q47 9 46 24 Q44 15 34 13 L33 17 Q24 13 14 24Z" fill="${h}"/>`;
      case "beanie": return `<path d="M13 22 Q13 6 30 6 Q47 6 47 22Z" fill="#3f6b3a"/><rect x="12" y="19" width="36" height="5" rx="2.5" fill="#94b36b"/><circle cx="30" cy="5" r="3" fill="#94b36b"/>`;
    }
    return "";
  }
  const faceExtras = (t) => (t.look === "glasses" ? `<g fill="none" stroke="#3a3a3a" stroke-width="1.4"><circle cx="24" cy="26" r="4.6"/><circle cx="36" cy="26" r="4.6"/><path d="M28.6 26 H31.4"/></g>` : "");

  function bodyExtras(id, t) {
    if (id === "pm") return `<path d="M30 42 L27 47 L30 60 L33 47Z" fill="#2f3e46"/>`;
    if (id === "qa") return `<path d="M15 50 Q15 40 25 40 L30 52 L35 40 Q45 40 45 50 L45 62 Q45 68 39 68 L21 68 Q15 68 15 62Z" fill="#f4f4f2"/><circle cx="38" cy="54" r="2.3" fill="${t.color}"/>`;
    if (id === "reviewer") return `<rect x="34" y="46" width="7" height="9" rx="1.5" fill="#fff" opacity=".9"/><path d="M35.5 49 h4 M35.5 51.5 h4" stroke="#999" stroke-width=".8"/>`;
    if (id === "frontend") return `<rect x="24" y="47" width="12" height="9" rx="1.5" fill="none" stroke="#fff" stroke-width="1.3" opacity=".85"/><path d="M27 58 h6" stroke="#fff" stroke-width="1.3" opacity=".85"/>`;
    if (id === "backend") return `<rect x="25" y="45" width="10" height="4" rx="1" fill="#fff" opacity=".8"/><rect x="25" y="51" width="10" height="4" rx="1" fill="#fff" opacity=".8"/><rect x="25" y="57" width="10" height="4" rx="1" fill="#fff" opacity=".8"/>`;
    if (id === "architect") return `<path d="M21 46 L39 46 M21 46 L30 60 L39 46" stroke="#fff" stroke-width="1.3" fill="none" opacity=".8"/>`;
    if (id === "debugger") return `<circle cx="30" cy="54" r="4" fill="#a8423c"/><path d="M26 52 h-3 M34 52 h3 M26 56 h-3 M34 56 h3 M30 50 v-2" stroke="#222" stroke-width="1"/>`;
    return "";
  }

  function headSVG(id) {
    const t = TEAM[id];
    return `<g class="head">
      <rect x="26" y="35" width="8" height="6" fill="${t.skin}"/>
      <circle cx="30" cy="24" r="16" fill="${t.skin}"/>
      ${hairSVG(t)}
      <g class="eyes"><ellipse cx="24" cy="26" rx="2.1" ry="2.7" fill="#1b1b1b"/><ellipse cx="36" cy="26" rx="2.1" ry="2.7" fill="#1b1b1b"/>
        <circle cx="24.8" cy="25" r=".8" fill="#fff"/><circle cx="36.8" cy="25" r=".8" fill="#fff"/></g>
      ${faceExtras(t)}
      <ellipse cx="19.5" cy="31" rx="3" ry="1.8" fill="#ff7b7b" opacity=".3"/><ellipse cx="40.5" cy="31" rx="3" ry="1.8" fill="#ff7b7b" opacity=".3"/>
      <path class="mouth" d="M25.5 32.5 Q30 36.5 34.5 32.5" stroke="#7a3b2e" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <ellipse class="mouth-open" cx="30" cy="33.8" rx="3.2" ry="2.4" fill="#7a3b2e"/>
    </g>`;
  }

  function characterSVG(id) {
    const t = TEAM[id];
    return `<svg viewBox="0 -4 60 94" class="char-svg" aria-hidden="true">
      <ellipse class="shadow" cx="30" cy="87" rx="16" ry="3.5"/>
      <g class="leg leg-l"><rect x="21" y="63" width="8" height="19" rx="3" fill="#3d405b"/><rect x="18.5" y="80" width="11.5" height="6" rx="3" fill="#22223b"/></g>
      <g class="leg leg-r"><rect x="31" y="63" width="8" height="19" rx="3" fill="#3d405b"/><rect x="30" y="80" width="11.5" height="6" rx="3" fill="#22223b"/></g>
      <g class="torso">
        <g class="arm arm-l"><rect x="9.5" y="43" width="8" height="21" rx="4" fill="${t.color}"/><circle cx="13.5" cy="64" r="4" fill="${t.skin}"/></g>
        <g class="arm arm-r"><rect x="42.5" y="43" width="8" height="21" rx="4" fill="${t.color}"/><circle cx="46.5" cy="64" r="4" fill="${t.skin}"/></g>
        <rect x="15" y="39" width="30" height="29" rx="11" fill="${t.color}"/>
        ${bodyExtras(id, t)}
        ${headSVG(id)}
      </g>
    </svg>`;
  }

  /** Round head-only avatar for chat and cards. */
  function avatar(id, size = 34) {
    const t = TEAM[id];
    if (!t) return "";
    return `<span class="avatar" style="--c:${t.color};width:${size}px;height:${size}px"><svg viewBox="9 2 42 42" aria-hidden="true">${headSVG(id)}</svg></span>`;
  }

  // ---------- furniture ----------
  function deskSVG(id) {
    const t = TEAM[id];
    return `<svg viewBox="0 0 120 72" preserveAspectRatio="none">
      <rect x="2" y="20" width="116" height="16" rx="4" fill="#c4915f"/>
      <rect x="2" y="32" width="116" height="38" rx="3" fill="#a87447"/>
      <g class="monitor">
        <rect x="5" y="-14" width="34" height="26" rx="3" fill="#2f3138"/>
        <rect class="screen" x="8" y="-11" width="28" height="19" rx="1.5" fill="#23272f"/>
        <g class="code-lines" stroke-width="2" stroke-linecap="round">
          <path d="M11 -7 h11" stroke="#9fd8c7"/><path d="M13 -3 h17" stroke="#e8c37c"/><path d="M13 1 h9" stroke="#e39a9a"/><path d="M11 5 h15" stroke="#9fd8c7"/>
        </g>
        <rect x="19" y="12" width="6" height="7" fill="#2f3138"/><rect x="13" y="18" width="18" height="3" rx="1.5" fill="#2f3138"/>
      </g>
      <rect x="44" y="22" width="32" height="7" rx="2" fill="#ecebe7"/><rect x="46" y="23.5" width="28" height="1.5" fill="#b4b0a8"/>
      <rect x="94" y="12" width="10" height="11" rx="2" fill="${t.color}"/><path d="M104 15 q4 2 0 5" stroke="${t.color}" stroke-width="2" fill="none"/>
      <rect x="36" y="45" width="48" height="16" rx="3" fill="#f6f3ec"/>
      <text x="60" y="57" font-size="10" text-anchor="middle" font-family="IBM Plex Sans Thai, sans-serif" font-weight="600" fill="#333">${t.name}</text>
    </svg>`;
  }

  function plant() {
    return `<svg viewBox="0 0 46 72" preserveAspectRatio="none"><path d="M23 44 Q8 30 6 10 Q20 22 23 44Z" fill="#6aa57f"/><path d="M23 44 Q38 28 41 6 Q27 20 23 44Z" fill="#4f8a66"/><path d="M23 44 Q22 22 24 2 Q30 24 23 44Z" fill="#87bd98"/><path d="M9 44 H37 L33 70 H13Z" fill="#c8694f"/><rect x="7" y="42" width="32" height="6" rx="2" fill="#d98b6a"/></svg>`;
  }

  const FURNITURE = [
    ...ORDER.map((id) => ({ cls: `desk desk-${id}`, x: DESKS[id].x, bottom: DESKS[id].y + 20, w: 120, h: 72, svg: deskSVG(id), id })),
    { cls: "meeting-table", x: 795, bottom: 256, w: 250, h: 66, svg: `<svg viewBox="0 0 250 66" preserveAspectRatio="none"><ellipse cx="125" cy="28" rx="122" ry="26" fill="#8a6a55"/><ellipse cx="125" cy="24" rx="122" ry="24" fill="#b88a64"/><rect x="45" y="45" width="10" height="20" fill="#6d4c41"/><rect x="195" y="45" width="10" height="20" fill="#6d4c41"/><rect x="95" y="14" width="22" height="14" rx="2" fill="#fff" opacity=".85"/><circle cx="160" cy="20" r="6" fill="#fff"/><circle cx="160" cy="20" r="4" fill="#6f4e37"/></svg>` },
    { cls: "test-screen", x: 770, bottom: 478, w: 170, h: 118, svg: `<svg viewBox="0 0 170 118" preserveAspectRatio="none"><rect x="2" y="2" width="166" height="92" rx="8" fill="#2b3440"/><rect x="8" y="8" width="154" height="80" rx="4" fill="#161b22"/><rect x="78" y="94" width="14" height="14" fill="#555"/><rect x="50" y="106" width="70" height="8" rx="4" fill="#444"/></svg><div class="screen-text" id="labScreen"></div>` },
    { cls: "rack", x: 925, bottom: 545, w: 70, h: 165, svg: `<svg viewBox="0 0 70 165" preserveAspectRatio="none"><rect x="2" y="2" width="66" height="161" rx="5" fill="#363b42"/>${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="8" y="${10 + i * 25}" width="54" height="19" rx="2" fill="#4a5058"/><circle class="led" cx="16" cy="${19.5 + i * 25}" r="2.5" fill="#5cc49a"/><circle class="led led2" cx="24" cy="${19.5 + i * 25}" r="2.5" fill="#e8c37c"/><rect x="34" y="${17 + i * 25}" width="22" height="4" rx="1" fill="#6c737d"/>`).join("")}</svg>` },
    { cls: "coffee", x: 560, bottom: 548, w: 80, h: 80, svg: `<svg viewBox="0 0 80 80" preserveAspectRatio="none"><rect x="0" y="44" width="80" height="36" rx="3" fill="#a87447"/><rect x="18" y="4" width="44" height="42" rx="6" fill="#3a3f47"/><rect x="24" y="12" width="32" height="10" rx="2" fill="#161b22"/><circle cx="30" cy="17" r="1.6" fill="#5cc49a"/><rect x="34" y="28" width="12" height="16" fill="#23272f"/><rect x="35" y="37" width="10" height="9" rx="1" fill="#f6f3ec"/></svg>` },
    { cls: "plant", x: 32, bottom: 595, w: 46, h: 72, svg: plant() },
    { cls: "plant", x: 588, bottom: 345, w: 40, h: 64, svg: plant() },
    { cls: "plant", x: 975, bottom: 598, w: 46, h: 72, svg: plant() },
  ];

  function backgroundSVG() {
    return `<svg class="bg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id="planks" width="120" height="40" patternUnits="userSpaceOnUse">
          <rect width="120" height="40" fill="var(--floor)"/><path d="M0 39.5 H120 M60 0 V20 M0 20 H120 M20 20 V40" stroke="var(--floor-line)" stroke-width="1"/>
        </pattern>
        <pattern id="tiles" width="30" height="30" patternUnits="userSpaceOnUse">
          <rect width="30" height="30" fill="var(--lab)"/><path d="M0 0 H30 V30" fill="none" stroke="var(--lab-line)"/>
        </pattern>
        <pattern id="carpet" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill="var(--carpet)"/><circle cx="8" cy="8" r="1" fill="var(--carpet-dot)"/>
        </pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#planks)"/>
      <rect width="${W}" height="128" fill="var(--wall)"/>
      <rect y="122" width="${W}" height="8" fill="var(--baseboard)"/>
      <rect x="612" y="130" width="374" height="186" fill="url(#carpet)"/>
      <rect x="622" y="332" width="368" height="260" rx="6" fill="url(#tiles)"/>
      <text x="640" y="354" class="zone-label">QA LAB</text>
      <text x="628" y="150" class="zone-label">MEETING ROOM</text>
      <g opacity=".55" fill="var(--glass)" stroke="var(--glass-edge)" stroke-width="2">
        <rect x="606" y="20" width="8" height="298"/><rect x="984" y="20" width="8" height="298"/>
      </g>
      <rect x="640" y="20" width="320" height="86" rx="4" fill="var(--window)"/>
      <path d="M800 20 V106 M640 63 H960" stroke="var(--window-frame)" stroke-width="5"/>
      <rect x="640" y="20" width="320" height="86" rx="4" fill="none" stroke="var(--window-frame)" stroke-width="6"/>
      <rect x="96" y="22" width="200" height="94" rx="4" fill="#fbfbf9" stroke="#9097a0" stroke-width="5"/>
      <rect x="140" y="114" width="110" height="6" rx="3" fill="#9097a0"/>
      <path d="M150 395 H990" stroke="var(--path)" stroke-width="2" stroke-dasharray="6 10" opacity=".45"/>
    </svg>`;
  }

  // ---------- Office ----------
  class Office {
    constructor(root) {
      this.root = root;
      this.agents = {};
      this.busy = false;
      root.innerHTML = backgroundSVG();

      this.board = el("div", "wb", `<div class="wb-title">SPEC / DESIGN</div><div class="wb-lines"><i></i><i></i><i></i><i></i></div>`);
      place(this.board, 106, 28);
      root.append(this.board);

      this.kanban = el("div", "kanban", `<div><h6>TO DO</h6><div data-col="todo"></div></div><div><h6>DOING</h6><div data-col="doing"></div></div><div><h6>DONE</h6><div data-col="done"></div></div>`);
      place(this.kanban, 318, 18);
      root.append(this.kanban);

      this.clock = el("div", "clock");
      place(this.clock, 48, 66);
      root.append(this.clock);
      const tick = () => { this.clock.textContent = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }); };
      tick();
      setInterval(tick, 10_000);

      this.furniture = {};
      for (const f of FURNITURE) {
        const node = el("div", "furn " + f.cls, f.svg);
        node.style.width = (f.w / W * 100) + "%";
        node.style.height = (f.h / H * 100) + "%";
        place(node, f.x - f.w / 2, f.bottom - f.h);
        node.style.zIndex = f.bottom;
        root.append(node);
        if (f.id) this.furniture[f.id] = node;
      }
      this.labScreen = root.querySelector("#labScreen");
      this.rack = root.querySelector(".rack");
      this.lab("idle");

      for (const id of ORDER) this.spawn(id);
      this.last = performance.now();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
      setInterval(() => this.ambient(), 3500);
    }

    spawn(id) {
      const t = TEAM[id];
      const node = el("div", "agent", `
        <div class="bubble" hidden></div>
        <div class="badge-status" hidden></div>
        <div class="figure">${characterSVG(id)}</div>
        <div class="nametag" style="--c:${t.color}">${t.name}<span>${t.short}</span></div>`);
      node.dataset.id = id;
      this.root.append(node);
      const a = { id, node, pos: { ...resolve(id, "desk").point }, route: [], waiters: [], at: "desk", status: "idle", lastBusy: performance.now(), wander: false, bubbleTimer: 0 };
      this.agents[id] = a;
      this.render(a);
    }

    render(a) {
      place(a.node, a.pos.x, a.pos.y);
      if (!a.node.classList.contains("talking")) a.node.style.zIndex = Math.round(a.pos.y) + 1;
    }

    loop(now) {
      // Time-based so walks finish on time even when the tab drops frames.
      const dt = Math.min(0.5, (now - this.last) / 1000);
      this.last = now;
      for (const a of Object.values(this.agents)) {
        if (!a.route.length) continue;
        let budget = SPEED * dt * (this.fast ? 20 : 1);
        while (budget > 0 && a.route.length) {
          const tgt = a.route[0];
          const dx = tgt.x - a.pos.x, dy = tgt.y - a.pos.y, d = Math.hypot(dx, dy);
          if (Math.abs(dx) > 1) a.node.classList.toggle("left", dx < 0);
          if (d <= budget) { a.pos = { ...tgt }; a.route.shift(); budget -= d; }
          else { a.pos.x += (dx / d) * budget; a.pos.y += (dy / d) * budget; budget = 0; }
        }
        this.render(a);
        if (!a.route.length) {
          a.node.classList.remove("walking", "left");
          const w = a.waiters;
          a.waiters = [];
          w.forEach((r) => r());
        }
      }
      requestAnimationFrame(this.loop);
    }

    /** Walk an agent to a named location. Resolves on arrival. */
    moveTo(id, name, { wander = false } = {}) {
      const a = this.agents[id];
      if (!a) return Promise.resolve();
      a.wander = wander;
      if (!wander) a.lastBusy = performance.now();
      // Mid-walk re-route: head straight for the corridor from wherever we are.
      const from = a.at && !a.route.length ? resolve(id, a.at) : null;
      const to = resolve(id, name);
      const pts = [];
      if (!from || from.key !== to.key) {
        if (from) pts.push(...[...from.entry].reverse());
        const startX = (pts.at(-1) || a.pos).x;
        const endX = (to.entry[0] || to.point).x;
        pts.push({ x: startX, y: CORRIDOR_Y }, { x: endX, y: CORRIDOR_Y }, ...to.entry);
      }
      pts.push(to.point);
      const route = [];
      let prev = a.pos;
      for (const p of pts) if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) { route.push(p); prev = p; }
      a.at = to.key;
      a.route = route;
      if (!route.length) return Promise.resolve();
      a.node.classList.add("walking");
      return new Promise((r) => a.waiters.push(r));
    }

    arrived(ids) {
      return Promise.all(ids.map((id) => {
        const a = this.agents[id];
        return a && a.route.length ? new Promise((r) => a.waiters.push(r)) : null;
      }));
    }

    setStatus(id, state) {
      const a = this.agents[id];
      if (!a) return;
      a.status = state;
      if (state !== "idle") a.lastBusy = performance.now();
      for (const s of ["thinking", "typing", "running"]) a.node.classList.toggle(s, state === s);
      const badge = a.node.querySelector(".badge-status");
      badge.hidden = state === "idle";
      if (state === "thinking") badge.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;
      else if (state === "typing") badge.innerHTML = ic("Keyboard", 13);
      else if (state === "running") badge.innerHTML = `<span class="spin">${ic("Loader", 13)}</span>`;
      this.furniture[id]?.classList.toggle("on", state === "typing" || state === "thinking");
      if (id === "pm" || id === "architect") this.board.classList.toggle("writing", state !== "idle" && a.at === "board");
      if (id === "qa" && state === "running") this.lab("running");
    }

    say(id, text, toNames = "") {
      const a = this.agents[id];
      if (!a) return;
      const b = a.node.querySelector(".bubble");
      const short = text.length > 180 ? text.slice(0, 177) + "…" : text;
      b.innerHTML = (toNames ? `<small>ถึง ${esc(toNames)}</small>` : "") + esc(short);
      b.hidden = false;
      b.classList.toggle("edge-left", a.pos.x < 170);
      b.classList.toggle("edge-right", a.pos.x > 830);
      a.node.classList.add("talking");
      a.node.style.zIndex = 2000;
      clearTimeout(a.bubbleTimer);
      clearTimeout(a.talkTimer);
      const ms = this.fast ? 300 : Math.min(9000, 2600 + short.length * 45);
      a.talkTimer = setTimeout(() => { a.node.classList.remove("talking"); this.render(a); }, Math.min(ms, 2000 + short.length * 25));
      a.bubbleTimer = setTimeout(() => { b.hidden = true; }, ms);
    }

    react(ids, kind) {
      if (this.fast) return;
      for (const id of ids) {
        const n = this.agents[id]?.node;
        if (!n) continue;
        n.classList.remove("jump", "shake", "nod");
        void n.offsetWidth;
        n.classList.add(kind);
        setTimeout(() => n.classList.remove(kind), 1600);
      }
    }

    emote(id, iconName, tone = "") {
      const a = this.agents[id];
      if (!a || this.fast) return;
      const e = el("div", "emote " + tone, ic(iconName, 14));
      a.node.append(e);
      setTimeout(() => e.remove(), 1800);
    }

    lab(state, info = {}) {
      const s = this.labScreen;
      s.className = "screen-text " + state;
      if (state === "running") s.innerHTML = `<b>RUNNING</b><span class="spin">${ic("Loader", 18)}</span>`;
      else if (state === "pass") s.innerHTML = `<b>ALL PASSED</b><span>${info.passed}/${info.total}</span>`;
      else if (state === "fail") s.innerHTML = `<b>FAILED</b><span>${info.passed}/${info.total}</span>`;
      else s.innerHTML = `<b>TEST RUNNER</b><span class="idle">พร้อม</span>`;
      this.rack.classList.toggle("blink", state === "running");
    }

    boardDone(on) { this.board.classList.toggle("filled", on); }

    kanbanSet(items) {
      const cols = {};
      for (const c of ["todo", "doing", "done"]) { cols[c] = this.kanban.querySelector(`[data-col="${c}"]`); cols[c].innerHTML = ""; }
      for (const p of items) {
        const col = p.state === "active" || p.state === "failed" ? "doing" : p.state === "done" ? "done" : "todo";
        const note = el("span", "sticky " + (p.state || ""), "");
        note.title = p.label;
        cols[col].append(note);
      }
    }

    confetti() {
      const colors = ["#c8694f", "#3c8278", "#e8c37c", "#7d65ad", "#4a6d99", "#5cc49a"];
      for (let i = 0; i < 80; i++) {
        const c = el("i", "confetti");
        c.style.left = Math.random() * 100 + "%";
        c.style.background = colors[i % colors.length];
        c.style.animationDelay = Math.random() * 0.6 + "s";
        c.style.animationDuration = 1.8 + Math.random() * 1.4 + "s";
        this.root.append(c);
        setTimeout(() => c.remove(), 4000);
      }
    }

    /** Idle life: agents with nothing to do grab coffee now and then. */
    ambient() {
      if (this.fast) return;
      const now = performance.now();
      for (const a of Object.values(this.agents)) {
        if (a.route.length || a.status !== "idle") continue;
        const idleFor = now - a.lastBusy;
        if (a.at === "desk" && idleFor > (this.busy ? 15000 : 7000) && Math.random() < 0.1) {
          this.moveTo(a.id, "coffee", { wander: true }).then(() => {
            if (a.at !== "coffee") return;
            this.emote(a.id, "Coffee");
            setTimeout(() => { if (a.at === "coffee" && a.wander) this.moveTo(a.id, "desk", { wander: true }); }, 2500 + Math.random() * 2500);
          });
        }
      }
    }
  }

  window.AgentOffice = { Office, TEAM, ORDER, avatar };
})();
