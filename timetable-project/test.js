const E = require("./engine.js");
for (const size of ["small", "medium", "large", "tight"]) {
  const data = E.makeSample(size);
  const issues = E.inputCheck(data, {});
  console.log(`\n=== ${size}: rooms ${data.room.length}, groups ${data.student_group.length}, teachers ${data.teacher.length}, subjects ${data.subject.length}, register ${data.register.length}`);
  console.log("input issues:", issues.map(i => i.level + ": " + i.message));
  const cfg = { runs: size === "large" ? 5 : 20 };
  const base = E.runSchedule(data, cfg, { mode: "baseline" });
  const vb = E.validate(data, base.rows, cfg);
  const h = E.runBest(data, cfg, null, { repair: false });
  const hr = E.runBest(data, cfg, null, { repair: true });
  const fmt = (name, res, v) => console.log(name.padEnd(12), "rows", res.rows.length, "| hard", v.summary.hardViolations, "| missing", v.summary.missingPeriods, "| rules", v.summary.rulesPassed + "/15", "| theory>9", v.summary.theoryAfter, "| gaps", v.summary.gaps, "| imbal", v.summary.imbalance, "| soft", v.summary.softScore, "| tMax", v.metrics.teacherMax, "| roomUtil", v.metrics.roomUtil + "%", "| ms", res.ms);
  fmt("baseline", base, vb);
  fmt("heuristic", h.best, h.validation);
  fmt("heur+repair", hr.best, hr.validation);
  console.log("failed rules baseline:", vb.rules.filter(r => !r.passed).map(r => r.id + "(" + r.count + ")").join(" "));
  console.log("failed rules best:", hr.validation.rules.filter(r => !r.passed).map(r => r.id + "(" + r.count + ")").join(" "));
  console.log("unscheduled best:", hr.best.unscheduled.slice(0, 3).map(u => u.message));
  console.log("warnings:", hr.best.warnings, "repair log:", hr.best.log.slice(0, 3));
  // determinism
  const a = E.runSchedule(data, cfg, { seed: 42 }), b = E.runSchedule(data, cfg, { seed: 42 });
  console.log("same seed same result:", JSON.stringify(a.rows) === JSON.stringify(b.rows));
}
// validator self-test: inject one violation per rule
const data = E.makeSample("medium");
const good = E.runBest(data, {}, null, { repair: true }).best.rows;
const mut = [
  [2, rows => { rows[0] = { ...rows[0], timeslot_id: "MON-05" }; }],
  [6, rows => { const r = rows.find(x => !x.subject_id.startsWith("2") && !x.subject_id.startsWith("3") || true); const other = rows.find(x => x.teacher_id !== r.teacher_id && x.group_id !== r.group_id && x.timeslot_id !== r.timeslot_id); other.timeslot_id = r.timeslot_id; other.teacher_id = r.teacher_id; }],
  [8, rows => { rows[3] = { ...rows[3], teacher_id: "T25" }; }],
  [14, rows => { const i = rows.findIndex(x => /2402|2406/.test(x.subject_id)); rows[i] = { ...rows[i], room_id: "R5101" }; }],
  [1, rows => { rows.pop(); }]
];
for (const [id, f] of mut) { const rows = good.map(r => ({ ...r })); f(rows); const v = E.validate(data, rows, {}); console.log(`inject rule ${id}: caught =`, !v.rules.find(r => r.id === id).passed, "| failing:", v.rules.filter(r => !r.passed).map(r => r.id).join(",")); }
// --- edit API tests
{
  const d = E.makeSample("medium"), cfg = E.mergeConfig({ runs: 10 });
  const r = E.runBest(d, cfg, null, { repair: true }).best;
  console.log("blocks", r.blocks.length, "rows==fromBlocks", JSON.stringify(E.rowsFromBlocks(r.blocks)) === JSON.stringify(r.rows));
  const five = r.blocks.filter(b => b.subject === "30204-2001" && b.groups[0] === "G01").map(b => b.slots.length);
  console.log("5-period default split", five);
  const cfg2 = E.mergeConfig({ runs: 5, splitOverride: { "30204-2001": [5] } });
  const r2 = E.runBest(d, cfg2, null, { repair: true });
  console.log("long-5 split", r2.best.blocks.filter(b => b.subject === "30204-2001").map(b => b.slots.length + "@" + b.day + b.periods[0]), "pass", r2.validation.passed);
  const I = E.prepare(d, cfg);
  let ok = 0, bad = 0, okValid = 0;
  for (const b of r.blocks.slice(0, 60)) for (const day of I.days) for (const p of I.periods) {
    const c = E.checkPlacement(I, cfg, r.blocks, [{ id: b.id, day, start: p }]);
    if (c.ok) { ok++; const nb = r.blocks.map(x => x.id === b.id ? { ...x, day, slots: c.placements[0].slots, periods: c.placements[0].periods, room: c.placements[0].room } : x); const v = E.validate(d, E.rowsFromBlocks(nb), cfg); if (v.passed) okValid++; else console.log("MISMATCH", b.id, day, p, v.rules.filter(x => !x.passed && x.type !== "soft").map(x => x.id)); } else bad++;
  }
  console.log("move checks ok", ok, "bad", bad, "ok&valid", okValid);
  // swaps
  let sOk = 0, sValid = 0; const gb = r.blocks.filter(b => b.groups.includes("G05"));
  for (const a of gb) for (const t of gb) { if (a === t) continue; const c = E.checkPlacement(I, cfg, r.blocks, [{ id: a.id, day: t.day, start: t.periods[0] }, { id: t.id, day: a.day, start: a.periods[0] }]); if (c.ok) { sOk++; const pm = new Map(c.placements.map(p => [p.id, p])); const nb = r.blocks.map(x => pm.has(x.id) ? { ...x, ...pm.get(x.id) } : x); if (E.validate(d, E.rowsFromBlocks(nb), cfg).passed) sValid++; else console.log("SWAP MISMATCH", a.id, t.id); } }
  console.log("swap ok", sOk, "valid", sValid);
  console.log("splitOptions(5)", JSON.stringify(E.splitOptions(5)));
}
