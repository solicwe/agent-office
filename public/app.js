/* Agent Office window: listens to the local server (which receives Claude Code's
   hooks) and turns each event into character movement. All animation is local:
   no AI calls, no tokens. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const time = (t) => new Date(t || Date.now()).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmt = (n) => Number(n || 0).toLocaleString("th-TH");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.hydrateIcons();

  // ---------- office + roster ----------
  let office = null;
  let pool = [];
  const STATUS = { idle: "ว่าง", thinking: "กำลังคิด", typing: "กำลังทำงาน", running: "กำลังรันเทสต์" };

  function build(agents) {
    pool = agents;
    office?.destroy();
    window.AgentOffice.configure(agents);
    office = new window.AgentOffice.Office($("#scene"));
    $("#roster").style.gridTemplateColumns = `repeat(${Math.min(agents.length, 9)}, minmax(0, 1fr))`;
    $("#roster").innerHTML = agents.map((a) => `
      <div class="member" id="m-${esc(a.id)}" style="--c:${esc(a.color)}" title="${esc(a.description)}">${window.AgentOffice.avatar(a.id, 30)}
        <div><b>${esc(a.name)}</b><small>${esc(a.role_title || a.id)}</small><div class="st">${STATUS.idle}</div></div></div>`).join("");
  }
  function status(id, state, label = "") {
    if (!office?.agents[id]) id = "helper";
    office.setStatus(id, state, label);
    const m = document.getElementById(`m-${id}`);
    if (!m) return;
    m.querySelector(".st").textContent = label && state !== "idle" ? label : STATUS[state] || state;
    m.classList.toggle("busy", state !== "idle");
  }
  const allIdle = () => pool.forEach((a) => status(a.id, "idle"));
  const nameOf = (id) => pool.find((a) => a.id === id)?.name || id;

  // ---------- roles tab ----------
  function renderRoles(agents, errors, dir) {
    $("#roleCount").textContent = agents.filter((a) => !a.builtin).length;
    if (dir) $("#rolesDir").innerHTML = `อ่านจาก <code>${esc(dir)}</code> ทุกไฟล์ .md คือ 1 role (ไฟล์เดียวกับที่ Claude Code ใช้เป็น subagent)`;
    $("#roleErrors").innerHTML = (errors || []).map((e) => `<div class="role-error">${window.icon("TriangleAlert", 14)}<div><b>${esc(e.file)}</b><span>${esc(e.message)}</span></div></div>`).join("");
    $("#roleList").innerHTML = agents.map((a) => `
      <div class="role-card">
        ${window.AgentOffice.avatar(a.id, 36)}
        <div class="grow">
          <div class="role-head"><b>${esc(a.name)}</b> <span class="muted">${esc(a.role_title || "")}</span>${a.builtin ? ` <span class="tag">ระบบ</span>` : ` <code>${esc(a.file)}</code>`}</div>
          <p>${esc(a.description)}</p>
          ${a.specialties?.length ? `<div class="tags">${a.specialties.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>` : ""}
          ${a.tools ? `<small class="muted">tools: ${esc(Array.isArray(a.tools) ? a.tools.join(", ") : a.tools)}</small>` : ""}
        </div>
      </div>`).join("");
  }

  // ---------- live feed ----------
  const feed = $("#feed");
  let lastWork = null; // consecutive tool calls by one agent update one line
  function feedItem(cls, iconName, html, t) {
    feed.querySelector(".empty")?.remove();
    const d = document.createElement("div");
    d.className = "fi " + cls;
    d.innerHTML = `<span class="fi-ic">${window.icon(iconName, 14)}</span><div class="fi-body">${html}</div><time>${time(t)}</time>`;
    feed.append(d);
    while (feed.children.length > 300) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;
    lastWork = null;
    return d;
  }
  const who = (id) => `<span class="who">${window.AgentOffice.avatar(id, 18)}${esc(nameOf(id))}</span>`;

  // ---------- event queue: one step at a time, never stalls ----------
  const queue = [];
  let running = false;
  let currentSession = null;
  const arrive = (ids) => (office.fast || document.hidden ? null : Promise.race([office.arrived(ids), sleep(3500)]));
  const pause = (ms) => (office.fast || document.hidden ? null : sleep(ms));

  function push(e) {
    queue.push(e);
    if (!running) drain();
  }
  async function drain() {
    running = true;
    while (queue.length) {
      const e = queue.shift();
      office.fast = queue.length > 15 || e.replay; // catch up quickly after a burst
      try { await play(e); } catch (err) { console.error(err); }
    }
    office.fast = false;
    running = false;
  }

  async function play(e) {
    switch (e.type) {
      case "SESSION_START":
        setConn(e.session_id);
        break;

      case "ORCHESTRATOR_THINKING":
        setConn(e.session_id);
        allIdle();
        office.lab("idle");
        feedItem("user", "MessageSquare", `<b>คำสั่งใหม่</b> ${esc(e.text)}`, e.t);
        office.moveTo("orchestrator", "board");
        await arrive(["orchestrator"]);
        status("orchestrator", "thinking", "คิดว่าจะใช้ใคร");
        office.say("orchestrator", `ได้รับงาน: ${e.text}`);
        await pause(900);
        break;

      case "AGENT_ASSIGNED": {
        const to = office.agents[e.to] ? e.to : "helper";
        feedItem("assign", "ArrowRightLeft", `${who("orchestrator")} มอบงานให้ ${who(to)}${e.agent !== to ? ` <span class="muted">(${esc(e.agent)})</span>` : ""}${e.parallel ? ` <span class="tag">ขนาน</span>` : ""}<div class="sub">${esc(e.subtask)}</div>`, e.t);
        status("orchestrator", "typing", "มอบหมายงาน");
        office.moveTo("orchestrator", `visit:${to}`);
        await arrive(["orchestrator"]);
        office.say("orchestrator", e.subtask || "ฝากงานนี้ด้วย", nameOf(to));
        office.react([to], "nod");
        status(to, "thinking", "รับงาน");
        await pause(1100);
        office.moveTo("orchestrator", "desk");
        status("orchestrator", "thinking", "รอผล");
        break;
      }

      case "AGENT_WORKING": {
        const id = office.agents[e.agent] ? e.agent : "helper";
        const testing = e.tool && /^(Bash|PowerShell)$/.test(e.tool) && /test|jest|pytest|vitest|mocha/i.test(e.badge || "");
        status(id, testing ? "running" : "typing", e.badge);
        if (testing) office.lab("running");
        if (id !== "orchestrator" && office.agents[id].at !== "desk" && !office.agents[id].route.length) office.moveTo(id, "desk");
        if (lastWork && lastWork.id === id) {
          lastWork.n++;
          lastWork.node.querySelector(".fi-body").innerHTML = `${who(id)} ${esc(e.badge)} <span class="muted">· ${lastWork.n} ขั้น</span>`;
          lastWork.node.querySelector("time").textContent = time(e.t);
        } else {
          const node = feedItem("work", "Wrench", `${who(id)} ${esc(e.badge)}`, e.t);
          lastWork = { id, node, n: 1 };
        }
        break;
      }

      case "AGENT_HANDOFF": {
        const from = office.agents[e.from] ? e.from : "helper";
        feedItem("handoff", "PackageCheck", `${who(from)} ส่งงานกลับให้ ${who("orchestrator")}${e.summary ? `<div class="sub">${esc(e.summary)}</div>` : ""}`, e.t);
        office.lab("idle");
        status(from, "typing", "ส่งงาน");
        office.moveTo(from, "visit:orchestrator");
        await arrive([from]);
        office.say(from, e.summary ? `เสร็จแล้ว: ${e.summary}` : "เสร็จแล้ว", "Claude");
        office.react(["orchestrator"], "nod");
        await pause(1200);
        office.moveTo(from, "desk");
        status(from, "idle");
        status("orchestrator", "thinking", "รวมผล");
        break;
      }

      case "AGENT_DONE":
        status(office.agents[e.agent] ? e.agent : "helper", "idle");
        break;

      case "TASK_COMPLETE":
        allIdle();
        office.lab("idle");
        office.moveTo("orchestrator", "desk");
        feedItem("done", "BadgeCheck", `<b>เสร็จ</b> ใช้ agent ${e.agents} งาน · ${fmt(e.tokens)} tokens${e.summary ? `<div class="sub">${esc(e.summary)}</div>` : ""}`, e.t);
        if (!e.replay) {
          office.say("orchestrator", e.summary || "เสร็จแล้ว");
          office.react(window.AgentOffice.ORDER, "jump");
          if (!office.fast) office.confetti();
          addTokens(e.tokens);
          loadSessions(true);
        }
        break;

      case "ANCHORED":
        feedItem(e.ok && (e.pushed || !e.remote) ? "anchor" : "warn", e.ok ? "Link" : "TriangleAlert",
          e.ok ? `ยึด hash ลง git แล้ว <code>${esc(String(e.commit).slice(0, 10))}</code>${e.pushed ? " และขึ้น GitHub แล้ว" : e.remote ? ` แต่ยังไม่ขึ้น GitHub: ${esc(e.push_error || "")}` : " (ในเครื่อง)"}` : `ยึด hash ไม่สำเร็จ: ${esc(e.error)}`, e.t);
        if (!e.replay && $(".tab[data-tab=audit]").classList.contains("active")) loadSession(currentAudit);
        break;
    }
  }

  // ---------- connection ----------
  function setConn(sessionId) {
    currentSession = sessionId || currentSession;
    $("#connChip").classList.add("live");
    $("#connChip").innerHTML = `${window.icon("PlugZap", 14)}<span>เชื่อมกับ Claude Code${currentSession ? ` · ${esc(currentSession.slice(0, 8))}` : ""}</span>`;
  }
  let roundTokens = 0;
  function addTokens(n) {
    roundTokens += n || 0;
    $("#tokenChip").hidden = false;
    $("#tokenChip span").textContent = `session นี้ ${fmt(roundTokens)} tokens`;
  }

  function connect() {
    const es = new EventSource("/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "HELLO") {
        build(e.agents);
        renderRoles(e.agents, e.errors);
        fetch("/api/agents").then((r) => r.json()).then((d) => renderRoles(d.agents, d.errors, d.dir)).catch(() => {});
        // Catch up on what happened before this window opened, without the walking.
        feed.innerHTML = `<div class="empty">ยังไม่มีงาน<br>เปิด Claude Code ในโฟลเดอร์นี้ แล้วพิมพ์งานได้เลย ตัวละครจะขยับตามที่ Claude ทำจริง</div>`;
        for (const r of e.recent) push({ ...r, replay: true });
        return;
      }
      if (e.type === "AGENTS_CHANGED") {
        build(e.agents);
        renderRoles(e.agents, e.errors);
        feedItem("info", "UserPlus", `อัปเดต roles จากไฟล์ .md แล้ว (${e.agents.filter((a) => !a.builtin).length} roles${e.errors.length ? `, มีปัญหา ${e.errors.length} ไฟล์ ดูแท็บ Roles` : ""})`, e.t);
        return;
      }
      push(e);
    };
    es.onerror = () => {
      $("#connChip").classList.remove("live");
      $("#connChip").innerHTML = `${window.icon("Unplug", 14)}<span>ต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่…</span>`;
    };
  }

  // ---------- audit tab ----------
  let currentAudit = null;
  async function loadSessions(keep) {
    const { sessions } = await (await fetch("/api/sessions")).json();
    const sel = $("#sessionSelect");
    const was = keep ? sel.value : null;
    sel.innerHTML = sessions.length
      ? sessions.map((s) => `<option value="${esc(s.session_id)}">${esc(new Date(s.updated).toLocaleString("th-TH"))} · ${esc(s.first_prompt || s.session_id.slice(0, 8))} (${s.prompts} รอบ)</option>`).join("")
      : `<option value="">ยังไม่มี session</option>`;
    const pick = (was && sessions.some((s) => s.session_id === was) ? was : sessions[0]?.session_id) || "";
    sel.value = pick;
    if (pick) loadSession(pick); else { $("#timeline").innerHTML = `<div class="empty">ยังไม่มี session<br>สั่งงานใน Claude Code แล้วกลับมาดูที่นี่</div>`; $("#auditActions").hidden = true; $("#verifyBox").hidden = true; }
  }

  const tok = (t) => (t ? `${fmt((t.input || 0) + (t.output || 0))} tokens${t.source === "estimate" ? " (ประมาณ)" : ""}` : "");
  const secs = (ms) => (ms != null ? `${(ms / 1000).toFixed(1)} วิ` : "");
  const pre = (label, text, open = false) => (text ? `<details${open ? " open" : ""}><summary>${esc(label)}</summary><pre>${esc(text)}</pre></details>` : "");

  async function loadSession(id) {
    if (!id) return;
    currentAudit = id;
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!r.ok) return;
    const d = await r.json();
    const v = d.verification;
    $("#verifyBox").hidden = false;
    $("#verifyBox").className = "verify " + (v.ok ? "ok" : "bad");
    $("#verifyBox").innerHTML = v.ok
      ? `${window.icon("ShieldCheck", 16)}<div><b>hash chain ถูกต้อง</b><span>${v.count} entries · head <code>${esc(v.head.slice(0, 16))}…</code></span></div>`
      : `${window.icon("ShieldAlert", 16)}<div><b>log ถูกแก้ไข</b><span>${esc(v.reason)}</span></div>`;
    $("#auditActions").hidden = false;
    $("#exportJson").href = `/api/sessions/${encodeURIComponent(id)}/export.json`;
    $("#exportMd").href = `/api/sessions/${encodeURIComponent(id)}/export.md`;
    $("#timeline").innerHTML = d.rounds.length ? d.rounds.map((round, i) => `
      <section class="round">
        <h4>รอบที่ ${i + 1} <time>${esc(new Date(round.prompt.ts).toLocaleString("th-TH"))}</time></h4>
        <div class="step user"><span class="dotc"></span><div><b>1. คำสั่งของผู้ใช้</b><p>${esc(round.prompt.prompt)}</p></div></div>
        <div class="step orch"><span class="dotc"></span><div><b>2. Orchestrator เลือก ${round.steps.length} งาน</b>
          <p>${round.steps.length ? round.steps.map((s) => `${window.AgentOffice.avatar(pool.some((a) => a.id === s.assigned.agent) ? s.assigned.agent : "helper", 18)} ${esc(s.assigned.agent)}`).join(" → ") : "ไม่ได้เรียก agent ย่อย Claude ทำเอง"}${round.steps.some((s) => s.assigned.execution === "parallel") ? ` <span class="tag">มีงานขนาน</span>` : ""}</p></div></div>
        ${round.steps.map((s, j) => `
          <div class="step agent"><span class="dotc" style="--c:${esc(pool.find((a) => a.id === s.assigned.agent)?.color || "#6b7a8f")}"></span><div>
            <b>3.${j + 1} ${esc(s.assigned.agent)}</b> <span class="muted small">${esc([s.assigned.execution, secs(s.result?.duration_ms), tok(s.finished?.tokens)].filter(Boolean).join(" · "))}</span>
            <p>${esc(s.assigned.subtask)}</p>
            <small class="muted">${s.assigned.md_file ? `ไฟล์ ${esc(s.assigned.md_file)} · sha256 <code>${esc(s.assigned.md_sha256.slice(0, 12))}…</code>` : "subagent ในตัวของ Claude Code"}</small>
            ${pre("เหตุผลที่เลือก", s.assigned.reasoning)}${pre("Input", s.assigned.input)}${pre("Output", s.result?.output)}
          </div></div>`).join("")}
        <div class="step final"><span class="dotc"></span><div><b>4. คำตอบสุดท้าย</b> <span class="muted small">${round.final ? esc([secs(round.final.duration_ms), tok(round.final.tokens_round_total), `${round.tools} tool calls`].join(" · ")) : "ยังไม่จบ"}</span>
          ${pre("ข้อความ", round.final?.text, true)}
          ${round.anchors.map((a) => `<small class="anchor ${a.pushed ? "ok" : ""}">${window.icon("Link", 12)} ${a.ok ? `commit <code>${esc(String(a.commit).slice(0, 10))}</code> · ${a.pushed ? "ขึ้น GitHub แล้ว" : "ยังไม่ขึ้น GitHub"}` : `ยึด hash ไม่สำเร็จ: ${esc(a.error)}`}</small>`).join("")}
        </div></div>
      </section>`).join("") : `<div class="empty">session นี้ยังไม่มีคำสั่ง</div>`;
  }
  $("#sessionSelect").addEventListener("change", (e) => loadSession(e.target.value));
  $("#refreshAudit").addEventListener("click", () => loadSessions(true));

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === "audit") loadSessions(true);
  }));

  connect();
})();
