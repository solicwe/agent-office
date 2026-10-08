/* Agent Office UI: projects sidebar, brief assistant, and the live office view
   driven by server events (SSE). */
(() => {
  const { Office, TEAM, ORDER, avatar } = window.AgentOffice;
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const md = (s) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || "")) : `<pre>${esc(s)}</pre>`);
  const time = () => new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  const fmt = (n) => Number(n || 0).toLocaleString("th-TH");
  const store = {
    get(k, area = localStorage) { try { return JSON.parse(area.getItem(k)); } catch { return null; } },
    set(k, v, area = localStorage) { try { area.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k, area = localStorage) { try { area.removeItem(k); } catch { /* ignore */ } },
  };
  async function api(url, body) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  hydrateIcons();
  const office = new Office($("#scene"));
  let config = { models: [], efforts: [], serverHasKey: false, localClaude: { available: false }, shareBases: [] };

  // ---------- settings ----------
  const settings = Object.assign({ provider: "", model: "", effort: "medium", swuModel: "", maxFixRounds: 4, maxReviewRounds: 1 }, store.get("agentOffice.settings") || {});
  const getKey = () => store.get("agentOffice.key") || store.get("agentOffice.key", sessionStorage) || "";
  const getSwuKey = () => store.get("agentOffice.swuKey") || store.get("agentOffice.swuKey", sessionStorage) || "";
  const isGuest = () => config.role === "guest";
  // A friend's own key: used when the owner's tokens (or their share) run out.
  const getOwnKey = () => store.get("agentOffice.ownKey") || store.get("agentOffice.ownKey", sessionStorage) || null;
  const hasOwnKey = () => Boolean(getOwnKey()?.key);
  // Default: SWU AI when the server has its key, else Claude on this machine, else an API key.
  const provider = () => (isGuest() ? "api" : settings.provider || (config.swu?.serverKey ? "swu" : config.localClaude.available ? "local" : "api"));
  const connected = () => {
    if (isGuest()) return config.serverHasKey || hasOwnKey();
    if (provider() === "local") return config.localClaude.available;
    if (provider() === "swu") return Boolean(getSwuKey()) || Boolean(config.swu?.serverKey);
    return config.serverHasKey || Boolean(getKey());
  };
  const llmBody = () => ({
    settings: { ...settings, provider: provider() },
    apiKey: provider() === "api" && !isGuest() ? getKey() : "",
    swuKey: provider() === "swu" && !isGuest() ? getSwuKey() : "",
    ...(isGuest() && hasOwnKey() ? { ownKey: { kind: getOwnKey().kind, key: getOwnKey().key }, ownFirst: Boolean(getOwnKey().first) } : {}),
  });

  function fillSettings() {
    $("#setProvider").value = provider();
    $("#setModel").innerHTML = config.models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
    $("#setModel").value = settings.model || config.defaultModel;
    $("#setEffort").innerHTML = config.efforts.map((e) => `<option>${e}</option>`).join("");
    $("#setEffort").value = settings.effort;
    $("#setFix").value = settings.maxFixRounds;
    $("#setReview").value = settings.maxReviewRounds;
    $("#setKey").value = getKey();
    $("#setRemember").checked = Boolean(store.get("agentOffice.key"));
    $("#setSwuKey").value = getSwuKey();
    $("#setSwuRemember").checked = Boolean(store.get("agentOffice.swuKey"));
    $("#setSwuModel").value = settings.swuModel || config.swu?.model || "anthropic/claude-sonnet-5.5";
    $("#setSwuKey").placeholder = config.swu?.serverKey ? "ใช้ SWU key ในไฟล์ .env ของเซิร์ฟเวอร์อยู่แล้ว (เว้นว่างได้)" : "API key จากเว็บไซต์ SWU AI";
    const own = getOwnKey();
    $("#setOwnKind").value = own?.kind || "";
    $("#setOwnKey").value = own?.key || "";
    $("#setOwnFirst").checked = Boolean(own?.first);
    $("#setOwnRemember").checked = !own || Boolean(store.get("agentOffice.ownKey"));
    renderBudget(budget);
    syncSettingsForm();
  }
  function syncSettingsForm() {
    const p = $("#setProvider").value;
    $("#keyGroup").hidden = p !== "api" || isGuest();
    $("#swuGroup").hidden = p !== "swu" || isGuest();
    $("#modelField").hidden = p === "swu" && !isGuest();
    $("#effortField").hidden = p === "swu" && !isGuest();
    $("#providerNote").textContent = p === "local"
      ? (config.localClaude.available
        ? `ใช้ token จากบัญชี Claude ที่ล็อกอิน ${config.localClaude.version} ไว้ในเครื่องนี้ ถ้ายังไม่ได้ล็อกอิน ให้เปิด terminal พิมพ์ claude แล้วใช้คำสั่ง /login`
        : "ไม่พบ Claude Code ในเครื่องนี้ ติดตั้งด้วย npm i -g @anthropic-ai/claude-code แล้วล็อกอิน หรือเลือกช่องทางอื่น")
      : p === "swu"
        ? "ใช้ token จากโควตา SWU AI ของคุณ key จะถูกส่งไปที่เซิร์ฟเวอร์นี้ตอนเริ่มงานเท่านั้น"
        : (config.serverHasKey ? "เซิร์ฟเวอร์มี API key อยู่แล้ว ใส่ key ของคุณเองเพื่อใช้แทนได้" : "ใส่ API key จาก console.anthropic.com key จะถูกส่งไปที่เซิร์ฟเวอร์นี้ตอนเริ่มงานเท่านั้น");
    $("#ownKeyFields").hidden = !$("#setOwnKind").value;
    const m = config.models.find((x) => x.id === $("#setModel").value);
    $("#setEffort").disabled = Boolean(m && !m.effort);
  }
  $("#setProvider").addEventListener("change", syncSettingsForm);
  $("#setOwnKind").addEventListener("change", syncSettingsForm);
  $("#loadSwuModels").addEventListener("click", async () => {
    const key = $("#setSwuKey").value.trim();
    if (!key && !config.swu?.serverKey) { $("#swuNote").textContent = "ใส่ SWU API key ก่อน"; return; }
    $("#swuNote").textContent = "กำลังดึงรายชื่อโมเดล…";
    try {
      const { models } = await api("/api/swu/models", { swuKey: key });
      $("#swuModelList").innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
      const claude = models.filter((m) => /claude/i.test(m.id)).map((m) => m.id);
      $("#swuNote").textContent = `พบ ${models.length} โมเดล${claude.length ? ` (Claude: ${claude.join(", ")})` : ""} คลิกช่องโมเดลเพื่อเลือก`;
      if (claude.length && !$("#setSwuModel").value) $("#setSwuModel").value = claude[0];
    } catch (err) {
      $("#swuNote").textContent = err.message + " พิมพ์ชื่อโมเดลเองได้ เช่น anthropic/claude-sonnet-5";
    }
  });
  $("#setModel").addEventListener("change", syncSettingsForm);
  $("#settingsBtn").addEventListener("click", () => { fillSettings(); $("#settings").showModal(); });
  $("#resetUsage").addEventListener("click", async () => {
    renderBudget(await api("/api/usage/reset", {}));
  });
  $("#settings").addEventListener("close", async () => {
    if ($("#settings").returnValue !== "save") return;
    const swuKey = $("#setSwuKey").value.trim();
    store.del("agentOffice.swuKey");
    store.del("agentOffice.swuKey", sessionStorage);
    if (swuKey) store.set("agentOffice.swuKey", swuKey, $("#setSwuRemember").checked ? localStorage : sessionStorage);
    Object.assign(settings, {
      provider: $("#setProvider").value,
      model: $("#setModel").value,
      effort: $("#setEffort").value,
      swuModel: $("#setSwuModel").value.trim(),
      maxFixRounds: Number($("#setFix").value) || 4,
      maxReviewRounds: Math.max(0, Number($("#setReview").value) || 0),
    });
    store.set("agentOffice.settings", settings);
    const key = $("#setKey").value.trim();
    store.del("agentOffice.key");
    store.del("agentOffice.key", sessionStorage);
    if (key) store.set("agentOffice.key", key, $("#setRemember").checked ? localStorage : sessionStorage);
    if (isGuest()) {
      const own = { kind: $("#setOwnKind").value, key: $("#setOwnKey").value.trim(), first: $("#setOwnFirst").checked };
      store.del("agentOffice.ownKey");
      store.del("agentOffice.ownKey", sessionStorage);
      if (own.kind && own.key) store.set("agentOffice.ownKey", own, $("#setOwnRemember").checked ? localStorage : sessionStorage);
      renderBudget(budget);
    }
  });

  // ---------- share with friends (owner only) ----------
  const shareBase = () => (store.get("agentOffice.shareBase") || config.shareBases?.[0] || location.origin).replace(/\/+$/, "");
  async function renderInvites() {
    const { invites, serverHasKey } = await api("/api/invites");
    config.serverHasKey = serverHasKey;
    $("#serverKeyState").textContent = serverHasKey ? "ตั้ง API key สำหรับเพื่อนแล้ว (ใส่ใหม่เพื่อเปลี่ยน หรือเว้นว่างแล้วบันทึกเพื่อลบ)" : "ยังไม่ได้ตั้ง เพื่อนจะสั่งงานไม่ได้จนกว่าจะตั้ง";
    $("#inviteList").innerHTML = invites.length ? invites.map((i) => `
      <div class="invite">
        <div><b>${esc(i.name)}</b> <small>ใช้ไป ${fmt(i.used)} / ${fmt(i.limit)} tokens</small></div>
        <span class="row-gap">
          <button type="button" class="btn small ghost" data-copy="${esc(shareBase() + "/i/" + i.code)}">${icon("Copy", 13)}คัดลอก</button>
          <button type="button" class="btn small ghost" data-revoke="${esc(i.code)}">${icon("Ban", 13)}ยกเลิก</button>
        </span>
        <code class="link-box">${esc(shareBase() + "/i/" + i.code)}</code>
      </div>`).join("") : `<p class="muted small">ยังไม่มีลิงก์เชิญ</p>`;
  }
  // Outside link: a Cloudflare quick tunnel to Agent Office (each app gets its own when opened).
  let tunnelOn = false;
  function renderTunnel(t, error) {
    config.shareBases = t.shareBases || config.shareBases;
    tunnelOn = Boolean(t.main?.url);
    const btn = $("#tunnelToggle");
    btn.disabled = false;
    btn.querySelector("span").textContent = tunnelOn ? "ปิดลิงก์คนนอกบ้าน" : "เปิดให้คนนอกบ้านเข้า";
    btn.classList.toggle("primary", !tunnelOn);
    $("#tunnelState").innerHTML = t.fixed
      ? `ใช้ที่อยู่ที่ตั้งไว้ใน .env: <code>${esc(t.fixed)}</code>`
      : tunnelOn
        ? `เปิดแล้ว คนนอกบ้านเข้าได้ที่ <code>${esc(t.main.url)}</code> ลิงก์เชิญด้านล่างใช้ที่อยู่นี้ให้แล้ว (ที่อยู่จะเปลี่ยนเมื่อปิดแล้วเปิดใหม่ ให้ส่งลิงก์เชิญใหม่)`
        : "เพื่อนในวง Wi-Fi เดียวกันเปิดได้เลย ถ้าเพื่อนอยู่นอกบ้าน กดปุ่มนี้";
    btn.hidden = Boolean(t.fixed);
    const hint = error || (!t.available && !t.fixed ? t.hint : "");
    $("#tunnelHint").hidden = !hint;
    $("#tunnelHint").textContent = hint || "";
  }
  $("#tunnelToggle").addEventListener("click", async () => {
    const btn = $("#tunnelToggle");
    btn.disabled = true;
    btn.querySelector("span").textContent = tunnelOn ? "กำลังปิด…" : "กำลังเปิด (ไม่เกิน 30 วินาที)…";
    const res = await fetch("/api/tunnel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !tunnelOn }) });
    const t = await res.json().catch(() => ({}));
    if (t.main?.url) store.del("agentOffice.shareBase");
    renderTunnel(t, t.error);
    $("#shareBase").value = shareBase();
    renderInvites();
  });
  $("#shareBtn").addEventListener("click", async () => {
    $("#serverKey").value = "";
    try { renderTunnel(await api("/api/tunnel")); } catch { /* older server */ }
    $("#shareBase").value = shareBase();
    await renderInvites();
    $("#share").showModal();
  });
  $("#shareBase").addEventListener("change", () => {
    const v = $("#shareBase").value.trim();
    if (v) store.set("agentOffice.shareBase", v); else store.del("agentOffice.shareBase");
    renderInvites();
  });
  $("#saveServerKey").addEventListener("click", async () => {
    await api("/api/server-key", { apiKey: $("#serverKey").value.trim() });
    $("#serverKey").value = "";
    renderInvites();
  });
  $("#createInvite").addEventListener("click", async () => {
    const inv = await api("/api/invites", { name: $("#inviteName").value.trim() || "เพื่อน", limit: Number($("#inviteLimit").value) || 200000 });
    $("#inviteName").value = "";
    await renderInvites();
    copyText(shareBase() + "/i/" + inv.code);
  });
  $("#inviteList").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) return copyText(c.dataset.copy, c);
    const r = e.target.closest("[data-revoke]");
    if (r) { await fetch(`/api/invites/${encodeURIComponent(r.dataset.revoke)}`, { method: "DELETE" }); renderInvites(); }
  });

  // ---------- token usage ----------
  let budget = { used: 0, exhausted: false };
  const when = (iso) => new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  function renderBudget(b) {
    if (!b) return;
    budget = b;
    const cap = !isGuest() && b.roundLimit ? ` / ~${fmt(b.roundLimit)}` : "";
    const onOwn = isGuest() && (b.onOwnKey || (b.exhausted && hasOwnKey()));
    $("#tokenText").textContent = onOwn
      ? `ใช้ key ของคุณ${b.ownUsed ? ` ${fmt(b.ownUsed)} tokens` : ""}`
      : b.exhausted ? (isGuest() ? "โควตาโทเค็นหมด" : "โทเค็นหมด") : `ใช้ไปแล้ว ${fmt(b.used)}${cap} tokens`;
    $("#tokenChip").classList.toggle("out", Boolean(b.exhausted) && !onOwn);
    const next = b.nextResetAt ? ` น่าจะรีเซ็ตราว ${when(b.nextResetAt)}` : "";
    $("#tokenChip").title = b.exhausted
      ? `ต้นทางแจ้งว่าโทเค็นหมด เมื่อต้นทางรีเซ็ตแล้วจะกลับมาใช้ได้และตัวนับเริ่มใหม่เอง${next}`
      : `นับตั้งแต่ ${b.since ? when(b.since) : "-"}${isGuest() && b.limit ? ` · โควตา ${fmt(b.limit)} tokens` : ""}${cap ? ` · ต้นทางให้ประมาณ ${fmt(b.roundLimit)} tokens ต่อรอบ` : ""}`;
    if ($("#usedText")) $("#usedText").textContent = `${fmt(b.used)} tokens`;
    if ($("#roundsText")) $("#roundsText").innerHTML = roundsSummary(b);
  }
  function span(ms) {
    const h = ms / 3600e3;
    return h >= 36 ? `${Math.round(h / 24)} วัน` : h >= 1 ? `${Math.round(h)} ชั่วโมง` : `${Math.max(1, Math.round(ms / 60e3))} นาที`;
  }
  /** What the past rounds taught us about the upstream limit (owner only). */
  function roundsSummary(b) {
    if (!b.roundLimit) {
      return b.lastReset?.reason === "upstream"
        ? `ยังไม่รู้ว่าต้นทางจำกัดกี่ token ต่อรอบ รอบนี้เริ่มนับตั้งแต่ต้นทางรีเซ็ต (${when(b.lastReset.at)}) พอใช้จนหมดแล้วต้นทางรีเซ็ตอีกครั้ง ระบบจะรู้และแสดงให้เอง`
        : "ยังไม่รู้ว่าต้นทางจำกัดกี่ token ต่อรอบ ระบบจะจำเองหลังโทเค็นหมดแล้วต้นทางรีเซ็ตครบ 2 ครั้ง (รอบแรกมักเริ่มนับกลางทาง จึงยังใช้วัดไม่ได้)";
    }
    const parts = [`ต้นทางให้ประมาณ <b>${fmt(b.roundLimit)}</b> tokens ต่อรอบ (ดูจาก ${b.roundsSeen} รอบที่ใช้จนหมด)`];
    if (b.periodMs) parts.push(`รีเซ็ตประมาณทุก ${span(b.periodMs)}`);
    if (b.nextResetAt) parts.push(`ครั้งถัดไปราว ${when(b.nextResetAt)}`);
    const last = (b.rounds || []).slice(-3).reverse().map((r) => `<li>${fmt(r.used)} tokens · ${when(r.from)} ถึง ${when(r.outAt || r.to)}</li>`).join("");
    return parts.join(" · ") + (last ? `<ul class="rounds-list">${last}</ul>` : "");
  }

  // ---------- examples + attachments ----------
  const EXAMPLES = [
    { label: "ร้านค้าออนไลน์", text: "สร้างเว็บไซต์ร้านค้าออนไลน์ขายเสื้อผ้า มีหน้ารวมสินค้าแยกหมวด ค้นหาและเรียงราคา หน้ารายละเอียดสินค้าเลือกไซซ์ ตะกร้า โค้ดส่วนลด หน้าชำระเงินพร้อมฟอร์มที่อยู่ และหน้าประวัติคำสั่งซื้อ" },
    { label: "ระบบจองห้องประชุม", text: "สร้างเว็บจองห้องประชุม แสดงตารางรายวัน จองช่วงเวลาได้ ห้ามจองซ้อนกัน ยกเลิกการจองได้ และสรุปการใช้ห้องรายสัปดาห์" },
    { label: "ตรวจเลขบัตรประชาชน", text: "เขียนฟังก์ชัน JavaScript ตรวจสอบเลขบัตรประชาชนไทย 13 หลักด้วย checksum รองรับรูปแบบที่มีขีดหรือเว้นวรรค" },
  ];
  $("#examples").innerHTML = EXAMPLES.map((e, i) => `<button type="button" data-ex="${i}">${esc(e.label)}</button>`).join("");
  $("#examples").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ex]");
    if (b) $("#task").value = EXAMPLES[b.dataset.ex].text;
  });

  let attached = [];
  const TEXT_EXT = /\.(html?|css|js|cjs|mjs|ts|tsx|jsx|json|md|txt|svg|xml|ya?ml|py|java|go|rb|php|cs|sql|env\.example|gitignore)$/i;
  async function readFiles(list) {
    const out = [];
    for (const f of list) {
      const p = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
      if (/(^|\/)(node_modules|\.git|dist|build)\//.test(p) || !TEXT_EXT.test(p) || f.size > 300_000) continue;
      out.push({ path: f.webkitRelativePath ? p.split("/").slice(1).join("/") : p, content: await f.text() });
    }
    return out.slice(0, 300);
  }
  for (const id of ["#fileInput", "#folderInput"]) {
    $(id).addEventListener("change", async (ev) => {
      attached = await readFiles(ev.target.files);
      $("#attachInfo").textContent = attached.length ? `แนบแล้ว ${attached.length} ไฟล์` : "ไม่มีไฟล์ข้อความที่ใช้ได้";
    });
  }

  // ---------- brief assistant ----------
  const brief = { idea: "", answers: [], current: null, picked: new Set() };
  function briefLog(html) {
    $("#briefLog").insertAdjacentHTML("beforeend", html);
    $("#briefLog").scrollTop = $("#briefLog").scrollHeight;
  }
  function renderOptions() {
    const q = brief.current;
    $("#briefOptions").innerHTML = (q?.options || []).map((o, i) =>
      `<button type="button" data-opt="${i}" class="${brief.picked.has(i) ? "on" : ""}">${brief.picked.has(i) ? icon("Check", 13) : ""}${esc(o)}</button>`).join("");
  }
  async function briefStep(finish = false) {
    $("#briefNext").disabled = true;
    $("#briefFinish").disabled = true;
    briefLog(`<div class="thinking-row" id="briefThinking">${avatar("pm", 22)}<span class="dots"><i></i><i></i><i></i></span></div>`);
    let r;
    try {
      r = await api("/api/brief", { idea: brief.idea, answers: brief.answers, finish, projectSlug: project?.slug, ...llmBody() });
    } catch (err) {
      r = { done: false, question: "", options: [], warning: err.message };
    }
    $("#briefThinking")?.remove();
    $("#briefNext").disabled = false;
    $("#briefFinish").disabled = false;
    if (r.usage) renderBudget(r.usage);
    $("#briefMode").textContent = r.mode === "claude" ? "Nina ใช้ Claude ช่วยคิดคำถาม" : `ชุดคำถามพื้นฐาน${r.warning ? ` (${r.warning})` : ""}`;
    if (r.done) {
      $("#briefAsk").hidden = true;
      $("#briefResult").hidden = false;
      $("#briefText2").value = r.brief;
      $("#briefName").value = r.projectName || "";
      briefLog(`<div class="bq">${avatar("pm", 28)}<div class="bubble-q">สรุปโจทย์ให้แล้วค่ะ ตรวจดูด้านล่าง แก้ได้ตามต้องการ</div></div>`);
      return;
    }
    brief.current = r;
    brief.picked.clear();
    briefLog(`<div class="bq">${avatar("pm", 28)}<div class="bubble-q">${esc(r.question)}</div></div>`);
    renderOptions();
    $("#briefText").value = "";
    $("#briefText").focus();
  }
  function openBrief() {
    brief.idea = $("#task").value.trim();
    brief.answers = [];
    brief.current = null;
    $("#briefTitle").textContent = project ? `ช่วยคิดว่าจะเพิ่มหรือแก้อะไรใน "${project.name}"` : "ช่วยคิดโจทย์กับ Nina";
    $("#briefLog").innerHTML = brief.idea
      ? `<div class="ba">${esc(brief.idea)}</div>`
      : "";
    $("#briefAsk").hidden = false;
    $("#briefResult").hidden = true;
    $("#brief").showModal();
    briefStep();
  }
  $("#briefBtn").addEventListener("click", openBrief);
  $("#briefRestart").addEventListener("click", openBrief);
  $("#briefOptions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-opt]");
    if (!b) return;
    const i = Number(b.dataset.opt);
    if (brief.current?.multi) { brief.picked.has(i) ? brief.picked.delete(i) : brief.picked.add(i); renderOptions(); }
    else { brief.picked = new Set([i]); submitAnswer(); }
  });
  function submitAnswer() {
    if (!brief.current) return;
    const chosen = [...brief.picked].map((i) => brief.current.options[i]);
    const typed = $("#briefText").value.trim();
    const answer = [...chosen, typed].filter(Boolean).join(", ") || "ไม่แน่ใจ ให้ทีมเลือกให้";
    brief.answers.push({ question: brief.current.question, answer });
    briefLog(`<div class="ba">${esc(answer)}</div>`);
    $("#briefOptions").innerHTML = "";
    brief.current = null;
    briefStep();
  }
  $("#briefNext").addEventListener("click", submitAnswer);
  $("#briefText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitAnswer(); } });
  $("#briefFinish").addEventListener("click", () => {
    if (brief.current && ($("#briefText").value.trim() || brief.picked.size)) {
      const chosen = [...brief.picked].map((i) => brief.current.options[i]);
      brief.answers.push({ question: brief.current.question, answer: [...chosen, $("#briefText").value.trim()].filter(Boolean).join(", ") });
    }
    $("#briefOptions").innerHTML = "";
    briefStep(true);
  });
  $("#briefUse").addEventListener("click", () => {
    $("#task").value = $("#briefText2").value.trim();
    if (!project && $("#briefName").value.trim()) $("#projectName").value = $("#briefName").value.trim();
    $("#brief").close();
    $("#task").focus();
  });

  // ---------- pipeline ----------
  const PHASES = [
    { id: "kickoff", icon: "Users", label: "Kick-off", who: "ทั้งทีม" },
    { id: "analyze", icon: "ClipboardList", label: "Requirement", who: "Nina" },
    { id: "plan", icon: "LayoutTemplate", label: "ออกแบบ/แตกงาน", who: "Archie" },
    { id: "build", icon: "Code", label: "เขียนโค้ด", who: "Mia + Ben" },
    { id: "tests", icon: "FlaskConical", label: "เขียนเทสต์", who: "Tessa" },
    { id: "run", icon: "Play", label: "รันเทสต์", who: "QA Lab" },
    { id: "debug", icon: "Bug", label: "แก้บั๊ก", who: "Max" },
    { id: "review", icon: "ScanSearch", label: "Code review", who: "Rex" },
    { id: "signoff", icon: "BadgeCheck", label: "ส่งมอบ", who: "Nina" },
  ];
  const phaseState = {};
  function renderPipeline() {
    $("#pipeline").innerHTML = PHASES.map((p) => {
      const s = phaseState[p.id] || {};
      return `<li class="step ${s.state || ""}"><span class="ico-wrap">${icon(p.icon, 15)}</span><div><b>${esc(p.label)}</b><small>${esc(s.note || p.who)}</small></div></li>`;
    }).join("");
    office.kanbanSet(PHASES.map((p) => ({ label: p.label, state: phaseState[p.id]?.state })));
  }

  // ---------- roster ----------
  const STATUS_TH = { idle: "ว่าง", thinking: "กำลังคิด", typing: "กำลังพิมพ์", running: "กำลังรันเทสต์" };
  $("#roster").innerHTML = ORDER.map((id) => {
    const t = TEAM[id];
    return `<div class="member" id="m-${id}" style="--c:${t.color}">${avatar(id, 30)}<div><b>${t.name}</b><small>${t.short} · ${t.th}</small><div class="st">${STATUS_TH.idle}</div></div></div>`;
  }).join("");
  function setMember(id, state) {
    const m = $(`#m-${id}`);
    if (!m) return;
    m.querySelector(".st").textContent = STATUS_TH[state] || state;
    m.classList.toggle("busy", state !== "idle");
  }

  // ---------- chat ----------
  const chat = $("#chat");
  const nameList = (to) => (to === "all" ? "ทุกคน" : (to || []).map((id) => TEAM[id]?.name).filter(Boolean).join(", "));
  function chatMsg(from, to, text) {
    const t = TEAM[from];
    chat.querySelector(".empty")?.remove();
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `${avatar(from, 32)}<div class="body"><div class="who">${t.name} <span>${t.short}${to ? " → " + esc(nameList(to)) : ""} · ${time()}</span></div><div class="text">${esc(text)}</div></div>`;
    chat.append(div);
    chat.scrollTop = chat.scrollHeight;
  }
  function chatSys(text, cls = "", ic = "") {
    chat.querySelector(".empty")?.remove();
    const div = document.createElement("div");
    div.className = "sys " + cls;
    div.innerHTML = `${ic ? icon(ic, 13) : ""}<span>${esc(text)}</span>`;
    chat.append(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // ---------- work: tasks + documents ----------
  let tasks = [];
  function renderTasks() {
    if (!tasks.length) return;
    const STATE = { active: ["Loader", "กำลังทำ"], done: ["CircleCheck", "เสร็จ"], failed: ["CircleAlert", "ไม่มีไฟล์"], todo: ["Circle", "รอ"] };
    $("#taskList").innerHTML = tasks.map((t) => {
      const [ic, label] = STATE[t.state || "todo"];
      return `<div class="task ${t.state || ""}">${avatar(t.owner, 28)}<div><b>${esc(t.id)} · ${esc(t.title)}</b><small>${esc(t.files.join(", ") || "ตามดีไซน์")}${t.depends.length ? ` · รอ ${esc(t.depends.join(", "))}` : ""}</small></div><span class="state">${t.state === "active" ? `<span class="spin">${icon(ic, 13)}</span>` : icon(ic, 13)}${label}</span></div>`;
    }).join("");
  }
  const DOCS = [
    { id: "spec", label: "Spec", icon: "ClipboardList" }, { id: "design", label: "Design", icon: "LayoutTemplate" },
    { id: "debug", label: "Debug", icon: "Bug" }, { id: "review", label: "Review", icon: "ScanSearch" },
    { id: "summary", label: "สรุปงาน", icon: "BadgeCheck" },
  ];
  const docs = {};
  let currentDoc = null;
  function renderDocs() {
    $("#docTabs").innerHTML = DOCS.filter((d) => docs[d.id]).map((d) =>
      `<button data-doc="${d.id}" class="${d.id === currentDoc ? "active" : ""}">${icon(d.icon, 13)}${d.label}${docs[d.id].version > 1 ? ` v${docs[d.id].version}` : ""}</button>`).join("");
    const d = docs[currentDoc];
    $("#docView").innerHTML = d
      ? `<div class="meta">${avatar(d.by, 20)} ${esc(TEAM[d.by]?.name || "")} · เวอร์ชัน ${d.version}</div>${md(d.content)}`
      : `<p class="muted small">เอกสารจากทีมจะแสดงที่นี่</p>`;
  }
  $("#docTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-doc]"); if (b) { currentDoc = b.dataset.doc; renderDocs(); } });

  // ---------- files ----------
  const files = {};
  let currentFile = null;
  let project = null; // { slug, name, dir, demoPath }
  function fileIcon(p) {
    if (/\.html?$/.test(p)) return "FileCode2";
    if (/\.css$/.test(p)) return "Palette";
    if (/test\.c?js$/.test(p)) return "FlaskConical";
    if (/\.(c?js|mjs|ts)$/.test(p)) return "FileCode";
    if (/\.json$/.test(p)) return "Braces";
    return "FileText";
  }
  function renderTree(flash) {
    const paths = Object.keys(files).sort((a, b) => {
      const da = a.includes("/"), db = b.includes("/");
      return da === db ? a.localeCompare(b) : da ? 1 : -1;
    });
    let lastDir = null;
    const rows = [];
    for (const p of paths) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      if (dir !== lastDir) { if (dir) rows.push(`<li class="dir">${icon("Folder", 13)}${esc(dir)}/</li>`); lastDir = dir; }
      const f = files[p];
      const color = TEAM[f.by]?.color || "#999";
      rows.push(`<li><button data-file="${esc(p)}" class="${p === currentFile ? "active" : ""} ${p === flash ? "flash" : ""}">${icon(fileIcon(p), 13)}<span class="name">${esc(p.split("/").pop())}</span><span class="who" style="--c:${color}" title="${esc(TEAM[f.by]?.name || "ไฟล์เดิม")}"></span></button></li>`);
    }
    $("#fileTree").innerHTML = rows.join("");
    $("#fileCount").hidden = !paths.length;
    $("#fileCount").textContent = paths.length;
    $("#filesInfo").textContent = paths.length ? `${paths.length} ไฟล์` : "ยังไม่มีไฟล์";
  }
  function showFile(p) {
    currentFile = p;
    const f = files[p];
    if (!f) return;
    $("#fileHead").innerHTML = `${icon(fileIcon(p), 13)}<span>${esc(p)}</span><span>· v${f.version} · ${esc(TEAM[f.by]?.name || "ไฟล์เดิม")}</span>`;
    $("#fileBody").textContent = f.content;
    renderTree();
  }
  $("#fileTree").addEventListener("click", (e) => { const b = e.target.closest("[data-file]"); if (b) showFile(b.dataset.file); });
  // Long lines wrap by default so nothing hides past the edge; toggle for raw layout.
  const wrapOn = store.get("agentOffice.wrap") !== false;
  $("#fileBody").classList.toggle("wrap", wrapOn);
  $("#wrapToggle").classList.toggle("active", wrapOn);
  $("#wrapToggle").addEventListener("click", () => {
    const on = !$("#fileBody").classList.contains("wrap");
    $("#fileBody").classList.toggle("wrap", on);
    $("#wrapToggle").classList.toggle("active", on);
    $("#wrapToggle").title = on ? "ตัดบรรทัดอยู่ (กดเพื่อเลื่อนซ้ายขวาแทน)" : "ไม่ตัดบรรทัด (กดเพื่อตัดบรรทัด)";
    store.set("agentOffice.wrap", on);
  });

  // ---------- tests ----------
  const rounds = [];
  function renderTests() {
    const r = rounds.at(-1);
    if (!r) return;
    const fails = r.results.filter((x) => !x.ok), oks = r.results.filter((x) => x.ok);
    $("#testView").innerHTML = `
      <div class="test-summary">
        <div class="stat ${r.ok ? "ok" : "bad"}"><b>${r.passed}/${r.total}</b><small>ผ่านทั้งหมด</small></div>
        <div class="stat"><b>${r.testCount}</b><small>เทสต์อัตโนมัติ</small></div>
        <div class="stat"><b>${r.total - r.testCount}</b><small>ตรวจไฟล์ (syntax/ลิงก์)</small></div>
      </div>
      <div class="rounds">${rounds.map((x) => `<span class="round ${x.ok ? "ok" : "bad"}">${icon(x.ok ? "CircleCheck" : "CircleX", 12)}รอบ ${x.round}: ${x.passed}/${x.total}</span>`).join("")}</div>
      ${[...fails, ...oks].map((x) => `<div class="result ${x.ok ? "ok" : "bad"}">${icon(x.ok ? "Check" : "X", 14)}<div>${esc(x.name)}${x.ok ? "" : `<pre>${esc(x.error)}</pre>`}</div></div>`).join("")}`;
  }

  // ---------- preview + sharing ----------
  let previewTimer = 0;
  const hasPage = () => Object.keys(files).some((p) => p.endsWith(".html"));
  /** Link other people can open: the LAN address when browsing on localhost, else this origin. */
  function shareUrl(demoPath) {
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    return (local ? shareBase() : location.origin) + demoPath;
  }
  // Each project runs as its own website on its own port. Through the outside link (a
  // domain name instead of an IP) that port is unreachable, so the app gets its own
  // https link instead; /p/ is the last fallback.
  const directHost = () => /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(location.hostname);
  let appState = null;
  async function refreshPreview(force) {
    if (!project || !hasPage()) return;
    const slug = project.slug;
    let url = project.demoPath, share = shareUrl(project.demoPath);
    $("#previewInfo").textContent = directHost() ? "กำลังเปิดแอป…" : "กำลังเปิดแอปและสร้างลิงก์ของแอป (ครั้งแรกใช้เวลาสักครู่)…";
    try { appState = await api(`/api/projects/${encodeURIComponent(slug)}/app`); } catch { appState = null; }
    if (project?.slug !== slug) return;
    const pub = appState?.running && appState.publicUrl ? appState.publicUrl.replace(/\/+$/, "") + "/" : "";
    if (appState?.running && directHost()) {
      url = `${location.protocol}//${location.hostname}:${appState.port}/`;
      share = pub || `${new URL(shareBase()).protocol}//${new URL(shareBase()).hostname}:${appState.port}/`;
    } else if (pub) {
      url = share = pub;
    }
    $("#openPreview").href = url;
    $("#openDemoTop").href = url;
    for (const id of ["#openPreview", "#copyLink", "#demoLink", "#restartApp"]) $(id).hidden = false;
    $("#reloadPreview").disabled = false;
    $("#demoLink").textContent = share;
    const canShareOut = config.role === "owner" && directHost() && appState?.running;
    $("#appTunnel").hidden = !canShareOut;
    $("#appTunnel").querySelector("span").textContent = pub ? "ปิดลิงก์นอกบ้านของแอป" : "แชร์แอปนี้ออกนอกบ้าน";
    const broken = appState && !appState.running && (directHost() || appState.error);
    $("#previewInfo").textContent = broken
      ? `แอปเปิดไม่ขึ้น: ${appState.error || appState.reason || "ไม่ทราบสาเหตุ"}`
      : !directHost() && pub ? "แอปนี้มีลิงก์ของตัวเอง สมัครและ login ได้จริง ถ้า login ในกรอบนี้ไม่ติด กด \"เปิด\" เพื่อใช้ในแท็บใหม่"
      : pub ? "แอปนี้มีลิงก์ https ของตัวเองแล้ว ส่งลิงก์นี้ให้ใครก็ได้ แม้อยู่นอกบ้าน"
      : appState?.kind === "app" ? "แอปจริง (มีเซิร์ฟเวอร์และฐานข้อมูล) ลิงก์นี้ส่งให้คนในวง Wi-Fi เดียวกันลองได้" : "ลิงก์เดโม่สำหรับแชร์";
    $("#appLog").hidden = !(broken && appState.logs);
    $("#appLog").textContent = broken ? appState.logs || "" : "";
    if (force || $(".tab[data-tab=preview]").classList.contains("active")) $("#previewFrame").src = url;
  }
  $("#reloadPreview").addEventListener("click", () => refreshPreview(true));
  $("#appTunnel").addEventListener("click", async () => {
    if (!project) return;
    const on = !appState?.publicUrl;
    const btn = $("#appTunnel");
    btn.disabled = true;
    $("#previewInfo").textContent = on ? "กำลังสร้างลิงก์ https ของแอป (ไม่เกิน 30 วินาที)…" : "กำลังปิดลิงก์…";
    const res = await fetch(`/api/projects/${encodeURIComponent(project.slug)}/app/tunnel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
    const r = await res.json().catch(() => ({}));
    btn.disabled = false;
    await refreshPreview(false);
    if (!res.ok && r.error) $("#previewInfo").textContent = r.error;
  });
  $("#restartApp").addEventListener("click", async () => {
    if (!project) return;
    $("#previewInfo").textContent = "กำลังรีสตาร์ทแอป…";
    await api(`/api/projects/${encodeURIComponent(project.slug)}/app/restart`, {}).catch(() => {});
    refreshPreview(true);
  });

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    if (btn) { const old = btn.innerHTML; btn.innerHTML = `${icon("Check", 14)}คัดลอกแล้ว`; setTimeout(() => (btn.innerHTML = old), 1500); }
  }
  $("#copyLink").addEventListener("click", (e) => copyText($("#demoLink").textContent, e.currentTarget));
  $("#copyLinkTop").addEventListener("click", (e) => project && copyText(shareUrl(project.demoPath), e.currentTarget));

  /** Write every project file into a folder the user picks (Chrome / Edge). */
  async function saveToLocalFolder(slug) {
    if (!window.showDirectoryPicker) {
      alert("เบราว์เซอร์นี้ยังไม่รองรับการเลือกโฟลเดอร์ ใช้ Chrome หรือ Edge หรือดาวน์โหลด .zip แทน");
      return;
    }
    let root;
    try { root = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return; }
    const { files: all } = await api(`/api/projects/${encodeURIComponent(slug)}/files`);
    const top = await root.getDirectoryHandle(slug, { create: true });
    for (const [p, content] of Object.entries(all)) {
      const parts = p.split("/");
      let dir = top;
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(content);
      await w.close();
    }
    chatSys(`บันทึก ${Object.keys(all).length} ไฟล์ลงโฟลเดอร์ ${root.name}/${slug} แล้ว`, "good", "HardDriveDownload");
  }
  $("#saveLocalBtn").addEventListener("click", () => project && saveToLocalFolder(project.slug));

  // ---------- live streams ----------
  const streams = {};
  function stream(id) {
    if (!streams[id]) {
      $("#liveView .empty")?.remove();
      const t = TEAM[id];
      const box = document.createElement("section");
      box.className = "stream";
      box.innerHTML = `<header>${avatar(id, 22)}${t.name} <span class="muted">${t.short}</span><span class="state"></span></header><pre></pre>`;
      $("#liveView").prepend(box);
      streams[id] = { box, pre: box.querySelector("pre"), state: box.querySelector(".state") };
    }
    return streams[id];
  }

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab));
    if (tab.dataset.tab === "work") tab.querySelector(".dot").hidden = true;
    if (tab.dataset.tab === "preview") refreshPreview(true);
  }));
  const markWork = () => { if (!$(".tab[data-tab=work]").classList.contains("active")) $(".tab[data-tab=work] .dot").hidden = false; };

  // ---------- projects sidebar ----------
  const STATUS_LABEL = { passed: "ผ่าน", running: "กำลังทำ", "needs-work": "ยังไม่ผ่าน", failed: "ล้มเหลว", cancelled: "หยุดแล้ว", interrupted: "ถูกขัดจังหวะ" };
  let projectList = [];
  async function loadProjects() {
    try {
      const { dir, projects } = await api("/api/projects");
      projectList = projects;
      renderProjectNav();
    } catch { /* server not ready */ }
  }
  function renderProjectNav() {
    $("#projectNav").innerHTML = projectList.length ? projectList.map((p) => `
      <button data-slug="${esc(p.slug)}" class="${project?.slug === p.slug ? "active" : ""}">
        <span class="sdot ${esc(p.status || "")}" title="${esc(STATUS_LABEL[p.status] || "")}"></span>
        <span class="nm">${esc(p.name || p.slug)}</span>
        <small>${(p.jobs || []).length} รอบงาน · ${p.updatedAt ? new Date(p.updatedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : ""}</small>
        ${config.role === "guest" && p.owner !== config.userId ? `<span class="shared">แชร์กับคุณ</span>` : (p.members || []).length ? `<span class="shared">เพื่อนร่วมแก้ ${(p.members || []).length} คน</span>` : ""}
      </button>`).join("") : `<p class="muted small pad">ยังไม่มีโปรเจกต์</p>`;
  }
  $("#projectNav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-slug]");
    if (b) { openProject(b.dataset.slug); closeSidebar(); }
  });
  $("#newProjectBtn").addEventListener("click", () => { newProject(); closeSidebar(); });
  const closeSidebar = () => { $("#sidebar").classList.remove("open"); $("#sidebarScrim").hidden = true; };
  $("#openSidebar").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#sidebarScrim").hidden = false; });
  $("#closeSidebar").addEventListener("click", closeSidebar);
  $("#sidebarScrim").addEventListener("click", closeSidebar);

  function setHeader() {
    $("#projectTitle").textContent = project ? project.name : "โปรเจกต์ใหม่";
    $("#projectSub").textContent = project ? "ดูทีมทำงาน สั่งงานเพิ่ม หรือทำต่อจากรอบที่ค้างได้" : "ทีม AI ที่วิเคราะห์ เขียนโค้ด ทดสอบ รีวิว และแก้บั๊ก จนกว่างานจะผ่าน";
    $("#taskLabel").textContent = project ? `สั่งงานเพิ่มในโปรเจกต์นี้ (ทีมจะแก้ต่อจากไฟล์ล่าสุด)` : "งานจากลูกค้า";
    $("#nameField").hidden = Boolean(project);
    renderProjectNav();
  }

  // ---------- project sharing + delete ----------
  let projectMeta = null;
  const isMine = (meta) => config.role === "owner" || (meta && meta.owner === config.userId);
  function renderProjectActions(meta) {
    projectMeta = meta;
    const members = meta?.members || [];
    $("#membersBtn").hidden = !project;
    $("#deleteProjectBtn").hidden = !project || !isMine(meta);
    const badge = $("#sharedBadge");
    if (project && config.role === "guest" && meta?.owner !== config.userId) {
      badge.hidden = false;
      badge.querySelector("span").textContent = `แชร์โดย ${meta?.ownerName || "เจ้าของเครื่อง"}`;
    } else if (project && members.length) {
      badge.hidden = false;
      badge.querySelector("span").textContent = `เพื่อนร่วมแก้ ${members.length} คน`;
    } else {
      badge.hidden = true;
    }
  }

  /** Owner: every friend with a checkbox. Friends: who is in the project, plus links they created. */
  async function renderMembers() {
    const slug = encodeURIComponent(project.slug);
    const info = await api(`/api/projects/${slug}/members`);
    $("#memberQuota").textContent = isGuest() ? `โควตาของเพื่อนที่ชวนจะแบ่งจากโควตาของคุณ (เหลือ ${fmt(info.yourRemaining)} tokens)` : "";
    if (config.role === "owner") {
      const { invites } = await api("/api/invites");
      const members = new Set(projectMeta?.members || []);
      $("#memberList").innerHTML = invites.length ? invites.map((i) => `
        <label class="member-row">
          <input type="checkbox" data-member="${esc(i.code)}" ${members.has("guest:" + i.code) ? "checked" : ""}>
          <span class="grow"><b>${esc(i.name)}</b><small>ใช้ไป ${fmt(i.used)} / ${fmt(i.limit)} tokens${i.invitedBy ? " · ชวนโดยเพื่อน" : ""}</small></span>
          <button type="button" class="btn small ghost" data-copy="${esc(projectInviteUrl(i.code))}">${icon("Copy", 13)}ลิงก์</button>
        </label>`).join("") : `<p class="muted small">ยังไม่มีเพื่อน ชวนด้านล่างได้เลย</p>`;
      return;
    }
    $("#memberList").innerHTML = `<div class="member-row"><span class="grow"><b>${esc(info.owner)}</b><small>เจ้าของโปรเจกต์</small></span></div>` +
      info.members.map((m) => `
        <div class="member-row">
          <span class="grow"><b>${esc(m.name)}${m.you ? " (คุณ)" : ""}</b><small>ชวนโดย ${esc(m.invitedBy || "-")}</small></span>
          ${m.code ? `<button type="button" class="btn small ghost" data-copy="${esc(projectInviteUrl(m.code))}">${icon("Copy", 13)}ลิงก์</button>` : ""}
        </div>`).join("");
  }
  const projectInviteUrl = (code) => `${isGuest() ? location.origin : shareBase()}/i/${code}${project ? `?p=${encodeURIComponent(project.slug)}` : ""}`;

  $("#membersBtn").addEventListener("click", async () => {
    if (!project) return;
    $("#membersProject").textContent = project.name;
    $("#newLinks").innerHTML = "";
    $("#memberNote").textContent = config.serverHasKey ? "" : "ยังไม่ได้ตั้ง key สำหรับเพื่อน (ปุ่ม แชร์ให้เพื่อน) เพื่อนจะดูได้แต่สั่งงานไม่ได้";
    await renderMembers();
    $("#members").showModal();
  });
  $("#memberList").addEventListener("change", async (e) => {
    const box = e.target.closest("[data-member]");
    if (!box || !project) return;
    const { members } = await api(`/api/projects/${encodeURIComponent(project.slug)}/members`, { code: box.dataset.member, add: box.checked });
    renderProjectActions({ ...projectMeta, members });
  });
  for (const id of ["#memberList", "#newLinks"]) {
    $(id).addEventListener("click", (e) => {
      const c = e.target.closest("[data-copy]");
      if (c) { e.preventDefault(); copyText(c.dataset.copy, c); }
    });
  }
  $("#createMember").addEventListener("click", async () => {
    if (!project) return;
    const names = $("#memberName").value.trim() || "เพื่อน";
    const res = await fetch(`/api/projects/${encodeURIComponent(project.slug)}/invite`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, limit: Number($("#memberLimit").value) || 100000 }),
    });
    const data = await res.json();
    const created = data.created || [];
    $("#newLinks").innerHTML = created.map((c) => `
      <div class="member-row"><span class="grow"><b>${esc(c.name)}</b><small>${fmt(c.limit)} tokens</small><code class="link-box">${esc(projectInviteUrl(c.code))}</code></span>
      <button type="button" class="btn small ghost" data-copy="${esc(projectInviteUrl(c.code))}">${icon("Copy", 13)}คัดลอก</button></div>`).join("");
    if (created.length) await copyText(created.map((c) => `${c.name}: ${projectInviteUrl(c.code)}`).join("\n"));
    $("#memberNote").textContent = data.error
      ? `${created.length ? `สร้างได้ ${created.length} คน · ` : ""}${data.error}`
      : `สร้างลิงก์ ${created.length} คนแล้ว และคัดลอกทั้งหมดไว้ให้ ส่งให้แต่ละคนเปิดได้เลย`;
    $("#memberName").value = "";
    const meta = await api(`/api/projects/${encodeURIComponent(project.slug)}`);
    renderProjectActions(meta);
    await renderMembers();
    loadProjects();
  });

  $("#deleteProjectBtn").addEventListener("click", async () => {
    if (!project) return;
    if (!confirm(`ลบโปรเจกต์ "${project.name}" พร้อมไฟล์และประวัติทั้งหมด? กู้คืนไม่ได้`)) return;
    try {
      await fetch(`/api/projects/${encodeURIComponent(project.slug)}`, { method: "DELETE" }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      newProject();
      await loadProjects();
    } catch (err) {
      chatSys(err.message, "bad", "OctagonAlert");
    }
  });

  function renderJobs(meta, activeId) {
    renderProjectActions(meta);
    const jobs = meta?.jobs || [];
    $("#jobBar").hidden = !project;
    $("#jobPills").innerHTML = jobs.map((j, i) => `<button data-job="${esc(j.id)}" class="${j.id === activeId ? "active" : ""}" title="${esc(j.task || "")}"><span class="sdot ${esc(j.status || "")}"></span><span>รอบ ${i + 1} · ${esc((j.task || "").slice(0, 28))}</span></button>`).join("");
    $("#openDemoTop").href = project?.demoPath || "#";
    // The latest round stopped part-way: offer to continue it instead of starting over.
    const last = jobs.at(-1);
    latestJobId = last?.id || null;
    resumable = last && !meta?.runningJob && RESUMABLE.includes(last.status) ? last.id : null;
    $("#resumeBtn").hidden = !resumable;
  }
  const RESUMABLE = ["interrupted", "failed", "cancelled", "out-of-tokens"];
  let resumable = null, latestJobId = null;
  $("#resumeBtn").addEventListener("click", async () => {
    if (!project || !resumable) return;
    if (!connected()) { fillSettings(); $("#settings").showModal(); return; }
    try {
      const data = await api("/api/jobs", { projectSlug: project.slug, resumeJobId: resumable, task: "", ...llmBody() });
      resetView();
      renderJobs(await api(`/api/projects/${encodeURIComponent(project.slug)}`), data.id);
      connect(data.id, project.slug);
      loadProjects();
    } catch (err) {
      chatSys(err.message, "bad", "OctagonAlert");
    }
  });
  $("#jobPills").addEventListener("click", (e) => {
    const b = e.target.closest("[data-job]");
    if (!b || !project) return;
    resetView();
    connect(b.dataset.job, project.slug);
    $("#jobPills").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
  });

  async function openProject(slug) {
    let meta;
    try { meta = await api(`/api/projects/${encodeURIComponent(slug)}`); } catch (err) { chatSys(err.message, "bad", "OctagonAlert"); return; }
    stopStream();
    resetView();
    project = { slug, name: meta.name || slug, demoPath: meta.demoPath };
    store.set("agentOffice.project", slug, sessionStorage);
    setHeader();
    const jobId = meta.runningJob || meta.jobs?.at(-1)?.id;
    renderJobs(meta, jobId);
    if (jobId) connect(jobId, slug);
    else chatSys("โปรเจกต์นี้ยังไม่มีประวัติงาน", "", "Info");
    $("#task").value = "";
  }

  function newProject() {
    stopStream();
    resetView();
    project = null;
    store.del("agentOffice.project", sessionStorage);
    $("#projectName").value = "";
    $("#task").value = "";
    $("#jobBar").hidden = true;
    renderProjectActions(null);
    setHeader();
    setRunning(false);
  }

  // ---------- event playback ----------
  // Events play in order; walking and talking take real time so the story is watchable.
  // Events older than the moment we connected (history, reloads) are replayed fast.
  const queue = [];
  let pumping = false, connectedAt = 0, generation = 0;
  function enqueue(e, gen) { queue.push([e, gen]); if (!pumping) pump(); }
  async function pump() {
    pumping = true;
    while (queue.length) {
      const [e, gen] = queue.shift();
      if (gen !== generation) continue; // from a stream we already left
      office.fast = e.t < connectedAt - 1500;
      try { await handle(e); } catch (err) { console.error(err, e); }
    }
    office.fast = false;
    pumping = false;
  }
  const wait = (ms) => (office.fast || document.hidden ? null : sleep(ms));
  // Wait for characters to finish walking, but never stall the story: animations
  // pause in a hidden tab, and replays must not wait at all.
  const arrive = (ids) => (office.fast || document.hidden ? null : Promise.race([office.arrived(ids), sleep(4000)]));

  async function handle(e) {
    switch (e.type) {
      case "project":
        if (!project || project.slug !== e.slug) project = { slug: e.slug, name: e.name, demoPath: e.demoPath };
        $("#saveLocalBtn").hidden = false;
        $("#zipBtn").hidden = false;
        $("#zipBtn").href = `/api/projects/${encodeURIComponent(e.slug)}/project.zip`;
        chatSys(e.resume ? "ทำงานต่อจากรอบที่ค้าง" : e.followUp ? `สั่งงานเพิ่ม: ${e.task}` : "เริ่มโปรเจกต์ใหม่", "", e.resume ? "Play" : e.followUp ? "MessageSquarePlus" : "FolderOpen");
        break;
      case "init":
        chatSys("ทีมรวมตัวที่ห้องประชุม", "", "Inbox");
        break;
      case "phase": {
        phaseState[e.id] = { state: e.state, note: e.note };
        renderPipeline();
        const p = PHASES.find((x) => x.id === e.id);
        if (e.state === "active" && p && !(e.id === "build" && e.note)) chatSys(`${p.label}${e.note ? ` · ${e.note}` : ""}`, "", p.icon);
        await wait(120);
        break;
      }
      case "move":
        office.moveTo(e.agent, e.to);
        await wait(50);
        break;
      case "status": {
        office.setStatus(e.agent, e.state);
        setMember(e.agent, e.state);
        const s = stream(e.agent);
        if (e.state === "thinking") { s.pre.textContent = ""; s.box.classList.remove("done"); $("#liveView").prepend(s.box); }
        s.state.textContent = STATUS_TH[e.state] || "";
        s.box.classList.toggle("done", e.state === "idle");
        break;
      }
      case "delta": {
        const s = stream(e.agent);
        s.pre.textContent += e.text;
        if (s.pre.textContent.length > 60000) s.pre.textContent = s.pre.textContent.slice(-40000);
        s.pre.scrollTop = s.pre.scrollHeight;
        break;
      }
      case "say": {
        const to = e.to === "all" ? ORDER.filter((id) => id !== e.from) : e.to;
        await arrive([e.from]);
        office.say(e.from, e.text, nameList(e.to));
        office.react(to, "nod");
        chatMsg(e.from, e.to, e.text);
        await wait(Math.min(5000, 1500 + e.text.length * 26));
        break;
      }
      case "doc":
        docs[e.name] = { content: e.content, by: e.by, version: (docs[e.name]?.version || 0) + 1 };
        if (e.name !== "report") { currentDoc = e.name; renderDocs(); markWork(); }
        if (e.name === "spec" || e.name === "design") office.boardDone(true);
        break;
      case "tasks":
        tasks = e.tasks.map((t) => ({ ...t, state: "todo" }));
        renderTasks();
        markWork();
        chatSys(`แตกงานเป็น ${tasks.length} งานย่อย`, "", "ListChecks");
        break;
      case "task": {
        const t = tasks.find((x) => x.id === e.id);
        if (t) { t.state = e.state; renderTasks(); }
        break;
      }
      case "file":
        files[e.path] = { content: e.content, by: e.by, version: (files[e.path]?.version || 0) + 1 };
        if (!currentFile || currentFile === e.path) showFile(e.path); else renderTree(e.path);
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => refreshPreview(false), 1200);
        break;
      case "test": {
        await arrive(["qa"]);
        rounds.push(e);
        renderTests();
        office.lab(e.ok ? "pass" : "fail", e);
        if (e.ok) { office.react(["qa"], "jump"); office.emote("qa", "PartyPopper", "good"); }
        else { office.react(["qa"], "shake"); office.emote("qa", "TriangleAlert", "bad"); }
        chatSys(e.ok ? `รอบ ${e.round}: ผ่านทั้งหมด ${e.passed}/${e.total}` : `รอบ ${e.round}: ไม่ผ่าน ${e.failed} จาก ${e.total} รายการ`, e.ok ? "good" : "bad", e.ok ? "CircleCheck" : "CircleX");
        await wait(1300);
        break;
      }
      case "budget":
        if (!office.fast) renderBudget(e);
        break;
      case "done":
        await arrive(["pm"]);
        if (e.success) {
          if (!office.fast) office.confetti();
          office.react(ORDER, "jump");
          chatSys(`ส่งมอบงานสำเร็จ · ${e.fileCount} ไฟล์ · แก้บั๊ก ${e.fixRounds} รอบ`, "good", "BadgeCheck");
        } else {
          chatSys("ทีมยังทำงานไม่ผ่านทั้งหมด ดูผลเทสต์และสรุปในแท็บงาน", "bad", "TriangleAlert");
        }
        if (docs.summary) { currentDoc = "summary"; renderDocs(); markWork(); }
        if (e.preview && project) chatSys(`ลิงก์เดโม่: ${shareUrl(project.demoPath)}`, "good", "Link");
        refreshPreview(false);
        await wait(2000);
        break;
      case "notice":
        chatSys(e.message, "", "RotateCw");
        break;
      case "error":
        chatSys(e.message, "bad", "OctagonAlert");
        ORDER.forEach((id) => { office.setStatus(id, "idle"); setMember(id, "idle"); });
        if (e.resumable) office.lab("idle");
        // Only the latest round can be continued: resuming an older one would overwrite newer work.
        if (e.resumable && latestJobId && jobId !== latestJobId) chatSys("รอบนี้ทำต่อไม่ได้แล้ว เพราะมีรอบที่ใหม่กว่าทำงานต่อจากไฟล์ล่าสุดไปแล้ว ถ้ายังขาดอะไร ให้สั่งงานเพิ่มได้เลย", "", "Info");
        break;
      case "end":
        finishStream();
        break;
    }
  }

  // ---------- connect / start / cancel ----------
  let source = null, jobId = null;
  function setRunning(on) {
    office.busy = on;
    $("#startBtn").disabled = on;
    $("#startBtn").querySelector("span").textContent = on ? "ทีมกำลังทำงาน…" : (project ? "สั่งงานเพิ่ม" : "มอบหมายงาน");
    $("#cancelBtn").hidden = !on;
  }
  function stopStream() {
    source?.close();
    source = null;
    generation++;
    queue.length = 0;
  }
  async function finishStream() {
    source?.close();
    source = null;
    setRunning(false);
    await loadProjects();
    if (project) {
      try { renderJobs(await api(`/api/projects/${encodeURIComponent(project.slug)}`), jobId); } catch { /* ignore */ }
    }
  }

  function resetView() {
    for (const o of [phaseState, docs, files, streams]) for (const k of Object.keys(o)) delete o[k];
    tasks = []; rounds.length = 0; currentDoc = null; currentFile = null;
    renderPipeline(); renderDocs(); renderTree();
    $("#taskList").innerHTML = `<p class="muted small">Tech Lead จะแตกงานหลังวิเคราะห์ requirement</p>`;
    $("#testView").innerHTML = `<div class="empty">ยังไม่ได้รันเทสต์</div>`;
    $("#liveView").innerHTML = `<div class="empty">ข้อความที่ agent กำลังพิมพ์จะแสดงที่นี่แบบสด</div>`;
    $("#fileHead").innerHTML = ""; $("#fileBody").textContent = "";
    for (const id of ["#zipBtn", "#openPreview", "#saveLocalBtn", "#copyLink", "#demoLink", "#appTunnel"]) $(id).hidden = true;
    $("#reloadPreview").disabled = true;
    $("#previewInfo").textContent = "ลิงก์เดโม่จะใช้ได้เมื่อทีมสร้างไฟล์ HTML";
    $("#previewFrame").removeAttribute("src");
    chat.innerHTML = "";
    office.lab("idle");
    office.boardDone(false);
    ORDER.forEach((id) => { office.setStatus(id, "idle"); setMember(id, "idle"); });
  }

  function connect(id, slug) {
    stopStream();
    const gen = generation;
    jobId = id;
    connectedAt = Date.now();
    setRunning(true);
    let lastSeq = -1;
    source = new EventSource(`/api/jobs/${id}/events?project=${encodeURIComponent(slug)}`);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data);
      // After a reconnect the server may replay the whole log: skip what we already have.
      if (typeof e.seq === "number") {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
      }
      if (e.type === "end") source?.close(); // otherwise EventSource reconnects forever
      enqueue(e, gen);
    };
    source.onerror = () => {
      if (source && source.readyState === EventSource.CLOSED && gen === generation) {
        chatSys("โหลดประวัติงานนี้ไม่ได้", "bad", "WifiOff");
        setRunning(false);
      }
    };
  }

  $("#taskForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const task = $("#task").value.trim();
    if (!task) { $("#task").focus(); return; }
    if (!connected()) { fillSettings(); $("#settings").showModal(); return; }
    const followUp = project?.slug;
    try {
      const data = await api("/api/jobs", {
        task, files: attached, projectSlug: followUp || undefined,
        projectName: followUp ? undefined : $("#projectName").value.trim(), ...llmBody(),
      });
      resetView();
      attached = []; $("#attachInfo").textContent = "";
      const meta = await api(`/api/projects/${encodeURIComponent(data.slug)}`);
      project = { slug: data.slug, name: meta.name || data.slug, demoPath: meta.demoPath };
      store.set("agentOffice.project", data.slug, sessionStorage);
      setHeader();
      renderJobs(meta, data.id);
      $("#task").value = "";
      connect(data.id, data.slug);
      loadProjects();
    } catch (err) {
      chatSys(err.message, "bad", "OctagonAlert");
    }
  });

  $("#cancelBtn").addEventListener("click", () => { if (jobId) fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" }); });

  // ---------- boot ----------
  renderPipeline();
  renderDocs();
  api("/api/config").then(async (cfg) => {
    config = cfg;
    if (cfg.role === "none") {
      $("#locked").hidden = false;
      // On the owner's own computer: sign in with the owner token.
      $("#ownerForm").hidden = !cfg.onThisMachine;
      $("#ownerForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          await api("/api/owner-login", { token: $("#ownerToken").value.trim() });
          location.reload();
        } catch (err) {
          $("#ownerMsg").textContent = err.message;
        }
      });
      return;
    }
    document.body.classList.toggle("guest", cfg.role === "guest");
    $("#shareBtn").hidden = cfg.role !== "owner";
    $("#guestChip").hidden = cfg.role !== "guest";
    $("#guestName").textContent = cfg.userName;
    if (!settings.model) settings.model = cfg.defaultModel;
    renderBudget(cfg.usage);
    await loadProjects();
    // An invite link for one project lands on /#p=<slug>.
    const fromLink = decodeURIComponent((location.hash.match(/^#p=(.+)$/) || [])[1] || "");
    if (fromLink) history.replaceState(null, "", location.pathname);
    const last = fromLink || store.get("agentOffice.project", sessionStorage);
    if (last && projectList.some((p) => p.slug === last)) openProject(last);
    else setHeader();
    if (!connected()) chatSys(isGuest() ? "เจ้าของเครื่องยังไม่ได้เปิดให้ใช้ Claude สำหรับเพื่อน" : "ยังไม่ได้เชื่อม Claude เปิดหน้าตั้งค่า (ไอคอนเฟือง) เพื่อเลือกวิธีเชื่อมต่อ", "", "Plug");
  });
})();
