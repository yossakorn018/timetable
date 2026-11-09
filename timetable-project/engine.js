/* =====================================================================
   engine.js — แกนระบบจัดตารางสอนอัตโนมัติ (ใช้ได้ทั้งในเบราว์เซอร์, Web Worker และ Node)
   โมดูล: config · rng · sample · csv · inputCheck · classify · scheduler · validator · metrics
   ===================================================================== */
(function (root) {
  "use strict";

  /* ---------- 1) การตั้งค่า: ทุกค่าที่อาจเปลี่ยนตามโจทย์อยู่ที่นี่ ห้าม hardcode ในโค้ด ---------- */
  const DEFAULT_CONFIG = {
    breakPeriods: [5],                                                    // ข้อ 2
    maxPeriodsPerDay: 10,                                                 // ข้อ 5
    managerRole: "Manager",                                               // ข้อ 10
    managerMeeting: { day: "Tue", start: "15:00", end: "16:00" },
    homeroom: { nameKeywords: ["โฮมรูม", "homeroom"], minPeriods: 1, byAdvisor: true }, // ข้อ 11
    activity: { nameKeywords: ["กิจกรรม", "activit"], day: "Wed", start: "15:00", end: "17:00", needsRoom: false }, // ข้อ 12
    general: { idPrefixes: ["20000", "30000"], groupSize: 2 },            // ข้อ 13
    iot: { nameKeywords: ["IOT", "ไอโอที"], roomId: "R6201" },            // ข้อ 14
    theoryRoomTypes: ["Theory", "ทฤษฎี"],                                 // ข้อ 9
    avoidTheoryAfterPeriod: 9,                                            // ข้อ 15
    blockMax: { practice: 4, theory: 2 },                                 // ความยาวบล็อกคาบติดกันสูงสุด (เช่น 5 คาบ → 3+2)
    splitOverride: {},
    teacherUnavailable: {},                                               // เวลาที่ครูแจ้งไม่สะดวก {"T05": ["MON-01", ...]}                                                    // รูปแบบคาบรายวิชา เช่น {"30204-2001": [5]} = เรียนยาว, [3,2] = แบ่ง
    dayAliases: {
      Mon: ["Mon", "Monday", "จันทร์", "จ"], Tue: ["Tue", "Tuesday", "อังคาร", "อ"],
      Wed: ["Wed", "Wednesday", "พุธ", "พ"], Thu: ["Thu", "Thursday", "พฤหัสบดี", "พฤหัส", "พฤ"],
      Fri: ["Fri", "Friday", "ศุกร์", "ศ"], Sat: ["Sat", "Saturday", "เสาร์", "ส"], Sun: ["Sun", "Sunday", "อาทิตย์", "อา"]
    },
    weights: { theoryLate: 50, dayLoad: 4, gap: 6, sameDay: 30, teacherDay: 1, tolerance: 3 }, // น้ำหนักตอนเลือกช่อง
    softWeights: { theoryLate: 10, gap: 3, imbalance: 2 },               // น้ำหนักคะแนนคุณภาพ (ยิ่งน้อยยิ่งดี)
    seed: 2569, runs: 20, repairIterations: 200
  };
  const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_TH = { Mon: "จันทร์", Tue: "อังคาร", Wed: "พุธ", Thu: "พฤหัสบดี", Fri: "ศุกร์", Sat: "เสาร์", Sun: "อาทิตย์" };
  const TYPE_TH = { activity: "กิจกรรม", homeroom: "โฮมรูม", iot: "IOT", general: "สามัญ (เรียนรวม)", practice: "ปฏิบัติ", theory: "ทฤษฎี" };
  const TABLES = {
    room: ["room_id", "room_name", "room_type"],
    student_group: ["group_id", "group_name", "student_count", "advisor"],
    subject: ["subject_id", "subject_name", "theory", "practice", "credit"],
    teacher: ["teacher_id", "teacher_name", "role"],
    timeslot: ["timeslot_id", "day", "period", "start", "end"],
    teach: ["teacher_id", "subject_id"],
    register: ["group_id", "subject_id"]
  };
  const OUTPUT_COLUMNS = ["group_id", "timeslot_id", "subject_id", "teacher_id", "room_id"];

  function mergeConfig(user) {
    const c = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (!user) return c;
    for (const k of Object.keys(user)) {
      if (user[k] && typeof user[k] === "object" && !Array.isArray(user[k]) && c[k] && typeof c[k] === "object") Object.assign(c[k], user[k]);
      else c[k] = user[k];
    }
    return c;
  }

  /* ---------- 2) ตัวสุ่มที่กำหนด seed ได้ (รันซ้ำได้ผลเดิม ห้ามใช้ Math.random) ---------- */
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 3) CSV: อ่าน/เขียน (รองรับเครื่องหมายคำพูดและ BOM) ---------- */
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, "");
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some(v => v.trim() !== "")) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell); if (row.some(v => v.trim() !== "")) rows.push(row);
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map(h => h.trim());
    const records = rows.slice(1).map(r => { const o = {}; headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); }); return o; });
    return { headers, records };
  }
  function toCSV(records, columns) {
    const esc = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [columns.join(","), ...records.map(r => columns.map(c => esc(r[c])).join(","))].join("\n");
  }

  /* ---------- 4) ชุดข้อมูลตัวอย่าง 3 ขนาด (สร้างแบบกำหนดได้ทุกครั้งเหมือนเดิม) ---------- */
  const SUBJECT_CATALOG = (function () {
    const P = (id, name, t, p) => ({ subject_id: id, subject_name: name, theory: t, practice: p, credit: t + Math.round(p / 2) });
    return {
      generalHigh: [P("30000-1101", "ภาษาไทยเพื่อการสื่อสารในงานอาชีพ", 2, 0), P("30000-1201", "ภาษาอังกฤษเพื่อการสื่อสารในงานอาชีพ", 3, 0),
        P("30000-1301", "วิทยาศาสตร์เพื่องานเทคโนโลยี", 2, 0), P("30000-1401", "คณิตศาสตร์สำหรับงานเทคโนโลยี", 3, 0),
        P("30000-1501", "การพัฒนาทักษะชีวิตเพื่อสุขภาวะและสังคม", 2, 0), P("30000-1601", "การจัดการธุรกิจเบื้องต้น", 2, 0),
        P("30000-1202", "ภาษาอังกฤษสำหรับงานเทคโนโลยีสารสนเทศ", 3, 0)],
      generalVoc: [P("20000-1101", "ภาษาไทยพื้นฐาน", 2, 0), P("20000-1201", "ภาษาอังกฤษในชีวิตจริง", 3, 0),
        P("20000-1301", "วิทยาศาสตร์เพื่อพัฒนาทักษะชีวิต", 2, 0), P("20000-1401", "คณิตศาสตร์พื้นฐานอาชีพ", 3, 0),
        P("20000-1501", "หน้าที่พลเมืองและศีลธรรม", 2, 0), P("20000-1601", "พลศึกษาเพื่อพัฒนาสุขภาพ", 2, 0),
        P("20000-1202", "ภาษาอังกฤษสื่อสาร", 3, 0)],
      activityHigh: P("30000-2001", "กิจกรรมองค์การวิชาชีพ 1", 0, 2),
      activityVoc: P("20000-2002", "กิจกรรมองค์การวิชาชีพ 2", 0, 2),
      homeroom: P("HR-0001", "โฮมรูม (พบครูที่ปรึกษา)", 1, 0)
    };
  })();
  const PROGRAMS = [
    { key: "IT1", groups: ["สทส.1/1", "สทส.1/2"], level: "High", dept: "IT", generals: [0, 1, 3],
      majors: [["30204-2001", "การเขียนโปรแกรมคอมพิวเตอร์", 2, 3], ["30204-2003", "การออกแบบและพัฒนาฐานข้อมูล", 1, 3], ["30204-2402", "อินเทอร์เน็ตของสรรพสิ่ง (IOT)", 1, 3], ["30204-2002", "การวิเคราะห์และออกแบบระบบ", 2, 0], ["30204-2004", "ความมั่นคงปลอดภัยสารสนเทศ", 2, 0]],
      extra: [["30204-2101", "การพัฒนาแอปพลิเคชันบนอุปกรณ์เคลื่อนที่", 1, 3], ["30204-2005", "จริยธรรมและกฎหมายดิจิทัล", 2, 0]] },
    { key: "IT2", groups: ["สทส.2/1", "สทส.2/2"], level: "High", dept: "IT", generals: [0, 4, 6],
      majors: [["30204-2102", "การพัฒนาเว็บแอปพลิเคชัน", 1, 3], ["30204-2103", "การบริหารระบบเครือข่าย", 1, 3], ["30204-2104", "คลาวด์คอมพิวติ้ง", 1, 3], ["30204-2105", "การจัดการโครงการซอฟต์แวร์", 2, 0], ["30204-2106", "วิทยาการข้อมูลเบื้องต้น", 2, 0]],
      extra: [["30204-2107", "โครงงานเทคโนโลยีสารสนเทศ", 1, 3], ["30204-2108", "การทดสอบซอฟต์แวร์", 2, 0]] },
    { key: "AI1", groups: ["สปญ.1/1", "สปญ.1/2"], level: "High", dept: "IT", generals: [1, 2, 5],
      majors: [["30205-2001", "การเขียนโปรแกรมภาษาไพทอน", 2, 3], ["30205-2002", "การเรียนรู้ของเครื่อง", 2, 3], ["30205-2402", "ระบบอินเทอร์เน็ตของสรรพสิ่ง (IOT)", 1, 3], ["30205-2003", "คณิตศาสตร์สำหรับปัญญาประดิษฐ์", 2, 0], ["30205-2004", "จริยธรรมปัญญาประดิษฐ์", 2, 0]],
      extra: [["30205-2005", "การประมวลผลภาพดิจิทัล", 1, 3], ["30205-2006", "สถิติสำหรับวิทยาการข้อมูล", 2, 0]] },
    { key: "CB1", groups: ["ชคธ.1/1", "ชคธ.1/2"], level: "Voc", dept: "COM", generals: [0, 1, 3],
      majors: [["20204-2001", "คอมพิวเตอร์และการบำรุงรักษา", 1, 3], ["20204-2002", "การเขียนโปรแกรมเบื้องต้น", 2, 3], ["20204-2003", "การสร้างงานกราฟิก", 1, 3], ["20204-2004", "ระบบปฏิบัติการเบื้องต้น", 2, 0], ["20204-2005", "การใช้โปรแกรมสำนักงาน", 2, 0]],
      extra: [["20204-2006", "การพิมพ์เอกสารดิจิทัล", 1, 3], ["20204-2007", "ความรู้เบื้องต้นธุรกิจดิจิทัล", 2, 0]] },
    { key: "CB2", groups: ["ชคธ.2/1", "ชคธ.2/2"], level: "Voc", dept: "COM", generals: [2, 4, 6],
      majors: [["20204-2101", "การสร้างเว็บไซต์", 1, 3], ["20204-2406", "อุปกรณ์ไอโอทีเบื้องต้น (IOT)", 1, 3], ["20204-2102", "ฐานข้อมูลเบื้องต้น", 1, 3], ["20204-2103", "เครือข่ายคอมพิวเตอร์เบื้องต้น", 2, 0], ["20204-2104", "การนำเสนองานด้วยมัลติมีเดีย", 2, 0]],
      extra: [["20204-2105", "การตัดต่อวิดีโอ", 1, 3], ["20204-2106", "การตลาดออนไลน์", 2, 0]] },
    { key: "CB3", groups: ["ชคธ.3/1", "ชคธ.3/2"], level: "Voc", dept: "COM", generals: [1, 5, 3],
      majors: [["20204-2201", "การเขียนโปรแกรมเชิงวัตถุ", 1, 3], ["20204-2202", "การพัฒนาแอปพลิเคชันเบื้องต้น", 1, 3], ["20204-2203", "โครงงานคอมพิวเตอร์ธุรกิจ", 1, 4], ["20204-2204", "การรักษาความปลอดภัยคอมพิวเตอร์", 2, 0], ["20204-2205", "การบริการลูกค้าด้านไอที", 2, 0]],
      extra: [["20204-2206", "แอนิเมชันเบื้องต้น", 1, 3], ["20204-2207", "การเป็นผู้ประกอบการ", 2, 0]] }
  ];
  const FIRST = ["สมชาย", "สุดา", "วิชัย", "อรทัย", "ประเสริฐ", "กาญจนา", "ธนพล", "พิมพ์ชนก", "อนุชา", "รัตนา", "ศักดิ์ชัย", "นงลักษณ์", "ปิยะ", "วราภรณ์", "เกียรติศักดิ์", "จันทร์เพ็ญ", "ณัฐวุฒิ", "สุภาพร", "ชาญวิทย์", "มาลัย", "ทวีศักดิ์", "ศิริพร", "บุญเลิศ", "กมลวรรณ", "อภิชาติ"];
  const LAST = ["ใจดี", "ศรีสุข", "ทองคำ", "บุญมา", "แก้วใส", "มั่นคง", "รักเรียน", "สายบุญ", "พรหมมา", "ชัยมงคล", "อินทร์แก้ว", "สุขเกษม", "วงศ์ใหญ่", "เพชรรัตน์", "ศรีวิไล"];
  const pad = (n, w) => String(n).padStart(w, "0");

  function makeSample(size) {
    if (size === "tight") {
      // ชุด "ห้องน้อย": ขนาดกลางแต่เหลือห้องทฤษฎี 4 ห้อง ห้องปฏิบัติ 3 ห้อง (+ IOT Lab) ใช้ทดสอบวงรอบซ่อม
      const d = makeSample("medium"); let t = 0, p = 0;
      d.room = d.room.filter(r => r.room_id === "R6201" || (r.room_type === "Theory" ? ++t <= 4 : ++p <= 3));
      return d;
    }
    const reps = size === "large" ? 3 : 1;
    const progs = size === "small" ? [Object.assign({}, PROGRAMS[0]), Object.assign({}, PROGRAMS[2], { groups: [PROGRAMS[2].groups[0]] })] : PROGRAMS;
    const timeslot = [];
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) for (let p = 1; p <= 12; p++) {
      timeslot.push({ timeslot_id: d.toUpperCase() + "-" + pad(p, 2), day: d, period: p, start: pad(7 + p, 2) + ":00", end: pad(8 + p, 2) + ":00" });
    }
    const subjects = new Map();
    const addSub = s => subjects.set(s.subject_id, s);
    const C = SUBJECT_CATALOG;
    [...C.generalHigh, ...C.generalVoc, C.activityHigh, C.activityVoc, C.homeroom].forEach(addSub);
    for (const pr of PROGRAMS) for (const m of [...pr.majors, ...pr.extra]) addSub({ subject_id: m[0], subject_name: m[1], theory: m[2], practice: m[3], credit: m[2] + Math.round(m[3] / 2) });

    const teacher = [], room = [], student_group = [], teach = [], register = [];
    let tId = 0, gId = 0;
    const newTeacher = (role) => { tId++; const i = tId - 1; teacher.push({ teacher_id: "T" + pad(tId, 2), teacher_name: "อ." + FIRST[i % FIRST.length] + " " + LAST[(i * 7) % LAST.length] + (i >= FIRST.length ? " " + (Math.floor(i / FIRST.length) + 1) : ""), role }); return "T" + pad(tId, 2); };
    const teachSet = new Set();
    const addTeach = (t, s) => { const k = t + "|" + s; if (!teachSet.has(k)) { teachSet.add(k); teach.push({ teacher_id: t, subject_id: s }); } };

    // ห้อง: R6201 = IOT Lab (มีห้องเดียว), ห้องทฤษฎี, ห้องปฏิบัติ
    room.push({ room_id: "R6201", room_name: "IOT Lab", room_type: "Practice" });
    const nTheory = size === "small" ? 3 : 11 * reps, nPractice = size === "small" ? 2 : 18 * reps;
    for (let i = 1; i <= nTheory; i++) room.push({ room_id: "R" + (1100 + i), room_name: "ห้องบรรยาย " + (1100 + i), room_type: "Theory" });
    for (let i = 1; i <= nPractice; i++) room.push({ room_id: "R" + (5100 + i), room_name: "ห้องปฏิบัติการคอมพิวเตอร์ " + (5100 + i), room_type: "Practice" });

    for (let r = 0; r < reps; r++) {
      // ครูแยกตามแผนก + ครูวิชาสามัญ; หัวหน้า (Manager) แผนกละ 1 คน
      const pool = { IT: [], COM: [], GEN: [] };
      const deptSize = size === "small" ? { IT: 5, COM: 0, GEN: 2 } : { IT: 12, COM: 8, GEN: 5 };
      for (const d of ["IT", "COM", "GEN"]) for (let i = 0; i < deptSize[d]; i++) pool[d].push(newTeacher(i === 0 ? "Manager" : "Teacher"));
      const usedProgs = progs.filter(p => size !== "small" || true);
      let advisorIdx = { IT: 0, COM: 0 };
      for (const pr of usedProgs) {
        const dept = pool[pr.dept].length ? pr.dept : "IT";
        const deptPool = pool[dept];
        // ใน replica 2,3 ของชุดใหญ่ ให้ใช้วิชาเสริมแทนวิชา IOT (ห้อง IOT Lab มีห้องเดียว)
        const majors = pr.majors.map(m => (r > 0 && /IOT/.test(m[1])) ? pr.extra[0] : m);
        const gens = pr.generals.map(i => (pr.level === "High" ? C.generalHigh : C.generalVoc)[i]);
        const act = pr.level === "High" ? C.activityHigh : C.activityVoc;
        for (const gname of pr.groups) {
          gId++;
          const advisor = deptPool[advisorIdx[dept] % deptPool.length]; advisorIdx[dept]++;
          const group_id = "G" + pad(gId, 2);
          student_group.push({ group_id, group_name: gname + (reps > 1 ? " (ชุด " + (r + 1) + ")" : ""), student_count: 28 + ((gId * 5) % 13), advisor });
          for (const m of majors) register.push({ group_id, subject_id: m[0] });
          for (const g of gens) register.push({ group_id, subject_id: g.subject_id });
          register.push({ group_id, subject_id: act.subject_id });
          register.push({ group_id, subject_id: C.homeroom.subject_id });
          addTeach(advisor, act.subject_id); addTeach(advisor, C.homeroom.subject_id);
        }
        // ครูวิชาชีพ: วิชาละ 2 คนในแผนก
        majors.forEach((m, i) => { addTeach(deptPool[(i * 2 + 1) % deptPool.length], m[0]); addTeach(deptPool[(i * 2 + 2) % deptPool.length], m[0]); });
        gens.forEach((g, i) => { addTeach(pool.GEN[i % pool.GEN.length], g.subject_id); addTeach(pool.GEN[(i + 1) % pool.GEN.length], g.subject_id); });
      }
      if (size === "small") break;
    }
    return { room, student_group, subject: [...subjects.values()], teacher, timeslot, teach, register };
  }

  /* ---------- 5) เตรียมข้อมูล: แปลงวัน/เวลา ทำดัชนี แยกประเภทวิชา ---------- */
  const toMin = t => { const m = String(t || "").match(/(\d{1,2})[:.](\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  function normDay(v, cfg) {
    const s = String(v || "").trim().toLowerCase();
    for (const [k, list] of Object.entries(cfg.dayAliases)) if (list.some(a => a.toLowerCase() === s)) return k;
    return String(v || "").trim();
  }
  const hasKeyword = (text, kws) => kws.some(k => String(text || "").toLowerCase().includes(String(k).toLowerCase()));

  // ลำดับสำคัญ: กิจกรรม → โฮมรูม → IOT (ดูจากชื่อวิชา) แล้วค่อยดูรหัสวิชาสามัญ
  // (วิชากิจกรรมบางวิชามีรหัส 20000/30000 ถ้าเช็กรหัสก่อนจะแยกผิด — บทเรียนจากระบบรุ่นพี่)
  function classifySubject(s, cfg, override) {
    if (override && override[s.subject_id]) return override[s.subject_id];
    if (hasKeyword(s.subject_name, cfg.activity.nameKeywords)) return "activity";
    if (hasKeyword(s.subject_name, cfg.homeroom.nameKeywords)) return "homeroom";
    if (hasKeyword(s.subject_name, cfg.iot.nameKeywords)) return "iot";
    if (cfg.general.idPrefixes.some(p => String(s.subject_id).startsWith(p))) return "general";
    return Number(s.practice) > 0 ? "practice" : "theory";
  }

  function prepare(data, cfg) {
    const idx = {};
    idx.subject = new Map(data.subject.map(s => [s.subject_id, s]));
    idx.teacher = new Map(data.teacher.map(t => [t.teacher_id, t]));
    idx.room = new Map(data.room.map(r => [r.room_id, r]));
    idx.group = new Map(data.student_group.map(g => [g.group_id, g]));
    idx.slots = data.timeslot.map(t => ({ id: t.timeslot_id, day: normDay(t.day, cfg), period: Number(t.period), start: toMin(t.start), end: toMin(t.end), startText: t.start, endText: t.end }));
    idx.slot = new Map(idx.slots.map(s => [s.id, s]));
    idx.days = DAY_ORDER.filter(d => idx.slots.some(s => s.day === d));
    for (const s of idx.slots) if (!idx.days.includes(s.day)) idx.days.push(s.day);
    idx.slotsByDay = {};
    for (const d of idx.days) idx.slotsByDay[d] = idx.slots.filter(s => s.day === d).sort((a, b) => a.period - b.period);
    idx.periods = [...new Set(idx.slots.map(s => s.period))].sort((a, b) => a - b);
    idx.isBreak = s => cfg.breakPeriods.includes(s.period);
    const inWin = (s, w) => s.day === normDay(w.day, cfg) && s.start >= toMin(w.start) && s.end <= toMin(w.end);
    const overlapsWin = (s, w) => s.day === normDay(w.day, cfg) && s.start < toMin(w.end) && s.end > toMin(w.start);
    idx.inActivity = s => inWin(s, cfg.activity);
    idx.inMeeting = s => overlapsWin(s, cfg.managerMeeting);
    const unav = new Set(); for (const [t, list] of Object.entries(cfg.teacherUnavailable || {})) (list || []).forEach(sid => unav.add(t + "|" + sid));
    idx.isUnavailable = (tid, sid) => unav.has(tid + "|" + sid);
    idx.isTheoryRoom = r => cfg.theoryRoomTypes.some(t => String(r.room_type).toLowerCase() === String(t).toLowerCase());
    idx.type = new Map(data.subject.map(s => [s.subject_id, classifySubject(s, cfg, cfg.typeOverride)]));
    idx.periodsOf = s => (Number(s.theory) || 0) + (Number(s.practice) || 0);
    idx.teachersOf = new Map();
    for (const t of data.teach) { if (!idx.teachersOf.has(t.subject_id)) idx.teachersOf.set(t.subject_id, []); idx.teachersOf.get(t.subject_id).push(t.teacher_id); }
    idx.teachSet = new Set(data.teach.map(t => t.teacher_id + "|" + t.subject_id));
    idx.registerOf = new Map();
    for (const r of data.register) { if (!idx.registerOf.has(r.group_id)) idx.registerOf.set(r.group_id, []); idx.registerOf.get(r.group_id).push(r.subject_id); }
    idx.isManager = tid => { const t = idx.teacher.get(tid); return !!t && String(t.role).toLowerCase() === String(cfg.managerRole).toLowerCase(); };
    // ประเภทห้องที่ใช้ได้ของแต่ละวิชา (ข้อ 9, 14)
    idx.roomsFor = sid => {
      const s = idx.subject.get(sid), type = idx.type.get(sid);
      if (type === "activity" && !cfg.activity.needsRoom) return null; // null = ไม่ใช้ห้อง
      if (type === "iot") return data.room.filter(r => r.room_id === cfg.iot.roomId).map(r => r.room_id);
      const practice = Number(s.practice) > 0;
      return data.room.filter(r => r.room_id !== cfg.iot.roomId && (practice ? !idx.isTheoryRoom(r) : idx.isTheoryRoom(r))).map(r => r.room_id);
    };
    return idx;
  }

  /* ---------- 6) ตรวจข้อมูลนำเข้าก่อนคำนวณ: แจ้งปัญหาพร้อมวิธีแก้ ---------- */
  function inputCheck(data, cfg) {
    cfg = mergeConfig(cfg);
    const issues = []; // {level: 'error'|'warn', table, message, hint}
    const add = (level, table, message, hint, row) => issues.push({ level, table, message, hint, row });
    for (const [t, cols] of Object.entries(TABLES)) {
      const rows = data[t];
      if (!rows || !rows.length) { add("error", t, `ไม่มีข้อมูลในตาราง ${t}`, `นำเข้าไฟล์ ${t}.csv`); continue; }
      const missing = cols.filter(c => !(c in rows[0]));
      if (missing.length) add("error", t, `ตาราง ${t} ขาดคอลัมน์ ${missing.join(", ")}`, "ดาวน์โหลดไฟล์แม่แบบแล้วตรวจชื่อหัวคอลัมน์");
    }
    if (issues.some(i => i.level === "error")) return issues;
    // ช่องที่ต้องกรอก (ชื่อ/จำนวนนักเรียน/หน่วยกิตเว้นว่างได้)
    const OPTIONAL = new Set(["room_name", "group_name", "student_count", "credit", "teacher_name"]);
    for (const [t, cols] of Object.entries(TABLES)) data[t].forEach((r, i) => {
      const empty = cols.filter(c => !OPTIONAL.has(c) && String(r[c] == null ? "" : r[c]).trim() === "");
      if (empty.length) add("error", t, `${t} แถว ${i + 2}: ยังไม่ได้กรอก ${empty.join(", ")}`, "กรอกให้ครบ หรือลบแถวนี้", i);
    });
    const dupCheck = (t, key) => { const seen = new Set(); for (const [i, r] of data[t].entries()) { if (seen.has(r[key])) add("error", t, `${key} ซ้ำ: ${r[key]} (แถว ${i + 2})`, "ลบแถวที่ซ้ำหรือแก้รหัสให้ไม่ซ้ำกัน", i); seen.add(r[key]); } };
    dupCheck("room", "room_id"); dupCheck("student_group", "group_id"); dupCheck("subject", "subject_id"); dupCheck("teacher", "teacher_id"); dupCheck("timeslot", "timeslot_id");
    const idx = prepare(data, cfg);
    data.teach.forEach((r, i) => {
      if (!idx.teacher.has(r.teacher_id)) add("error", "teach", `teach แถว ${i + 2}: ไม่พบครู ${r.teacher_id}`, "เพิ่มครูในตาราง teacher หรือแก้รหัสครู", i);
      if (!idx.subject.has(r.subject_id)) add("error", "teach", `teach แถว ${i + 2}: ไม่พบวิชา ${r.subject_id}`, "เพิ่มวิชาในตาราง subject หรือแก้รหัสวิชา", i);
    });
    data.register.forEach((r, i) => {
      if (!idx.group.has(r.group_id)) add("error", "register", `register แถว ${i + 2}: ไม่พบกลุ่ม ${r.group_id}`, "เพิ่มกลุ่มในตาราง student_group", i);
      if (!idx.subject.has(r.subject_id)) add("error", "register", `register แถว ${i + 2}: ไม่พบวิชา ${r.subject_id}`, "เพิ่มวิชาในตาราง subject", i);
    });
    data.subject.forEach((s, i) => {
      if (s.theory === "" || s.practice === "" || isNaN(Number(s.theory)) || isNaN(Number(s.practice))) add("error", "subject", `วิชา ${s.subject_id}: theory/practice ไม่ใช่ตัวเลข`, "ใส่จำนวนคาบเป็นตัวเลข", i);
      if (!String(s.subject_id || "").trim()) add("error", "subject", `แถว ${i + 2}: ไม่มีรหัสวิชา`, "ใส่ subject_id", i);
    });
    data.timeslot.forEach((t, i) => {
      if (!DAY_ORDER.includes(normDay(t.day, cfg))) add("warn", "timeslot", `ไม่รู้จักวัน "${t.day}" ใน ${t.timeslot_id}`, "เพิ่มชื่อวันนี้ในการตั้งค่า dayAliases", i);
      if (isNaN(toMin(t.start)) || isNaN(toMin(t.end))) add("error", "timeslot", `เวลาใน ${t.timeslot_id} อ่านไม่ได้`, "ใช้รูปแบบ HH:MM เช่น 08:00", i);
    });
    const registered = new Set(data.register.map(r => r.subject_id));
    for (const sid of registered) {
      const s = idx.subject.get(sid); if (!s) continue;
      const type = idx.type.get(sid);
      if (!(idx.teachersOf.get(sid) || []).length && !(type === "homeroom" && cfg.homeroom.byAdvisor)) add("error", "teach", `วิชา ${sid} ${s.subject_name} ไม่มีครูสอนใน teach`, "เพิ่มแถว teacher_id, subject_id ในตาราง teach");
      const rooms = idx.roomsFor(sid);
      if (rooms && !rooms.length) add("error", "room", `วิชา ${sid} ไม่มีห้องที่ใช้ได้ (${Number(s.practice) > 0 ? "ห้องปฏิบัติ" : "ห้องทฤษฎี"})`, "ตรวจ room_type หรือ theoryRoomTypes ในการตั้งค่า");
    }
    if (!idx.room.has(cfg.iot.roomId) && [...registered].some(s => idx.type.get(s) === "iot")) add("error", "room", `ไม่พบห้อง IOT ${cfg.iot.roomId}`, "ตั้งค่า iot.roomId ให้ตรงกับรหัสห้องจริง");
    const usable = idx.slots.filter(s => !idx.isBreak(s));
    const capacity = idx.days.reduce((a, d) => a + Math.min(cfg.maxPeriodsPerDay, idx.slotsByDay[d].filter(s => !idx.isBreak(s)).length), 0);
    data.student_group.forEach((g, gi) => {
      const need = (idx.registerOf.get(g.group_id) || []).reduce((a, sid) => a + (idx.subject.has(sid) ? idx.periodsOf(idx.subject.get(sid)) : 0), 0);
      if (need > capacity) add("error", "register", `กลุ่ม ${g.group_id} ต้องเรียน ${need} คาบ แต่มีช่องได้สูงสุด ${capacity} คาบ`, "ลดวิชาที่ลงทะเบียน หรือเพิ่ม timeslot");
      if (!idx.teacher.has(g.advisor)) add("warn", "student_group", `กลุ่ม ${g.group_id}: ครูที่ปรึกษา ${g.advisor} ไม่อยู่ในตาราง teacher`, "แก้รหัส advisor ให้ตรงกับ teacher_id", gi);
      if (!(idx.registerOf.get(g.group_id) || []).some(s => idx.type.get(s) === "homeroom")) add("warn", "register", `กลุ่ม ${g.group_id} ไม่มีวิชาโฮมรูม (ข้อ 11)`, "เพิ่มวิชาโฮมรูมใน register หรือตรวจคำค้นใน homeroom.nameKeywords");
    });
    // ห้อง IOT มีห้องเดียว: เช็กความจุ
    const iotNeed = data.register.filter(r => idx.type.get(r.subject_id) === "iot").reduce((a, r) => a + idx.periodsOf(idx.subject.get(r.subject_id)), 0);
    if (iotNeed > usable.length) add("error", "room", `วิชา IOT ต้องใช้ห้อง ${cfg.iot.roomId} ${iotNeed} คาบ แต่มีเพียง ${usable.length} ช่อง`, "ห้องเดียวรองรับไม่พอ ต้องลดกลุ่มที่เรียน IOT");
    const actSlots = idx.slots.filter(s => idx.inActivity(s) && !idx.isBreak(s)).length;
    for (const sid of registered) if (idx.type.get(sid) === "activity" && idx.periodsOf(idx.subject.get(sid)) > actSlots) add("error", "subject", `วิชากิจกรรม ${sid} มี ${idx.periodsOf(idx.subject.get(sid))} คาบ แต่ช่วงกิจกรรมมี ${actSlots} คาบ`, "ตรวจช่วงเวลา activity ในการตั้งค่า");
    if (!actSlots) add("warn", "timeslot", "ไม่พบ timeslot ในช่วงกิจกรรม (ข้อ 12)", "ตรวจ activity.day/start/end ในการตั้งค่า");
    // วิชาสามัญที่จำนวนกลุ่มเป็นเลขคี่
    const genCount = {};
    data.register.forEach(r => { if (idx.type.get(r.subject_id) === "general") genCount[r.subject_id] = (genCount[r.subject_id] || 0) + 1; });
    for (const [sid, n] of Object.entries(genCount)) if (n % cfg.general.groupSize) add("warn", "register", `วิชาสามัญ ${sid} มี ${n} กลุ่ม (เลขคี่) จะเหลือ 1 กลุ่มเรียนเดี่ยว`, "ยอมรับได้ หรือเพิ่ม/ลดกลุ่มให้เป็นคู่");
    return issues;
  }

  /* ---------- 7) ตัวจัดตาราง ---------- */
  const TYPE_PRIORITY = { activity: 0, homeroom: 1, iot: 2, general: 3, practice: 4, theory: 5 };

  function splitBlocks(total, maxLen) {
    if (total <= 0) return [];
    const n = Math.ceil(total / maxLen), base = Math.floor(total / n), extra = total % n;
    return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  }

  // สร้างงาน (task): 1 งาน = 1 วิชาของ 1 กลุ่ม (วิชาสามัญรวมกลุ่มตาม groupSize)
  function buildTasks(data, cfg, idx, warnings) {
    const tasks = []; const generalGroups = new Map();
    for (const r of data.register) {
      const s = idx.subject.get(r.subject_id); if (!s || !idx.group.has(r.group_id)) continue;
      const type = idx.type.get(r.subject_id);
      if (type === "general") { if (!generalGroups.has(r.subject_id)) generalGroups.set(r.subject_id, []); generalGroups.get(r.subject_id).push(r.group_id); }
      else tasks.push({ subject: r.subject_id, groups: [r.group_id], type });
    }
    for (const [sid, gs] of generalGroups) {
      const sorted = [...new Set(gs)].sort();
      for (let i = 0; i < sorted.length; i += cfg.general.groupSize) {
        const chunk = sorted.slice(i, i + cfg.general.groupSize);
        if (chunk.length < cfg.general.groupSize && sorted.length >= cfg.general.groupSize) warnings.push(`วิชาสามัญ ${sid}: กลุ่ม ${chunk.join(", ")} ไม่มีคู่ จึงเรียนเดี่ยว`);
        tasks.push({ subject: sid, groups: chunk, type: "general" });
      }
    }
    tasks.forEach((t, i) => {
      t.id = i;
      const s = idx.subject.get(t.subject);
      t.periods = idx.periodsOf(s);
      t.practice = Number(s.practice) > 0;
      t.rooms = idx.roomsFor(t.subject);
      const ov = cfg.splitOverride && cfg.splitOverride[t.subject];
      const ovOK = Array.isArray(ov) && ov.length && ov.every(n => Number.isInteger(n) && n > 0) && ov.reduce((a, b) => a + b, 0) === t.periods;
      t.blocks = t.type === "activity" ? [t.periods] : ovOK ? ov.slice() : t.type === "homeroom" ? splitBlocks(t.periods, 1) : splitBlocks(t.periods, t.practice ? cfg.blockMax.practice : cfg.blockMax.theory);
    });
    return tasks;
  }

  // เลือกครู 1 คนต่องาน (ล็อกไว้ทั้งวิชา): โฮมรูม/กิจกรรมใช้ครูที่ปรึกษา ที่เหลือเลือกครูที่ภาระน้อยที่สุด
  function assignTeachers(tasks, cfg, idx, mode) {
    const load = new Map();
    const order = mode === "baseline" ? tasks : [...tasks].sort((a, b) => (idx.teachersOf.get(a.subject) || []).length - (idx.teachersOf.get(b.subject) || []).length || b.periods - a.periods);
    for (const t of order) {
      let cands = idx.teachersOf.get(t.subject) || [];
      if ((t.type === "homeroom" && cfg.homeroom.byAdvisor) || t.type === "activity") {
        const adv = idx.group.get(t.groups[0]).advisor;
        if (idx.teacher.has(adv) && (cands.includes(adv) || t.type === "homeroom")) cands = [adv];
      }
      if (!cands.length) { t.teacher = null; continue; }
      t.teacher = mode === "baseline" ? cands[0] : cands.reduce((best, c) => ((load.get(c) || 0) < (load.get(best) || 0) ? c : best), cands[0]);
      load.set(t.teacher, (load.get(t.teacher) || 0) + t.periods);
    }
  }

  function makeState(idx) {
    return { group: new Map(), teacher: new Map(), room: new Map(), dayCount: new Map(), dayPeriods: new Map(), teacherDay: new Map(), placed: [] };
  }
  const occKey = (a, b) => a + "|" + b;

  // ช่องเรียงติดกันยาว len คาบในวันเดียว ไม่คร่อมคาบพัก
  function sequences(idx, len) {
    const out = [];
    for (const d of idx.days) {
      const arr = idx.slotsByDay[d];
      for (let i = 0; i + len <= arr.length; i++) {
        const seq = arr.slice(i, i + len);
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
          if (idx.isBreak(seq[j])) { ok = false; break; }
          if (j > 0 && seq[j].period !== seq[j - 1].period + 1) { ok = false; break; }
        }
        if (ok) out.push({ day: d, slots: seq });
      }
    }
    return out;
  }

  function countGaps(periodSet, idx) {
    if (periodSet.size < 2) return 0;
    const ps = [...periodSet].sort((a, b) => a - b);
    let gaps = 0;
    for (let p = ps[0] + 1; p < ps[ps.length - 1]; p++) if (!periodSet.has(p) && !idx.breakSet.has(p)) gaps++;
    return gaps;
  }

  // ตรวจว่าช่องนี้วางได้ไหม (Hard ทุกข้อ) คืนเหตุผลถ้าวางไม่ได้
  function checkSeq(task, seq, st, cfg, idx) {
    if (task.type === "activity" && !seq.slots.every(s => idx.inActivity(s))) return { why: "window" };
    for (const g of task.groups) {
      if ((st.dayCount.get(occKey(g, seq.day)) || 0) + seq.slots.length > cfg.maxPeriodsPerDay) return { why: "dayFull", who: g };
      for (const s of seq.slots) if (st.group.has(occKey(g, s.id))) return { why: "group", who: g };
    }
    if (task.teacher) {
      for (const s of seq.slots) {
        if (st.teacher.has(occKey(task.teacher, s.id))) return { why: "teacher", who: task.teacher };
        if (idx.isManager(task.teacher) && idx.inMeeting(s)) return { why: "meeting", who: task.teacher };
        if (idx.isUnavailable(task.teacher, s.id)) return { why: "unavail", who: task.teacher };
      }
    }
    if (task.rooms === null) return { room: null };
    const free = task.rooms.filter(r => seq.slots.every(s => !st.room.has(occKey(r, s.id))));
    if (!free.length) return { why: "room" };
    return { freeRooms: free };
  }

  function penalty(task, seq, st, cfg, idx) {
    const w = cfg.weights; let p = 0;
    if (!task.practice && task.type !== "activity") p += w.theoryLate * seq.slots.filter(s => s.period > cfg.avoidTheoryAfterPeriod).length;
    for (const g of task.groups) {
      p += w.dayLoad * (st.dayCount.get(occKey(g, seq.day)) || 0);
      const set = new Set(st.dayPeriods.get(occKey(g, seq.day)) || []);
      const before = countGaps(set, idx);
      seq.slots.forEach(s => set.add(s.period));
      p += w.gap * Math.max(0, countGaps(set, idx) - before);
    }
    if (st.placed.some(b => b.task === task.id && b.day === seq.day)) p += w.sameDay;
    if (task.teacher) p += w.teacherDay * (st.teacherDay.get(occKey(task.teacher, seq.day)) || 0);
    return p;
  }

  function place(task, blockIdx, seq, roomId, st) {
    const b = { task: task.id, block: blockIdx, day: seq.day, slots: seq.slots.map(s => s.id), periods: seq.slots.map(s => s.period), room: roomId, teacher: task.teacher, groups: task.groups, subject: task.subject };
    for (const s of b.slots) {
      for (const g of b.groups) st.group.set(occKey(g, s), b);
      if (b.teacher) st.teacher.set(occKey(b.teacher, s), b);
      if (b.room) st.room.set(occKey(b.room, s), b);
    }
    for (const g of b.groups) {
      st.dayCount.set(occKey(g, b.day), (st.dayCount.get(occKey(g, b.day)) || 0) + b.slots.length);
      st.dayPeriods.set(occKey(g, b.day), [...(st.dayPeriods.get(occKey(g, b.day)) || []), ...b.periods]);
    }
    if (b.teacher) st.teacherDay.set(occKey(b.teacher, b.day), (st.teacherDay.get(occKey(b.teacher, b.day)) || 0) + b.slots.length);
    st.placed.push(b);
    return b;
  }
  function unplace(b, st) {
    for (const s of b.slots) {
      for (const g of b.groups) st.group.delete(occKey(g, s));
      if (b.teacher) st.teacher.delete(occKey(b.teacher, s));
      if (b.room) st.room.delete(occKey(b.room, s));
    }
    for (const g of b.groups) {
      st.dayCount.set(occKey(g, b.day), st.dayCount.get(occKey(g, b.day)) - b.slots.length);
      const ps = st.dayPeriods.get(occKey(g, b.day)).slice();
      b.periods.forEach(p => ps.splice(ps.indexOf(p), 1));
      st.dayPeriods.set(occKey(g, b.day), ps);
    }
    if (b.teacher) st.teacherDay.set(occKey(b.teacher, b.day), st.teacherDay.get(occKey(b.teacher, b.day)) - b.slots.length);
    st.placed.splice(st.placed.indexOf(b), 1);
  }

  const WHY_TH = { window: "อยู่นอกช่วงเวลาที่กำหนด", dayFull: "กลุ่มเรียนครบ 10 คาบในวันนั้นแล้ว", group: "กลุ่มเรียนไม่ว่าง", teacher: "ครูไม่ว่าง", meeting: "ครูติดประชุมหัวหน้า", unavail: "ครูแจ้งไม่สะดวก", room: "ไม่มีห้องที่ใช้ได้ว่าง" };

  // หาช่องที่ดีที่สุดสำหรับ 1 บล็อก; mode baseline = ช่องแรกที่ว่าง
  function findBest(task, len, st, cfg, idx, rng, mode) {
    const tally = {}; let best = [];
    let minP = Infinity;
    for (const seq of idx.seqCache(len)) {
      const r = checkSeq(task, seq, st, cfg, idx);
      if (r.why) { tally[r.why] = (tally[r.why] || 0) + 1; continue; }
      if (mode === "baseline") return { seq, room: r.room === null ? null : r.freeRooms[0], tally };
      const p = penalty(task, seq, st, cfg, idx);
      best.push({ seq, p, rooms: r.room === null ? null : r.freeRooms });
      if (p < minP) minP = p;
    }
    if (!best.length) return { tally };
    const pool = best.filter(c => c.p <= minP + cfg.weights.tolerance);
    const pick = pool[Math.floor(rng() * pool.length)];
    return { seq: pick.seq, room: pick.rooms === null ? null : pick.rooms[Math.floor(rng() * pick.rooms.length)], tally };
  }

  function explain(task, tally, idx) {
    const s = idx.subject.get(task.subject);
    const parts = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${WHY_TH[k] || k} ${n} ช่อง`);
    let hint = "ลองเพิ่มครูที่สอนวิชานี้ใน teach หรือเพิ่มห้อง";
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (top && top[0] === "room") hint = task.type === "iot" ? "ห้อง IOT มีห้องเดียว ลดจำนวนกลุ่มที่เรียน IOT หรือเพิ่มคาบเรียน" : "เพิ่มห้องประเภทที่วิชานี้ใช้";
    if (tally.unavail && (!top || top[0] === "unavail" || top[0] === "window")) hint = `ครู ${task.teacher} แจ้งเวลาไม่สะดวกมากจนวางไม่ได้ ลดช่วงไม่สะดวก หรือเพิ่มครูอีกคนใน teach`;
    else if (top && (top[0] === "teacher" || top[0] === "meeting")) hint = `ครู ${task.teacher} สอนเต็ม ลองเพิ่มครูอีกคนให้วิชา ${task.subject} ใน teach`;
    if (top && (top[0] === "group" || top[0] === "dayFull")) hint = "กลุ่มนี้ลงวิชาแน่นเกินไป ลองลดวิชาหรือเพิ่ม timeslot";
    return { message: `${task.subject} ${s.subject_name} (${task.groups.join(", ")}) วางไม่ได้: ${parts.join(", ") || "ไม่มีช่องยาวพอ"}`, hint };
  }

  // ชั้น 2: วงรอบซ่อม plan-act-check — ถอดบล็อกที่ขวาง 1 บล็อก วางบล็อกที่ค้าง แล้ววางบล็อกที่ถอดใหม่
  function repair(pending, tasks, st, cfg, idx, rng, log) {
    const taskById = new Map(tasks.map(t => [t.id, t]));
    let iter = 0;
    for (let k = 0; k < pending.length && iter < cfg.repairIterations; k++) {
      const item = pending[k]; const task = taskById.get(item.task);
      let fixed = false;
      for (const seq of idx.seqCache(item.len)) {
        if (fixed || iter >= cfg.repairIterations) break;
        if (task.type === "activity" && !seq.slots.every(s => idx.inActivity(s))) continue;
        if (task.teacher && idx.isManager(task.teacher) && seq.slots.some(s => idx.inMeeting(s))) continue;
        if (task.teacher && seq.slots.some(s => idx.isUnavailable(task.teacher, s.id))) continue;
        const roomOpts = task.rooms === null ? [null] : task.rooms;
        for (const room of roomOpts) {
          const blockers = new Set();
          for (const s of seq.slots) {
            for (const g of task.groups) { const b = st.group.get(occKey(g, s.id)); if (b) blockers.add(b); }
            if (task.teacher) { const b = st.teacher.get(occKey(task.teacher, s.id)); if (b) blockers.add(b); }
            if (room) { const b = st.room.get(occKey(room, s.id)); if (b) blockers.add(b); }
          }
          if (!blockers.size || blockers.size > 2) continue;
          const bs = [...blockers];
          if (bs.some(b => taskById.get(b.task).type === "activity")) continue;
          iter++;
          // Plan: ถอดบล็อกที่ขวาง (ไม่เกิน 2 บล็อก) ออกชั่วคราว
          const saved = bs.map(b => ({ b, task: taskById.get(b.task), seq: { day: b.day, slots: b.slots.map(id => idx.slot.get(id)) } }));
          saved.forEach(s => unplace(s.b, st));
          const restore = () => saved.forEach(s => place(s.task, s.b.block, s.seq, s.b.room, st));
          const c = checkSeq(task, seq, st, cfg, idx);
          if (c.why || (room && !c.freeRooms.includes(room))) { restore(); continue; }
          // Act: วางบล็อกที่ค้าง แล้ววางบล็อกที่ถอดออกใหม่
          const newB = place(task, item.block, seq, room, st);
          const moved = [];
          let ok = true;
          for (const s of saved) {
            const re = findBest(s.task, s.b.slots.length, st, cfg, idx, rng, "heuristic");
            if (!re.seq) { ok = false; break; }
            moved.push({ s, nb: place(s.task, s.b.block, re.seq, re.room, st), re });
          }
          // Check: ถ้าวางกลับไม่ครบ ให้ย้อนกลับทั้งหมด
          if (ok) {
            moved.forEach(m => log.push(`ซ่อม: ย้าย ${m.s.task.subject} (${m.s.task.groups.join(",")}) ไป${DAY_TH[m.re.seq.day] || m.re.seq.day} คาบ ${m.re.seq.slots[0].period} เพื่อวาง ${task.subject} (${task.groups.join(",")})`));
            item.fixed = true; fixed = true; break;
          }
          moved.forEach(m => unplace(m.nb, st)); unplace(newB, st); restore();
        }
      }
    }
    return pending.filter(p => !p.fixed);
  }

  function runSchedule(data, userCfg, opts) {
    const t0 = Date.now();
    const cfg = mergeConfig(userCfg);
    const mode = (opts && opts.mode) || "heuristic";
    const seed = (opts && opts.seed != null) ? opts.seed : cfg.seed;
    const rng = mulberry32(seed);
    const idx = prepare(data, cfg);
    idx.breakSet = new Set(cfg.breakPeriods);
    const cache = new Map();
    idx.seqCache = len => { if (!cache.has(len)) cache.set(len, sequences(idx, len)); return cache.get(len); };
    const warnings = [];
    const tasks = buildTasks(data, cfg, idx, warnings);
    assignTeachers(tasks, cfg, idx, mode);
    const st = makeState(idx);
    const unscheduled = []; const log = [];
    // เรียงความยาก: ประเภท → ทางเลือกห้องน้อย → บล็อกยาว (baseline = ตามลำดับไฟล์)
    let order;
    if (mode === "baseline") order = tasks;
    else {
      const jitter = new Map(tasks.map(t => [t.id, rng()]));
      order = [...tasks].sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]
        || (a.rooms ? a.rooms.length : 999) - (b.rooms ? b.rooms.length : 999)
        || b.groups.length - a.groups.length || b.periods - a.periods || jitter.get(a.id) - jitter.get(b.id));
    }
    const pending = [];
    for (const task of order) {
      if (!task.teacher) { unscheduled.push({ subject: task.subject, groups: task.groups, periods: task.periods, message: `${task.subject} (${task.groups.join(", ")}) ไม่มีครูสอนใน teach`, hint: "เพิ่มครูในตาราง teach" }); continue; }
      task.blocks.forEach((len, bi) => {
        const r = findBest(task, len, st, cfg, idx, rng, mode);
        if (r.seq) place(task, bi, r.seq, r.room, st);
        else pending.push({ task: task.id, block: bi, len, tally: r.tally });
      });
    }
    let left = pending;
    if (opts && opts.repair && pending.length) {
      left = repair(pending, tasks, st, cfg, idx, rng, log);
      // ยังค้าง: แบ่งบล็อกยาวเป็น 2 ส่วนแล้ววางทีละส่วน (คาบไม่ติดกันแต่ยังครบจำนวน)
      left = left.filter(p => {
        const task = tasks[p.task];
        if (p.len < 2 || task.type === "activity") return true;
        const halves = splitBlocks(p.len, Math.ceil(p.len / 2)); const placedNow = [];
        for (const h of halves) { const r = findBest(task, h, st, cfg, idx, rng, "heuristic"); if (!r.seq) break; placedNow.push(place(task, p.block, r.seq, r.room, st)); }
        if (placedNow.length === halves.length) { log.push(`ซ่อม: แบ่ง ${task.subject} (${task.groups.join(",")}) ${p.len} คาบ เป็น ${halves.join("+")} คาบ แล้ววางได้`); return false; }
        placedNow.forEach(b => unplace(b, st)); return true;
      });
      left = left.length ? repair(left.map(p => ({ ...p, fixed: false })), tasks, st, cfg, idx, rng, log) : left;
    }
    for (const p of left) {
      const task = tasks[p.task]; const e = explain(task, p.tally, idx);
      unscheduled.push({ subject: task.subject, groups: task.groups, periods: p.len, message: e.message, hint: e.hint });
    }
    const blocks = st.placed.map((b, i) => ({ id: "b" + i, subject: b.subject, type: idx.type.get(b.subject), groups: b.groups.slice(), teacher: b.teacher, room: b.room, day: b.day, slots: b.slots.slice(), periods: b.periods.slice() }));
    const rows = [];
    for (const b of st.placed) for (const s of b.slots) for (const g of b.groups) rows.push({ group_id: g, timeslot_id: s, subject_id: b.subject, teacher_id: b.teacher || "", room_id: b.room || "" });
    rows.sort((a, b) => a.group_id.localeCompare(b.group_id) || a.timeslot_id.localeCompare(b.timeslot_id));
    return { rows, blocks, unscheduled, warnings, log, seed, mode, repair: !!(opts && opts.repair), ms: Date.now() - t0 };
  }

  /* ---------- 8) ตัวตรวจ 15 เงื่อนไข (แยกจากตัวจัดตาราง) ---------- */
  function validate(data, rows, userCfg) {
    const cfg = mergeConfig(userCfg);
    const idx = prepare(data, cfg);
    const R = [];
    const rule = (id, name, type) => { const r = { id, name, type, violations: [] }; R.push(r); return r; };
    const v = (r, message, hint) => r.violations.push({ message, hint });
    const slotOf = id => idx.slot.get(id);
    const slotTH = id => { const s = slotOf(id); return s ? `${DAY_TH[s.day] || s.day} คาบ ${s.period}` : id; };
    const need = sid => idx.subject.has(sid) ? idx.periodsOf(idx.subject.get(sid)) : 0;

    const byGS = new Map(), byGroup = new Map(), byGD = new Map();
    for (const r of rows) {
      const k = r.group_id + "|" + r.subject_id; byGS.set(k, (byGS.get(k) || 0) + 1);
      if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []); byGroup.get(r.group_id).push(r);
      const s = slotOf(r.timeslot_id); if (s) { const kd = r.group_id + "|" + s.day; byGD.set(kd, (byGD.get(kd) || 0) + 1); }
    }
    // 1
    let r1 = rule(1, "จำนวนคาบของแต่ละวิชา = theory + practice", "hard");
    for (const reg of data.register) { const got = byGS.get(reg.group_id + "|" + reg.subject_id) || 0, n = need(reg.subject_id); if (got !== n) v(r1, `กลุ่ม ${reg.group_id} วิชา ${reg.subject_id}: ได้ ${got} คาบ ต้องได้ ${n} คาบ`, got < n ? "มีคาบที่จัดไม่ลง ดูรายการวางไม่ได้ในหน้าจัดตาราง" : "มีคาบเกิน ตรวจข้อมูล output"); }
    // 2
    let r2 = rule(2, "คาบพักห้ามจัดวิชา", "lock");
    for (const r of rows) { const s = slotOf(r.timeslot_id); if (s && cfg.breakPeriods.includes(s.period)) v(r2, `กลุ่ม ${r.group_id} มีวิชา ${r.subject_id} ใน${slotTH(r.timeslot_id)} ซึ่งเป็นคาบพัก`, "ย้ายไปคาบอื่น"); }
    // 3
    let r3 = rule(3, "จำนวนวิชาในตาราง = จำนวนวิชาที่ลงทะเบียน", "hard");
    for (const g of data.student_group) {
      const reg = new Set(idx.registerOf.get(g.group_id) || []), got = new Set((byGroup.get(g.group_id) || []).map(r => r.subject_id));
      const miss = [...reg].filter(s => !got.has(s)), extra = [...got].filter(s => !reg.has(s));
      if (miss.length) v(r3, `กลุ่ม ${g.group_id} ขาดวิชา ${miss.join(", ")}`, "วิชานี้จัดไม่ลงเลย ดูเหตุผลในหน้าจัดตาราง");
      if (extra.length) v(r3, `กลุ่ม ${g.group_id} มีวิชาที่ไม่ได้ลงทะเบียน ${extra.join(", ")}`, "ตรวจ register");
    }
    // 4
    let r4 = rule(4, "จำนวนคาบรวม = ผลรวมคาบของวิชาที่ลงทะเบียน", "hard");
    for (const g of data.student_group) { const n = (idx.registerOf.get(g.group_id) || []).reduce((a, s) => a + need(s), 0), got = (byGroup.get(g.group_id) || []).length; if (n !== got) v(r4, `กลุ่ม ${g.group_id}: รวม ${got} คาบ ต้องได้ ${n} คาบ`, "ดูข้อ 1 ว่าวิชาไหนขาด"); }
    // 5
    let r5 = rule(5, `เรียนไม่เกิน ${cfg.maxPeriodsPerDay} คาบต่อวัน`, "hard");
    for (const [k, n] of byGD) if (n > cfg.maxPeriodsPerDay) { const [g, d] = k.split("|"); v(r5, `กลุ่ม ${g} วัน${DAY_TH[d] || d} เรียน ${n} คาบ`, "ย้ายบางวิชาไปวันอื่น"); }
    // 6, 7: อนุญาตเฉพาะวิชาสามัญเรียนรวม (วิชาเดียว ห้องเดียว ไม่เกิน groupSize กลุ่ม)
    const sharedOK = list => { const subj = new Set(list.map(r => r.subject_id)), rooms = new Set(list.map(r => r.room_id)), teachers = new Set(list.map(r => r.teacher_id)); return subj.size === 1 && rooms.size === 1 && teachers.size === 1 && idx.type.get(list[0].subject_id) === "general" && new Set(list.map(r => r.group_id)).size <= cfg.general.groupSize; };
    const groupBy = (keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    let r6 = rule(6, "ครูไม่สอน 2 กลุ่มในเวลาเดียวกัน", "hard");
    for (const [k, list] of groupBy(r => r.teacher_id ? r.teacher_id + "|" + r.timeslot_id : null)) if (list.length > 1 && !sharedOK(list)) v(r6, `ครู ${list[0].teacher_id} สอน ${list.map(r => r.group_id + ":" + r.subject_id).join(", ")} ใน${slotTH(list[0].timeslot_id)}`, "ย้ายวิชาของกลุ่มใดกลุ่มหนึ่งไปคาบอื่น หรือเปลี่ยนครู");
    let r7 = rule(7, "ห้อง 1 คาบใช้ได้กลุ่มเดียว วิชาเดียว", "hard");
    for (const [k, list] of groupBy(r => r.room_id ? r.room_id + "|" + r.timeslot_id : null)) if (list.length > 1 && !sharedOK(list)) v(r7, `ห้อง ${list[0].room_id} ถูกใช้โดย ${list.map(r => r.group_id + ":" + r.subject_id).join(", ")} ใน${slotTH(list[0].timeslot_id)}`, "ย้ายไปห้องอื่นที่ว่าง");
    // 8
    let r8 = rule(8, "ครูสอนเฉพาะวิชาที่กำหนดใน teach", "hard");
    const seen8 = new Set();
    for (const r of rows) { const k = r.teacher_id + "|" + r.subject_id; if (seen8.has(k)) continue; seen8.add(k); const t = idx.type.get(r.subject_id); const advisorOK = t === "homeroom" && cfg.homeroom.byAdvisor && idx.group.get(r.group_id) && idx.group.get(r.group_id).advisor === r.teacher_id; if (!idx.teachSet.has(k) && !advisorOK) v(r8, `ครู ${r.teacher_id || "(ว่าง)"} ไม่มีสิทธิ์สอน ${r.subject_id}`, "เปลี่ยนเป็นครูที่อยู่ใน teach"); }
    // 9
    let r9 = rule(9, "วิชาทฤษฎีใช้ห้องทฤษฎี / วิชามีปฏิบัติห้ามใช้ห้องทฤษฎี", "hard");
    const seen9 = new Set();
    for (const r of rows) { if (!r.room_id) continue; const k = r.subject_id + "|" + r.room_id; if (seen9.has(k)) continue; seen9.add(k); const s = idx.subject.get(r.subject_id), room = idx.room.get(r.room_id); if (!s || !room) { if (!room) v(r9, `ไม่พบห้อง ${r.room_id}`, "ตรวจรหัสห้อง"); continue; } const practice = Number(s.practice) > 0, theoryRoom = idx.isTheoryRoom(room); if (practice && theoryRoom) v(r9, `วิชา ${r.subject_id} มีชั่วโมงปฏิบัติ แต่ใช้ห้องทฤษฎี ${r.room_id}`, "ย้ายไปห้องปฏิบัติ"); if (!practice && !theoryRoom) v(r9, `วิชาทฤษฎี ${r.subject_id} ใช้ห้อง ${r.room_id} ที่ไม่ใช่ห้องทฤษฎี`, "ย้ายไปห้องทฤษฎี"); }
    // 10
    let r10 = rule(10, `หัวหน้า (${cfg.managerRole}) ห้ามสอนช่วงประชุม ${DAY_TH[normDay(cfg.managerMeeting.day, cfg)] || cfg.managerMeeting.day} ${cfg.managerMeeting.start}-${cfg.managerMeeting.end}`, "lock");
    for (const r of rows) { const s = slotOf(r.timeslot_id); if (s && idx.isManager(r.teacher_id) && idx.inMeeting(s)) v(r10, `หัวหน้า ${r.teacher_id} สอน ${r.subject_id} ในช่วงประชุม (${slotTH(r.timeslot_id)})`, "ย้ายวิชานี้ออกจากช่วงประชุม"); }
    // 11
    let r11 = rule(11, `มีคาบโฮมรูมอย่างน้อย ${cfg.homeroom.minPeriods} คาบต่อสัปดาห์`, "lock");
    for (const g of data.student_group) { const hr = (byGroup.get(g.group_id) || []).filter(r => idx.type.get(r.subject_id) === "homeroom"); if (hr.length < cfg.homeroom.minPeriods) v(r11, `กลุ่ม ${g.group_id} มีโฮมรูม ${hr.length} คาบ`, "เพิ่มวิชาโฮมรูมใน register"); else if (cfg.homeroom.byAdvisor && hr.some(r => r.teacher_id !== g.advisor)) v(r11, `กลุ่ม ${g.group_id}: โฮมรูมไม่ได้สอนโดยครูที่ปรึกษา ${g.advisor}`, "ให้ครูที่ปรึกษาเป็นผู้สอนโฮมรูม"); }
    // 12
    let r12 = rule(12, `วิชากิจกรรมอยู่ในช่วง ${DAY_TH[normDay(cfg.activity.day, cfg)] || cfg.activity.day} ${cfg.activity.start}-${cfg.activity.end}`, "lock");
    for (const r of rows) { if (idx.type.get(r.subject_id) !== "activity") continue; const s = slotOf(r.timeslot_id); if (!s || !idx.inActivity(s)) v(r12, `กลุ่ม ${r.group_id} วิชากิจกรรม ${r.subject_id} อยู่ใน${slotTH(r.timeslot_id)}`, "ย้ายเข้าช่วงกิจกรรม"); }
    // 13
    let r13 = rule(13, `วิชาสามัญเรียนรวม ${cfg.general.groupSize} กลุ่ม`, "hard");
    const genReg = {}; data.register.forEach(r => { if (idx.type.get(r.subject_id) === "general") genReg[r.subject_id] = (genReg[r.subject_id] || 0) + 1; });
    for (const [sid, n] of Object.entries(genReg)) {
      const sessions = groupBy(r => r.subject_id === sid ? r.timeslot_id + "|" + r.teacher_id : null);
      const alone = new Set();
      for (const list of sessions.values()) if (list.length < cfg.general.groupSize) list.forEach(r => alone.add(r.group_id));
      const allowed = n % cfg.general.groupSize;
      if (alone.size > allowed) v(r13, `วิชาสามัญ ${sid}: กลุ่ม ${[...alone].join(", ")} เรียนเดี่ยว (อนุญาตเดี่ยวได้ ${allowed} กลุ่ม)`, "จัดให้เรียนพร้อมกันเป็นคู่");
    }
    // 14
    let r14 = rule(14, `วิชา IOT เรียนที่ห้อง ${cfg.iot.roomId} เท่านั้น`, "hard");
    const seen14 = new Set();
    for (const r of rows) if (idx.type.get(r.subject_id) === "iot" && r.room_id !== cfg.iot.roomId && !seen14.has(r.group_id + r.subject_id + r.room_id)) { seen14.add(r.group_id + r.subject_id + r.room_id); v(r14, `กลุ่ม ${r.group_id} วิชา ${r.subject_id} ใช้ห้อง ${r.room_id || "(ว่าง)"}`, `ย้ายไปห้อง ${cfg.iot.roomId}`); }
    // 15 (soft)
    let r15 = rule(15, `เลี่ยงวิชาทฤษฎีหลังคาบ ${cfg.avoidTheoryAfterPeriod}`, "soft");
    for (const r of rows) { const s = slotOf(r.timeslot_id), sub = idx.subject.get(r.subject_id); if (s && sub && Number(sub.practice) === 0 && idx.type.get(r.subject_id) !== "activity" && s.period > cfg.avoidTheoryAfterPeriod) v(r15, `กลุ่ม ${r.group_id} วิชาทฤษฎี ${r.subject_id} อยู่ใน${slotTH(r.timeslot_id)}`, "ถ้าเป็นไปได้ให้ย้ายขึ้นคาบเช้า"); }

    R.forEach(r => { r.count = r.violations.length; r.passed = r.count === 0; });
    // เงื่อนไขเพิ่มเติม (ไม่อยู่ใน 15 ข้อของโจทย์): ครูต้องไม่สอนในเวลาที่แจ้งว่าไม่สะดวก
    const extra = { id: "U", name: "ครูไม่สอนในเวลาที่แจ้งว่าไม่สะดวก", type: "hard", violations: [] };
    const seenU = new Set();
    for (const r of rows) if (r.teacher_id && idx.isUnavailable(r.teacher_id, r.timeslot_id) && !seenU.has(r.teacher_id + r.timeslot_id)) { seenU.add(r.teacher_id + r.timeslot_id); extra.violations.push({ message: `ครู ${r.teacher_id} สอน ${r.subject_id} ใน${slotTH(r.timeslot_id)} ซึ่งแจ้งว่าไม่สะดวก`, hint: "จัดตารางใหม่ หรือลากวิชานี้ไปช่องอื่น" }); }
    extra.count = extra.violations.length; extra.passed = extra.count === 0;
    const hard = R.filter(r => r.type !== "soft");
    const m = metrics(data, rows, cfg, idx);
    const missingPeriods = data.register.reduce((a, reg) => a + Math.max(0, need(reg.subject_id) - (byGS.get(reg.group_id + "|" + reg.subject_id) || 0)), 0);
    const sw = cfg.softWeights;
    const softScore = sw.theoryLate * r15.count + sw.gap * m.totalGaps + sw.imbalance * m.imbalance;
    return {
      passed: hard.every(r => r.passed) && extra.passed, rules: R, extra: [extra],
      summary: { hardViolations: hard.filter(r => r.id !== 1 && r.id !== 3 && r.id !== 4).reduce((a, r) => a + r.count, 0) + extra.count, rulesPassed: R.filter(r => r.passed).length, missingPeriods, theoryAfter: r15.count, gaps: m.totalGaps, imbalance: m.imbalance, softScore },
      metrics: m
    };
  }

  /* ---------- 9) ตัวชี้วัดช่วยตัดสินใจ ---------- */
  function metrics(data, rows, cfg, idx) {
    idx = idx || prepare(data, mergeConfig(cfg)); cfg = mergeConfig(cfg);
    const usable = idx.slots.filter(s => !cfg.breakPeriods.includes(s.period));
    const roomUse = new Map(data.room.map(r => [r.room_id, new Set()]));
    const teacherLoad = new Map(data.teacher.map(t => [t.teacher_id, new Set()]));
    const gd = new Map();
    for (const r of rows) {
      if (r.room_id && roomUse.has(r.room_id)) roomUse.get(r.room_id).add(r.timeslot_id);
      if (r.teacher_id && teacherLoad.has(r.teacher_id)) teacherLoad.get(r.teacher_id).add(r.timeslot_id);
      const s = idx.slot.get(r.timeslot_id); if (!s) continue;
      const k = r.group_id + "|" + s.day; if (!gd.has(k)) gd.set(k, new Set()); gd.get(k).add(s.period);
    }
    const bs = new Set(cfg.breakPeriods);
    let totalGaps = 0, imbalance = 0;
    const groupStats = data.student_group.map(g => {
      const perDay = idx.days.map(d => (gd.get(g.group_id + "|" + d) || new Set()).size);
      let gaps = 0;
      for (const d of idx.days) { const set = gd.get(g.group_id + "|" + d); if (!set || set.size < 2) continue; const ps = [...set].sort((a, b) => a - b); for (let p = ps[0] + 1; p < ps[ps.length - 1]; p++) if (!set.has(p) && !bs.has(p)) gaps++; }
      totalGaps += gaps; imbalance += Math.max(...perDay) - Math.min(...perDay);
      return { group_id: g.group_id, name: g.group_name, total: perDay.reduce((a, b) => a + b, 0), perDay, gaps };
    });
    const rooms = data.room.map(r => ({ room_id: r.room_id, name: r.room_name, type: r.room_type, used: roomUse.get(r.room_id).size, pct: Math.round(roomUse.get(r.room_id).size / usable.length * 100) }));
    const teachers = data.teacher.map(t => ({ teacher_id: t.teacher_id, name: t.teacher_name, role: t.role, load: teacherLoad.get(t.teacher_id).size }));
    const loads = teachers.map(t => t.load);
    return {
      roomUtil: Math.round(rooms.reduce((a, r) => a + r.used, 0) / (rooms.length * usable.length) * 100),
      rooms, teachers, groups: groupStats, totalGaps, imbalance,
      teacherMax: Math.max(...loads, 0), teacherMin: Math.min(...loads, 0), teacherAvg: loads.length ? +(loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1) : 0
    };
  }

  // รันหลายรอบ (seed, seed+1, ...) เก็บผลที่ดีที่สุด: conflict → คาบที่ขาด → คะแนนคุณภาพ
  function runBest(data, userCfg, onProgress, opts) {
    const cfg = mergeConfig(userCfg);
    const n = Math.max(1, cfg.runs | 0);
    let best = null; const history = [];
    for (let i = 0; i < n; i++) {
      const res = runSchedule(data, cfg, { mode: "heuristic", repair: opts && opts.repair, seed: cfg.seed + i });
      const val = validate(data, res.rows, cfg);
      const score = [val.summary.hardViolations, val.summary.missingPeriods, val.summary.softScore];
      history.push({ seed: res.seed, hard: score[0], missing: score[1], soft: score[2], ms: res.ms });
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) best = { res, val, score };
      if (onProgress) onProgress(i + 1, n, best);
    }
    return { best: best.res, validation: best.val, history };
  }

  /* ---------- 10) แก้ตารางด้วยมือ: แปลงบล็อกเป็นแถว และตรวจการย้าย/สลับก่อนยอมให้วาง ---------- */
  function rowsFromBlocks(blocks) {
    const rows = [];
    for (const b of blocks) for (const s of b.slots) for (const g of b.groups) rows.push({ group_id: g, timeslot_id: s, subject_id: b.subject, teacher_id: b.teacher || "", room_id: b.room || "" });
    rows.sort((a, b) => a.group_id.localeCompare(b.group_id) || a.timeslot_id.localeCompare(b.timeslot_id));
    return rows;
  }

  // ตัวเลือกการแบ่งคาบของวิชา n คาบ: เรียนยาว n คาบ หรือแบ่งเป็นไม่เกิน 3 ช่วง (เรียงจากมากไปน้อย)
  function splitOptions(n) {
    const out = [];
    const rec = (left, max, parts) => {
      if (left === 0) { out.push(parts.slice()); return; }
      if (parts.length === 3) return;
      for (let k = Math.min(left, max); k >= 1; k--) { parts.push(k); rec(left - k, k, parts); parts.pop(); }
    };
    rec(n, n, []);
    return out;
  }

  // moves = [{ id, day, start }] ย้ายบล็อก id ไปเริ่มที่ (day, คาบ start) ตรวจทีละรายการตามลำดับ
  // คืน { ok, reasons[], placements: [{ id, day, slots, periods, room, roomChanged }] }
  function checkPlacement(idx, cfg, blocks, moves) {
    cfg = mergeConfig(cfg);
    const moving = new Set(moves.map(m => m.id));
    const occ = { group: new Set(), teacher: new Set(), room: new Map(), day: new Map() };
    const occupy = (b, slots, day, room) => {
      for (const s of slots) { b.groups.forEach(g => occ.group.add(g + "|" + s)); if (b.teacher) occ.teacher.add(b.teacher + "|" + s); if (room) occ.room.set(room + "|" + s, b.id); }
      b.groups.forEach(g => occ.day.set(g + "|" + day, (occ.day.get(g + "|" + day) || 0) + slots.length));
    };
    for (const b of blocks) if (!moving.has(b.id)) occupy(b, b.slots, b.day, b.room);
    const reasons = [], placements = [];
    const byId = new Map(blocks.map(b => [b.id, b]));
    for (const m of moves) {
      const b = byId.get(m.id), len = b.slots.length;
      const dayList = idx.slotsByDay[m.day] || [];
      const i0 = dayList.findIndex(s => s.period === m.start);
      const seq = i0 < 0 ? [] : dayList.slice(i0, i0 + len);
      const label = `${b.subject} (${b.groups.join(",")})`;
      const dayTH = DAY_TH[m.day] || m.day;
      const tName = b.teacher && idx.teacher.get(b.teacher) ? idx.teacher.get(b.teacher).teacher_name : b.teacher;
      if (seq.length < len || seq.some((s, j) => j > 0 && s.period !== seq[j - 1].period + 1)) { reasons.push(`${label} ยาว ${len} คาบ วางเริ่มคาบ ${m.start} ไม่พอ`); continue; }
      if (seq.some(s => cfg.breakPeriods.includes(s.period))) { reasons.push(`${label} จะคร่อมคาบพัก`); continue; }
      if (b.type === "activity" && !seq.every(s => idx.inActivity(s))) { reasons.push(`วิชากิจกรรมต้องอยู่ช่วง ${DAY_TH[normDay(cfg.activity.day, cfg)]} ${cfg.activity.start}-${cfg.activity.end}`); continue; }
      const ids = seq.map(s => s.id);
      const busyG = b.groups.find(g => ids.some(s => occ.group.has(g + "|" + s)));
      if (busyG) { reasons.push(`กลุ่ม ${busyG} มีวิชาอื่นใน${dayTH} คาบ ${m.start}–${m.start + len - 1}`); continue; }
      const fullG = b.groups.find(g => (occ.day.get(g + "|" + m.day) || 0) + len > cfg.maxPeriodsPerDay);
      if (fullG) { reasons.push(`กลุ่ม ${fullG} จะเรียนเกิน ${cfg.maxPeriodsPerDay} คาบในวัน${dayTH}`); continue; }
      if (b.teacher && ids.some(s => occ.teacher.has(b.teacher + "|" + s))) { reasons.push(`${tName} (${b.teacher}) สอนวิชาอื่นอยู่ใน${dayTH} คาบนั้น`); continue; }
      if (b.teacher && idx.isManager(b.teacher) && seq.some(s => idx.inMeeting(s))) { reasons.push(`${tName} เป็นหัวหน้า ติดประชุมช่วงนั้น`); continue; }
      if (b.teacher && seq.some(s => idx.isUnavailable(b.teacher, s.id))) { reasons.push(`${tName} แจ้งว่าไม่สะดวกสอนช่วงนั้น`); continue; }
      let room = b.room, roomChanged = false;
      if (room && ids.some(s => occ.room.has(room + "|" + s))) {
        const alt = (idx.roomsFor(b.subject) || []).find(r => ids.every(s => !occ.room.has(r + "|" + s)));
        if (!alt) { reasons.push(`ห้อง ${room} ไม่ว่าง และไม่มีห้องประเภทเดียวกันว่าง`); continue; }
        room = alt; roomChanged = true;
      }
      occupy(b, ids, m.day, room);
      placements.push({ id: b.id, day: m.day, slots: ids, periods: seq.map(s => s.period), room, roomChanged });
    }
    return { ok: reasons.length === 0 && placements.length === moves.length, reasons, placements };
  }

  const api = { rowsFromBlocks, splitOptions, checkPlacement, DEFAULT_CONFIG, DAY_ORDER, DAY_TH, TYPE_TH, TABLES, OUTPUT_COLUMNS, mergeConfig, mulberry32, parseCSV, toCSV, makeSample, prepare, classifySubject, inputCheck, runSchedule, runBest, validate, metrics, normDay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TTEngine = api;
})(typeof self !== "undefined" ? self : this);
