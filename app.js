"use strict";
// RS Coach – phone front end for the RS training app.
// Data comes from data/report.json and data/weekly.json in the private GitHub repo (written by the
// GitHub Actions engine). Logging buttons start the repo's workflows. "Ask the coach" talks to Claude directly.

// The Android app is Richie's; the web version starts blank so each person enters their own data repo.
const IN_APK = location.host === "appassets.androidplatform.net";
const DEFAULT_REPO = IN_APK ? "richiesheerin/RS-training-app" : "";
// Everyday coach model, and the stronger one for blood-results chats. The engine's config.toml wins when it sends them.
// Who the app is for and which specialist parts are on ([profile] in config.toml). Older reports predate it: Richie's.
const profile = () => report?.profile || { name: "Richie", medical: true, food_safety: true, checkin_part: "Hip" };
const MODELS = { default: "claude-haiku-5-5", medical: "claude-sonnet-5-5" };
const modelFor = (mode) => report?.coach_models?.[mode === "medical" ? "medical" : "default"] || MODELS[mode === "medical" ? "medical" : "default"];
const modelName = (m) => m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
const WORKFLOWS = { refresh: "refuel.yml", weight: "log-weight.yml", labs: "log-labs.yml", checkin: "check-in.yml", fit: "export-fit.yml",
  coach: "coach-update.yml" };
const MAX_CHAT_MESSAGES = 40;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

let settings = store.get("settings", { repo: DEFAULT_REPO, github: "", anthropic: "" });
let report = store.get("report", null);
let weeklyData = store.get("weekly", null);
let athlete = store.get("athlete", "");
let chat = store.get("chat", null);
let view = "today";
let busy = false;
let pendingEnergy = null;  // energy tapped on the Today prompt, carried into the check-in form
const openDays = new Set();

// ---------- formatting ----------
const isoToday = () => new Date().toLocaleDateString("en-CA");
const dayName = (iso) => new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const shortDate = (iso) => new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const rng = (a) => (a[0] !== a[1] ? `${a[0]}–${a[1]}` : `${a[0]}`);
const signed = (x, d = 1) => (x > 0 ? "+" : "") + Number(x).toFixed(d);
function dur(h) {
  const m = Math.round(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`;
}
const zone = (level) => `var(--z${level})`;
function zbar(level) {
  return `<div class="zbar">${[0, 1, 2, 3, 4].map((i) => `<span style="${i <= level ? `background:${zone(i)}` : ""}"></span>`).join("")}</div>`;
}
const rows = (pairs) => `<table class="rows">${pairs.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>`;

function mdLite(text) {
  // Escaped first, then a little markdown: **bold**, bullet lists, paragraphs.
  const out = [];
  let list = null;
  for (const raw of esc(text).split("\n")) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const m = line.match(/^\s*[-*•]\s+(.*)/);
    if (m) { (list ||= []).push(`<li>${m[1]}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}
const noteHtml = (note, label) => `<div class="note"><div class="label">${label}</div>${note.split("\n").filter((l) => l.trim())
  .map((l) => `<p>${esc(l.replace(/^\s*-\s*/, ""))}</p>`).join("")}</div>`;
const flagsHtml = (flags) => `<ul class="flags">${flags.map((f) => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join("")}</ul>`;

// ---------- status bar ----------
function status(msg, kind = "") {
  const el = $("#status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = "status " + kind;
  el.innerHTML = msg;
}

// ---------- GitHub ----------
function ghHint(code) {
  return { 401: "Token wrong or expired – check Settings.", 403: "Token lacks permission (needs Contents: read, Actions: read & write).",
    404: "Not found – check the repo name, or the token can't see this repo.", 422: "GitHub rejected the request." }[code] || "";
}
async function gh(path, { method = "GET", body, raw = false } = {}) {
  if (!settings.github) throw new Error("Add your GitHub token in Settings.");
  const res = await fetch(`https://api.github.com/repos/${settings.repo}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${settings.github}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}. ${ghHint(res.status)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

async function loadData() {
  const [rep, wk, ath] = await Promise.allSettled([
    gh("/contents/data/report.json", { raw: true }),
    gh("/contents/data/weekly.json", { raw: true }),
    gh("/contents/athlete.md", { raw: true }),
  ]);
  if (rep.status === "fulfilled") { report = JSON.parse(rep.value); store.set("report", report); }
  if (wk.status === "fulfilled") { weeklyData = JSON.parse(wk.value); store.set("weekly", weeklyData); }
  if (ath.status === "fulfilled") { athlete = ath.value; store.set("athlete", athlete); }
  if (rep.status === "rejected") {
    if (rep.reason.status === 404) throw new Error("No app data yet. Go to Log → Update now to create it.");
    throw rep.reason;
  }
}

async function reload() {
  if (busy) return;
  $("#refresh").classList.add("spin");
  try {
    await loadData();
    status("");
  } catch (e) {
    status(esc(e.message), "err");
  } finally {
    $("#refresh").classList.remove("spin");
    render();
  }
}

async function runWorkflow(key, inputs, label) {
  if (busy) { status("Another update is still running…"); return false; }
  busy = true;
  setBusyButtons(true);
  try {
    const file = WORKFLOWS[key];
    const repo = await gh("");
    const before = (await gh(`/actions/workflows/${file}/runs?per_page=1`)).workflow_runs[0]?.id || 0;
    await gh(`/actions/workflows/${file}/dispatches`, { method: "POST", body: { ref: repo.default_branch, inputs } });
    status(`${esc(label)}: queued…`);
    let run = null;
    for (let i = 0; i < 72; i++) {  // up to ~6 minutes
      await sleep(5000);
      if (!run) {
        run = (await gh(`/actions/workflows/${file}/runs?per_page=5`)).workflow_runs.find((r) => r.id > before) || null;
        if (!run) continue;
      } else {
        run = await gh(`/actions/runs/${run.id}`);
      }
      if (run.status === "completed") {
        if (run.conclusion === "success") {
          status(`${esc(label)}: done ✓ – loading…`);
          await loadData().catch(() => {});
          render();
          status(`${esc(label)}: done ✓`);
          setTimeout(() => status(""), 4000);
          return true;
        }
        status(`${esc(label)} failed (${esc(run.conclusion)}). <a href="${esc(run.html_url)}">See the run log</a>.`, "err");
        return false;
      }
      status(`${esc(label)}: ${run.status === "in_progress" ? "running" : esc(run.status)}…`);
    }
    status(`${esc(label)} is taking a while – check the Actions tab on GitHub.`, "err");
    return false;
  } catch (e) {
    status(esc(e.message), "err");
    return false;
  } finally {
    busy = false;
    setBusyButtons(false);
  }
}
function setBusyButtons(on) {
  $$("[data-busy]").forEach((b) => { b.disabled = on; });
}

// ---------- views ----------
const TITLES = { today: "Today", week: "Week", trends: "Trends", coach: "Coach", log: "Log", settings: "Settings" };

function show(v) {
  view = v;
  $$(".view").forEach((el) => { el.hidden = el.id !== `view-${v}`; });
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $("#title").textContent = TITLES[v];
  render();
  $("main").scrollTop = 0;
}
window.appBack = () => {
  if (!$("#sheet").hidden) { closeSheet(); return true; }
  if (view !== "today") { show(view === "settings" && !settings.github ? "settings" : "today"); return true; }
  return false;
};

function render() {
  $("#updated").textContent = report ? `${shortDate(report.generated_at)} ${report.generated_at.slice(11, 16)}` : "";
  ({ today: renderToday, week: renderWeek, trends: renderTrends, coach: renderCoach, log: renderLog, settings: renderSettings }[view])();
}

const LOGO = `<div class="logo"><span class="tile"><img src="logo.png" alt="Trainer"></span></div>`;
const emptyState = () => `${LOGO}<div class="empty">${settings.github
  ? "No data yet.<br>Tap ⟳ to load, or Log → <b>Update now</b> to fetch from intervals.icu."
  : "Add your GitHub token in <b>Settings</b> (⚙) to load your data."}</div>`;

function sessionHtml(s, f, level) {
  const at = s.start ? ` at ${s.start.slice(11, 16)}` : "";
  const fuel = f && f.hi
    ? `<div class="small" style="margin-top:6px">${s.kind.includes("Ride") ? "On the bike" : "During"}: ${f.lo}–${f.hi} g/h${f.total ? ` (~${f.total} g total)` : ""}. ${esc(f.note)}.</div>` : "";
  const gym = isGym(s.kind);
  return `<div class="session${gym ? " tap" : ""}" style="border-left-color:${zone(level)}"${gym ? ` data-gym="1" role="button" tabindex="0"` : ""}>
    <div class="srow">${icon(iconKey(s.kind, s.race))}<div><b>${esc(s.name)}${at}</b>
    <span class="small muted">${dur(s.hours)}${s.load ? ` · load ${Math.round(s.load)}` : ""}</span></div>${gym ? `<span class="chev">Exercises ›</span>` : ""}</div>${fuel}</div>`;
}

function notesHtml(d) {
  return (d.notes || []).map((n) => `<div class="session note-ev"><div class="srow">${icon("other")}<div><b>${esc(n.name)}</b>
    ${n.description ? `<span class="small muted">${esc(n.description)}</span>` : ""}</div></div></div>`).join("");
}

function mealsHtml(d) {
  const ideas = report.meal_plan?.days?.[d.day] || [];
  return rows(d.meals.map((m, i) => {
    const idea = ideas.find((x) => x.slot === m.label) || ideas[i];
    return [esc(m.label), `${m.carbs} g carbs${m.protein ? `, ${m.protein} g protein` : ""}`
      + (idea ? `<br><span class="dish">${esc(idea.dish)}</span>${idea.prep ? `<br><span class="small muted">${esc(idea.prep)}</span>` : ""}` : "")];
  }));
}

const dayTotals = (d) => rows([["Carbs", `${rng(d.carbs)} g`], ["Protein", `${d.protein} g`], ["Fat", `~${d.fat} g`], ["Energy", `~${d.kcal} kcal`]]);

function dayDetail(d) {
  const sessions = d.sessions.map((s, i) => sessionHtml(s, d.fuel[i], d.level)).join("") + notesHtml(d);
  return `${dayTotals(d)}
    ${sessions}${d.race ? `<p class="small">Race day: foods you've trained with, low fibre before the start.</p>` : ""}
    <h3>How to split it</h3>${mealsHtml(d)}`;
}

// A card that folds to its headline; whether it's open is remembered per card on this phone.
function foldCard(id, head, body) {
  const open = store.get(`fold:${id}`, true);
  return `<details class="card fold" data-fold="${id}"${open ? " open" : ""}><summary>${head}<span class="fold-chev" aria-hidden="true"></span></summary>${body}</details>`;
}

// ---------- food log: what he told the coach he's had ----------
const hhmm = () => new Date().toTimeString().slice(0, 5);

function foodEntries(b) {
  return (b.input.entries || []).map((e, i) => ({ id: `${b.id}-${i}`, date: e.date || isoToday(), time: e.time || hhmm(),
    item: e.item, carbs_g: e.carbs_g, protein_g: e.protein_g, ...(e.kcal ? { kcal: e.kcal } : {}) }));
}

function addPendingFood(entries) {
  store.set("food_pending", [...store.get("food_pending", []), ...entries]);
}

function foodLog(day = isoToday()) {
  // The report's saved log, plus anything logged on this phone that the next refresh hasn't brought back yet.
  const saved = report?.food_log || [], ids = new Set(saved.map((r) => r.id));
  const week = new Date(Date.now() - 7 * 864e5).toLocaleDateString("en-CA");
  const pending = store.get("food_pending", []).filter((r) => !ids.has(r.id) && r.date >= week);
  if (pending.length !== store.get("food_pending", []).length) store.set("food_pending", pending);
  return [...saved, ...pending].filter((r) => r.date === day).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

function todayTargets() {
  const t = isoToday();
  return [report?.today, ...(report?.days || [])].find((x) => x && x.day === t) || null;
}

function eatenSummary() {
  const log = foodLog(), d = todayTargets();
  const c = log.reduce((s, r) => s + (r.carbs_g || 0), 0), p = log.reduce((s, r) => s + (r.protein_g || 0), 0);
  return `Today so far: ${c} g carbs, ${p} g protein` + (d ? ` of ${d.carbs[0]}–${d.carbs[1]} g carbs and ${d.protein} g protein.` : ".");
}

function eatenHtml(d) {
  const log = foodLog(d.day);
  const c = log.reduce((s, r) => s + (r.carbs_g || 0), 0), p = log.reduce((s, r) => s + (r.protein_g || 0), 0);
  const [lo, hi] = d.carbs, cMax = Math.max(hi, c), pMax = Math.max(d.protein, p);
  const bar = (label, val, max, unit, mark, target) => `<div class="eat"><div class="eat-head"><span>${label}</span><b>${val}<small> / ${target} ${unit}</small></b></div>
    <div class="eat-track"><b style="width:${Math.min(100, val / max * 100).toFixed(1)}%"></b>${mark != null ? `<i style="left:${(mark / max * 100).toFixed(1)}%"></i>` : ""}</div></div>`;
  const left = Math.max(0, lo - c);
  return `<div class="eaten"><h3>Eaten so far</h3>
    ${bar("Carbs", c, cMax, "g", lo, `${lo}–${hi}`)}${bar("Protein", p, pMax, "g", null, d.protein)}
    <p class="small muted" style="margin:4px 0 0">${log.length ? (left ? `About ${left} g carbs to go to reach the low end.` : c > hi ? "Above today's range – fine after a big session, otherwise ease off." : "In today's range.")
      : "Tell the coach what you eat or drink and it appears here."}</p>
    ${log.length ? `<table class="rows food">${log.map((r) => `<tr><td>${esc(r.time || "")}</td><td>${esc(r.item)}<br><span class="small muted">${r.carbs_g ?? 0} g carbs · ${r.protein_g ?? 0} g protein</span></td></tr>`).join("")}</table>` : ""}</div>`;
}

// kcal for a logged item: the coach's estimate, or carbs and protein plus a typical share from fat if it gave none.
const itemKcal = (r) => (r.kcal != null ? r.kcal : Math.round(((r.carbs_g || 0) * 4 + (r.protein_g || 0) * 4) * 1.25));

function burnedToday(eaten, target) {
  // Resting energy for the hours gone so far, plus training (minus the resting part already counted), steps, and
  // digestion (~10% of what's eaten; by the end of the day, of the target).
  const e = report.energy;
  if (!e) return null;
  const t = isoToday(), now = new Date();
  const frac = (now.getHours() * 60 + now.getMinutes()) / 1440, perMin = e.bmr / 1440;
  const steps = (report.wellness || []).find((w) => w.id === t)?.steps;
  const acts = (report.activities || []).filter((a) => a.date === t && a.kcal && !(steps != null && WALKS.has(a.type)));
  const training = Math.round(acts.reduce((s, a) => s + Math.max(0, a.kcal - perMin * (a.mins || 0)), 0));
  const walking = Math.round((steps || 0) * e.kcal_per_step);
  const resting = Math.round(e.bmr * frac), digestion = Math.round(0.1 * eaten);
  return { resting, training, walking, digestion, soFar: resting + training + walking + digestion,
    endOfDay: e.bmr + training + walking + Math.round(0.1 * Math.max(eaten, target)) };
}

function energyHtml(d) {
  const eaten = foodLog(d.day).reduce((s, r) => s + itemKcal(r), 0);
  const b = burnedToday(eaten, d.kcal);
  const guessed = foodLog(d.day).some((r) => r.kcal == null);
  const max = Math.max(d.kcal, eaten, b ? b.endOfDay : 0, 1);
  const pct = (v) => (Math.min(v, max) / max * 100).toFixed(1);
  const fmt = (v) => thousands(v);
  const row = (label, val, cls, extra = "", ghost = null) => `<div class="kc"><span>${label}</span><div class="kc-track">
    ${ghost != null ? `<b class="ghost" style="width:${pct(ghost)}%"></b>` : ""}<b class="${cls}" style="width:${pct(val)}%"></b></div><em>${extra}</em></div>`;
  let html = `<h3>Energy today</h3>
    ${row("Target", d.kcal, "target", `${fmt(d.kcal)}`)}
    ${row("Eaten", eaten, "eaten", `${guessed ? "~" : ""}${fmt(eaten)}`)}`;
  if (b) {
    html += row("Burned", b.soFar, "burned", `${fmt(b.soFar)}`, b.endOfDay);
    const net = eaten - b.soFar, plan = d.kcal - b.endOfDay;
    html += `<p class="small" style="margin:6px 0 0">Burned so far: resting ${fmt(b.resting)} · training ${fmt(b.training)} · steps ${fmt(b.walking)} · digestion ${fmt(b.digestion)}.
      About <b>${fmt(b.endOfDay)}</b> by the end of the day if you eat to target and do no more training or walking (lighter bar).</p>
      <p class="small" style="margin:4px 0 0">Eaten minus burned so far: <b>${net > 0 ? "+" : "−"}${fmt(Math.abs(net))} kcal</b>.
      Hitting the target would leave you about <b>${fmt(Math.abs(plan))} kcal ${plan <= 0 ? "under" : "over"}</b> today's burn${report.goal?.weight_goal === "gain" ? (plan > 0 ? " – the surplus for gaining" : "") : plan <= 0 ? " – the deficit for weight loss" : ""}.</p>`;
  } else {
    html += `<p class="small muted" style="margin:6px 0 0">Add sex, height_cm and birth_year under [profile] in config.toml to see kcal burned.</p>`;
  }
  return html + `<p class="small muted" style="margin:4px 0 0">Estimates: resting energy from your weight, height and age; training from your devices.</p>`;
}

// Today's fuelling: from the report's own "today", or from its days list if the report was made yesterday.
function todayFuel() {
  const t = isoToday(), d = [report.today, ...(report.days || [])].find((x) => x && x.day === t);
  if (!d) return "";
  const fuel = d.sessions.map((s, i) => [s, d.fuel[i]]).filter(([, f]) => f && f.hi)
    .map(([s, f]) => `<p class="small" style="margin:6px 0 0"><b>${esc(s.name)}:</b> ${s.kind.includes("Ride") ? "on the bike" : "during"} ${f.lo}–${f.hi} g/h${f.total ? ` (~${f.total} g total)` : ""}.</p>`).join("");
  const eaten = foodLog(d.day).reduce((s, r) => s + (r.carbs_g || 0), 0);
  return foldCard("fuel-today", `<h2>Fuel today</h2><div class="big">${rng(d.carbs)} g carbs</div>${zbar(d.level)}
    <div class="tier" style="color:${zone(d.level)}">${esc(d.tier)} day · ${d.protein} g protein${eaten ? ` · ${eaten} g eaten` : ""}</div>`,
    `${eatenHtml(d)}${energyHtml(d)}<p class="small muted" style="margin:8px 0 0">Fat: about ${d.fat} g across the day.</p>${fuel}<h3>Today's meals</h3>${mealsHtml(d)}`);
}

const WALKS = new Set(["Walk", "Hike"]);

// Activity icons in the logo's style: solid square blocks, right angles only.
const ICON_ROWS = {
  ride: ["..###.##.", "...#..#..", ".#######.", "###...###", "#.#...#.#", "###...###"],
  run: ["....##..", "....##..", ".#####..", ".#..##.#", "....####", "...##...", "..##.###", ".##....#"],
  walk: ["...##...", "...##...", "..####..", ".#.##.#.", "...##...", "..#..#..", "..#..#..", ".##..##."],
  gym: ["#.....#", "##...##", "#######", "##...##", "#.....#"],
  race: ["#.##.##", "##.##.#", "#.##.##", "#......", "#......", "#......"],
  rest: [".###", "##..", "##..", "##..", ".###"],
  other: ["#####", "#....", "#####", "....#", "##.##", "#...#", "#.###"],
};
const ICONS = Object.fromEntries(Object.entries(ICON_ROWS).map(([k, rows]) => {
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  const rects = rows.flatMap((r, y) => [...r].map((c, x) => (c === "#" ? `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>` : ""))).join("");
  return [k, `<svg viewBox="-0.5 -0.5 ${w + 1} ${h + 1}" fill="currentColor" aria-hidden="true">${rects}</svg>`];
}));
function iconKey(kind = "", race = false) {
  if (race) return "race";
  if (/Ride|Bike|Cycl/i.test(kind)) return "ride";
  if (/Run/i.test(kind)) return "run";
  if (/Walk|Hike/i.test(kind)) return "walk";
  if (/Weight|Strength|Workout|Crossfit/i.test(kind)) return "gym";
  return "other";
}
const icon = (key) => `<span class="ai">${ICONS[key] || ICONS.other}</span>`;
const isGym = (kind) => iconKey(kind) === "gym";
const km = (m) => (m / 1000).toFixed(m >= 10000 ? 0 : 1);
const thousands = (n) => Math.round(n).toLocaleString("en-GB");

function refuelDue(rec) {
  // Only straight after a ride: judged by the phone's clock, so an old report can't show a stale refuel.
  if (!rec || !rec.ends_at) return false;
  const since = Date.now() - Date.parse(rec.ends_at);
  return since > -3600e3 && since <= (report.refuel_window_hours || 2) * 3600e3;
}

const stag = (done) => `<span class="stag ${done ? "done" : "plan"}">${done ? "✓ COMPLETED" : "PLANNED"}</span>`;

function actLine(a, tag = "") {
  const bits = [dur(a.mins / 60)];
  if (a.distance_m) bits.push(`${km(a.distance_m)} km`);
  if (a.load) bits.push(`load ${Math.round(a.load)}`);
  return `<tr class="tap" data-act="${esc(a.id)}"><td><div class="srow">${icon(iconKey(a.type))}<div>${esc(a.name || a.type)}<br>
    <span class="small">${esc(a.type || "")}${a.start ? ` · ${a.start.slice(11, 16)}` : ""}</span>${tag ? `<br>${tag}` : ""}</div></div></td><td>${bits.join(" · ")}<br><span class="chev">Feedback ›</span></td></tr>`;
}

function todaySoFar() {
  const today = isoToday();
  const acts = (report.activities || []).filter((a) => a.date === today);
  const steps = (report.wellness || []).find((w) => w.id === today)?.steps;
  const anySteps = (report.wellness || []).some((w) => w.steps != null);
  // Today's planned sessions: done if an activity of the same kind (ride, run, gym…) is logged today, else still planned.
  const planned = (report.recent_plan || []).filter((p) => p.day === today);
  const left = [...acts], open = [];
  for (const p of planned) {
    const i = left.findIndex((a) => iconKey(a.type) === iconKey(p.kind));
    if (i >= 0) left.splice(i, 1); else open.push(p);
  }
  if (!acts.length && !planned.length && steps == null && report.generated_at.slice(0, 10) !== today) return "";
  let html = `<div class="card"><h2>${planned.length ? "Today's plan" : "Today so far"}</h2>`;
  const planRow = (p) => `<tr${isGym(p.kind) ? ` class="tap" data-gym="1"` : ""}><td><div class="srow">${icon(iconKey(p.kind, p.race))}<div>${esc(p.name)}<br>
    <span class="small">${p.start ? `${String(p.start).slice(11, 16)} · ` : ""}${dur(p.hours || 0)}${p.load ? ` · load ${Math.round(p.load)}` : ""}</span><br>${stag(false)}</div></div></td><td>${isGym(p.kind) ? `<span class="chev">Exercises ›</span>` : ""}</td></tr>`;
  html += acts.length || open.length ? `<table class="rows">${open.map(planRow).join("")}${acts.map((a) => actLine(a, stag(true))).join("")}</table>`
    : `<p class="small muted" style="margin:0">Nothing planned or logged yet today.</p>`;
  // Today's call changes the plan: say how, next to the sessions it applies to.
  const r = report.readiness;
  if (open.length && r && r.verdict !== "Execute") {
    html += `<div class="nag" style="margin-top:10px"><b>${esc(r.verdict)}:</b> ${esc(r.advice)}</div>`;
  }
  if (steps != null) html += `<div class="stat" style="margin-top:10px"><div><span class="small muted">Steps</span><b>${thousands(steps)}</b></div></div>`;
  const hidden = (report.hidden_by_strava || []).filter((d) => d === today).length;
  if (hidden) html += `<p class="small muted">${hidden} activit${hidden > 1 ? "ies" : "y"} today came in via Strava, so intervals.icu can't share ${hidden > 1 ? "them" : "it"} with this app. Import activities from Garmin in intervals.icu (Settings → Garmin) instead.</p>`;
  if (!anySteps) html += `<p class="small muted">Steps and walks appear once your Garmin syncs straight to intervals.icu (Settings → Connections there).</p>`;
  return html + `</div>`;
}

// ---------- hero panels: today's call, road to Leuven ----------
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

function spark(values, { w = 120, h = 34 } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const ys = pts.map(([, v]) => v), lo = Math.min(...ys), hi = Math.max(...ys), n = values.length - 1;
  const X = (i) => 2 + (i / n) * (w - 6), Y = (v) => h - 4 - ((v - lo) / ((hi - lo) || 1)) * (h - 8);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const [li, lv] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/><rect x="${X(li) - 3}" y="${Y(lv) - 3}" width="6" height="6"/></svg>`;
}

// The coach's note and rule checks behind today's call, one tap away from it.
function whyButton() {
  if (!report.note && !report.flags.length) return "";
  const warns = report.flags.filter((f) => f.level === "warn").length;
  return `<button class="why-btn" id="why-call">Coach's reasoning${warns ? ` · ${warns} alert${warns > 1 ? "s" : ""}` : ""} ›</button>`;
}

function openWhy() {
  openSheet(`<h2>Why ${esc(report.readiness?.verdict || "today's call")}</h2>
    ${report.note ? noteHtml(report.note, "COACH'S NOTE") : ""}
    ${report.flags.length ? `<h3>Checks</h3>${flagsHtml(report.flags)}` : ""}`);
}

function readinessHero() {
  const r = report.readiness, k = report.consistency, g = report.goal;
  if (!r) return "";
  const order = ["Execute", "Modify", "Recover"];
  const lamp = order.map((v) => `<span class="lamp ${v === r.verdict ? `on ${v.toLowerCase()}` : ""}"><i></i>${v[0]}</span>`).join("");
  const sig = r.signals.map((x) => `<div class="sig ${x.status}"><i></i><span><b>${esc(x.label)}</b> ${esc(x.value)}${x.baseline != null ? ` <em>norm ${esc(x.baseline)}</em>` : ""}<br><small>${esc(x.text)}</small></span></div>`).join("");
  let ff = "";
  if (r.ctl != null && r.atl != null) {
    const max = Math.max(r.ctl, r.atl, 1) * 1.15;
    ff = `<div class="ff"><div class="ffrow"><span>Fitness</span><div class="track"><b style="width:${(r.ctl / max * 100).toFixed(0)}%"></b></div><em>${Math.round(r.ctl)}</em></div>
      <div class="ffrow"><span>Fatigue</span><div class="track"><b class="fat" style="width:${(r.atl / max * 100).toFixed(0)}%"></b></div><em>${Math.round(r.atl)}</em></div>
      <div class="ffform">Form <b>${signed(r.ctl - r.atl, 0)}</b>${k ? ` · load 7 d <b>${k.load_7d}</b> vs 4-wk avg <b>${k.load_28d_week_avg}</b>` : ""}</div></div>`;
  }
  let cons = "";
  if (k) {
    const top = Math.max(...k.weeks.map((x) => x.hours), 1);
    const avg = k.weeks.reduce((t, x) => t + x.hours, 0) / k.weeks.length;
    const pct = (h) => (h / top * 100).toFixed(0);
    cons = `<div class="cons"><div class="hlabel">CONSISTENCY · 6 WEEKS</div>
      <div class="cplot">${k.weeks.map((x, i) =>
        `<div class="cbar${i === k.weeks.length - 1 ? " now" : ""}" title="${dur(x.hours)} · ${x.sessions} sessions"><b style="height:${Math.max(6, pct(x.hours))}%"></b></div>`).join("")}
        ${avg > 0 ? `<div class="cavg" style="bottom:${pct(avg)}%"><span>avg ${dur(avg)}</span></div>` : ""}</div>
      <div class="cnums">${k.weeks.map((x) => `<span>${x.sessions}</span>`).join("")}</div>
      <div class="csub">${k.plan_days ? `Plan this week: <b>${k.plan_days_done}/${k.plan_days}</b> days done · ` : ""}bars = hours, line = 6-week average, number = sessions</div></div>`;
  }
  const chip = g ? `<button class="leuven-chip" id="to-leuven">${esc((g.event_short || "Goal").toUpperCase())} · ${g.weeks} WK</button>` : "";
  return `<section class="hero">
    <div class="hhead"><span class="hlabel">TODAY'S CALL</span>${chip}</div>
    <div class="verdict"><span class="vword ${r.verdict.toLowerCase()}">${esc(r.verdict.toUpperCase())}</span><span class="lamps">${lamp}</span></div>
    <p class="advice">${esc(r.advice)}${r.enough ? "" : " (Few signals today – sync your watch or check in.)"}</p>
    ${whyButton()}
    ${ff}<div class="sigs">${sig}</div>${cons}</section>`;
}

function leuvenHero() {
  const g = report.goal;
  if (!g) return "";
  const total = Math.max(1, Math.round((Date.parse(g.event_date) - Date.parse(g.plan_start)) / 6048e5));
  const left = Math.max(0, g.weeks), done = Math.max(0, total - left);
  const blocks = Array.from({ length: total }, (_, i) => `<i class="${i < done ? "done" : ""}"></i>`).join("");
  const wk = g.weeks_data || [];
  const tile = (label, latest, unit, change, series, better, sub = "") => {
    if (change != null) change = unit.trim() === "W" ? Math.round(change) : Math.round(change * 10) / 10;
    const ch = change == null ? "" : `<span class="delta ${(change > 0) === (better === "up") && change !== 0 ? "good" : change === 0 ? "" : "bad"}">${change > 0 ? "▲" : change < 0 ? "▼" : "■"} ${Math.abs(change)}${unit}</span>`;
    return `<div class="gtile"><span class="glabel">${label}</span><b>${latest ?? "–"}${latest != null ? `<small>${unit}</small>` : ""}</b>${ch}${spark(series)}${sub ? `<small class="gsub">${sub}</small>` : ""}</div>`;
  };
  const kg = g.weight.latest;
  const ftpWkg = g.eftp.latest && kg ? `${(g.eftp.latest / kg).toFixed(2)} W/kg · set FTP ${g.set_ftp ?? "–"} W` : "";
  const ttLatest = g.tt.latest != null ? mmss(g.tt.latest) : null;
  const ttChange = g.tt.change != null ? Math.round(g.tt.change) : null;
  return `<section class="hero leuven">
    <div class="hhead"><span class="hlabel">ROAD TO ${esc((g.event_short || g.event || "the goal").toUpperCase())}</span><span class="hdate">${esc(dayName(g.event_date))} ${String(g.event_date).slice(0, 4)}${g.date_confirmed ? "" : " · date TBC"}</span></div>
    <div class="count"><b>${left}</b><span>WEEKS<br><small>${g.days} days${g.event_detail ? ` · ${esc(g.event_detail)}` : ""}</small></span></div>
    <div class="wblocks" aria-label="${done} of ${total} weeks gone">${blocks}</div>
    <div class="gtiles">
      ${tile("THRESHOLD (eFTP)", g.eftp.latest, " W", g.eftp.change, wk.map((x) => x.eftp), "up", ftpWkg)}
      ${tile("BEST 20 MIN", g.p20.latest, " W", g.p20.change, wk.map((x) => x.p20_4wk), "up", kickrPct() ? "4-week best, Favero scale" : "4-week best")}
      ${tile("WEIGHT", kg, " kg", g.weight.change, wk.map((x) => x.weight), g.weight_goal === "gain" ? "up" : "down", `target ${g.target_weight} kg`)}
      ${g.show_tt === false ? "" : `<div class="gtile"><span class="glabel">${g.tt_distance_km} KM TT ESTIMATE</span><b>${ttLatest ?? "–"}</b>${ttChange != null ? `<span class="delta ${ttChange < 0 ? "good" : ttChange > 0 ? "bad" : ""}">${ttChange < 0 ? "▼" : ttChange > 0 ? "▲" : "■"} ${Math.abs(ttChange)} s</span>` : ""}${spark(wk.map((x) => x.tt_secs))}<small class="gsub">flat, still air, from 20-min power</small></div>`}
      ${lrTile(g, wk)}
    </div>
    <p class="gnote">Changes compare the last 4 weeks with the 4 before.${kickrPct() ? ` KICKR efforts (Zwift rides without the pedals' left/right data) are corrected −${kickrPct()}% to the Favero scale.` : ""}</p></section>`;
}

function lrTile(g, wk) {
  // Left share of power by week, against his usual split. Shown as a trend to watch, never as a 50/50 target.
  const lp = g.left_pct || {}, base = g.lr_baseline_left, left = lp.latest;
  if (left == null) return "";
  const ch = lp.change != null ? Math.round(lp.change * 10) / 10 : null;
  const delta = ch == null ? "" : `<span class="delta">${ch > 0 ? "▲" : ch < 0 ? "▼" : "■"} ${Math.abs(ch)} pts left</span>`;
  return `<div class="gtile wide"><span class="glabel">LEFT / RIGHT BALANCE</span>
    <div class="lrrow"><b>${Math.round(left)}<small> / ${Math.round(100 - left)}</small></b>${delta}</div>
    <div class="lrbar" aria-label="Left ${left}%, usual ${base}%"><b style="width:${left}%"></b>${base != null ? `<i style="left:${base}%"></i>` : ""}</div>
    ${spark(wk.map((x) => x.left_pct))}
    <small class="gsub">left % of power, by week${base != null ? ` · your usual ${base}/${100 - base} (marker)` : ""} · a trend to watch, not a target</small></div>`;
}

function checkedInToday() {
  const today = isoToday();
  return store.get("checkinDate", "") === today || (report?.checkins || []).some((c) => c.date === today);
}
function checkinPrompt() {
  if (checkedInToday()) return "";
  return `<div class="card prompt"><h2>How are you today?</h2><p class="small muted" style="margin:0 0 8px">A 20-second check-in helps the coach spot fatigue early.</p>
    <div class="label">ENERGY</div><div class="scale" id="quick-energy">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}">${n}</button>`).join("")}</div>
    <div class="scale-ends"><span>exhausted</span><span>great</span></div></div>`;
}

function renderToday() {
  const v = $("#view-today");
  if (!report) { v.innerHTML = emptyState(); return; }
  const tm = report.days[0];
  const body = report.body;
  let html = "";

  const rec = report.recovery;
  if (refuelDue(rec)) {
    const a = rec.activity;
    const steps = [["In the next 30–60 min", `${rng(rec.carbs)} g carbs + ${rng(rec.protein)} g protein`]];
    if (rec.follow_up) steps.push(["Then each hour for 2–3 h", `~${rec.follow_up} g carbs`]);
    steps.push(["Fluids", "~150% of weight lost; salt the meal"]);
    html += `<div class="card"><h2>Refuel now</h2><div class="small muted">${esc(a.name)} · ${dur(a.hours)}${a.load ? ` · load ${Math.round(a.load)}` : ""}${rec.kcal ? ` · ~${Math.round(rec.kcal)} kcal` : ""}</div>
      <div class="big">${rng(rec.carbs)} g carbs</div><div class="big" style="font-size:22px">${rng(rec.protein)} g protein</div>${rows(steps)}
      <p class="small muted">${rec.quick ? "Fast refuel: big session or a demanding day tomorrow." : "Normal refuel: a regular meal within the hour covers it."}</p></div>`;
  }

  html = readinessHero() + checkinPrompt() + html;
  html += todaySoFar();
  html += todayFuel();

  html += foldCard("fuel-tomorrow", `<h2>Tomorrow · ${dayName(tm.day)}</h2><div class="big">${rng(tm.carbs)} g carbs</div>${zbar(tm.level)}
    <div class="tier" style="color:${zone(tm.level)}">${esc(tm.tier)} day${tm.hours ? ` · ${dur(tm.hours)} planned, load ${Math.round(tm.load)}` : tm.race ? " · race" : " · nothing planned"}</div>`,
    dayDetail(tm));

  if (!report.readiness && (report.flags.length || report.note)) {  // no hero to hang the button on
    html += `<div class="card"><h2>Coach</h2>${flagsHtml(report.flags)}${report.note ? noteHtml(report.note, "COACH'S NOTE") : ""}</div>`;
  }

  const b = [["Weight", body.weighed_on ? `${body.weight.toFixed(1)} kg (${dayName(body.weighed_on)})` : `${body.weight.toFixed(1)} kg (default)`]];
  if (body.trend != null) b.push(["7-day change", `${signed(body.trend)} kg`]);
  if (body.form != null) b.push(["Fitness / fatigue / form", `${Math.round(body.ctl)} / ${Math.round(body.atl)} / ${signed(body.form, 0)}`]);
  html += `<div class="card"><h2>Body</h2>${body.stale ? `<div class="nag">Time to weigh in – Log → Weight.</div>` : ""}${rows(b)}</div>`;
  v.innerHTML = html;
  // Cards alternate brand green and white down the page, starting from the green hero.
  [...v.children].forEach((el, i) => { if (!el.classList.contains("hero")) el.classList.toggle("dark", i % 2 === 0); });
  $$("details[data-fold]", v).forEach((d) => d.addEventListener("toggle", () => store.set(`fold:${d.dataset.fold}`, d.open)));
  $("#to-leuven", v)?.addEventListener("click", () => show("trends"));
  $("#why-call", v)?.addEventListener("click", openWhy);
  $$("#quick-energy button", v).forEach((b) => b.addEventListener("click", () => {
    pendingEnergy = b.dataset.v;
    show("log");
    $("#f-checkin")?.scrollIntoView({ block: "start" });
  }));
}

function shoppingCard() {
  const mp = report.meal_plan;
  if (!mp?.shopping?.length || !mp.shop_day || mp.shop_day < isoToday()) return "";
  const key = `shop:${mp.generated}`, ticked = new Set(store.get(key, []));
  const groups = {};
  mp.shopping.forEach((it, i) => (groups[it.section] ||= []).push([it, i]));
  const covers = mp.covers || [];
  const span = covers.length ? `${dayName(covers[0]).split(" ")[0]}–${dayName(covers[covers.length - 1]).split(" ")[0]}` : "";
  return `<div class="card shop"><h2>🛒 Shopping list · ${esc(dayName(mp.shop_day))}</h2>
    <p class="small muted" style="margin:0 0 6px">For ${esc(span)}. Staples you keep in aren't listed.</p>
    ${Object.entries(groups).map(([sec, items]) => `<div class="label" style="margin-top:10px">${esc(sec.toUpperCase())}</div>
      ${items.map(([it, i]) => `<label class="tick"><input type="checkbox" data-shop="${i}"${ticked.has(i) ? " checked" : ""}>
        <span>${esc(it.item)} <em>${esc(it.quantity)}</em></span></label>`).join("")}`).join("")}
    ${(mp.tips || []).length ? `<div class="note" style="margin-top:12px"><div class="label">PREP</div>${mp.tips.map((t) => `<p>${esc(t)}</p>`).join("")}</div>` : ""}</div>`;
}

function renderWeek() {
  const v = $("#view-week");
  if (!report) { v.innerHTML = emptyState(); return; }
  const items = report.days.map((d, i) => {
    const what = [...d.sessions.map((s) => esc(s.name)), ...(d.notes || []).map((n) => `📌 ${esc(n.name)}`)].join(", ") || "Rest";
    const detail = d.hours ? `${dur(d.hours)} · ${Math.round(d.load)}` : d.race ? "Race" : "";
    return `<li><button class="day${d.level >= 3 ? " hard" : ""}" data-day="${i}" aria-expanded="${openDays.has(i)}">
      <span class="pill" style="background:${zone(d.level)}"></span>${icon(d.sessions.length ? iconKey(d.sessions[0].kind, d.race) : "rest")}
      <span class="what">${dayName(d.day)}<span>${what}</span></span>
      <span class="num">${detail}<b>${rng(d.carbs)} g</b></span></button>
      ${openDays.has(i) ? `<div class="daydetail">${dayDetail(d)}</div>` : ""}</li>`;
  }).join("");
  let html = shoppingCard() + `<div class="card"><h2>Next ${report.days.length} days</h2><p class="small muted" style="margin:0 0 4px">Tap a day for its fuelling plan.</p><ul class="days">${items}</ul></div>`;

  if (weeklyData) {
    const s = weeklyData.summary;
    const marks = { done: "✓", partial: "~", missed: "✗", extra: "+", rest: "" };
    const days = s.days.map((r) => {
      const planned = r.planned.map((x) => x.name).join(", ");
      const did = r.done.map((x) => `<span class="tap link" data-act="${esc(x.id)}">${esc(x.name)}</span>`).join(", ");
      const what = did || (planned ? `Missed: ${planned}` : "Rest");
      const plainDid = r.done.map((x) => x.name).join(", ");
      return `<tr><td><span class="mark ${r.status}">${marks[r.status]}</span>${dayName(r.day)}<br><span class="small">${did || esc(what)}${planned && did && planned !== plainDid ? `<br>Planned: ${esc(planned)}` : ""}</span></td>
        <td>${r.done.length ? `${dur(r.hours)} · ${Math.round(r.load)}` : ""}</td></tr>`;
    }).join("");
    const g = [];
    if (s.planned_days) g.push(["Planned days completed", `${s.planned_days_done} / ${s.planned_days}`]);
    g.push(["Hard sessions", `${s.hard_done.length} (plan: ${report.goals.hard_sessions_per_week})`]);
    g.push(["Weight", `${s.weight.toFixed(1)} kg${s.weight_trend != null ? ` (${signed(s.weight_trend)} kg/wk)` : ""}`]);
    if (s.ctl != null) g.push(["Fitness", `${Math.round(s.ctl)}${s.ctl_change != null ? ` (${signed(s.ctl_change, 0)})` : ""}`]);
    html += `<div class="card"><h2>Last week · ${shortDate(s.start)} – ${shortDate(s.end)}</h2>
      <div class="big" style="font-size:24px">${dur(s.done_hours)} · load ${Math.round(s.done_load)}</div>
      <div class="small muted">${s.planned_hours ? `planned ${dur(s.planned_hours)} · ${Math.round(s.planned_load)} · ` : ""}week before ${dur(s.prev_hours)}</div>
      <table class="rows" style="margin-top:8px">${days}</table><h3>Goals</h3>${rows(g)}
      ${weeklyData.note ? noteHtml(weeklyData.note, "COACH'S REVIEW") : ""}</div>`;
  } else {
    html += `<div class="card small muted">The weekly review appears here after Sunday's email.</div>`;
  }
  v.innerHTML = html;
  $$("[data-shop]", v).forEach((cb) => cb.addEventListener("change", () => {
    const key = `shop:${report.meal_plan.generated}`;
    store.set(key, $$("[data-shop]", v).filter((x) => x.checked).map((x) => +x.dataset.shop));
  }));
  $$(".day", v).forEach((btn) => btn.addEventListener("click", () => {
    const i = +btn.dataset.day;
    openDays.has(i) ? openDays.delete(i) : openDays.add(i);
    renderWeek();
  }));
}

// ---------- charts (inline SVG, single axis, crosshair tooltip) ----------
function chart(host, series, { ref = null, digits = 0, unit = "" } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) { host.innerHTML = `<p class="small muted">Not enough data yet.</p>`; return; }
  const W = Math.max(280, host.clientWidth || 320), H = 150;
  const pad = { l: 34, r: series.length > 1 ? 52 : 12, t: 10, b: 20 };
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.y).concat(ref ? [ref.y] : []);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x0 === x1) x1 = x0 + 864e5;
  const span = (y1 - y0) || Math.abs(y1) * 0.1 || 1;
  y0 -= span * 0.15; y1 += span * 0.15;
  const X = (t) => pad.l + ((t - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15];
  const fmt = (y) => Number(y).toFixed(digits);
  let svg = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("");
  svg += `<text class="axis" x="${pad.l}" y="${H - 4}">${shortDate(new Date(x0).toISOString())}</text><text class="axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${shortDate(new Date(x1).toISOString())}</text>`;
  if (ref) svg += `<line class="ref" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(ref.y)}" y2="${Y(ref.y)}"/><text class="reflabel" x="${W - pad.r}" y="${Y(ref.y) - 4}" text-anchor="end">${esc(ref.label)}</text>`;
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    const last = s.points[s.points.length - 1];
    svg += `<path class="line" d="${d}" stroke="${s.color}"/>`;
    svg += s.points.length <= 12 ? s.points.map((p) => `<circle class="dot" cx="${X(p.t)}" cy="${Y(p.y)}" r="4" fill="${s.color}"/>`).join("")
      : `<circle class="dot" cx="${X(last.t)}" cy="${Y(last.y)}" r="4" fill="${s.color}"/>`;
    if (series.length > 1) svg += `<text class="dlabel" x="${X(last.t) + 8}" y="${Y(last.y) + 4}">${esc(s.name)}</text>`;
  }
  svg += `<g class="hover" visibility="hidden"><line class="cross" y1="${pad.t}" y2="${H - pad.b}"/>${series.map((s) => `<circle class="dot" r="5" fill="${s.color}"/>`).join("")}</g>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))} chart">${svg}</svg><div class="tip" hidden></div>`
    + (series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>` : "");

  const el = $("svg", host), g = $(".hover", host), tip = $(".tip", host);
  const allT = [...new Set(xs)].sort((a, b) => a - b);
  const move = (ev) => {
    const r = el.getBoundingClientRect();
    const t = x0 + ((ev.clientX - r.left) / r.width * W - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
    const near = allT.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    const vals = series.map((s) => s.points.find((p) => p.t === near));
    $("line", g).setAttribute("x1", X(near)); $("line", g).setAttribute("x2", X(near));
    $$("circle", g).forEach((c, i) => {
      const p = vals[i];
      c.setAttribute("visibility", p ? "visible" : "hidden");
      if (p) { c.setAttribute("cx", X(p.t)); c.setAttribute("cy", Y(p.y)); }
    });
    g.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${shortDate(new Date(near).toISOString())}: ` + series.map((s, i) => (vals[i] ? `${series.length > 1 ? s.name + " " : ""}${fmt(vals[i].y)}${unit}` : null)).filter(Boolean).join(" · ");
    tip.style.left = `${Math.min(Math.max(X(near) / W * r.width, 60), r.width - 60)}px`;
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerdown", move);
  el.addEventListener("pointerleave", () => { g.setAttribute("visibility", "hidden"); tip.hidden = true; });
}
function walkingCard() {
  const today = Date.parse(isoToday() + "T12:00:00"), day = 864e5;
  const walks = (report.activities || []).filter((a) => WALKS.has(a.type));
  const inWeek = (a, from, to) => { const t = Date.parse(a.date + "T12:00:00"); return t > today - to * day && t <= today - from * day; };
  const sum = (list, k) => list.reduce((n, a) => n + (a[k] || 0), 0);
  const wk = walks.filter((a) => inWeek(a, 0, 7)), prev = walks.filter((a) => inWeek(a, 7, 14));
  const stepRows = (report.wellness || []).filter((r) => r.steps != null);
  const last7 = stepRows.filter((r) => Date.parse(r.id + "T12:00:00") > today - 7 * day);
  const avg = last7.length ? sum(last7, "steps") / last7.length : null;
  return `<div class="card"><h2>Walking &amp; steps</h2><div class="stat">
      <div><span class="small muted">Steps, 7-day avg</span><b>${avg != null ? thousands(avg) : "–"}</b></div>
      <div><span class="small muted">Walks this week</span><b>${wk.length ? `${dur(sum(wk, "mins") / 60)}` : "–"}</b>
        <span class="small muted">${wk.length ? `${wk.length} walk${wk.length > 1 ? "s" : ""}${sum(wk, "distance_m") ? ` · ${km(sum(wk, "distance_m"))} km` : ""}` : ""}</span></div></div>
    ${prev.length ? `<p class="small muted" style="margin:8px 0 0">Walking time ${signed(sum(wk, "mins") - sum(prev, "mins"), 0)} min vs the week before.</p>` : ""}
    <h3>Daily steps</h3><div class="chart" id="c-steps"></div>${stepRows.length ? tableHtml([{ name: "Steps", points: pointsOf(stepRows, "steps") }]) : ""}
    ${stepRows.length ? "" : `<p class="small muted">No step data yet. Steps come from your Garmin via intervals.icu wellness – connect Garmin directly in intervals.icu (Settings → Connections).</p>`}</div>`;
}

function bars(host, points, { unit = "" } = {}) {
  if (!points.length) { host.innerHTML = ""; return; }
  const W = Math.max(280, host.clientWidth || 320), H = 130, pad = { l: 34, r: 8, t: 10, b: 20 };
  const max = Math.max(...points.map((p) => p.y)) * 1.1 || 1;
  const n = points.length, slot = (W - pad.l - pad.r) / n, bw = Math.max(2, slot - 2);
  const Y = (y) => pad.t + (1 - y / max) * (H - pad.t - pad.b), base = Y(0);
  const short = (y) => (y >= 1000 ? `${Math.round(y / 1000)}k` : `${Math.round(y)}`);
  let svg = [max / 2, max / 1.1].map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${short(t)}</text>`).join("");
  svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>`;
  svg += points.map((p, i) => {
    const x = pad.l + i * slot + 1, y = Y(p.y), h = Math.max(base - y, 1), r = Math.min(2, bw / 2, h);
    return `<path data-i="${i}" fill="var(--s1)" d="M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z"/>`;
  }).join("");
  svg += `<text class="axis" x="${pad.l}" y="${H - 4}">${shortDate(new Date(points[0].t).toISOString())}</text><text class="axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${shortDate(new Date(points[n - 1].t).toISOString())}</text>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily steps chart">${svg}</svg><div class="tip" hidden></div>`;
  const el = $("svg", host), tip = $(".tip", host);
  const move = (ev) => {
    const r = el.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width * W - pad.l) / slot)));
    $$("path", el).forEach((b) => b.setAttribute("opacity", +b.dataset.i === i ? "1" : "0.55"));
    tip.hidden = false;
    tip.textContent = `${shortDate(new Date(points[i].t).toISOString())}: ${thousands(points[i].y)}${unit}`;
    tip.style.left = `${Math.min(Math.max((pad.l + (i + 0.5) * slot) / W * r.width, 60), r.width - 60)}px`;
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerdown", move);
  el.addEventListener("pointerleave", () => { $$("path", el).forEach((b) => b.removeAttribute("opacity")); tip.hidden = true; });
}

function tableHtml(series, digits = 0) {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => b - a);
  return `<details class="table"><summary>Show as table</summary><table><tr><th>Date</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>${dates.map((t) =>
    `<tr><td>${shortDate(new Date(t).toISOString())}</td>${series.map((s) => { const p = s.points.find((q) => q.t === t); return `<td>${p ? Number(p.y).toFixed(digits) : ""}</td>`; }).join("")}</tr>`).join("")}</table></details>`;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pointsOf = (rows_, key, dateKey = "id") => rows_.filter((r) => r[key] != null).map((r) => ({ t: Date.parse(r[dateKey].slice(0, 10) + "T12:00:00"), y: r[key] }));

function renderTrends() {
  const v = $("#view-trends");
  if (!report) { v.innerHTML = emptyState(); return; }
  const w = report.wellness || [];
  const charts = [
    { id: "c-weight", title: "Weight (kg)", series: [{ name: "Weight", color: css("--s1"), points: pointsOf(w, "weight") }], digits: 1, unit: " kg",
      ref: { y: report.goals.target_weight_kg, label: `Target ${report.goals.target_weight_kg} kg` } },
    { id: "c-fit", title: "Fitness & fatigue", series: [{ name: "Fitness", color: css("--s1"), points: pointsOf(w, "ctl") }, { name: "Fatigue", color: css("--s2"), points: pointsOf(w, "atl") }] },
    { id: "c-rhr", title: "Resting HR (bpm)", series: [{ name: "Resting HR", color: css("--s1"), points: pointsOf(w, "restingHR") }], unit: " bpm" },
    { id: "c-hrv", title: "HRV", series: [{ name: "HRV", color: css("--s1"), points: pointsOf(w, "hrv") }] },
    ...(profile().medical ? [{ id: "c-hb", title: "Haemoglobin (g/L)", series: [{ name: "Hb", color: css("--s1"), points: pointsOf(report.labs || [], "hb", "date") }], unit: " g/L" }] : []),
  ];
  const eff = report.efficiency;
  let html = leuvenHero() + walkingCard();
  html += `<div class="card"><h2>Watts per heartbeat</h2>${eff
    ? `<div class="stat"><div><span class="small muted">Last 14 days vs 4 weeks before</span><b>${signed(eff.change_pct, 0)}%</b></div></div>
       <p class="small muted">Steady rides${kickrPct() ? ", KICKR corrected to Favero (rides with left/right data are already Favero)" : ""}. A drop means the same power costs more heart rate – fatigue, illness, heat, or lower Hb.</p>`
    : `<p class="small muted">Needs heart rate on at least 2 steady rides in the last 14 days and 3 in the 4 weeks before.</p>`}</div>`;
  if (profile().medical) html += labsCard();
  html += charts.map((c) => `<div class="card"><h2>${c.title}</h2><div class="chart" id="${c.id}"></div>${c.series[0].points.length ? tableHtml(c.series, c.digits || 0) : ""}</div>`).join("");
  const ci = (report.checkins || []).slice(-7).reverse();
  if (ci.length) {
    html += `<div class="card"><h2>Check-ins</h2><table class="rows">${ci.map((r) => `<tr><td>${dayName(r.date)}</td><td>${["energy", "mood", "legs", "hip", "sleep"]
      .filter((k) => r[k] != null).map((k) => `${k === "hip" ? esc((profile().checkin_part || "hip").toLowerCase()) : k} ${r[k]}`).join(" · ")}${r.notes ? `<br><span class="muted">${esc(r.notes)}</span>` : ""}</td></tr>`).join("")}</table></div>`;
  }
  v.innerHTML = html;
  for (const c of charts) chart($(`#${c.id}`), c.series, c);
  const hb = $("#c-hb")?.closest(".card");
  if (hb && (report.labs || []).length) {
    hb.insertAdjacentHTML("beforeend", `<button class="primary" id="ask-labs" style="width:100%;margin-top:12px">Ask the coach about my results</button>
      <p class="small muted" style="margin:6px 0 0">Uses ${esc(modelName(modelFor("medical")))} for a careful read.</p>`);
    $("#ask-labs").addEventListener("click", () => {
      newChat("medical");
      show("coach");
      const last = report.labs[report.labs.length - 1];
      $("#chat-input").value = `Talk me through my latest blood results (${shortDate(last.date)}) – what they mean for training and fuelling, and what to raise with my haematology team.`;
      sendChat();
    });
  }
  const sp = $("#c-steps");
  if (sp) bars(sp, pointsOf(w, "steps"), { unit: " steps" });
}

// Latest blood results against the lab's ranges, each with its history as a sparkline.
const LAB_GROUPS = [["Blood count", ["hb", "haematocrit", "platelets", "wbc", "neutrophils", "lymphocytes", "rdw"]],
  ["Chemistry", ["ldh", "ast", "alt", "creatinine", "crp", "urate", "albumin", "ferritin"]],
  ["Immunity & hormones", ["igg", "testosterone", "fsh", "lh"]]];

function labsCard() {
  const labs = report.labs || [], M = report.lab_markers || {};
  if (!labs.length) return "";
  const last = labs[labs.length - 1];
  const latestOf = (k) => [...labs].reverse().find((r) => typeof r[k] === "number");
  const row = (k) => {
    const m = M[k], r = latestOf(k);
    if (!m || !r) return "";
    const v = r[k], tag = v > m.hi ? "high" : v < m.lo ? "low" : "";
    const old = r.date !== last.date ? ` <em>${shortDate(r.date)}${r.note ? ` · ${esc(r.note)}` : ""}</em>` : "";
    return `<tr class="${tag}"><td>${esc(m.label)}${old}</td><td><b>${v}</b> <small>${esc(m.unit)}</small>${tag ? ` <span class="ltag">${tag.toUpperCase()}</span>` : ""}<br><small class="muted">range ${m.lo}–${m.hi}</small></td><td class="lspark">${spark(labs.map((x) => (typeof x[k] === "number" ? x[k] : null)), { w: 90, h: 26 })}</td></tr>`;
  };
  const para = [...labs].reverse().find((r) => r.paraprotein);
  return `<div class="card"><h2>Blood results</h2><p class="small muted">Latest ${dayName(last.date)} ${last.date.slice(0, 4)}${last.note ? ` (${esc(last.note)})` : ""} · ${labs.length} results since ${shortDate(labs[0].date)} ${labs[0].date.slice(0, 4)}. Lines show each marker's history.</p>
    ${LAB_GROUPS.map(([name, keys]) => { const r = keys.map(row).join(""); return r ? `<h3>${name}</h3><table class="labs">${r}</table>` : ""; }).join("")}
    ${para ? `<p class="small">Paraprotein: <b>${esc(para.paraprotein)}</b> (${shortDate(para.date)} ${para.date.slice(0, 4)})</p>` : ""}
    <p class="small muted">The lab's ranges, not targets: your team reads these. AST and LDH also rise for 2–3 days after hard or long sessions.</p></div>`;
}

// ---------- coach chat ----------
function coachPrompt() {
  const p = profile(), n = p.name;
  return `You are the coaching engine in ${n}'s training app, now chatting with them in the app. Their brief is below: \
their health background, the expertise you coach with and their coaching rules. Follow its rules strictly, especially: \
consider medical causes first, restraint over load, and no medication or supplement-dosing advice. Never diagnose.${p.medical ? " You \
coach with haematology knowledge but you are not their clinician: interpret blood results and trends, explain what they mean for \
training, and say what to raise with their team. No iron, transfusion or hormone (e.g. TRT) advice." : ""} If they describe red-flag symptoms (chest pain, fainting, severe breathlessness, fever, \
unusual bleeding or bruising), tell them to stop training and get medical advice today.

Answer like a good coach on a phone: direct and specific, using their data below (numbers, days, sessions). Short paragraphs or a \
few bullets, no headings, no greetings. If the data doesn't cover something, say so rather than guessing.

Your tools each show ${n} a card they must tap to confirm, so nothing changes until they do:
- propose_plan_changes edits their intervals.icu calendar for the next 4 weeks: add sessions, change or move them, or remove them. \
Planned sessions are in report.days[].sessions[] with their event id; calendar notes are in report.days[].notes[]. \
Add anything they'll train or race in (a track meet, group ride, parkrun) as a WORKOUT or RACE_A/B/C with a type and your best \
estimate of minutes and load, even if details are TBC, so their fuelling counts it; use NOTE only for reminders that aren't \
training. You can turn an existing note into a session with update (category, type, minutes, load). Use it when they ask for a change or agrees to one you \
suggested. Keep to their rules (${report?.goals?.hard_sessions_per_week ?? 1} hard session(s) a week, rest days as in their brief, back off when recovery markers are poor) and plan around \
events they mention. Say in a line or two what you're changing, then call the tool once with every change.
- remember saves things they tell you that should shape coaching from now on: appointments and date changes, events, injuries, \
symptoms, how sessions felt. To change the date of an existing reminder (report.reminders), reuse its exact text with \
is_reminder true.
- change_meals swaps dishes in their meal plan (report.meal_plan.days, by date and slot) and can add items to the \
shopping list (report.meal_plan.shopping). Keep each swapped dish close to that slot's carbs and protein targets \
(report.days[].meals[]); follow their food preferences (report.food_preferences)${p.food_safety ? " and transplant food-safety choices \
(meat, fish and eggs cooked through; pasteurised dairy)" : ""}.
- set_food_preferences saves what they like, avoid, their usual ride fuel, cooking time, household and other food notes, \
so future meal plans and shopping lists use them. Merge with what's already saved – send the full updated text.
- log_food records food and drink they say they've had (or are having now): one entry per item with your best estimate of carbs, \
protein and kcal, and the time if they give one. Use typical UK portions and label values; if the amount is \
unclear, assume a normal portion and say so in a few words. It shows on their Fuel today card against the day's targets \
(report.today), and the tool result gives the running total – use it to say what's left to eat today.
Never say a change is made or saved until the tool result says so.`;
}

const TOOL_DEFS = [
  {
    name: "propose_plan_changes",
    description: "Propose changes to @'s planned sessions on their intervals.icu calendar (next 4 weeks). They confirm in the app before anything changes.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line describing the change, shown on the confirmation card." },
        changes: {
          type: "array", minItems: 1, maxItems: 10,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "update", "delete"] },
              event_id: { type: "string", description: "Existing event id (update and delete)." },
              date: { type: "string", description: "YYYY-MM-DD. Required for add; for update, moves the session." },
              category: { type: "string", enum: ["WORKOUT", "NOTE", "RACE_A", "RACE_B", "RACE_C"] },
              type: { type: "string", enum: ["Ride", "VirtualRide", "Run", "Walk", "WeightTraining", "Workout", "Swim", "Other"] },
              name: { type: "string" },
              minutes: { type: "integer", minimum: 0, maximum: 600 },
              load: { type: "integer", minimum: 0, maximum: 400, description: "Estimated training load (TSS-like)." },
              description: { type: "string", description: "Session details: targets, HR zone, fuelling." },
            },
            required: ["action"],
          },
        },
      },
      required: ["summary", "changes"],
    },
  },
  {
    name: "change_meals",
    description: "Swap dishes in @'s meal plan and optionally add items to the shopping list. They confirm in the app.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        changes: {
          type: "array", maxItems: 20,
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              slot: { type: "string", description: "Meal slot name as in the plan, e.g. 'Next main meal'." },
              dish: { type: "string" },
              carbs_g: { type: "integer" },
              protein_g: { type: "integer" },
              prep: { type: "string" },
            },
            required: ["date", "slot", "dish", "carbs_g", "protein_g"],
          },
        },
        shopping_add: {
          type: "array", maxItems: 15,
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              quantity: { type: "string" },
              section: { type: "string", enum: ["Fruit & veg", "Bakery", "Meat & fish", "Dairy & eggs", "Cupboard", "Frozen", "Sports nutrition", "Other"] },
            },
            required: ["item", "quantity", "section"],
          },
        },
      },
      required: ["summary", "changes"],
    },
  },
  {
    name: "set_food_preferences",
    description: "Save @'s food preferences for future meal plans and shopping lists. Send the full updated text for each field you change. They confirm in the app.",
    input_schema: {
      type: "object",
      properties: {
        likes: { type: "string" },
        avoid: { type: "string" },
        ride_fuel: { type: "string", description: "Gels, drinks, bars or real food he uses on the bike." },
        cook_minutes: { type: "integer", description: "Typical weekday cooking time." },
        household: { type: "string", description: "Who the shop is for and how to size portions." },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "log_food",
    description: "Log food and drink @ says they've had, with estimated carbs and protein, so the Fuel today card shows it against their targets. They confirm in the app.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array", minItems: 1, maxItems: 10,
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "What and how much, e.g. '500 ml energy drink (40 g carbs/500 ml)'." },
              carbs_g: { type: "integer", minimum: 0, maximum: 500 },
              protein_g: { type: "integer", minimum: 0, maximum: 200 },
              kcal: { type: "integer", minimum: 0, maximum: 3000 },
              time: { type: "string", description: "HH:MM if he said when; otherwise leave out (the app uses now)." },
              date: { type: "string", description: "YYYY-MM-DD, only if not today." },
            },
            required: ["item", "carbs_g", "protein_g", "kcal"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "remember",
    description: "Save facts @ tells you so the daily notes, emails and future chats use them. They confirm in the app.",
    input_schema: {
      type: "object",
      properties: {
        facts: {
          type: "array", minItems: 1, maxItems: 5,
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The fact, in one sentence; for a reminder, its short label." },
              date: { type: "string", description: "YYYY-MM-DD if the fact has a date." },
              is_reminder: { type: "boolean", description: "True for appointments or events to remind him about." },
            },
            required: ["text"],
          },
        },
      },
      required: ["facts"],
    },
  },
];

// The tool definitions with the athlete's name in (copied into each chat when it starts).
const buildTools = () => JSON.parse(JSON.stringify(TOOL_DEFS).replaceAll("@'s", `${profile().name}'s`).replaceAll("@ ", `${profile().name} `));

const suggestions = () => ["Should I race on Friday?", "Here's what I like to eat…", "Swap tomorrow's dinner",
  ...(profile().medical ? ["What should I ask at my haematology clinic?"] : []),
  ...(report?.goals?.target_weight_kg ? [`Am I on track for ${report.goals.target_weight_kg} kg?`] : []), "How should I adjust next week?"];

function coachSystem() {
  // Same text for the chat and session feedback, so they share the prompt cache.
  if (chat && chat.dataAt === (report?.generated_at || null)) return chat.system;
  return `${coachPrompt()}\n\n${athlete || "(athlete.md not loaded)"}\n\n# Latest data from the app (JSON)\n${JSON.stringify({ report, last_week: weeklyData })}`;
}

function newChat(mode = "everyday") {
  // The system prompt and model are fixed for the whole conversation (history is append-only), so new data or a
  // different model means a new chat.
  chat = null;
  chat = { started: new Date().toISOString(), dataAt: report?.generated_at || null, system: coachSystem(), messages: [],
    mode, model: modelFor(mode), tools: buildTools() };
  store.set("chat", chat);
}

function chatText(m) {
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function changeLine(c) {
  const known = report?.days?.flatMap((d) => d.sessions).find((x) => String(x.id) === String(c.event_id));
  const what = c.name || known?.name || "session";
  const when = c.date ? dayName(c.date) : known ? dayName(known.day) : "";
  const verb = { add: "Add", update: c.date && known && c.date !== known.day ? "Move" : "Change", delete: "Remove" }[c.action] || c.action;
  const bits = [c.minutes != null ? dur(c.minutes / 60) : "", c.load != null ? `load ${c.load}` : ""].filter(Boolean).join(" · ");
  return `<li>${icon(iconKey(c.type || known?.kind, /^RACE/.test(c.category || "")))}<span><b>${esc(verb)}</b> ${esc(what)}${when ? ` – ${esc(when)}` : ""}${bits ? `<br><span class="small muted">${esc(bits)}</span>` : ""}${c.description ? `<br><span class="small muted">${esc(c.description)}</span>` : ""}</span></li>`;
}

function toolCard(b) {
  const d = (chat.decisions || {})[b.id];
  const state = d === undefined ? `<div class="actions"><button class="primary" data-tool="${esc(b.id)}" data-ok="1">${{ remember: "Save", set_food_preferences: "Save preferences", change_meals: "Update meal plan", log_food: "Log it" }[b.name] || "Apply to calendar"}</button>
      <button class="secondary" data-tool="${esc(b.id)}" data-ok="0">Not now</button></div>`
    : `<p class="small ${d.ok ? "" : "muted"}" style="margin:8px 0 0">${esc(d.result || (d.ok ? "Applying…" : "Not applied."))}</p>`;
  if (b.name === "set_food_preferences") {
    const labels = { likes: "Likes", avoid: "Avoid", ride_fuel: "Ride fuel", cook_minutes: "Cooking time", household: "Household", notes: "Notes" };
    return `<div class="toolcard"><div class="label">FOOD PREFERENCES</div><ul class="changes">${Object.entries(b.input || {}).map(([k, v]) =>
      `<li><span><b>${esc(labels[k] || k)}</b><br><span class="small">${esc(k === "cook_minutes" ? `${v} min` : v)}</span></span></li>`).join("")}</ul>${state}</div>`;
  }
  if (b.name === "change_meals") {
    return `<div class="toolcard"><div class="label">MEAL CHANGE</div>${b.input.summary ? `<p style="margin:0 0 6px">${esc(b.input.summary)}</p>` : ""}
      <ul class="changes">${(b.input.changes || []).map((c) => `<li><span><b>${esc(dayName(c.date))} · ${esc(c.slot)}</b><br>${esc(c.dish)}
        <br><span class="small muted">${c.carbs_g} g carbs · ${c.protein_g} g protein${c.prep ? ` · ${esc(c.prep)}` : ""}</span></span></li>`).join("")}
      ${(b.input.shopping_add || []).map((i) => `<li><span>🛒 Add <b>${esc(i.item)}</b> <span class="small muted">${esc(i.quantity)}</span></span></li>`).join("")}</ul>${state}</div>`;
  }
  if (b.name === "log_food") {
    const es = b.input.entries || [];
    const tot = (k) => es.reduce((t, e) => t + (e[k] || 0), 0);
    return `<div class="toolcard"><div class="label">FOOD LOG</div><ul class="changes">${es.map((e) =>
      `<li><span><b>${esc(e.item)}</b>${e.time ? ` <span class="small muted">${esc(e.time)}</span>` : ""}<br><span class="small muted">${e.carbs_g} g carbs · ${e.protein_g} g protein${e.kcal ? ` · ${e.kcal} kcal` : ""}</span></span></li>`).join("")}</ul>
      ${es.length > 1 ? `<p class="small" style="margin:6px 0 0">Total ${tot("carbs_g")} g carbs · ${tot("protein_g")} g protein</p>` : ""}${state}</div>`;
  }
  if (b.name === "remember") {
    return `<div class="toolcard"><div class="label">REMEMBER</div><ul class="changes">${(b.input.facts || []).map((f) =>
      `<li><span>${esc(f.text)}${f.date ? ` – ${esc(dayName(f.date))}` : ""}</span></li>`).join("")}</ul>${state}</div>`;
  }
  return `<div class="toolcard"><div class="label">PLAN CHANGE</div>${b.input.summary ? `<p style="margin:0 0 6px">${esc(b.input.summary)}</p>` : ""}
    <ul class="changes">${(b.input.changes || []).map(changeLine).join("")}</ul>${state}</div>`;
}

function msgHtml(m) {
  if (m.role === "user") {
    if (typeof m.content === "string") return `<div class="msg user">${esc(m.content).replace(/\n/g, "<br>")}</div>`;
    const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return text ? `<div class="msg user">${esc(text).replace(/\n/g, "<br>")}</div>` : "";
  }
  const text = chatText(m);
  const tools = (m.content || []).filter((b) => b.type === "tool_use").map(toolCard).join("");
  return (text ? `<div class="msg coach">${mdLite(text)}</div>` : "") + tools;
}

function openTools() {
  // tool_use blocks in the last assistant turn that haven't had a tool_result yet
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.filter((b) => b.type === "tool_use");
}

async function decideTool(id, ok) {
  chat.decisions ||= {};
  chat.decisions[id] = { ok };
  store.set("chat", chat);
  renderCoach();
  const pending = openTools();
  if (pending.some((b) => !chat.decisions[b.id])) return;  // wait until every card is answered
  const accepted = pending.filter((b) => chat.decisions[b.id].ok);
  let outcome = null;
  if (accepted.length) {
    const changes = accepted.filter((b) => b.name === "propose_plan_changes").flatMap((b) => b.input.changes || []);
    const facts = accepted.filter((b) => b.name === "remember").flatMap((b) => b.input.facts || []);
    const mealB = accepted.filter((b) => b.name === "change_meals");
    const mealEdits = mealB.length ? { changes: mealB.flatMap((b) => b.input.changes || []), shopping_add: mealB.flatMap((b) => b.input.shopping_add || []) } : {};
    const prefs = Object.assign({}, ...accepted.filter((b) => b.name === "set_food_preferences").map((b) => b.input || {}));
    const food = accepted.filter((b) => b.name === "log_food").flatMap((b) => foodEntries(b));
    if (food.length) addPendingFood(food);  // shows on Fuel today straight away; the workflow makes it permanent
    outcome = await runWorkflow("coach", { changes: JSON.stringify(changes), memory: JSON.stringify(facts),
      meals: JSON.stringify(mealEdits), prefs: JSON.stringify(prefs), food: JSON.stringify(food) },
      changes.length ? "Calendar update" : mealB.length ? "Meal update" : food.length ? "Food log" : "Saving");
  }
  const results = pending.map((b) => {
    const d = chat.decisions[b.id];
    d.result = !d.ok ? "Not applied." : outcome ? ({ remember: "Saved ✓", set_food_preferences: "Saved ✓", change_meals: "Meal plan updated ✓", log_food: "Logged ✓ – see Fuel today" }[b.name] || "Applied to your calendar ✓")
      : "Couldn't apply – see the message at the top.";
    return { type: "tool_result", tool_use_id: b.id, content: !d.ok ? `${profile().name} chose not to apply this.`
      : outcome ? (b.name === "log_food" ? `Logged. ${eatenSummary()}` : { remember: "Saved.", set_food_preferences: "Saved.", change_meals: "Meal plan updated." }[b.name] || "Applied to the intervals.icu calendar.") : "Failed to apply; nothing changed.",
      ...(d.ok && !outcome ? { is_error: true } : {}) };
  });
  chat.messages.push({ role: "user", content: results });
  store.set("chat", chat);
  await continueChat();
}

function renderCoach() {
  if (!chat) newChat();
  if (!chat.model) chat.model = modelFor(chat.mode);  // chats saved before models were split
  const log = $("#chat-log");
  const stale = report && chat.dataAt !== report.generated_at;
  const who = `${chat.mode === "medical" ? "Blood results · " : ""}${modelName(chat.model)}`;
  let html = `<div class="chat-head"><span class="muted">${esc(who)}<br>${stale ? "New data since this chat started." : chat.dataAt ? `Data from ${dayName(chat.dataAt)} ${chat.dataAt.slice(11, 16)}` : ""}</span>
    <button class="secondary" id="new-chat">New chat</button></div>`;
  if (!settings.anthropic) html += `<div class="msg info">Add your Anthropic API key in Settings (⚙) to ask the coach.</div>`;
  if (!chat.messages.length) html += `<div class="msg info">Ask about training, fuelling, recovery or your goals. The coach sees your brief, this week's plan and your recent data.</div>`;
  html += chat.messages.map(msgHtml).join("");
  if (chat.messages.length >= MAX_CHAT_MESSAGES) html += `<div class="msg info">This chat is getting long – start a new one to keep answers quick.</div>`;
  log.innerHTML = html;
  $("#new-chat").addEventListener("click", () => { newChat(); renderCoach(); });
  $$("[data-tool]", log).forEach((b) => b.addEventListener("click", () => decideTool(b.dataset.tool, b.dataset.ok === "1")));
  $("#chat-suggest").innerHTML = chat.messages.length ? "" : suggestions().map((s) => `<button type="button">${esc(s)}</button>`).join("");
  $$("#chat-suggest button").forEach((b) => b.addEventListener("click", () => {
    const t = b.textContent;
    if (t.endsWith("…")) { $("#chat-input").value = t.slice(0, -1) + " "; $("#chat-input").focus(); return; }  // finish it yourself
    $("#chat-input").value = t;
    sendChat();
  }));
  $("main").scrollTop = $("main").scrollHeight;
}

async function streamClaude(onText, system = chat.system, messages = chat.messages, model = chat.model || modelFor("default"), tools = null) {
  const headers = {
    "x-api-key": settings.anthropic,
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  };
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    output_config: { effort: model === modelFor("medical") ? "high" : "medium" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
    ...(tools ? { tools } : {}),
  };
  if (!model.includes("haiku")) {  // Haiku has no server-side refusal fallback
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const hint = { 401: "API key wrong – check Settings.", 429: "Rate limited – try again in a minute.", 529: "Claude is busy – try again shortly." }[res.status] || "";
    throw new Error(`${hint} ${body.error?.message || `Error ${res.status}`}`.trim());
  }
  // Rebuild the content blocks exactly as sent, so they can be replayed unchanged next turn.
  const blocks = [], jsonParts = {};
  let stop = null, buf = "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  const handle = (ev) => {
    if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block };
    else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index], d = ev.delta;
      if (d.type === "text_delta") { b.text = (b.text || "") + d.text; onText(blocks.filter((x) => x?.type === "text").map((x) => x.text).join("")); }
      else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
      else if (d.type === "input_json_delta") jsonParts[ev.index] = (jsonParts[ev.index] || "") + d.partial_json;
    } else if (ev.type === "message_delta") stop = ev.delta?.stop_reason || stop;
    else if (ev.type === "error") throw new Error(ev.error?.message || "Stream error");
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r/g, "");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) handle(JSON.parse(data));
    }
  }
  if (stop === "refusal") throw new Error("The coach couldn't answer that one – try rephrasing.");
  for (const [i, raw] of Object.entries(jsonParts)) {
    try { blocks[i].input = raw ? JSON.parse(raw) : {}; } catch { throw new Error("The coach's change came through garbled – ask again."); }
  }
  const out = blocks.filter(Boolean);
  out.stop = stop;
  return out;
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text || $("#chat-send").disabled) return;
  if (!settings.anthropic) { status("Add your Anthropic API key in Settings first.", "err"); return; }
  input.value = "";
  autosize();
  // Typing instead of answering a card counts as "not now" for it.
  const open = openTools();
  chat.decisions ||= {};
  open.forEach((b) => { chat.decisions[b.id] ||= { ok: false, result: "Not applied." }; });
  const results = open.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: `${profile().name} replied instead of confirming; not applied.` }));
  chat.messages.push({ role: "user", content: results.length ? [...results, { type: "text", text }] : text });
  const sent = chat.messages.length;
  const ok = await continueChat();
  if (!ok && chat.messages.length === sent) {
    chat.messages.pop();  // nothing was answered: drop the unanswered question (the last turn only)
    input.value = text;
    store.set("chat", chat);
    renderCoach();
  }
}

async function continueChat() {
  renderCoach();
  const bubble = document.createElement("div");
  bubble.className = "msg coach typing";
  bubble.textContent = "Thinking";
  $("#chat-log").appendChild(bubble);
  $("main").scrollTop = $("main").scrollHeight;
  $("#chat-send").disabled = true;
  const onText = (t) => {
    bubble.classList.remove("typing");
    bubble.innerHTML = mdLite(t);
    $("main").scrollTop = $("main").scrollHeight;
  };
  try {
    let blocks;
    try {
      // A chat keeps the tools it started with, so an app update can't invalidate its history.
      blocks = await streamClaude(onText, chat.system, chat.messages, chat.model, chat.tools || buildTools());
    } catch (e) {
      if (!/signature|different conversation/i.test(e.message)) throw e;
      // Saved reasoning no longer matches (e.g. a chat from before an update): drop the thinking blocks,
      // keep every reply's text and tool calls, and retry once with the current tools.
      chat.messages = chat.messages.map((m) => (m.role === "assistant" && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") } : m))
        .map((m) => (m.role === "assistant" && Array.isArray(m.content) && !m.content.length ? { ...m, content: "…" } : m));
      chat.tools = buildTools();
      blocks = await streamClaude(onText, chat.system, chat.messages, chat.model, chat.tools);
    }
    chat.messages.push({ role: "assistant", content: [...blocks] });
    status("");
    return true;
  } catch (e) {
    status(esc(e.message), "err");
    return false;
  } finally {
    store.set("chat", chat);
    $("#chat-send").disabled = false;
    renderCoach();
  }
}
function autosize() {
  const t = $("#chat-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

// ---------- log ----------
function scale(name, label, lo, hi) {
  return `<label>${label}</label><div class="scale" data-scale="${name}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}">${n}</button>`).join("")}</div>
    <div class="scale-ends"><span>${lo}</span><span>${hi}</span></div>`;
}
function renderLog() {
  const v = $("#view-log");
  const today = isoToday();
  v.innerHTML = `
  <div class="card"><h2>Weight</h2><form class="log" id="f-weight">
    <div class="row"><div><label for="w-kg">kg</label><input id="w-kg" type="number" inputmode="decimal" step="0.1" min="30" max="200" required
      placeholder="${report ? report.body.weight.toFixed(1) : "88.0"}"></div>
    <div><label for="w-date">Date</label><input id="w-date" type="date" value="${today}" max="${today}"></div></div>
    <button class="primary" data-busy>Save weight</button></form></div>

  <div class="card"><h2>How do you feel?</h2><form class="log" id="f-checkin">
    ${scale("energy", "Energy", "exhausted", "great")}${scale("mood", "Mood", "low", "great")}
    ${scale("legs", "Legs", "heavy / sore", "fresh")}${profile().checkin_part ? scale("hip", `${esc(profile().checkin_part)} comfort`, "painful", "fine") : ""}${scale("sleep", "Sleep", "poor", "great")}
    <label for="c-notes">Notes</label><textarea id="c-notes" rows="2" maxlength="500" placeholder="Symptoms, how the session felt…"></textarea>
    <button class="primary" data-busy>Save check-in</button></form></div>

  ${profile().medical ? `<div class="card"><h2>Blood results</h2><form class="log" id="f-labs">
    <label for="l-date">Test date</label><input id="l-date" type="date" value="${today}" max="${today}">
    <div class="row"><div><label for="l-hb">Hb (g/L)</label><input id="l-hb" type="number" inputmode="decimal" step="1" placeholder="e.g. 128"></div>
    <div><label for="l-fer">Ferritin (µg/L)</label><input id="l-fer" type="number" inputmode="decimal" step="1"></div></div>
    <div class="row"><div><label for="l-plt">Platelets (×10⁹/L)</label><input id="l-plt" type="number" inputmode="decimal" step="1"></div>
    <div><label for="l-neu">Neutrophils (×10⁹/L)</label><input id="l-neu" type="number" inputmode="decimal" step="0.1"></div></div>
    <button class="primary" data-busy>Save results</button></form></div>` : ""}

  <div class="card"><h2>Update now</h2><p class="small muted">Fetches your latest rides, wellness and calendar from intervals.icu and rebuilds the coach's note (about a minute, no email).</p>
    <button class="primary" id="b-refresh" data-busy style="width:100%">Update now</button></div>`;
  setBusyButtons(busy);
  if (pendingEnergy) {
    $(`[data-scale=energy] button[data-v="${pendingEnergy}"]`, v)?.classList.add("on");
    pendingEnergy = null;
  }

  $$(".scale", v).forEach((sc) => $$("button", sc).forEach((b) => b.addEventListener("click", () => {
    const was = b.classList.contains("on");
    $$("button", sc).forEach((x) => x.classList.remove("on"));
    if (!was) b.classList.add("on");
  })));

  $("#f-weight").addEventListener("submit", async (e) => {
    e.preventDefault();
    const kg = parseFloat($("#w-kg").value);
    if (!(kg >= 30 && kg <= 200)) { status("That weight doesn't look right.", "err"); return; }
    if (await runWorkflow("weight", { weight: kg.toFixed(1), date: $("#w-date").value === today ? "" : $("#w-date").value }, `Weight ${kg.toFixed(1)} kg`)) show("today");
  });
  $("#f-checkin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inputs = {};
    $$(".scale", v).forEach((sc) => { const on = $("button.on", sc); inputs[sc.dataset.scale] = on ? on.dataset.v : ""; });
    inputs.notes = $("#c-notes").value.trim();
    if (!Object.values(inputs).some(Boolean)) { status("Pick at least one score or add a note.", "err"); return; }
    if (await runWorkflow("checkin", inputs, "Check-in")) { store.set("checkinDate", today); show("today"); }
  });
  $("#f-labs")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const hb = $("#l-hb").value, inputs = { date: $("#l-date").value, hb, ferritin: $("#l-fer").value, platelets: $("#l-plt").value, neutrophils: $("#l-neu").value };
    if (hb && +hb < 25) { status(`Hb ${esc(hb)} looks like g/dL – enter g/L (e.g. ${Math.round(hb * 10)}).`, "err"); return; }
    if (![inputs.hb, inputs.ferritin, inputs.platelets, inputs.neutrophils].some(Boolean)) { status("Enter at least one result.", "err"); return; }
    if (await runWorkflow("labs", inputs, "Blood results")) show("trends");
  });
  $("#b-refresh").addEventListener("click", () => runWorkflow("refresh", { mode: "refresh" }, "Update"));
}

// ---------- settings ----------
function renderSettings() {
  const v = $("#view-settings");
  v.innerHTML = `${LOGO}<div class="card settings"><h2>Connections</h2>
    <label for="s-repo">GitHub repo</label><input id="s-repo" value="${esc(settings.repo)}" placeholder="owner/repo-name" autocapitalize="off" autocomplete="off" spellcheck="false">
    <label for="s-gh">GitHub token</label><input id="s-gh" type="password" value="${esc(settings.github)}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
    <p class="help">Fine-grained token for this repo only, with Contents: read and Actions: read &amp; write.</p>
    <label for="s-ai">Anthropic API key</label><input id="s-ai" type="password" value="${esc(settings.anthropic)}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="sk-ant-…">
    <p class="help">For "Ask the coach". Can be the same key as the repo's ANTHROPIC_API_KEY secret.</p>
    <div class="actions"><button class="primary" id="s-save">Save</button><button class="secondary" id="s-test">Test</button></div>
    <p class="help">Keys are stored only on this phone, inside the app.</p></div>
    <div class="card small muted">RS Coach · coach ${esc(modelName(modelFor("default")))}${profile().medical ? ` · blood results ${esc(modelName(modelFor("medical")))}` : ""}</div>`;
  const read = () => ({ repo: $("#s-repo").value.trim() || DEFAULT_REPO, github: $("#s-gh").value.trim(), anthropic: $("#s-ai").value.trim() });
  $("#s-save").addEventListener("click", () => {
    settings = read();
    store.set("settings", settings);
    status("Saved.");
    setTimeout(() => status(""), 2000);
    reload();
    show("today");
  });
  $("#s-test").addEventListener("click", async () => {
    const prev = settings;
    settings = read();
    const out = [];
    try { const r = await gh(""); out.push(`GitHub ✓ (${esc(r.full_name)})`); } catch (e) { out.push(`GitHub ✗ ${esc(e.message)}`); }
    if (settings.anthropic) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": settings.anthropic, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true" } });
        out.push(r.ok ? "Anthropic ✓" : `Anthropic ✗ (${r.status})`);
      } catch (e) { out.push(`Anthropic ✗ ${esc(e.message)}`); }
    }
    settings = prev;
    status(out.join(" · "), out.some((s) => s.includes("✗")) ? "err" : "");
  });
}

// ---------- detail sheets ----------
function openSheet(html) {
  $("#sheet-content").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-body").scrollTop = 0;
}
function closeSheet() { $("#sheet").hidden = true; }

function openGym() {
  const g = report?.gym || {};
  const ex = (g.exercises || []).map((e, i) => `<div class="ex"><div class="exhead"><b>${i + 1}. ${esc(e.name)}</b><span>${esc(e.sets)}</span></div>
    ${e.tempo ? `<div class="small muted">Tempo: ${esc(e.tempo)}</div>` : ""}<p>${esc(e.cues)}</p>${e.safety ? `<p class="safety">${esc(e.safety)}</p>` : ""}</div>`).join("");
  openSheet(`<div class="sheet-title">${icon("gym")}<h2>Gym – pelvic stability</h2></div>
    ${g.warmup ? `<p class="small"><b>Warm-up:</b> ${esc(g.warmup)}</p>` : ""}${ex || `<p class="muted">No exercises set – add them under [gym] in config.toml.</p>`}
    ${(g.notes || []).length ? `<div class="note"><div class="label">EVERY SESSION</div>${g.notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : ""}`);
}

// The Favero pedals send left/right balance and the KICKR doesn't, so a Zwift ride with balance data is Favero power.
// Only when a KICKR offset is configured (report.goal.kickr_offset_pct; older reports: Richie's 6%).
const kickrPct = () => report?.goal ? (report.goal.kickr_offset_pct ?? 6) : 0;
const onKickr = (a) => kickrPct() > 0 && a.lr_balance == null && !/favero/i.test(a.power_meter || "") && /kickr|zwift/i.test(a.device || "");

function ruleFeedback(a, planned) {
  const out = [];
  const fam = iconKey(a.type);
  const plan = planned.find((p) => iconKey(p.kind) === fam) || null;
  if (plan) {
    const pct = plan.hours ? Math.round((a.mins / 60) / plan.hours * 100) : null;
    out.push(["info", `Planned: ${plan.name} (${dur(plan.hours)}). You did ${dur(a.mins / 60)}${pct ? ` – ${pct}% of the plan` : ""}.`]);
  } else if (planned.length) {
    out.push(["info", `Not the planned session (${planned.map((p) => p.name).join(", ")}).`]);
  }
  const z2 = report.z2_hr;
  const easy = /Z2|Endurance|Aerobic|spin|Easy|Recovery/i.test(plan?.name || a.name || "");
  const hard = a.load && a.mins ? a.load / (a.mins / 60) >= 75 : false;
  if (z2 && a.avg_hr && fam === "ride" && easy && !hard) {
    if (a.avg_hr > z2[1]) out.push(["warn", `HR averaged ${Math.round(a.avg_hr)} – above your Z2 cap of ${z2[1]}. Ease the pace on easy days.`]);
    else if (a.avg_hr >= z2[0]) out.push(["ok", `HR averaged ${Math.round(a.avg_hr)} – inside Z2 (${z2[0]}–${z2[1]}).`]);
    else out.push(["info", `HR averaged ${Math.round(a.avg_hr)} – below Z2; fine for recovery.`]);
  }
  if (a.lr_balance != null && fam === "ride") {
    const left = 100 - a.lr_balance, base = report.goal?.lr_baseline_left ?? 62, d = left - base;
    out.push(["info", `Left/right ${Math.round(left)}/${Math.round(a.lr_balance)} – ${Math.abs(d) < 3 ? "your usual split" : `${Math.abs(d).toFixed(0)} points ${d > 0 ? "more on the left" : "more on the right"} than your usual ${base}/${100 - base}; note how the hip and right leg felt`}.`]);
  }
  if (hard) out.push(["info", "A hard session – this is the week's one intensity day; keep the next 2 days aerobic."]);
  if (onKickr(a) && (a.np_w || a.avg_w)) {
    const w = a.np_w || a.avg_w;
    out.push(["info", `KICKR power reads ~${kickrPct()}% high: ${a.np_w ? "NP" : "avg"} ${Math.round(w)} W ≈ ${Math.round(w / (1 + kickrPct() / 100))} W Favero.`]);
  }
  if (a.decoupling != null && fam === "ride" && a.mins >= 60) {
    out.push([a.decoupling > 5 ? "warn" : "ok", `HR drift ${a.decoupling.toFixed(1)}% – ${a.decoupling > 5 ? "above 5%: fatigue, heat or under-fuelling" : "good aerobic durability"}.`]);
  }
  if (fam === "ride" && a.mins > 75) out.push(["info", `Fuel for this length: 30–60 g carbs/h ≈ ${Math.round(a.mins / 60 * 30)}–${Math.round(a.mins / 60 * 60)} g on the bike.`]);
  if (fam === "run") out.push(["info", "Run: check the hip and right foot tonight; build run time by no more than ~5 min a week."]);
  return out.map(([level, text]) => ({ level, text }));
}

async function downloadFit(a) {
  // Exported files live as downloads on the repo's private "Activity files" release, named <date>_<id>.<ext>.
  const find = async () => {
    try {
      return (await gh("/releases/tags/fit-files")).assets.find((x) => x.name.startsWith(`${a.date}_${a.id}.`)) || null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  };
  try {
    let asset = await find();
    if (!asset) {
      if (!(await runWorkflow("fit", { activity_id: String(a.id), date: a.date }, "FIT export"))) return;
      asset = await find();
    }
    if (!asset) { status("The export finished but the file isn't listed yet – try again in a moment.", "err"); return; }
    status(`Opening ${esc(asset.name)} in your browser…`);
    setTimeout(() => status(""), 4000);
    location.href = asset.browser_download_url;  // the WebView hands non-app links to the browser
  } catch (e) {
    status(esc(e.message), "err");
  }
}

function openActivity(id) {
  const a = (report?.activities || []).find((x) => String(x.id) === String(id));
  if (!a) { status("That activity isn't in the app's data any more.", "err"); return; }
  const planned = (report.recent_plan || []).filter((p) => p.day === a.date);
  const stats = [["When", `${dayName(a.date)}${a.start ? ` · ${a.start.slice(11, 16)}` : ""}`], ["Time", dur(a.mins / 60)]];
  if (a.distance_m) stats.push(["Distance", `${km(a.distance_m)} km`]);
  if (a.load) stats.push(["Load", `${Math.round(a.load)}${a.intensity_pct ? ` · intensity ${Math.round(a.intensity_pct)}%` : ""}`]);
  if (a.avg_hr) stats.push(["Heart rate", `avg ${Math.round(a.avg_hr)}${a.max_hr ? ` · max ${Math.round(a.max_hr)}` : ""} bpm`]);
  if (a.np_w || a.avg_w) stats.push(["Power", `${a.avg_w ? `avg ${Math.round(a.avg_w)} W` : ""}${a.np_w ? ` · NP ${Math.round(a.np_w)} W` : ""}`]);
  if (a.lr_balance != null) stats.push(["Left / right", `${Math.round(100 - a.lr_balance)} / ${Math.round(a.lr_balance)}`]);
  if (a.cadence) stats.push(["Cadence", `${Math.round(a.cadence)} rpm`]);
  if (a.elev_m) stats.push(["Climbing", `${Math.round(a.elev_m)} m`]);
  if (a.kcal) stats.push(["Energy", `${Math.round(a.kcal)} kcal`]);
  if (a.rpe) stats.push(["RPE", `${a.rpe}`]);
  if (a.device) stats.push(["Recorded on", esc(a.device) + (a.np_w || a.avg_w ? (onKickr(a) ? " · KICKR power" : kickrPct() && (a.lr_balance != null || a.power_meter) ? " · Favero power" : "") : "")]);
  const cached = store.get(`fb:${a.id}`, null);
  openSheet(`<div class="sheet-title">${icon(iconKey(a.type))}<div><h2>${esc(a.name || a.type)}</h2><span class="small muted">${esc(a.type || "")}</span></div></div>
    ${rows(stats)}<h3>Coaching</h3>${flagsHtml(ruleFeedback(a, planned))}
    <div class="note" id="fb"><div class="label">COACH'S FEEDBACK</div><div id="fb-text">${cached ? mdLite(cached)
      : settings.anthropic ? `<p class="typing">Thinking</p>` : `<p class="muted">Add your Anthropic key in Settings for the coach's feedback.</p>`}</div></div>
    ${cached ? `<button class="secondary" id="fb-again" style="margin-top:10px">Ask again</button>` : ""}
    <h3>File</h3><button class="secondary" id="fit-dl" data-busy style="width:100%">⤓ Download FIT file</button>
    <p class="small muted" style="margin:6px 0 0">The first time takes about a minute; it then opens in your browser to save.</p>`);
  $("#fit-dl").addEventListener("click", () => downloadFit(a));
  setBusyButtons(busy);
  const ask = async () => {
    const el = $("#fb-text");
    el.innerHTML = `<p class="typing">Thinking</p>`;
    const checkin = (report.checkins || []).find((c) => c.date === a.date) || null;
    const prompt = `Give coaching feedback on this completed session for the app's session screen.
Activity: ${JSON.stringify(a)}
Planned that day: ${JSON.stringify(planned)}
Check-in that day: ${JSON.stringify(checkin)}
In at most 110 words, 2–4 bullets starting with "- ": how it went against the plan and his rules, anything to watch (recovery markers, hip, HR, fuelling), and what it means for the next 2–3 days.`;
    try {
      let text = "";
      await streamClaude((t) => { text = t; if ($("#fb-text") === el) el.innerHTML = mdLite(t); }, coachSystem(), [{ role: "user", content: prompt }], modelFor("default"));
      store.set(`fb:${a.id}`, text);
    } catch (e) {
      if ($("#fb-text") === el) el.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  };
  $("#fb-again")?.addEventListener("click", ask);
  if (!cached && settings.anthropic) ask();
}

document.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act) { e.stopPropagation(); openActivity(act.dataset.act); return; }
  if (e.target.closest("[data-gym]")) { e.stopPropagation(); openGym(); return; }
  if (e.target.closest("#sheet-close") || e.target.id === "sheet") closeSheet();
}, true);

// ---------- start screen ----------
function splash() {
  const el = $("#splash");
  const acts = [["ride", "Ride"], ["run", "Run"], ["walk", "Walk"], ["gym", "Gym"], ["race", "Race"]];
  $("#splash-acts").innerHTML = acts.map(([k, label], i) =>
    `<li style="animation-delay:${450 + i * 160}ms">${icon(k)}<span>${label}</span></li>`).join("");
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), 500);
  };
  el.addEventListener("click", done);  // tap to skip
  setTimeout(done, reduced ? 900 : 2300);
}
splash();

// ---------- start ----------
$$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#open-settings").addEventListener("click", () => show("settings"));
$("#refresh").addEventListener("click", reload);
$("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#chat-input").addEventListener("input", autosize);
window.addEventListener("resize", () => { if (view === "trends") renderTrends(); });

if (!settings.github) show("settings");
else { show("today"); reload(); }
