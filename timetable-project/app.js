/* app.js — หน้าจอของต้นแบบ: นำเข้า/แก้ไข → ตั้งค่า → จัดตาราง → ตรวจ → ตาราง (ลากย้าย/สลับ/แบ่งคาบ) → สถิติ */
(function () {
  "use strict";
  const E = window.TTEngine;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const TYPES = ["activity", "homeroom", "iot", "general", "practice", "theory"];
  const SAMPLES = [
    { key: "small", name: "เล็ก", desc: "3 กลุ่ม · ทดสอบวิชาสามัญเลขคี่" },
    { key: "medium", name: "กลาง", desc: "12 กลุ่ม · ขนาดใกล้โจทย์จริง" },
    { key: "large", name: "ใหญ่", desc: "36 กลุ่ม · Stress test" },
    { key: "tight", name: "ห้องน้อย", desc: "12 กลุ่ม 8 ห้อง · ทดสอบวงรอบซ่อม" }
  ];
  const VIEWS = ["login", "data", "settings", "run", "check", "table", "stats", "unavail", "users"];
  /* ---------- สิทธิ์ตามบทบาท (RBAC): ตรวจทั้งตอนแสดงเมนูและตอนกดทำรายการ ---------- */
  const PERMS = {
    admin: ["data", "settings", "run", "check", "table", "stats", "unavail", "users", "editTable", "viewAll", "exportAll"],
    teacher: ["check", "table", "stats", "unavail", "viewAll"],
    student: ["table"]
  };
  const ROLE_TH = { admin: "Admin", teacher: "Teacher", student: "Student" };
  const HOME = { admin: "run", teacher: "table", student: "table" };
  // คอลัมน์ที่อ้างถึงตารางอื่น: ใช้รายการให้เลือก ลดการพิมพ์ผิด
  const LISTS = { "teach.teacher_id": "teacher", "teach.subject_id": "subject", "register.group_id": "group", "register.subject_id": "subject", "student_group.advisor": "teacher", "room.room_type": "roomtype", "timeslot.day": "day", "teacher.role": "role" };
  const NUMERIC = new Set(["subject.theory", "subject.practice", "subject.credit", "student_group.student_count", "timeslot.period"]);

  const state = {
    data: null, source: "", sampleKey: null, cfg: E.mergeConfig({ runs: 20 }),
    draft: null, edTable: "subject", edQ: "", importTab: null,
    results: null, final: null, checkWhich: "final",
    tt: { mode: "group", id: null, q: "" }, sel: null, running: null, subjQ: "",
    users: [], user: null, un: null, notices: [], userQ: "", userRole: "all"
  };
  const can = perm => !!state.user && PERMS[state.user.role].includes(perm);
  function deny(perm) { if (can(perm)) return false; toast("บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้"); return true; }

  /* ---------- รหัสผ่าน: เก็บเป็น SHA-256 ของ salt + รหัสผ่าน ไม่เก็บรหัสจริง ---------- */
  function sha256(text) {
    const bytes = new TextEncoder().encode(text), rot = (v, n) => (v >>> n) | (v << (32 - n));
    const K = [], H = [];
    for (let c = 2, n = 0; n < 64; c++) { let prime = true; for (let d = 2; d * d <= c; d++) if (c % d === 0) { prime = false; break; } if (prime) { if (n < 8) H[n] = (Math.pow(c, 1 / 2) * 4294967296) | 0; K[n++] = (Math.pow(c, 1 / 3) * 4294967296) | 0; } }
    const len = bytes.length, words = new Array(((len + 9 + 63) >> 6) << 4).fill(0);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8);
    words[len >> 2] |= 0x80 << ((3 - (len & 3)) * 8); words[words.length - 1] = len * 8;
    for (let j = 0; j < words.length; j += 16) {
      const w = words.slice(j, j + 16); let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        if (i >= 16) { const w15 = w[i - 15], w2 = w[i - 2]; w[i] = (w[i - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0; }
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }
  function newSalt() { const a = new Uint8Array(8); try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 8; i++) a[i] = (Date.now() >> i) & 255; } return [...a].map(x => x.toString(16).padStart(2, "0")).join(""); }
  function makeUser(username, role, link, password, auto) {
    const salt = newSalt();
    return { username: username.toLowerCase(), role, teacher_id: role === "teacher" ? link : "", group_id: role === "student" ? link : "", salt, hash: sha256(salt + ":" + password), auto: !!auto };
  }
  const checkPassword = (u, pw) => u.hash === sha256(u.salt + ":" + pw);
  function displayName(u) {
    if (u.role === "teacher") { const t = state.data.teacher.find(x => x.teacher_id === u.teacher_id); return t ? t.teacher_name : "(ไม่พบครู " + u.teacher_id + ")"; }
    if (u.role === "student") { const g = state.data.student_group.find(x => x.group_id === u.group_id); return g ? "นักเรียน " + g.group_name : "(ไม่พบกลุ่ม " + u.group_id + ")"; }
    return "ผู้ดูแลระบบ";
  }
  // ครูและกลุ่มเรียนใหม่ได้บัญชีอัตโนมัติ (ชื่อผู้ใช้ = รหัสตัวพิมพ์เล็ก รหัสผ่านเริ่มต้น 1234)
  function syncUsers() {
    const has = n => state.users.some(u => u.username === n);
    if (!state.users.some(u => u.role === "admin")) state.users.push(makeUser("admin", "admin", "", "admin123", true));
    for (const t of state.data.teacher) if (!state.users.some(u => u.role === "teacher" && u.teacher_id === t.teacher_id) && !has(t.teacher_id.toLowerCase())) state.users.push(makeUser(t.teacher_id, "teacher", t.teacher_id, "1234", true));
    for (const g of state.data.student_group) if (!state.users.some(u => u.role === "student" && u.group_id === g.group_id) && !has(g.group_id.toLowerCase())) state.users.push(makeUser(g.group_id, "student", g.group_id, "1234", true));
  }

  /* ---------- เครื่องมือเล็ก ๆ ---------- */
  let toastTimer;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
  const teacherName = id => { const t = state.data.teacher.find(x => x.teacher_id === id); return t ? t.teacher_name : id; };
  const groupName = id => { const g = state.data.student_group.find(x => x.group_id === id); return g ? g.group_name : id; };
  const shortName = n => String(n || "").replace(/^อ\./, "").split(" ")[0];
  function idx() { if (!state._idx || state._idxFor !== state.data || state._idxCfg !== state.cfg) { state._idx = E.prepare(state.data, state.cfg); state._idxFor = state.data; state._idxCfg = state.cfg; } return state._idx; }
  const bestResult = () => state.results && (state.results.rep || state.results.heur);
  const isMgr = role => String(role).toLowerCase() === String(state.cfg.managerRole).toLowerCase();
  const periodsOf = s => (Number(s.theory) || 0) + (Number(s.practice) || 0);

  // รูปแบบคาบอัตโนมัติ (ตรงกับตัวจัดตาราง): ปฏิบัติไม่เกิน blockMax.practice ทฤษฎีไม่เกิน blockMax.theory
  function autoSplit(s, type) {
    const n = periodsOf(s); if (n <= 0) return [];
    if (type === "activity") return [n];
    const max = type === "homeroom" ? 1 : Number(s.practice) > 0 ? state.cfg.blockMax.practice : state.cfg.blockMax.theory;
    const k = Math.ceil(n / max), base = Math.floor(n / k), extra = n % k;
    return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  }
  const splitLabel = (parts, n) => parts.length === 1 ? `เรียนยาว ${n} คาบ` : parts.join("+");
  function splitSelect(s, type, current, attr) {
    const n = periodsOf(s);
    if (n < 2 || type === "activity") return `<span class="muted">${n ? splitLabel([n], n) : "—"}</span>`;
    const auto = autoSplit(s, type), cur = Array.isArray(current) ? current.join("+") : "";
    const opts = E.splitOptions(n).map(p => p.join("+"));
    return `<select class="splitsel" ${attr} aria-label="การแบ่งคาบ ${esc(s.subject_id)}"><option value="">อัตโนมัติ (${splitLabel(auto, n)})</option>${opts.map(o => `<option value="${o}" ${o === cur ? "selected" : ""}>${o.includes("+") ? "แบ่ง " + o : "เรียนยาว " + o + " คาบ"}</option>`).join("")}</select>`;
  }

  /* ---------- ดาวน์โหลดไฟล์: ใน claude.ai ใช้ downloads capability, เว็บที่ deploy เองใช้ลิงก์ปกติ ---------- */
  let dlCap;
  async function getDownloads() {
    if (dlCap !== undefined) return dlCap;
    if (!window.claude || typeof window.claude.use !== "function") { dlCap = "anchor"; return dlCap; }
    try { dlCap = await window.claude.use("downloads"); } catch (e) { dlCap = null; }
    return dlCap;
  }
  async function saveFile(filename, data, mime) {
    const d = await getDownloads();
    if (d === "anchor") {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("ดาวน์โหลด " + filename); return;
    }
    if (!d) { toast("หน้านี้ดาวน์โหลดไฟล์ไม่ได้"); return; }
    try { await d.save({ filename, data }); toast("บันทึก " + filename + " แล้ว"); }
    catch (e) { if (e && e.code === "declined") return; toast(e && e.code === "rate_limited" ? "มีหน้าต่างบันทึกเปิดอยู่ ลองอีกครั้ง" : "บันทึกไฟล์ไม่ได้"); }
  }
  const xlsxBuffer = wb => window.XLSX.write(wb, { bookType: "xlsx", type: "array" });

  /* ---------- เส้นทางหน้า ---------- */
  function currentView() {
    if (!state.user) return "login";
    const h = location.hash.replace("#", "");
    return VIEWS.includes(h) && h !== "login" && can(h) ? h : HOME[state.user.role];
  }
  function showView() {
    const v = currentView();
    VIEWS.forEach(n => { $("#view-" + n).hidden = n !== v; });
    const nav = $("#steps"); nav.hidden = !state.user; nav.classList.toggle("plain", !!state.user && state.user.role !== "admin");
    document.querySelectorAll("#steps a").forEach(a => {
      a.hidden = !can(a.dataset.view);
      if (!a.dataset.label) a.dataset.label = a.lastChild.textContent;
      a.lastChild.textContent = a.dataset.view === "table" && state.user && state.user.role === "student" ? "ตารางเรียนของฉัน" : a.dataset.view === "table" && state.user && state.user.role === "teacher" ? "ตารางสอน" : a.dataset.label;
      if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    renderUserChip();
    if (v !== "table") clearSelection(false);
    render(v);
  }
  window.addEventListener("hashchange", showView);
  function stepMarks() {
    const issues = E.inputCheck(state.data, state.cfg);
    const set = (v, cls) => { const a = document.querySelector(`#steps a[data-view="${v}"]`); a.classList.remove("done", "attn"); if (cls) a.classList.add(cls); };
    set("data", state.draft ? "attn" : issues.some(i => i.level === "error") ? "attn" : "done");
    set("settings", "done");
    const f = state.final;
    set("run", f ? "done" : null); set("check", f ? (f.val.passed ? "done" : "attn") : null);
    set("table", f ? "done" : null); set("stats", f ? "done" : null);
    const d = state.data;
    $("#datasetPill").innerHTML = `ข้อมูล: <b>${esc(state.source)}</b> · ${d.student_group.length} กลุ่ม · ${d.teacher.length} ครู · ${d.room.length} ห้อง · ${d.subject.length} วิชา`;
  }
  function render(v) { if (v !== "login") stepMarks(); ({ login: renderLogin, data: renderData, settings: renderSettings, run: renderRun, check: renderCheck, table: renderTable, stats: renderStats, unavail: renderUnavail, users: renderUsers })[v](); }
  function renderUserChip() {
    const c = $("#userChip"), u = state.user;
    $("#datasetPill").hidden = !u || u.role !== "admin";
    if (!u) { c.hidden = true; return; }
    c.hidden = false;
    c.innerHTML = `<span class="role role-${u.role}">${ROLE_TH[u.role]}</span><b>${esc(displayName(u))}</b><span class="muted mono">${esc(u.username)}</span><button id="logoutBtn">ออกจากระบบ</button>`;
  }

  /* =================== เข้าสู่ระบบ =================== */
  function renderLogin() {
    const firstMgr = state.users.find(u => u.role === "teacher" && state.data.teacher.some(t => t.teacher_id === u.teacher_id && isMgr(t.role)));
    const firstT = state.users.find(u => u.role === "teacher" && u !== firstMgr && state.data.teacher.some(t => t.teacher_id === u.teacher_id && !isMgr(t.role)));
    const firstS = state.users.find(u => u.role === "student");
    const demos = [[state.users.find(u => u.username === "admin"), "admin123", "จัดการข้อมูล จัดตาราง แก้ตาราง และบัญชีผู้ใช้"],
      [firstMgr, "1234", "ครูที่เป็นหัวหน้า ดูตารางสอนและแจ้งเวลาไม่สะดวก"], [firstT, "1234", "ดูตารางสอนของตัวเองและแจ้งเวลาไม่สะดวก"], [firstS, "1234", "ดูเฉพาะตารางเรียนของกลุ่มตัวเอง"]].filter(d => d[0]);
    $("#demoAccounts").innerHTML = demos.map(([u, pw, what]) => `<button type="button" class="demo" data-demo="${esc(u.username)}" data-pw="${pw}"><span class="role role-${u.role}" style="justify-self:start">${ROLE_TH[u.role]}</span><span class="r">${esc(displayName(u))}</span><code>${esc(u.username)} / ${pw}</code><span>${what}</span></button>`).join("");
    $("#loginErr").hidden = true;
  }
  function login(username, password) {
    const u = state.users.find(x => x.username === String(username).trim().toLowerCase());
    if (!u || !checkPassword(u, password)) { const e = $("#loginErr"); e.textContent = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"; e.hidden = false; $("#loginPass").value = ""; $("#loginPass").focus(); return; }
    if ((u.role === "teacher" && !state.data.teacher.some(t => t.teacher_id === u.teacher_id)) || (u.role === "student" && !state.data.student_group.some(g => g.group_id === u.group_id))) { const e = $("#loginErr"); e.textContent = "บัญชีนี้ผูกกับครูหรือกลุ่มที่ไม่มีในข้อมูลแล้ว ติดต่อผู้ดูแลระบบ"; e.hidden = false; return; }
    state.user = u; state.sel = null;
    if (u.role === "teacher") state.tt = { mode: "teacher", id: u.teacher_id, q: "" };
    if (u.role === "student") state.tt = { mode: "group", id: u.group_id, q: "" };
    if (u.role === "admin") state.tt = { mode: "group", id: state.data.student_group[0] && state.data.student_group[0].group_id, q: "" };
    state.un = null;
    $("#loginForm").reset();
    location.hash = "#" + HOME[u.role]; showView();
    toast(`เข้าสู่ระบบเป็น ${ROLE_TH[u.role]}: ${displayName(u)}`);
  }
  function logout() { if (state.running) cancelRun(); state.user = null; state.sel = null; clearTargets(); location.hash = "#login"; showView(); }

  /* =================== 1) ข้อมูล: นำเข้า พรีวิว ตรวจ และแก้ไข =================== */
  // ร่างข้อมูล (draft) = สำเนาที่กำลังแก้หรือที่เพิ่งนำเข้า ยังไม่ถูกใช้จัดตารางจนกว่าจะกดบันทึก
  function ensureDraft() {
    if (!state.draft) state.draft = { origin: "edit", data: clone(state.data), split: clone(state.cfg.splitOverride || {}), added: new WeakSet(), missing: {}, imported: [], unknown: [], kept: [], before: {} };
    return state.draft;
  }
  const editData = () => state.draft ? state.draft.data : state.data;
  function draftIssues() {
    const d = editData(), issues = E.inputCheck(d, state.cfg);
    const OPTIONAL = new Set(["room_name", "group_name", "student_count", "credit", "teacher_name"]);
    if (state.draft) for (const [t, cols] of Object.entries(state.draft.missing)) for (const c of cols) {
      const empty = d[t].filter(r => String(r[c] ?? "").trim() === "").length;
      if (!empty) continue;
      if (OPTIONAL.has(c)) issues.push({ level: "warn", table: t, message: `ไฟล์ ${t} ไม่มีคอลัมน์ ${c} (ไม่บังคับ ว่าง ${empty} แถว)`, hint: "จัดตารางได้ ถ้าต้องการให้ครบให้กรอกในตารางด้านล่าง" });
      else issues.unshift({ level: "error", table: t, message: `ไฟล์ ${t} ไม่มีคอลัมน์ ${c} (ยังว่าง ${empty} แถว)`, hint: "กรอกค่าในตารางด้านล่าง หรือแก้ไฟล์แล้วนำเข้าใหม่" });
    }
    return issues;
  }
  function renderData() {
    $("#samples").innerHTML = SAMPLES.map(s => `<button class="sample" data-sample="${s.key}" aria-pressed="${state.sampleKey === s.key && !state.draft}"><b>${s.name}</b><span>${s.desc}</span></button>`).join("");
    $("#tplTable").innerHTML = Object.keys(E.TABLES).map(t => `<option value="${t}">${t}.csv</option>`).join("");
    const issues = draftIssues();
    renderImportSummary(issues);
    renderEditor(issues);
    renderIssues($("#issues"), issues);
  }
  function renderIssues(el, issues) {
    if (!issues.length) { el.innerHTML = `<div class="issue" style="background:var(--ok-soft)"><span class="pill ok">ผ่าน</span><span>ไม่พบปัญหา ข้อมูลพร้อมจัดตาราง</span></div>`; return; }
    const err = issues.filter(i => i.level === "error").length;
    el.innerHTML = `<p style="font-size:13.5px">${err ? `<span class="pill bad">ผิด ${err} รายการ</span> ต้องแก้ก่อนจัดตาราง` : ""} ${issues.length - err ? `<span class="pill warn">เตือน ${issues.length - err} รายการ</span>` : ""}</p>` +
      issues.slice(0, 40).map(i => `<div class="issue ${i.level}"><span class="pill ${i.level === "error" ? "bad" : "warn"}">${i.level === "error" ? "ผิด" : "เตือน"}</span><span>${esc(i.message)}${i.row != null ? ` <button class="chip" data-goto="${esc(i.table)}" data-row="${i.row}">ไปที่แถว</button>` : ""}</span><span class="hint">วิธีแก้: ${esc(i.hint)}</span></div>`).join("") +
      (issues.length > 40 ? `<p class="muted" style="font-size:12.5px">และอีก ${issues.length - 40} รายการ</p>` : "");
  }
  // หน้าพรีวิวการนำเข้า: สรุปทุกตารางก่อนบันทึก
  function renderImportSummary(issues) {
    const box = $("#stagedBox"), dr = state.draft;
    if (!dr || dr.origin !== "import") { box.innerHTML = ""; return; }
    const err = issues.filter(i => i.level === "error").length;
    const byT = t => issues.filter(i => i.table === t);
    const rows = Object.keys(E.TABLES).map(t => {
      const imp = dr.imported.find(i => i.table === t), list = byT(t), e = list.filter(i => i.level === "error").length, w = list.length - e;
      const before = dr.before[t] ?? 0, now = dr.data[t].length;
      const miss = dr.missing[t] || [], extra = (imp && imp.extra) || [];
      return `<tr><td class="mono">${t}</td>
        <td>${imp ? `<span class="pill hard">นำเข้าใหม่</span> <span class="muted" style="font-size:12.5px">${esc(imp.file)}</span>` : `<span class="pill soft">ใช้ของเดิม</span>`}</td>
        <td class="n"><span class="delta">${imp ? `${before} → ${now}` : now}</span></td>
        <td>${miss.length ? `<span class="pill ${miss.every(c => ["room_name", "group_name", "student_count", "credit", "teacher_name"].includes(c)) ? "warn" : "bad"}">ขาด ${esc(miss.join(", "))}</span>` : `<span class="pill ok">ครบ</span>`}${extra.length ? ` <span class="muted" style="font-size:12px">ไม่ใช้: ${esc(extra.join(", "))}</span>` : ""}</td>
        <td>${e ? `<span class="pill bad">ผิด ${e}</span> ` : ""}${w ? `<span class="pill warn">เตือน ${w}</span>` : ""}${!e && !w ? `<span class="pill ok">ผ่าน</span>` : ""}</td>
        <td><button class="chip" data-table="${t}">ดู/แก้</button></td></tr>`;
    }).join("");
    box.innerHTML = `<div class="staged">
      <div class="row" style="justify-content:space-between"><h3>พรีวิวการนำเข้าและผลตรวจ</h3>${err ? `<span class="pill bad">ต้องแก้ ${err} รายการก่อนบันทึก</span>` : `<span class="pill ok">ตรวจผ่าน พร้อมบันทึก</span>`}</div>
      <p class="muted" style="font-size:13.5px">ข้อมูลยังไม่ถูกใช้จนกว่าจะกดบันทึก แก้ค่าในตาราง "แก้ไขข้อมูล" ด้านล่างได้เลยถ้าเจอปัญหา</p>
      <div class="tablebox"><table class="data"><thead><tr><th>ตาราง</th><th>ที่มา</th><th class="n">แถว (เดิม → ใหม่)</th><th>คอลัมน์</th><th>ผลตรวจ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${dr.unknown.length ? `<p style="font-size:13px"><span class="pill warn">ไม่รู้จัก</span> ${dr.unknown.map(esc).join(", ")} · ตั้งชื่อไฟล์หรือชีตให้ตรงกับชื่อตาราง หรือใช้หัวคอลัมน์ตามแม่แบบ</p>` : ""}
      <div class="row"><button class="primary" id="commitImport" ${err ? "disabled" : ""}>บันทึกและจัดตาราง</button><button id="dropImport">ยกเลิกการนำเข้า</button></div></div>`;
  }
  function renderEditor(issues) {
    const d = editData(), t = state.edTable, cols = E.TABLES[t];
    const errCount = tb => issues.filter(i => i.table === tb && i.level === "error").length;
    $("#tableChips").innerHTML = Object.keys(E.TABLES).map(tb => `<button class="chip" data-table="${tb}" aria-pressed="${t === tb}">${tb}<small>${d[tb].length} แถว</small>${errCount(tb) ? ` <span class="pill bad" style="padding:0 6px">${errCount(tb)}</span>` : ""}</button>`).join("");
    $("#dataSource").textContent = state.draft ? (state.draft.origin === "import" ? "กำลังแก้ข้อมูลที่นำเข้า (ยังไม่บันทึก)" : "มีการแก้ไขที่ยังไม่บันทึก") : `ใช้อยู่: ${state.source} · พิมพ์แก้ในช่องได้เลย`;
    $("#saveBar").hidden = !state.draft || state.draft.origin === "import";
    $("#edSearch").value = state.edQ;
    const I = idx(), q = state.edQ.trim().toLowerCase();
    const miss = state.draft && state.draft.missing[t] || [];
    const rowIssue = new Map();
    issues.filter(i => i.table === t && i.row != null).forEach(i => { const cur = rowIssue.get(i.row); if (!cur || (cur.level === "warn" && i.level === "error")) rowIssue.set(i.row, i); });
    const list = d[t].map((r, i) => ({ r, i })).filter(({ r }) => !q || cols.some(c => String(r[c] ?? "").toLowerCase().includes(q)));
    const LIMIT = 200, shown = list.slice(0, LIMIT);
    const isSub = t === "subject";
    const head = `<tr><th class="n">#</th>${cols.map(c => `<th class="${miss.includes(c) ? "colmissing" : ""}">${c}${miss.includes(c) ? " (ไม่มีในไฟล์)" : ""}</th>`).join("")}${isSub ? `<th>คาบรวม</th><th>การแบ่งคาบ</th>` : ""}<th>ปัญหา</th><th></th></tr>`;
    const body = shown.map(({ r, i }) => {
      const iss = rowIssue.get(i), cls = [iss ? (iss.level === "error" ? "err" : "warnrow") : "", state.draft && state.draft.added.has(r) ? "new" : ""].join(" ");
      const cells = cols.map(c => {
        const key = t + "." + c, lst = LISTS[key];
        return `<td><input type="${NUMERIC.has(key) ? "number" : "text"}" value="${esc(r[c] ?? "")}" data-cell="${c}" data-r="${i}" ${lst ? `list="dl-${lst}"` : ""} aria-label="${t} แถว ${i + 2} ${c}"></td>`;
      }).join("");
      let extra = "";
      if (isSub) {
        const type = I.type.get(r.subject_id) || (Number(r.practice) > 0 ? "practice" : "theory");
        const split = (state.draft ? state.draft.split : state.cfg.splitOverride)[r.subject_id];
        extra = `<td class="n">${periodsOf(r)}</td><td>${splitSelect(r, type, split, `data-split="${esc(r.subject_id)}"`)}</td>`;
      }
      return `<tr class="${cls}" data-r="${i}"><td class="rowno">${i + 2}</td>${cells}${extra}<td class="issue-cell ${iss && iss.level === "warn" ? "warn" : ""}">${iss ? esc(iss.message.replace(/^[a-z_]+ แถว \d+: /, "")) : ""}</td><td><button class="del" data-del="${i}" title="ลบแถว ${i + 2}" aria-label="ลบแถว ${i + 2}">ลบ</button></td></tr>`;
    }).join("");
    $("#editorGrid").innerHTML = datalists(d) + `<table class="data edit"><thead>${head}</thead><tbody>${body}</tbody></table>` +
      (list.length > LIMIT ? `<p class="muted" style="padding:8px 10px;font-size:12.5px">แสดง ${LIMIT} จาก ${list.length} แถว ใช้ช่องค้นหาเพื่อหาแถวที่ต้องการ</p>` : "") +
      (!list.length ? `<p class="muted" style="padding:10px">ไม่พบแถวที่ตรงกับ "${esc(state.edQ)}"</p>` : "");
  }
  function datalists(d) {
    const opt = (v, l) => `<option value="${esc(v)}">${esc(l || "")}</option>`;
    return `<datalist id="dl-teacher">${d.teacher.map(x => opt(x.teacher_id, x.teacher_name)).join("")}</datalist>
      <datalist id="dl-subject">${d.subject.map(x => opt(x.subject_id, x.subject_name)).join("")}</datalist>
      <datalist id="dl-group">${d.student_group.map(x => opt(x.group_id, x.group_name)).join("")}</datalist>
      <datalist id="dl-roomtype">${[...new Set(["Theory", "Practice", ...d.room.map(r => r.room_type)])].map(v => opt(v)).join("")}</datalist>
      <datalist id="dl-day">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(v => opt(v, E.DAY_TH[v])).join("")}</datalist>
      <datalist id="dl-role">${["Teacher", state.cfg.managerRole].map(v => opt(v)).join("")}</datalist>`;
  }
  // อัปเดตเฉพาะสีแถวและข้อความปัญหา ไม่สร้างตารางใหม่ เพื่อไม่ให้เคอร์เซอร์หลุดระหว่างพิมพ์
  let recheckTimer;
  function recheckSoon() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      const issues = draftIssues(), t = state.edTable, map = new Map();
      issues.filter(i => i.table === t && i.row != null).forEach(i => { const cur = map.get(i.row); if (!cur || (cur.level === "warn" && i.level === "error")) map.set(i.row, i); });
      document.querySelectorAll("#editorGrid tbody tr[data-r]").forEach(tr => {
        const i = Number(tr.dataset.r), iss = map.get(i);
        tr.classList.toggle("err", !!iss && iss.level === "error"); tr.classList.toggle("warnrow", !!iss && iss.level === "warn");
        const c = tr.querySelector(".issue-cell"); c.textContent = iss ? iss.message.replace(/^[a-z_]+ แถว \d+: /, "") : ""; c.classList.toggle("warn", !!iss && iss.level === "warn");
      });
      renderIssues($("#issues"), issues); renderImportSummary(issues); stepMarks();
      const errCount = tb => issues.filter(i => i.table === tb && i.level === "error").length;
      document.querySelectorAll("#tableChips .chip").forEach(ch => { const tb = ch.dataset.table, d = editData(); ch.innerHTML = `${tb}<small>${d[tb].length} แถว</small>${errCount(tb) ? ` <span class="pill bad" style="padding:0 6px">${errCount(tb)}</span>` : ""}`; });
      $("#saveBar").hidden = !state.draft || state.draft.origin === "import";
    }, 250);
  }
  function addRow() {
    const dr = ensureDraft(), t = state.edTable, row = {};
    E.TABLES[t].forEach(c => { row[c] = ""; });
    if (t === "subject") { row.theory = "0"; row.practice = "0"; row.credit = "0"; }
    if (t === "teacher") row.role = "Teacher";
    if (t === "room") row.room_type = "Theory";
    dr.data[t].push(row); dr.added.add(row); state.edQ = "";
    renderData();
    const g = $("#editorGrid"); g.scrollTop = g.scrollHeight;
    const inp = g.querySelector(`tr[data-r="${dr.data[t].length - 1}"] input`); if (inp) inp.focus();
  }
  function deleteRow(i) {
    const dr = ensureDraft(), t = state.edTable, r = dr.data[t][i];
    dr.data[t].splice(i, 1);
    toast(`ลบแถว ${i + 2} ของ ${t} แล้ว (${E.TABLES[t].map(c => r[c]).filter(Boolean).slice(0, 2).join(" ")})`);
    renderData();
  }
  function saveDraft() {
    const dr = state.draft; if (!dr) return;
    const err = draftIssues().filter(i => i.level === "error");
    if (err.length) { toast(`ยังมีข้อมูลผิด ${err.length} รายการ แก้ก่อนบันทึก`); return; }
    const source = dr.origin === "import" ? "นำเข้า: " + dr.imported.map(i => i.table).join(", ") : state.source.replace(/ \(แก้ไขแล้ว\)$/, "") + " (แก้ไขแล้ว)";
    const split = dr.split, keepType = dr.origin === "edit";
    commit(dr.data, source, dr.origin === "edit" ? state.sampleKey : null, { split, keepType });
    toast("บันทึกข้อมูลแล้ว กำลังจัดตารางใหม่");
    location.hash = "#run"; showView(); startRun();
  }
  function detectTable(name, headers) {
    const base = String(name).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z_]/g, "");
    const alias = { studentgroup: "student_group", group: "student_group", groups: "student_group", rooms: "room", subjects: "subject", teachers: "teacher", timeslots: "timeslot" };
    if (E.TABLES[base]) return base;
    if (alias[base]) return alias[base];
    const hs = headers.map(h => String(h).trim());
    let best = null, n = 0;
    for (const [t, cols] of Object.entries(E.TABLES)) if (cols.every(c => hs.includes(c)) && cols.length > n) { best = t; n = cols.length; }
    return best;
  }
  async function importFiles(files) {
    const imported = [], unknown = [], tables = {}, missing = {};
    const take = (t, headers, records, file) => {
      const cols = E.TABLES[t], hs = headers.map(h => String(h).trim());
      const miss = cols.filter(c => !hs.includes(c)), extra = hs.filter(h => h && !cols.includes(h));
      tables[t] = records.map(r => { const o = {}; cols.forEach(c => { o[c] = r[c] == null ? "" : String(r[c]).trim(); }); return o; });
      if (miss.length) missing[t] = miss;
      imported.push({ table: t, rows: records.length, file, extra });
    };
    for (const f of files) {
      try {
        if (/\.xlsx?$/i.test(f.name)) {
          if (!window.XLSX) { unknown.push(f.name + " (โหลดตัวอ่าน Excel ไม่สำเร็จ ใช้ CSV แทน)"); continue; }
          const wb = window.XLSX.read(await f.arrayBuffer());
          for (const sn of wb.SheetNames) {
            const ws = wb.Sheets[sn];
            const headers = (window.XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(String);
            const recs = window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false }).map(r => { const o = {}; for (const k in r) o[String(k).trim()] = r[k]; return o; });
            const t = detectTable(sn, headers);
            if (t) take(t, headers, recs, f.name + " › " + sn); else if (sn.toLowerCase() !== "output") unknown.push(f.name + " › " + sn);
          }
        } else {
          const { headers, records } = E.parseCSV(await f.text());
          const t = detectTable(f.name, headers);
          if (t) take(t, headers, records, f.name); else unknown.push(f.name);
        }
      } catch (e) { unknown.push(f.name + " (อ่านไม่ได้)"); }
    }
    if (!imported.length) { toast("ไม่พบตารางที่รู้จักในไฟล์ที่เลือก"); return; }
    const before = {}; Object.keys(E.TABLES).forEach(t => { before[t] = state.data[t].length; });
    state.draft = { origin: "import", data: Object.assign(clone(state.data), tables), split: {}, added: new WeakSet(), missing, imported, unknown, kept: Object.keys(E.TABLES).filter(t => !tables[t]), before };
    state.edTable = imported[0].table; state.edQ = "";
    renderData();
    $("#stagedBox").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function commit(data, source, sampleKey, opts) {
    opts = opts || {};
    state.data = data; state.source = source; state.sampleKey = sampleKey || null; state.draft = null;
    state.results = null; state.final = null; state.sel = null; state.tt.id = null;
    state.cfg = E.mergeConfig(Object.assign({}, state.cfg, { typeOverride: opts.keepType ? (state.cfg.typeOverride || {}) : {}, splitOverride: opts.split || {}, teacherUnavailable: opts.keepType ? (state.cfg.teacherUnavailable || {}) : {} }));
    syncUsers();
  }

  /* =================== 2) ตั้งค่า =================== */
  const CFG_FIELDS = [
    ["breakPeriods", "คาบพัก (ข้อ 2)", "nums"], ["maxPeriodsPerDay", "คาบสูงสุดต่อวัน (ข้อ 5)", "num"],
    ["managerRole", "role ของหัวหน้า (ข้อ 10)", "text"], ["managerMeeting.day", "วันประชุมหัวหน้า", "day"], ["managerMeeting.start", "เริ่มประชุม", "text"], ["managerMeeting.end", "เลิกประชุม", "text"],
    ["homeroom.nameKeywords", "คำในชื่อวิชาโฮมรูม (ข้อ 11)", "list"], ["homeroom.minPeriods", "โฮมรูมขั้นต่ำ (คาบ)", "num"],
    ["activity.nameKeywords", "คำในชื่อวิชากิจกรรม (ข้อ 12)", "list"], ["activity.day", "วันกิจกรรม", "day"], ["activity.start", "เริ่มกิจกรรม", "text"], ["activity.end", "เลิกกิจกรรม", "text"], ["activity.needsRoom", "กิจกรรมต้องใช้ห้อง", "bool"],
    ["general.idPrefixes", "รหัสวิชาสามัญขึ้นต้นด้วย (ข้อ 13)", "list"], ["general.groupSize", "จำนวนกลุ่มที่เรียนรวม", "num"],
    ["iot.nameKeywords", "คำในชื่อวิชา IOT (ข้อ 14)", "list"], ["iot.roomId", "รหัสห้อง IOT", "text"],
    ["theoryRoomTypes", "ค่า room_type ที่เป็นห้องทฤษฎี (ข้อ 9)", "list"], ["avoidTheoryAfterPeriod", "เลี่ยงวิชาทฤษฎีหลังคาบ (ข้อ 15)", "num"],
    ["blockMax.practice", "วิชาปฏิบัติเรียนติดกันสูงสุด (คาบ)", "num"], ["blockMax.theory", "วิชาทฤษฎีเรียนติดกันสูงสุด (คาบ)", "num"]
  ];
  const getPath = (o, p) => p.split(".").reduce((a, k) => a && a[k], o);
  function renderSettings() {
    $("#cfgFields").innerHTML = CFG_FIELDS.map(([p, label, kind], i) => {
      const v = getPath(state.cfg, p), id = "cfg" + i;
      if (kind === "bool") return `<label class="check" style="align-self:end"><input type="checkbox" id="${id}" data-path="${p}" data-kind="bool" ${v ? "checked" : ""}> ${label}</label>`;
      if (kind === "day") return `<label class="field">${label}<select id="${id}" data-path="${p}" data-kind="day">${E.DAY_ORDER.map(d => `<option value="${d}" ${E.normDay(v, state.cfg) === d ? "selected" : ""}>${E.DAY_TH[d]}</option>`).join("")}</select></label>`;
      const val = Array.isArray(v) ? v.join(", ") : v;
      return `<label class="field">${label}<input type="${kind === "num" ? "number" : "text"}" id="${id}" data-path="${p}" data-kind="${kind}" value="${esc(val)}"></label>`;
    }).join("");
    $("#subjFilter").value = state.subjQ;
    renderClassify();
  }
  function renderClassify() {
    const I = idx(), q = state.subjQ.toLowerCase();
    const reg = new Set(state.data.register.map(r => r.subject_id));
    const subs = state.data.subject.filter(s => !q || (s.subject_id + " " + s.subject_name).toLowerCase().includes(q))
      .sort((a, b) => (reg.has(b.subject_id) - reg.has(a.subject_id)) || periodsOf(b) - periodsOf(a) || TYPES.indexOf(I.type.get(a.subject_id)) - TYPES.indexOf(I.type.get(b.subject_id)) || a.subject_id.localeCompare(b.subject_id));
    const counts = {}; state.data.subject.forEach(s => { if (reg.has(s.subject_id)) { const t = I.type.get(s.subject_id); counts[t] = (counts[t] || 0) + 1; } });
    $("#typeCounts").innerHTML = TYPES.map(t => `<span class="type type-${t}">${E.TYPE_TH[t]} ${counts[t] || 0}</span>`).join("");
    $("#classifyTable").innerHTML = `<thead><tr><th>รหัสวิชา</th><th>ชื่อวิชา</th><th class="n">ท.</th><th class="n">ป.</th><th class="n">รวม</th><th>ห้องที่ใช้</th><th>ประเภท</th><th>การแบ่งคาบ</th></tr></thead><tbody>` +
      subs.map(s => {
        const t = I.type.get(s.subject_id), rooms = I.roomsFor(s.subject_id);
        const roomTxt = rooms === null ? "ไม่ใช้ห้อง" : t === "iot" ? state.cfg.iot.roomId : Number(s.practice) > 0 ? "ห้องปฏิบัติ" : "ห้องทฤษฎี";
        return `<tr${reg.has(s.subject_id) ? "" : ' class="muted"'}><td class="mono">${esc(s.subject_id)}</td><td>${esc(s.subject_name)}${reg.has(s.subject_id) ? "" : ' <span class="muted">(ไม่มีกลุ่มลง)</span>'}</td><td class="n">${s.theory}</td><td class="n">${s.practice}</td><td class="n"><b>${periodsOf(s)}</b></td><td>${roomTxt}</td>
          <td><select data-override="${esc(s.subject_id)}" aria-label="ประเภทวิชา ${esc(s.subject_id)}">${TYPES.map(x => `<option value="${x}" ${x === t ? "selected" : ""}>${E.TYPE_TH[x]}</option>`).join("")}</select></td>
          <td>${splitSelect(s, t, state.cfg.splitOverride[s.subject_id], `data-cfgsplit="${esc(s.subject_id)}"`)}</td></tr>`;
      }).join("") + "</tbody>";
  }
  function readSettings() {
    const c = clone(state.cfg);
    document.querySelectorAll("#cfgFields [data-path]").forEach(el => {
      const p = el.dataset.path.split("."), kind = el.dataset.kind;
      let v = kind === "bool" ? el.checked : el.value;
      if (kind === "num") v = Number(v);
      if (kind === "nums") v = String(v).split(/[,\s]+/).filter(Boolean).map(Number);
      if (kind === "list") v = String(v).split(",").map(x => x.trim()).filter(Boolean);
      let o = c; for (let i = 0; i < p.length - 1; i++) o = o[p[i]]; o[p[p.length - 1]] = v;
    });
    return c;
  }

  /* =================== 3) จัดตาราง (Web Worker) =================== */
  const WORKER_SRC = `
    self.onmessage = function (e) {
      var E = self.TTEngine, m = e.data, n = Math.max(1, m.cfg.runs | 0), total = 1 + n + (m.repair ? n : 0), t0 = Date.now();
      var post = function (done, phase) { self.postMessage({ type: "progress", done: done, total: total, phase: phase }); };
      var base = E.runSchedule(m.data, m.cfg, { mode: "baseline" });
      var baseVal = E.validate(m.data, base.rows, m.cfg); post(1, "baseline");
      var heur = E.runBest(m.data, m.cfg, function (i) { post(1 + i, "heuristic"); }, { repair: false });
      var rep = m.repair ? E.runBest(m.data, m.cfg, function (i) { post(1 + n + i, "repair"); }, { repair: true }) : null;
      self.postMessage({ type: "done", base: base, baseVal: baseVal, heur: heur.best, heurVal: heur.validation, heurHist: heur.history,
        rep: rep && rep.best, repVal: rep && rep.validation, repHist: rep && rep.history, ms: Date.now() - t0, runs: n, seed: m.cfg.seed });
    };`;
  function runSync() {
    const n = Math.max(1, state.cfg.runs | 0), t0 = Date.now(), cfg = state.cfg;
    const base = E.runSchedule(state.data, cfg, { mode: "baseline" });
    const heur = E.runBest(state.data, cfg, null, { repair: false });
    const rep = E.runBest(state.data, cfg, null, { repair: true });
    return { base, baseVal: E.validate(state.data, base.rows, cfg), heur: heur.best, heurVal: heur.validation, heurHist: heur.history, rep: rep.best, repVal: rep.validation, repHist: rep.history, ms: Date.now() - t0, runs: n, seed: cfg.seed };
  }
  function startRun() {
    if (state.running || !can("run")) return;
    const issues = E.inputCheck(state.data, state.cfg);
    if (issues.some(i => i.level === "error")) { toast("ข้อมูลยังมีปัญหา แก้ในขั้นที่ 1 ก่อน"); location.hash = "#data"; return; }
    state.cfg.seed = Number($("#seed").value) || 0; state.cfg.runs = Math.min(200, Math.max(1, Number($("#runs").value) || 1));
    const repair = $("#useRepair").checked;
    let worker;
    try { worker = new Worker(URL.createObjectURL(new Blob([document.getElementById("engine").textContent + "\n" + WORKER_SRC], { type: "text/javascript" }))); }
    catch (e) { worker = null; }
    $("#runBtn").disabled = true; $("#retryBtn").disabled = true; $("#cancelBtn").hidden = false;
    $("#progBar").style.width = "0%"; $("#runStatus").textContent = "กำลังจัดตาราง…";
    if (!worker) { setTimeout(() => { finishRun(runSync()); }, 30); return; }
    state.running = worker;
    const phaseTH = { baseline: "วิธีพื้นฐาน", heuristic: "Heuristic", repair: "Heuristic + วงรอบซ่อม" };
    worker.onmessage = ev => {
      const m = ev.data;
      if (m.type === "progress") { $("#progBar").style.width = Math.round(m.done / m.total * 100) + "%"; $("#runStatus").textContent = `${phaseTH[m.phase]} · รอบที่ ${m.done} จาก ${m.total}`; }
      if (m.type === "done") { worker.terminate(); state.running = null; finishRun(m); }
    };
    worker.onerror = err => { worker.terminate(); state.running = null; resetRunButtons(); $("#runStatus").textContent = "เกิดข้อผิดพลาดระหว่างคำนวณ: " + (err.message || "ไม่ทราบสาเหตุ") + " · กดจัดตารางอีกครั้ง"; };
    worker.postMessage({ data: state.data, cfg: state.cfg, repair });
  }
  function resetRunButtons() { $("#runBtn").disabled = false; $("#retryBtn").disabled = false; $("#cancelBtn").hidden = true; }
  function cancelRun() {
    if (!state.running) return;
    state.running.terminate(); state.running = null; resetRunButtons();
    $("#progBar").style.width = "0%"; $("#runStatus").textContent = "ยกเลิกแล้ว ผลเดิมยังอยู่ กดจัดตารางเพื่อเริ่มใหม่";
  }
  function setFinalFromBest() {
    const best = bestResult();
    state.final = { blocks: clone(best.blocks), history: [], manual: new Set(), seed: best.seed };
    refreshFinal();
  }
  function refreshFinal() {
    const f = state.final;
    f.rows = E.rowsFromBlocks(f.blocks);
    f.val = E.validate(state.data, f.rows, state.cfg);
  }
  function finishRun(m) {
    if (!m.rep) { m.rep = null; m.repVal = null; }
    state.results = m; resetRunButtons(); setFinalFromBest(); state.sel = null; state.checkWhich = "final";
    $("#progBar").style.width = "100%";
    const v = m.repVal || m.heurVal;
    $("#runStatus").textContent = `เสร็จใน ${(m.ms / 1000).toFixed(2)} วินาที · ${1 + m.runs * (m.rep ? 2 : 1)} รอบ · ${v.passed ? "ผ่านเงื่อนไข Hard ทุกข้อ" : "ยังมีเงื่อนไขที่ไม่ผ่าน ดูขั้นที่ 4"}`;
    if (!state.tt.id) state.tt.id = state.data.student_group[0] && state.data.student_group[0].group_id;
    render(currentView());
  }
  // แจ้งผู้ดูแลเมื่อครูแจ้งเวลาไม่สะดวกที่ชนกับตารางปัจจุบัน
  function unavBanner() {
    if (!can("run") || !state.final) return "";
    const x = state.final.val.extra[0], recent = state.notices.slice(-3).reverse();
    if (!x.count && !recent.length) return "";
    return `<div class="banner">${x.count ? `ตารางปัจจุบันมี ${x.count} คาบที่ครูแจ้งว่าไม่สะดวก` : "ครูแจ้งเวลาไม่สะดวกแล้ว ตารางปัจจุบันไม่ชน"}${recent.length ? `<span style="font-weight:400">· ${recent.map(n => `${esc(n.name)} แจ้ง ${n.count} ช่อง (${n.time})`).join(" · ")}</span>` : ""}<span class="sp"></span>${x.count ? `<button class="primary" id="rerunNow">จัดตารางใหม่</button>` : `<button id="dismissNotice">รับทราบ</button>`}</div>`;
  }
  function renderRun() {
    $("#runBanner").innerHTML = unavBanner();
    $("#seed").value = state.cfg.seed; $("#runs").value = state.cfg.runs;
    const R = state.results;
    if (!R) { $("#compareTable").innerHTML = `<tbody><tr><td class="muted">ยังไม่ได้จัดตาราง กดปุ่ม "จัดตาราง"</td></tr></tbody>`; $("#repairLog").innerHTML = ""; $("#unscheduled").innerHTML = ""; $("#historyTable").innerHTML = ""; return; }
    const cols = [{ name: "วิธีพื้นฐาน", res: R.base, val: R.baseVal }, { name: `Heuristic<br><span class="muted" style="font-weight:400">ดีสุดจาก ${R.runs} รอบ</span>`, res: R.heur, val: R.heurVal }];
    if (R.rep) cols.push({ name: `Heuristic + ซ่อม<br><span class="muted" style="font-weight:400">ดีสุดจาก ${R.runs} รอบ</span>`, res: R.rep, val: R.repVal });
    const metric = [
      ["คาบที่จัดไม่ลง", c => c.val.summary.missingPeriods, "low"],
      ["ครู/ห้องชนกัน (จุด)", c => c.val.summary.hardViolations, "low"],
      ["เงื่อนไขที่ผ่าน", c => c.val.summary.rulesPassed, "high", v => v + " / 15"],
      ["วิชาทฤษฎีหลังคาบ " + state.cfg.avoidTheoryAfterPeriod, c => c.val.summary.theoryAfter, "low"],
      ["คาบว่างคั่นระหว่างวัน", c => c.val.summary.gaps, "low"],
      ["ความต่างคาบต่อวัน (รวมทุกกลุ่ม)", c => c.val.summary.imbalance, "low"],
      ["ภาระครูสูงสุด (คาบ/สัปดาห์)", c => c.val.metrics.teacherMax, "low"],
      ["คะแนนคุณภาพ", c => c.val.summary.softScore, "low"],
      ["เวลาต่อรอบ (ms)", c => c.res.ms, null]
    ];
    const baseSoft = R.baseVal.summary.softScore;
    $("#compareTable").innerHTML = `<thead><tr><th>ตัวชี้วัด</th>${cols.map(c => `<th class="n">${c.name}</th>`).join("")}</tr></thead><tbody>` +
      metric.map(([label, f, dir, fmt]) => {
        const vals = cols.map(f), target = dir === "low" ? Math.min(...vals) : dir === "high" ? Math.max(...vals) : null;
        return `<tr><td>${label}</td>${vals.map(v => `<td class="n">${target !== null && v === target && new Set(vals).size > 1 ? `<b style="color:var(--ok)">${fmt ? fmt(v) : v}</b>` : (fmt ? fmt(v) : v)}</td>`).join("")}</tr>`;
      }).join("") +
      `<tr><td><b>คะแนนคุณภาพดีขึ้นจากวิธีพื้นฐาน</b></td><td class="n muted">—</td>${cols.slice(1).map(c => `<td class="n"><b>${baseSoft ? Math.round((1 - c.val.summary.softScore / baseSoft) * 100) : 0}%</b></td>`).join("")}</tr></tbody>`;
    const best = bestResult();
    $("#repairLog").innerHTML = !R.rep ? `<p class="muted">ไม่ได้เปิดวงรอบซ่อม</p>` : best.log.length
      ? `<p style="font-size:13.5px">รอบที่ดีที่สุด (seed ${best.seed}) ซ่อม ${best.log.length} ครั้ง: วางบล็อกที่ค้าง (plan) → ย้ายบล็อกที่ขวาง (act) → ตรวจซ้ำ ถ้าแย่ลงย้อนกลับ (check)</p><ul class="plain log">${best.log.slice(0, 30).map(l => `<li>${esc(l)}</li>`).join("")}</ul>`
      : `<p class="muted">Heuristic วางได้ครบตั้งแต่รอบแรก จึงไม่ต้องซ่อม ลองชุด "ห้องน้อย" ในขั้นที่ 1 เพื่อดูการซ่อม</p>`;
    const un = best.unscheduled;
    $("#unscheduled").innerHTML = (best.warnings.length ? `<ul class="plain" style="margin-bottom:8px">${best.warnings.map(w => `<li><span class="pill warn">เตือน</span> ${esc(w)}</li>`).join("")}</ul>` : "") +
      (un.length ? `<div class="issues">${un.map(u => `<div class="issue error"><span class="pill bad">${u.periods} คาบ</span><span>${esc(u.message)}</span><span class="hint">วิธีแก้: ${esc(u.hint)}</span></div>`).join("")}</div>` : `<p><span class="pill ok">ครบ</span> วางได้ทุกคาบ ไม่มีวิชาค้าง</p>`);
    const hist = R.rep ? R.repHist : R.heurHist;
    $("#historyTable").innerHTML = `<thead><tr><th class="n">seed</th><th class="n">ชนกัน</th><th class="n">คาบที่ขาด</th><th class="n">คะแนนคุณภาพ</th><th class="n">เวลา (ms)</th></tr></thead><tbody>` +
      hist.map(h => `<tr class="${h.seed === best.seed ? "best" : ""}"><td class="n">${h.seed}${h.seed === best.seed ? " ✓ ดีที่สุด" : ""}</td><td class="n">${h.hard}</td><td class="n">${h.missing}</td><td class="n">${h.soft}</td><td class="n">${h.ms}</td></tr>`).join("") + "</tbody>";
  }

  /* =================== 4) ตรวจ 15 ข้อ =================== */
  function renderCheck() {
    const R = state.results;
    if (!R) { $("#checkSummary").innerHTML = ""; $("#rules").innerHTML = `<p class="muted">ยังไม่ได้จัดตาราง</p>`; $("#checkWhich").innerHTML = ""; return; }
    const opts = [["base", "วิธีพื้นฐาน", R.baseVal], ["heur", "Heuristic", R.heurVal]];
    if (R.rep) opts.push(["rep", "Heuristic + ซ่อม", R.repVal]);
    if (state.final.manual.size) opts.push(["final", `ฉบับปัจจุบัน (แก้เอง ${state.final.manual.size})`, state.final.val]);
    if (state.checkWhich === "final" && !state.final.manual.size) state.checkWhich = R.rep ? "rep" : "heur";
    if (!opts.some(o => o[0] === state.checkWhich)) state.checkWhich = opts[opts.length - 1][0];
    $("#checkWhich").innerHTML = opts.map(o => `<button data-which="${o[0]}" aria-pressed="${state.checkWhich === o[0]}">${o[1]}</button>`).join("");
    const v = opts.find(o => o[0] === state.checkWhich)[2], s = v.summary;
    $("#checkSummary").innerHTML = [
      [s.rulesPassed + " / 15", "เงื่อนไขที่ผ่าน", s.rulesPassed === 15 ? "ok" : "bad"],
      [s.hardViolations, "จุดที่ครู/ห้องชนกัน", s.hardViolations ? "bad" : "ok"],
      [s.missingPeriods, "คาบที่จัดไม่ลง", s.missingPeriods ? "bad" : "ok"],
      [s.softScore, "คะแนนคุณภาพ (ยิ่งน้อยยิ่งดี)", ""]
    ].map(([val, k, cls]) => `<div class="stat ${cls}"><div class="v">${val}</div><div class="k">${k}</div></div>`).join("");
    const TYPE = { hard: ["hard", "Hard"], lock: ["lock", "ช่องล็อก"], soft: ["soft", "Soft"] };
    const extraRules = (v.extra || []).filter(x => x.count || Object.values(state.cfg.teacherUnavailable || {}).some(l => l && l.length));
    $("#rules").innerHTML = [...v.rules, ...extraRules].map(r => `<details class="rule ${r.passed || r.type === "soft" ? "" : "fail"}" ${!r.passed && r.type !== "soft" ? "open" : ""}>
      <summary><span class="id">${r.id === "U" ? "+" : String(r.id).padStart(2, "0")}</span><span>${esc(r.name)}${r.id === "U" ? ' <span class="muted" style="font-size:12.5px">(เพิ่มเติมจากโจทย์)</span>' : ""}</span><span class="pill ${TYPE[r.type][0]}">${TYPE[r.type][1]}</span>
      <span class="pill ${r.passed ? "ok" : r.type === "soft" ? "warn" : "bad"}">${r.passed ? "ผ่าน" : (r.type === "soft" ? "พบ " : "ผิด ") + r.count + " จุด"}</span></summary>
      ${r.passed ? "" : `<div class="vlist">${r.violations.slice(0, 25).map(x => `<div>${esc(x.message)}<div class="h">วิธีแก้: ${esc(x.hint)}</div></div>`).join("")}${r.count > 25 ? `<div class="muted">และอีก ${r.count - 25} จุด</div>` : ""}</div>`}
    </details>`).join("");
  }

  /* =================== 5) ตารางสอน: แสดงเป็นบล็อก ลากย้าย สลับ แบ่ง/รวมคาบ =================== */
  function entities(mode) {
    const d = state.data;
    if (mode === "group") return d.student_group.map(g => ({ id: g.group_id, label: `${g.group_id} · ${g.group_name}` }));
    if (mode === "teacher") return d.teacher.map(t => ({ id: t.teacher_id, label: `${t.teacher_id} · ${t.teacher_name}${isMgr(t.role) ? " (หัวหน้า)" : ""}` }));
    return d.room.map(r => ({ id: r.room_id, label: `${r.room_id} · ${r.room_name} (${r.room_type})` }));
  }
  const inView = (b, mode, id) => mode === "group" ? b.groups.includes(id) : mode === "teacher" ? b.teacher === id : b.room === id;
  const blockById = id => state.final.blocks.find(b => b.id === id);
  function blockInfo(mode, b, I) {
    const s = I.subject.get(b.subject) || { subject_name: b.subject };
    const lines = mode === "group" ? [shortName(teacherName(b.teacher)), b.room || "ไม่ใช้ห้อง"]
      : mode === "teacher" ? [b.groups.map(groupName).join(" + "), b.room || "ไม่ใช้ห้อง"]
        : [b.groups.map(groupName).join(" + "), shortName(teacherName(b.teacher))];
    const hay = [b.subject, s.subject_name, b.teacher, teacherName(b.teacher), b.room, ...b.groups, ...b.groups.map(groupName)].join(" ").toLowerCase();
    return { title: `${b.subject} ${s.subject_name}`, lines, hay, total: periodsOf(s) };
  }
  function renderTable() {
    const u = state.user;
    if (u.role === "student") state.tt = Object.assign(state.tt, { mode: "group", id: u.group_id });
    $("#ttMode").hidden = !can("viewAll"); $("#ttEntity").closest("label").hidden = !can("viewAll");
    $("#exXlsx").hidden = !can("exportAll"); $("#exCsv").hidden = !can("exportAll");
    $("#ttBanner").innerHTML = unavBanner();
    document.querySelector("#view-table .view-head h2").textContent = u.role === "student" ? "ตารางเรียน" : "ตารางสอน";
    document.querySelector("#view-table .view-head p").textContent = can("editTable")
      ? "ลากวิชาไปช่องว่างเพื่อย้าย หรือวางทับวิชาอื่นเพื่อสลับ ระบบตรวจเงื่อนไขให้ก่อนวางทุกครั้ง บนมือถือให้แตะวิชาแล้วแตะช่องปลายทาง"
      : u.role === "teacher" ? "ดูตารางสอนของตัวเองและของครู กลุ่ม หรือห้องอื่นได้ ถ้าเวลาไหนไม่สะดวก แจ้งได้ที่เมนูเวลาไม่สะดวก" : `ตารางเรียนของกลุ่ม ${groupName(u.group_id)} (${u.group_id})`;
    const mode = state.tt.mode;
    $("#ttMode").innerHTML = [["group", "กลุ่มเรียน"], ["teacher", "ครู"], ["room", "ห้อง"]].map(([m, l]) => `<button data-mode="${m}" aria-pressed="${mode === m}">${l}</button>`).join("");
    const ents = entities(mode);
    if (!ents.some(e => e.id === state.tt.id)) state.tt.id = ents[0] && ents[0].id;
    $("#ttEntity").innerHTML = ents.map(e => `<option value="${esc(e.id)}" ${e.id === state.tt.id ? "selected" : ""}>${esc(e.label)}</option>`).join("");
    $("#ttLegend").innerHTML = TYPES.map(t => `<span class="type type-${t}">${E.TYPE_TH[t]}</span>`).join("") + (mode === "teacher" ? ` <span class="type" style="box-shadow:inset 0 0 0 2px var(--mark)">ช่วงประชุมหัวหน้า</span>` : "") + (can("editTable") ? ` <span class="type" style="background:var(--ink);color:var(--bg)">แก้เอง</span>` : "");
    if (!state.final) { $("#tt").innerHTML = `<tbody><tr><td class="muted">ยังไม่ได้จัดตาราง</td></tr></tbody>`; $("#editBar").innerHTML = ""; return; }
    const I = idx(), q = state.tt.q.trim().toLowerCase();
    const mgr = mode === "teacher" && I.isManager(state.tt.id);
    const blocks = state.final.blocks.filter(b => inView(b, mode, state.tt.id));
    const startAt = new Map(), covered = new Set();
    for (const b of blocks) { startAt.set(b.day + "|" + b.periods[0], b); b.periods.slice(1).forEach(p => covered.add(b.day + "|" + p)); }
    let html = `<thead><tr><th class="day">วัน</th>${I.periods.map(p => { const s = I.slots.find(x => x.period === p); return `<th>คาบ ${p}<span class="time">${s ? esc(s.startText) : ""}</span></th>`; }).join("")}</tr></thead><tbody>`;
    let total = 0, hits = 0;
    for (const d of I.days) {
      html += `<tr><th class="day">${E.DAY_TH[d] || d}</th>`;
      for (const p of I.periods) {
        if (covered.has(d + "|" + p)) continue;
        const slot = I.slotsByDay[d].find(s => s.period === p);
        if (!slot) { html += `<td></td>`; continue; }
        if (state.cfg.breakPeriods.includes(p)) { html += `<td data-day="${d}" data-period="${p}" data-break="1"><div class="cell break">พัก</div></td>`; continue; }
        const b = startAt.get(d + "|" + p), meet = mgr && I.inMeeting(slot);
        if (!b) { html += `<td data-day="${d}" data-period="${p}"><div class="cell empty ${meet ? "meeting" : ""}">${meet ? '<span class="x" style="padding:2px;color:var(--muted)">ประชุม</span>' : ""}</div></td>`; continue; }
        const len = b.slots.length; total += len;
        const c = blockInfo(mode, b, I), match = q && c.hay.includes(q); if (match) hits += len;
        const part = len < c.total ? `${len} จาก ${c.total} คาบ` : `${len} คาบ`;
        html += `<td colspan="${len}" data-block="${b.id}" data-day="${d}" data-period="${p}"><div class="cell t-${b.type} ${q ? (match ? "hit" : "dim") : ""}" title="${esc(c.title)} · ${esc(c.lines.join(" · "))} · ลากเพื่อย้าย">
          <span class="s">${esc(c.title)}${state.final.manual.has(b.id) ? '<span class="manual">แก้เอง</span>' : ""}</span>${c.lines.map(l => `<span class="x">${esc(l)}</span>`).join("")}<span class="len">${part}</span></div></td>`;
      }
      html += `</tr>`;
    }
    $("#tt").innerHTML = html + "</tbody>";
    $("#tt").classList.toggle("readonly", !can("editTable"));
    $("#ttNote").textContent = `${total} คาบต่อสัปดาห์` + (q ? ` · พบ "${state.tt.q}" ${hits} คาบ` : "") + " · เลื่อนตารางซ้าย-ขวาได้บนจอเล็ก";
    renderEditBar();
    if (state.sel) paintTargets(state.sel.id, state.sel.off);
  }
  function renderEditBar() {
    const f = state.final, s = f.val.summary;
    if (!can("editTable")) {
      const mine = state.user.role === "teacher" && state.tt.mode === "teacher" && state.tt.id === state.user.teacher_id;
      const un = mine ? (state.cfg.teacherUnavailable[state.user.teacher_id] || []).length : 0;
      $("#editBar").innerHTML = state.user.role === "teacher"
        ? `<span class="pill ${f.val.passed ? "ok" : "bad"}">ตรวจ 15 ข้อ: ผ่าน ${s.rulesPassed}/15</span><span class="readonly-note">ดูอย่างเดียว · แก้ตารางได้เฉพาะผู้ดูแลระบบ${mine && un ? ` · คุณแจ้งไม่สะดวก ${un} ช่อง` : ""}</span><span class="sp"></span><a class="btn" href="#unavail">แจ้งเวลาไม่สะดวก</a>`
        : `<span class="readonly-note">ตารางนี้เป็นฉบับล่าสุดที่ผู้ดูแลจัดไว้ · บันทึกเป็นไฟล์ได้ที่ปุ่ม "ตารางนี้ (พร้อมพิมพ์)"</span>`;
      return;
    }
    let html = `<span class="pill ${f.val.passed ? "ok" : "bad"}">ตรวจ 15 ข้อ: ผ่าน ${s.rulesPassed}/15</span>`;
    html += f.manual.size ? `<span>แก้เอง ${f.manual.size} บล็อก</span>` : `<span class="muted">ลากวิชาเพื่อย้ายหรือสลับ · คลิกวิชาเพื่อแบ่งหรือรวมคาบ</span>`;
    html += `<span class="sp"></span><button id="undoBtn" ${f.history.length ? "" : "disabled"}>เลิกทำ</button><button id="resetEdits" ${f.manual.size || f.history.length ? "" : "disabled"}>กลับเป็นผลอัตโนมัติ</button>`;
    if (state.sel) {
      const b = blockById(state.sel.id);
      if (b) {
        const I = idx(), sub = I.subject.get(b.subject), len = b.slots.length;
        const sibling = mergeCandidate(b);
        const splitOpts = []; for (let a = len - 1; a >= 1; a--) splitOpts.push(`${a}+${len - a}`);
        html += `<div class="detail" style="flex-basis:100%"><b>${esc(b.subject)} ${esc(sub ? sub.subject_name : "")}</b><span>${esc(E.DAY_TH[b.day])} คาบ ${b.periods[0]}–${b.periods[b.periods.length - 1]} (${len} คาบ) · ${esc(b.groups.join(", "))} · ${esc(teacherName(b.teacher))} · ${esc(b.room || "ไม่ใช้ห้อง")}</span>
          <span class="sp" style="flex:1"></span>
          ${len >= 2 && b.type !== "activity" ? `<label class="check">แบ่งบล็อกนี้เป็น <select id="splitHere">${splitOpts.map(o => `<option value="${o}">${o} คาบ</option>`).join("")}</select></label><button id="doSplit">แบ่ง</button>` : ""}
          ${sibling ? `<button id="doMerge">รวมกับช่วงที่ติดกันเป็น ${len + sibling.slots.length} คาบ</button>` : ""}
          <button id="goSplitCfg" title="ตั้งค่าให้การจัดอัตโนมัติครั้งต่อไป">ตั้งรูปแบบคาบของวิชานี้</button>
          <button id="clearSel">ยกเลิกการเลือก</button></div>`;
      }
    }
    $("#editBar").innerHTML = html;
  }
  // บล็อกของวิชาเดียวกัน กลุ่มเดียวกัน วันเดียวกัน ที่อยู่ติดกัน (รวมได้)
  function mergeCandidate(b) {
    const first = b.periods[0], last = b.periods[b.periods.length - 1];
    return state.final.blocks.find(o => o.id !== b.id && o.subject === b.subject && o.day === b.day && o.groups.join() === b.groups.join() && o.teacher === b.teacher &&
      (o.periods[0] === last + 1 || o.periods[o.periods.length - 1] === first - 1));
  }

  /* ----- ตรวจทุกช่องปลายทางของบล็อกที่กำลังลาก แล้วระบายสี ----- */
  // สถานะ: ok = ย้ายได้ (เขียว), warn = ย้ายได้แต่ผิดข้อ Soft (เหลือง), swap = สลับได้ (น้ำเงิน), no = วางไม่ได้ (แดง)
  let targets = new Map();
  function evaluateTarget(td, srcId, off) {
    const I = idx(), blocks = state.final.blocks, A = blockById(srcId);
    if (td.dataset.block === srcId) return { status: "src" };
    if (td.dataset.break) return { status: "no", why: "คาบพัก ห้ามจัดวิชา (ข้อ 2)" };
    if (td.dataset.block) {
      const B = blockById(td.dataset.block);
      const res = E.checkPlacement(I, state.cfg, blocks, [{ id: A.id, day: B.day, start: B.periods[0] }, { id: B.id, day: A.day, start: A.periods[0] }]);
      return res.ok ? { status: "swap", res, B, label: `สลับกับ ${B.subject}` } : { status: "no", why: "สลับไม่ได้: " + res.reasons[0] };
    }
    const day = td.dataset.day, start = Number(td.dataset.period) - off;
    const res = E.checkPlacement(I, state.cfg, blocks, [{ id: A.id, day, start }]);
    if (!res.ok) return { status: "no", why: res.reasons[0] };
    const pl = res.placements[0], sub = I.subject.get(A.subject);
    const late = A.type !== "activity" && Number(sub.practice) === 0 && pl.periods.some(p => p > state.cfg.avoidTheoryAfterPeriod);
    const where = `${E.DAY_TH[day]} คาบ ${pl.periods[0]}–${pl.periods[pl.periods.length - 1]}`;
    const label = where + (pl.roomChanged ? ` · ใช้ห้อง ${pl.room}` : "");
    return late ? { status: "warn", res, label, where, why: `ได้ แต่ไม่แนะนำ: วิชาทฤษฎีหลังคาบ ${state.cfg.avoidTheoryAfterPeriod} (ข้อ 15)` } : { status: "ok", res, label, where };
  }
  function paintTargets(srcId, off) {
    targets = new Map();
    const A = blockById(srcId); if (!A) return;
    let ok = 0, sw = 0;
    document.querySelectorAll("#tt td[data-day]").forEach(td => {
      const t = evaluateTarget(td, srcId, off); targets.set(td, t);
      td.classList.remove("d-ok", "d-warn", "d-swap", "d-no", "d-src", "d-sel", "d-hover");
      if (t.status === "src") td.classList.add(drag && drag.started ? "d-src" : "d-sel");
      else td.classList.add("d-" + t.status);
      const cell = td.querySelector(".cell");
      if (cell && (t.status === "ok" || t.status === "warn")) cell.dataset.hint = t.status === "ok" ? "วางได้" : "ไม่แนะนำ";
      if (t.status === "ok" || t.status === "warn") ok++; if (t.status === "swap") sw++;
    });
    const bar = $("#dragBar"); bar.hidden = false;
    bar.innerHTML = `<span class="msg">${drag && drag.started ? "กำลังย้าย" : "เลือกแล้ว"}: ${esc(A.subject)} (${esc(A.groups.join(","))}) ${A.slots.length} คาบ</span>
      <span class="key"><i class="sw ok"></i>ย้ายได้ ${ok - [...targets.values()].filter(t => t.status === "warn").length}</span><span class="key"><i class="sw warn"></i>ได้แต่ไม่แนะนำ</span><span class="key"><i class="sw swap"></i>สลับได้ ${sw}</span><span class="key"><i class="sw no"></i>วางไม่ได้</span>
      <span class="muted" id="dragMsg">${drag && drag.started ? "ปล่อยบนช่องสีเขียวหรือวิชาที่มีกรอบน้ำเงิน · Esc ยกเลิก" : "แตะช่องสีเขียวเพื่อย้าย หรือวิชาที่มีกรอบน้ำเงินเพื่อสลับ"}</span>`;
  }
  function clearTargets() {
    document.querySelectorAll("#tt td").forEach(td => { td.classList.remove("d-ok", "d-warn", "d-swap", "d-no", "d-src", "d-sel", "d-hover"); });
    targets = new Map(); const bar = $("#dragBar"); if (bar) bar.hidden = true;
  }
  function clearSelection(rerender) { state.sel = null; clearTargets(); if (rerender !== false && currentView() === "table" && state.final) renderEditBar(); }

  /* ----- นำการย้าย/สลับ/แบ่ง/รวมมาใช้ แล้วตรวจ 15 ข้อซ้ำ ----- */
  function applyBlocks(newBlocks, changedIds, msg) {
    const f = state.final;
    f.history.push({ blocks: f.blocks, manual: new Set(f.manual) });
    if (f.history.length > 50) f.history.shift();
    f.blocks = newBlocks; changedIds.forEach(id => f.manual.add(id));
    refreshFinal(); state.sel = null; clearTargets();
    renderTable(); stepMarks();
    const s = f.val.summary;
    toast(`${msg} · ตรวจ 15 ข้อ: ผ่าน ${s.rulesPassed}/15${f.val.passed ? "" : " (มีข้อที่ไม่ผ่าน ดูขั้นที่ 4)"}`);
  }
  function applyTarget(t, srcId) {
    if (!t || t.status === "src") return;
    if (t.status === "no") { toast("วางไม่ได้: " + t.why); return; }
    const pm = new Map(t.res.placements.map(p => [p.id, p]));
    const nb = state.final.blocks.map(b => pm.has(b.id) ? Object.assign({}, b, { day: pm.get(b.id).day, slots: pm.get(b.id).slots, periods: pm.get(b.id).periods, room: pm.get(b.id).room }) : b);
    const A = blockById(srcId), roomNote = t.res.placements.filter(p => p.roomChanged).map(p => ` · ${p.id === srcId ? A.subject : t.B.subject} ย้ายห้องเป็น ${p.room}`).join("");
    applyBlocks(nb, [...pm.keys()], (t.status === "swap" ? `สลับ ${A.subject} กับ ${t.B.subject}` : `ย้าย ${A.subject} ไป${t.where}`) + roomNote + (t.status === "warn" ? " · ไม่แนะนำ: ทฤษฎีหลังคาบ " + state.cfg.avoidTheoryAfterPeriod : ""));
  }
  let uid = 0;
  function splitSelected() {
    const b = blockById(state.sel.id), [a] = $("#splitHere").value.split("+").map(Number);
    const p1 = Object.assign({}, b, { id: b.id + "s" + (++uid), slots: b.slots.slice(0, a), periods: b.periods.slice(0, a) });
    const p2 = Object.assign({}, b, { id: b.id + "s" + (++uid), slots: b.slots.slice(a), periods: b.periods.slice(a) });
    applyBlocks(state.final.blocks.flatMap(x => x.id === b.id ? [p1, p2] : [x]), [p1.id, p2.id], `แบ่ง ${b.subject} เป็น ${a}+${b.slots.length - a} คาบ แล้วลากแต่ละช่วงไปวางได้`);
  }
  function mergeSelected() {
    const b = blockById(state.sel.id), o = mergeCandidate(b); if (!o) return;
    const [x, y] = b.periods[0] < o.periods[0] ? [b, o] : [o, b];
    const merged = Object.assign({}, x, { id: "m" + (++uid), slots: [...x.slots, ...y.slots], periods: [...x.periods, ...y.periods] });
    const rest = state.final.blocks.filter(z => z.id !== b.id && z.id !== o.id);
    const chk = E.checkPlacement(idx(), state.cfg, [...rest, merged], [{ id: merged.id, day: merged.day, start: merged.periods[0] }]);
    if (!chk.ok) { toast("รวมไม่ได้: " + chk.reasons[0]); return; }
    merged.room = chk.placements[0].room;
    applyBlocks([...rest, merged], [merged.id], `รวม ${b.subject} เป็น ${merged.slots.length} คาบติดกัน` + (chk.placements[0].roomChanged ? ` · ใช้ห้อง ${merged.room}` : ""));
  }

  /* ----- ลากด้วย pointer (เมาส์และนิ้ว) + แตะเลือกแล้วแตะปลายทาง ----- */
  let drag = null, ghost = null, hoverTd = null;
  function offsetIn(td, x, len) { const r = td.getBoundingClientRect(); return Math.min(len - 1, Math.max(0, Math.floor((x - r.left) / r.width * len))); }
  document.addEventListener("pointerdown", e => {
    const td = e.target.closest("#tt td[data-block]");
    if (!td || e.button > 0 || !state.final || !can("editTable")) return;
    const b = blockById(td.dataset.block); if (!b) return;
    drag = { id: b.id, off: offsetIn(td, e.clientX, b.slots.length), x: e.clientX, y: e.clientY, started: false, td };
  });
  document.addEventListener("pointermove", e => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.started = true; state.sel = null;
      $("#tt").classList.add("dragging");
      paintTargets(drag.id, drag.off);
      ghost = document.createElement("div"); ghost.className = "ghost"; document.body.appendChild(ghost);
    }
    e.preventDefault();
    const A = blockById(drag.id);
    const el = document.elementFromPoint(e.clientX, e.clientY), td = el && el.closest("#tt td[data-day]");
    if (hoverTd && hoverTd !== td) hoverTd.classList.remove("d-hover");
    hoverTd = td; if (td) td.classList.add("d-hover");
    const t = td ? targets.get(td) : null;
    ghost.className = "ghost " + (t ? (t.status === "src" ? "" : t.status) : "");
    ghost.innerHTML = `${esc(A.subject)} · ${A.slots.length} คาบ<small>${t ? (t.status === "ok" ? "ย้ายไป " + esc(t.label) : t.status === "warn" ? esc(t.label) + " · " + esc(t.why) : t.status === "swap" ? esc(t.label) : t.status === "src" ? "ตำแหน่งเดิม" : esc(t.why)) : "ลากไปที่ช่องในตาราง"}</small>`;
    ghost.style.left = Math.min(window.innerWidth - 270, e.clientX + 14) + "px"; ghost.style.top = (e.clientY + 16) + "px";
    const msg = $("#dragMsg"); if (msg && t && t.status === "no") msg.textContent = t.why;
  }, { passive: false });
  function endDrag() { if (ghost) ghost.remove(); ghost = null; if (hoverTd) hoverTd.classList.remove("d-hover"); hoverTd = null; $("#tt").classList.remove("dragging"); drag = null; }
  document.addEventListener("pointerup", e => {
    if (!drag) return;
    const d = drag;
    if (d.started) {
      const el = document.elementFromPoint(e.clientX, e.clientY), td = el && el.closest("#tt td[data-day]");
      const t = td ? targets.get(td) : null;
      endDrag();
      if (t && t.status !== "src") applyTarget(t, d.id); else { clearTargets(); renderEditBar(); }
    } else {
      endDrag();
      const t = state.sel ? targets.get(d.td) : null;
      if (state.sel && state.sel.id === d.id) clearSelection();
      else if (t && t.status === "swap") applyTarget(t, state.sel.id); // แตะวิชาที่สลับได้ = สลับ
      else { state.sel = { id: d.id, off: 0 }; renderEditBar(); paintTargets(d.id, 0); }
    }
  });
  document.addEventListener("pointercancel", () => { if (drag) { endDrag(); clearTargets(); } });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (drag) endDrag(); clearSelection(); } });
  // แตะเลือกแล้วแตะปลายทาง (ใช้ได้ทั้งมือถือและเมาส์)
  document.addEventListener("click", e => {
    if (!state.sel || !can("editTable")) return;
    const td = e.target.closest("#tt td[data-day]");
    if (!td || td.dataset.block === state.sel.id) return;
    const t = targets.get(td);
    if (td.dataset.block && t && t.status !== "swap") return; // คลิกบล็อกอื่นที่สลับไม่ได้ = เปลี่ยนการเลือก (pointerup จัดการแล้ว)
    if (t) applyTarget(t, state.sel.id);
  });

  function exportXlsx() {
    if (!window.XLSX) { toast("โหลดตัวเขียน Excel ไม่สำเร็จ ใช้ output.csv แทน"); return; }
    const f = state.final, I = idx(), X = window.XLSX, wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(f.rows, { header: E.OUTPUT_COLUMNS }), "output");
    for (const g of state.data.student_group) {
      const bySlot = new Map(); f.blocks.filter(b => b.groups.includes(g.group_id)).forEach(b => b.slots.forEach(s => bySlot.set(s, b)));
      const aoa = [[`ตารางเรียน ${g.group_name} (${g.group_id})`], ["วัน", ...I.periods.map(p => "คาบ " + p)]];
      for (const d of I.days) aoa.push([E.DAY_TH[d] || d, ...I.periods.map(p => { const s = I.slotsByDay[d].find(x => x.period === p); if (!s) return ""; if (state.cfg.breakPeriods.includes(p)) return "พัก"; const b = bySlot.get(s.id); if (!b) return ""; const c = blockInfo("group", b, I); return c.title + " / " + c.lines.join(" / "); })]);
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), g.group_id.slice(0, 31));
    }
    saveFile("timetable.xlsx", xlsxBuffer(wb));
  }
  function exportCsv() { saveFile("output.csv", "﻿" + E.toCSV(state.final.rows, E.OUTPUT_COLUMNS), "text/csv"); }
  function exportHtml() {
    const ent = entities(state.tt.mode).find(e => e.id === state.tt.id);
    const css = `body{font-family:"IBM Plex Sans Thai",sans-serif;margin:16px;color:#16202c}h1{font-size:18px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #c8cfd9;padding:4px;font-size:10px;vertical-align:top}.cell .s{font-weight:600;display:block}.cell .x,.cell .len{display:block}.manual{font-size:8px;margin-left:3px}.break{color:#888;text-align:center}.time{display:block;font-weight:400}@page{size:A4 landscape;margin:10mm}`;
    const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ตารางสอน ${esc(ent ? ent.label : "")}</title><style>${css}</style><\/head><body><h1>ตารางสอน ${esc(ent ? ent.label : "")}</h1>${$("#tt").outerHTML}<p style="font-size:10px;color:#666">สร้างจากระบบจัดตารางสอนอัตโนมัติ · seed ${state.final.seed}${state.final.manual.size ? " · แก้เอง " + state.final.manual.size + " บล็อก" : ""} · กด Ctrl+P เพื่อบันทึกเป็น PDF</p><\/body><\/html>`;
    saveFile(`timetable-${state.tt.id}.html`, html, "text/html");
  }

  /* =================== แจ้งเวลาไม่สะดวก (Teacher; Admin เลือกครูได้) =================== */
  function renderUnavail() {
    const I = idx(), u = state.user, isAdmin = u.role === "admin";
    const teachers = state.data.teacher;
    if (!state.un || (!isAdmin && state.un.tid !== u.teacher_id) || !teachers.some(t => t.teacher_id === state.un.tid)) {
      const tid = isAdmin ? (state.un && teachers.some(t => t.teacher_id === state.un.tid) ? state.un.tid : teachers[0].teacher_id) : u.teacher_id;
      state.un = { tid, set: new Set(state.cfg.teacherUnavailable[tid] || []), dirty: false };
    }
    const tid = state.un.tid;
    $("#unTeacherWrap").hidden = !isAdmin;
    if (isAdmin) $("#unTeacher").innerHTML = teachers.map(t => `<option value="${esc(t.teacher_id)}" ${t.teacher_id === tid ? "selected" : ""}>${esc(t.teacher_id)} · ${esc(t.teacher_name)}${(state.cfg.teacherUnavailable[t.teacher_id] || []).length ? ` (ไม่สะดวก ${(state.cfg.teacherUnavailable[t.teacher_id] || []).length})` : ""}</option>`).join("");
    const busy = new Map();
    if (state.final) state.final.blocks.filter(b => b.teacher === tid).forEach(b => b.slots.forEach(sid => busy.set(sid, b)));
    let html = `<thead><tr><th class="day">วัน</th>${I.periods.map(p => { const sl = I.slots.find(x => x.period === p); return `<th>คาบ ${p}<span class="time">${sl ? esc(sl.startText) : ""}</span></th>`; }).join("")}</tr></thead><tbody>`;
    let clash = 0;
    for (const d of I.days) {
      html += `<tr><th class="day">${E.DAY_TH[d] || d}</th>`;
      for (const p of I.periods) {
        const sl = I.slotsByDay[d].find(x => x.period === p);
        if (!sl) { html += "<td></td>"; continue; }
        if (state.cfg.breakPeriods.includes(p)) { html += `<td><div class="cell break">พัก</div></td>`; continue; }
        const off = state.un.set.has(sl.id), b = busy.get(sl.id), meet = I.isManager(tid) && I.inMeeting(sl);
        if (off && b) clash++;
        const cls = off && b ? "clash" : off ? "off" : b ? "busy" : "free";
        const txt = off && b ? `ไม่สะดวก<br>แต่มีสอน ${esc(b.subject)}` : off ? "ไม่สะดวก" : b ? esc(b.subject) : meet ? "ประชุมหัวหน้า" : "";
        html += `<td class="slot" data-slot="${sl.id}" title="${off ? "แตะเพื่อเปลี่ยนเป็นสะดวก" : "แตะเพื่อแจ้งว่าไม่สะดวก"}"><div class="cell ${cls}${meet ? " meeting" : ""}" style="font-size:11px">${txt}</div></td>`;
      }
      html += "</tr>";
    }
    $("#unGrid").innerHTML = html + "</tbody>";
    const t = teachers.find(x => x.teacher_id === tid);
    $("#unNote").innerHTML = `<b>${esc(t ? t.teacher_name : tid)}</b> แจ้งไม่สะดวก ${state.un.set.size} ช่อง` + (clash ? ` · <span style="color:var(--bad);font-weight:600">ชนกับตารางปัจจุบัน ${clash} คาบ</span> บันทึกแล้วผู้ดูแลจะเห็นแจ้งเตือนให้จัดตารางใหม่` : "") + (state.un.dirty ? ` · <span style="color:var(--warn);font-weight:600">ยังไม่ได้บันทึก</span>` : "");
  }
  function saveUnavail() {
    const tid = state.un.tid, list = [...state.un.set];
    const tu = Object.assign({}, state.cfg.teacherUnavailable); if (list.length) tu[tid] = list; else delete tu[tid];
    state.cfg = E.mergeConfig(Object.assign({}, state.cfg, { teacherUnavailable: {} })); state.cfg.teacherUnavailable = tu;
    if (state.final) refreshFinal();
    const t = state.data.teacher.find(x => x.teacher_id === tid), clash = state.final ? state.final.val.extra[0].violations.filter(v => v.message.includes(tid)).length : 0;
    const now = new Date();
    state.notices.push({ name: t ? t.teacher_name : tid, count: list.length, time: String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") });
    state.un.dirty = false; renderUnavail(); stepMarks();
    toast(`บันทึกเวลาไม่สะดวก ${list.length} ช่องแล้ว` + (clash ? ` · ชนกับตารางปัจจุบัน ${clash} คาบ ผู้ดูแลจะเห็นแจ้งเตือน` : ""));
  }

  /* =================== บัญชีผู้ใช้ (Admin) =================== */
  function renderUsers() {
    const c = r => state.users.filter(u => u.role === r).length;
    $("#userSummary").innerHTML = [["admin", c("admin")], ["teacher", c("teacher")], ["student", c("student")]].map(([r, n]) => `<div class="stat"><div class="v">${n}</div><div class="k"><span class="role role-${r}">${ROLE_TH[r]}</span></div></div>`).join("");
    $("#userRoleFilter").innerHTML = [["all", "ทั้งหมด"], ["admin", "Admin"], ["teacher", "Teacher"], ["student", "Student"]].map(([k, l]) => `<button type="button" data-urole="${k}" aria-pressed="${state.userRole === k}">${l}</button>`).join("");
    $("#userSearch").value = state.userQ;
    fillLinkOptions();
    const q = state.userQ.trim().toLowerCase();
    const list = state.users.filter(u => (state.userRole === "all" || u.role === state.userRole) && (!q || (u.username + " " + displayName(u) + " " + u.teacher_id + " " + u.group_id).toLowerCase().includes(q)));
    const shown = list.slice(0, 200);
    $("#userTable").innerHTML = `<thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อที่แสดง</th><th>บทบาท</th><th>ผูกกับ</th><th>ค่าที่เก็บ (hash)</th><th>ตั้งรหัสผ่านใหม่</th><th></th></tr></thead><tbody>` +
      shown.map(u => {
        const i = state.users.indexOf(u), self = u === state.user, lastAdmin = u.role === "admin" && c("admin") === 1;
        const link = u.role === "teacher" ? u.teacher_id : u.role === "student" ? u.group_id : "—";
        const orphan = displayName(u).startsWith("(ไม่พบ");
        return `<tr class="${orphan ? "err" : ""}"><td class="mono">${esc(u.username)}${self ? ' <span class="pill ok">คุณ</span>' : ""}</td><td>${esc(displayName(u))}</td><td><span class="role role-${u.role}">${ROLE_TH[u.role]}</span></td><td class="mono">${esc(link)}</td>
          <td class="mono muted" title="salt ${esc(u.salt)}">${u.hash.slice(0, 12)}…</td>
          <td><div class="pwd"><input type="text" id="pw-${i}" placeholder="รหัสใหม่" aria-label="รหัสผ่านใหม่ของ ${esc(u.username)}"><button type="button" data-setpw="${i}">ตั้งรหัส</button></div></td>
          <td>${self || lastAdmin ? `<span class="muted" style="font-size:12px">${self ? "บัญชีที่ใช้อยู่" : "Admin คนสุดท้าย"}</span>` : `<button type="button" class="del" data-deluser="${i}">ลบ</button>`}</td></tr>`;
      }).join("") + "</tbody>" + (list.length > shown.length ? `<caption class="muted" style="caption-side:bottom;padding:8px;font-size:12.5px">แสดง 200 จาก ${list.length} บัญชี ใช้ช่องค้นหาเพื่อหาบัญชีอื่น</caption>` : "");
  }
  function fillLinkOptions() {
    const role = $("#nuRole").value, sel = $("#nuLink");
    sel.disabled = role === "admin";
    sel.innerHTML = role === "teacher" ? state.data.teacher.map(t => `<option value="${esc(t.teacher_id)}">${esc(t.teacher_id)} · ${esc(t.teacher_name)}</option>`).join("")
      : role === "student" ? state.data.student_group.map(g => `<option value="${esc(g.group_id)}">${esc(g.group_id)} · ${esc(g.group_name)}</option>`).join("") : `<option value="">ไม่ต้องผูก</option>`;
  }
  function addUser() {
    const name = $("#nuName").value.trim().toLowerCase(), role = $("#nuRole").value, link = $("#nuLink").value, pw = $("#nuPass").value;
    if (!/^[a-z0-9._-]{3,30}$/.test(name)) { toast("ชื่อผู้ใช้ใช้ a-z 0-9 . _ - ยาว 3–30 ตัว"); return; }
    if (state.users.some(u => u.username === name)) { toast(`มีชื่อผู้ใช้ ${name} แล้ว`); return; }
    if (pw.length < 4) { toast("รหัสผ่านต้องยาวอย่างน้อย 4 ตัว"); return; }
    state.users.push(makeUser(name, role, link, pw, false));
    $("#addUserForm").reset(); $("#nuPass").value = "1234"; fillLinkOptions();
    toast(`เพิ่มบัญชี ${name} (${ROLE_TH[role]}) แล้ว`); renderUsers();
  }

  /* =================== 6) สถิติ =================== */
  function renderStats() {
    if (!state.final) { $("#statSummary").innerHTML = `<p class="muted">ยังไม่ได้จัดตาราง</p>`; ["#teacherBars", "#roomBars", "#groupDays"].forEach(s => { $(s).innerHTML = ""; }); return; }
    const m = state.final.val.metrics, I = idx();
    $("#statSummary").innerHTML = [
      [m.roomUtil + "%", "อัตราใช้ห้องเฉลี่ย"], [m.teacherAvg, "ภาระครูเฉลี่ย (คาบ/สัปดาห์)"], [`${m.teacherMin}–${m.teacherMax}`, "ภาระครูต่ำสุด–สูงสุด"], [m.totalGaps, "คาบว่างคั่นรวมทุกกลุ่ม"]
    ].map(([val, k]) => `<div class="stat"><div class="v">${val}</div><div class="k">${k}</div></div>`).join("");
    const tmax = Math.max(1, ...m.teachers.map(t => t.load));
    $("#teacherBars").innerHTML = [...m.teachers].sort((a, b) => b.load - a.load).map(t => `<div class="hbar"><span class="lab" title="${esc(t.name)}">${esc(t.teacher_id)} ${esc(shortName(t.name))}</span><span class="track"><i class="${isMgr(t.role) ? "mgr" : ""}" style="width:${t.load / tmax * 100}%"></i></span><span class="v">${t.load}</span></div>`).join("");
    $("#roomBars").innerHTML = [...m.rooms].sort((a, b) => b.pct - a.pct).map(r => `<div class="hbar"><span class="lab" title="${esc(r.name)}">${esc(r.room_id)} <span class="muted">${r.room_id === state.cfg.iot.roomId ? "IOT" : r.type === "Theory" ? "ทฤษฎี" : "ปฏิบัติ"}</span></span><span class="track"><i style="width:${r.pct}%"></i></span><span class="v">${r.pct}%</span></div>`).join("");
    const max = state.cfg.maxPeriodsPerDay;
    $("#groupDays").innerHTML = `<thead><tr><th>กลุ่ม</th>${I.days.map(d => `<th class="n">${E.DAY_TH[d] || d}</th>`).join("")}<th class="n">รวม</th><th class="n">คาบว่างคั่น</th></tr></thead><tbody>` +
      m.groups.map(g => `<tr><td>${esc(g.group_id)} ${esc(g.name)}</td>${g.perDay.map(n => `<td class="n" style="background:color-mix(in srgb, var(--accent) ${Math.round(n / max * 38)}%, transparent)">${n}</td>`).join("")}<td class="n"><b>${g.total}</b></td><td class="n">${g.gaps}</td></tr>`).join("") + "</tbody>";
  }

  /* =================== เหตุการณ์ =================== */
  document.addEventListener("click", e => {
    const slot = e.target.closest("#unGrid td.slot");
    if (slot && state.un && !deny("unavail")) { const id = slot.dataset.slot; if (state.un.set.has(id)) state.un.set.delete(id); else state.un.set.add(id); state.un.dirty = true; renderUnavail(); return; }
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.demo) { $("#loginUser").value = t.dataset.demo; $("#loginPass").value = t.dataset.pw; $("#loginBtn").focus(); return; }
    if (t.dataset.urole) { state.userRole = t.dataset.urole; renderUsers(); return; }
    if (t.dataset.setpw != null) {
      if (deny("users")) return;
      const u = state.users[Number(t.dataset.setpw)], pw = $("#pw-" + t.dataset.setpw).value;
      if (pw.length < 4) { toast("รหัสผ่านต้องยาวอย่างน้อย 4 ตัว"); return; }
      u.salt = newSalt(); u.hash = sha256(u.salt + ":" + pw); toast(`ตั้งรหัสผ่านใหม่ให้ ${u.username} แล้ว`); renderUsers(); return;
    }
    if (t.dataset.deluser != null) {
      if (deny("users")) return;
      const u = state.users[Number(t.dataset.deluser)];
      if (t.dataset.confirm !== "1") { t.dataset.confirm = "1"; t.textContent = "ยืนยันลบ"; setTimeout(() => { if (t.isConnected) { t.dataset.confirm = ""; t.textContent = "ลบ"; } }, 4000); return; }
      state.users.splice(state.users.indexOf(u), 1); toast(`ลบบัญชี ${u.username} แล้ว`); renderUsers(); return;
    }
    if (t.dataset.sample) {
      if (deny("data")) return;
      if (state.draft && !t.dataset.confirm) { t.dataset.confirm = "1"; toast("มีการแก้ไขที่ยังไม่บันทึก กดชุดข้อมูลอีกครั้งเพื่อทิ้งการแก้ไข"); setTimeout(() => { delete t.dataset.confirm; }, 4000); return; }
      const s = SAMPLES.find(x => x.key === t.dataset.sample); commit(E.makeSample(s.key), "ตัวอย่าง " + s.name, s.key); location.hash = "#run"; showView(); startRun(); return;
    }
    if (t.dataset.table) { state.edTable = t.dataset.table; state.edQ = ""; renderData(); if (t.closest("#stagedBox")) $("#editorPanel").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.dataset.goto) {
      state.edTable = t.dataset.goto; state.edQ = ""; renderData();
      const tr = document.querySelector(`#editorGrid tr[data-r="${t.dataset.row}"]`);
      if (tr) { tr.scrollIntoView({ block: "center" }); const inp = tr.querySelector("input"); if (inp) inp.focus({ preventScroll: true }); }
      return;
    }
    if (t.dataset.del != null) { if (!deny("data")) deleteRow(Number(t.dataset.del)); return; }
    if (t.dataset.which) { state.checkWhich = t.dataset.which; renderCheck(); return; }
    if (t.dataset.mode) { state.tt.mode = t.dataset.mode; state.tt.id = null; clearSelection(false); renderTable(); return; }
    const NEED = { commitImport: "data", edSave: "data", dropImport: "data", edCancel: "data", edAdd: "data", tplXlsx: "data", tplCsv: "data", runBtn: "run", cancelBtn: "run", retryBtn: "run", rerunNow: "run", applyCfg: "settings", resetCfg: "settings",
      undoBtn: "editTable", resetEdits: "editTable", doSplit: "editTable", doMerge: "editTable", goSplitCfg: "settings", exXlsx: "exportAll", exCsv: "exportAll", unSave: "unavail", unClear: "unavail" };
    if (NEED[t.id] && deny(NEED[t.id])) return;
    switch (t.id) {
      case "logoutBtn": logout(); break;
      case "rerunNow": location.hash = "#run"; showView(); startRun(); break;
      case "dismissNotice": state.notices = []; render(currentView()); break;
      case "unSave": saveUnavail(); break;
      case "unClear": state.un.set.clear(); state.un.dirty = true; renderUnavail(); break;
      case "commitImport": case "edSave": saveDraft(); break;
      case "dropImport": case "edCancel": state.draft = null; renderData(); stepMarks(); toast("ยกเลิกการแก้ไขแล้ว กลับไปใช้ข้อมูลเดิม"); break;
      case "edAdd": addRow(); break;
      case "runBtn": startRun(); break;
      case "cancelBtn": cancelRun(); break;
      case "retryBtn": $("#seed").value = (Number($("#seed").value) || 0) + (Number($("#runs").value) || 1); startRun(); break;
      case "applyCfg": { const ov = state.cfg.typeOverride, sp = state.cfg.splitOverride, tu = state.cfg.teacherUnavailable; state.cfg = E.mergeConfig(readSettings()); state.cfg.typeOverride = ov || {}; state.cfg.splitOverride = sp || {}; state.cfg.teacherUnavailable = tu || {}; toast("ใช้ค่าใหม่แล้ว กำลังจัดตารางใหม่"); location.hash = "#run"; showView(); startRun(); break; }
      case "resetCfg": state.cfg = E.mergeConfig({ runs: 20, typeOverride: {}, splitOverride: {}, teacherUnavailable: state.cfg.teacherUnavailable }); renderSettings(); toast("คืนค่าเริ่มต้นแล้ว กด ใช้ค่านี้ เพื่อจัดตารางใหม่"); break;
      case "undoBtn": { const f = state.final, h = f.history.pop(); if (h) { f.blocks = h.blocks; f.manual = h.manual; refreshFinal(); state.sel = null; clearTargets(); renderTable(); stepMarks(); toast("เลิกทำแล้ว"); } break; }
      case "resetEdits": setFinalFromBest(); state.sel = null; clearTargets(); renderTable(); stepMarks(); toast("กลับเป็นผลจัดอัตโนมัติแล้ว"); break;
      case "doSplit": splitSelected(); break;
      case "doMerge": mergeSelected(); break;
      case "clearSel": clearSelection(); break;
      case "goSplitCfg": { const b = blockById(state.sel.id); state.subjQ = b.subject; clearSelection(false); location.hash = "#settings"; break; }
      case "tplXlsx": {
        if (!window.XLSX) { toast("โหลดตัวเขียน Excel ไม่สำเร็จ ใช้แม่แบบ CSV แทน"); break; }
        const s = E.makeSample("medium"), wb = window.XLSX.utils.book_new();
        for (const [tn, cols] of Object.entries(E.TABLES)) window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(s[tn].slice(0, 2), { header: cols }), tn);
        saveFile("template.xlsx", xlsxBuffer(wb)); break;
      }
      case "tplCsv": { const tn = $("#tplTable").value; saveFile(tn + ".csv", "﻿" + E.toCSV(E.makeSample("medium")[tn].slice(0, 2), E.TABLES[tn]), "text/csv"); break; }
      case "exXlsx": if (state.final) exportXlsx(); break;
      case "exCsv": if (state.final) exportCsv(); break;
      case "exHtml": if (state.final) exportHtml(); break;
    }
  });
  document.addEventListener("submit", e => {
    e.preventDefault();
    if (e.target.id === "loginForm") login($("#loginUser").value, $("#loginPass").value);
    if (e.target.id === "addUserForm" && !deny("users")) addUser();
  });
  document.addEventListener("change", e => {
    const el = e.target;
    if (el.id === "nuRole") { fillLinkOptions(); return; }
    if (el.id === "unTeacher") {
      if (state.un && state.un.dirty) toast("ยังไม่ได้บันทึกของครูคนก่อน การแก้ไขนั้นถูกยกเลิก");
      state.un = { tid: el.value, set: new Set(state.cfg.teacherUnavailable[el.value] || []), dirty: false }; renderUnavail(); return;
    }
    if ((el.id === "fileInput" || el.dataset.cell || el.dataset.split) && deny("data")) return;
    if ((el.dataset.override || el.dataset.cfgsplit) && deny("settings")) return;
    if (el.id === "fileInput" && el.files.length) { importFiles([...el.files]); el.value = ""; return; }
    if (el.id === "ttEntity") { state.tt.id = el.value; clearSelection(false); renderTable(); return; }
    if (el.dataset.override) {
      state.cfg = E.mergeConfig(Object.assign({}, state.cfg, { typeOverride: Object.assign({}, state.cfg.typeOverride, { [el.dataset.override]: el.value }) }));
      renderClassify(); toast("เปลี่ยนประเภทแล้ว กด ใช้ค่านี้ เพื่อจัดตารางใหม่"); return;
    }
    if (el.dataset.cfgsplit) {
      const sp = Object.assign({}, state.cfg.splitOverride);
      if (el.value) sp[el.dataset.cfgsplit] = el.value.split("+").map(Number); else delete sp[el.dataset.cfgsplit];
      state.cfg = E.mergeConfig(Object.assign({}, state.cfg, { splitOverride: sp }));
      toast(`${el.dataset.cfgsplit}: ${el.value ? (el.value.includes("+") ? "แบ่ง " + el.value : "เรียนยาว " + el.value + " คาบ") : "อัตโนมัติ"} · กด ใช้ค่านี้ เพื่อจัดตารางใหม่`); return;
    }
    if (el.dataset.split) {
      const dr = ensureDraft();
      if (el.value) dr.split[el.dataset.split] = el.value.split("+").map(Number); else delete dr.split[el.dataset.split];
      recheckSoon(); return;
    }
    if (el.dataset.cell) {
      const dr = ensureDraft(), r = dr.data[state.edTable][Number(el.dataset.r)];
      const oldId = state.edTable === "subject" && el.dataset.cell === "subject_id" ? r.subject_id : null;
      r[el.dataset.cell] = el.value.trim();
      if (oldId && dr.split[oldId] && oldId !== r.subject_id) { dr.split[r.subject_id] = dr.split[oldId]; delete dr.split[oldId]; }
      if (state.edTable === "subject" && (el.dataset.cell === "theory" || el.dataset.cell === "practice")) { delete dr.split[r.subject_id]; renderData(); return; }
      recheckSoon();
    }
  });
  document.addEventListener("input", e => {
    const el = e.target;
    if (el.id === "ttSearch") { state.tt.q = el.value; renderTable(); }
    if (el.id === "subjFilter") { state.subjQ = el.value; renderClassify(); }
    if (el.id === "userSearch") { state.userQ = el.value; renderUsers(); const s2 = $("#userSearch"); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
    if (el.id === "edSearch") { state.edQ = el.value; renderEditor(draftIssues()); const s = $("#edSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    if (el.dataset && el.dataset.cell && !state.draft) { ensureDraft(); $("#saveBar").hidden = false; $("#dataSource").textContent = "มีการแก้ไขที่ยังไม่บันทึก"; stepMarks(); }
  });
  const dropZone = $("#drop");
  ["dragenter", "dragover"].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove("over"); }));
  dropZone.addEventListener("drop", e => { if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });

  /* ---------- เริ่มต้น: โหลดชุดกลาง แล้วจัดตารางทันที เพื่อให้หน้าแรกมีผลให้ดู ---------- */
  commit(E.makeSample("medium"), "ตัวอย่าง กลาง", "medium");
  state.cfg.runs = 10;
  const first = runSync(); first.runs = state.cfg.runs;
  state.results = first; state.cfg.runs = 20; setFinalFromBest();
  state.tt.id = state.data.student_group[0].group_id;
  syncUsers();
  $("#runStatus").textContent = `โหลดชุดตัวอย่างกลางและจัดตารางให้แล้ว (${1 + first.runs * 2} รอบ ใน ${(first.ms / 1000).toFixed(2)} วินาที) · กดจัดตารางเพื่อรัน 20 รอบ`;
  $("#progBar").style.width = "100%";
  showView();
  getDownloads().then(d => { if (!d) { $("#exportRow").hidden = true; ["tplXlsx", "tplCsv", "tplTable"].forEach(id => { $("#" + id).hidden = true; }); const n = $("#dlNote"); n.hidden = false; n.textContent = "การดาวน์โหลดไฟล์ปิดอยู่ในหน้านี้ ใช้ได้เมื่อ deploy บนเว็บของทีมเอง"; } });
})();
