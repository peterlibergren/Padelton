const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// =====================
// PERSISTENS (state.json)
// =====================
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn("[STATE] Could not create data dir:", e);
  }
}

function safeReadJSON(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[STATE] Could not read JSON:", e);
    return null;
  }
}

function safeWriteJSON(filepath, obj) {
  try {
    ensureDataDir();
    const tmp = filepath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, filepath);
  } catch (e) {
    console.warn("[STATE] Could not write JSON:", e);
  }
}

// ==== SPILLER-LISTER (op til 16 pr. side) ====
const MAX_PLAYERS = 16;
let homePlayers = new Array(MAX_PLAYERS).fill("");
let awayPlayers = new Array(MAX_PLAYERS).fill("");

// ==== BANENAVNE (meta) ====
// Default values (kan ændres via admin og gemmes i state.json)
const DEFAULT_COURTS_META = [
  { id: 1, sponsor: "Bane 1 – BetaPack" },
  { id: 2, sponsor: "Bane 2 – Brdr. Thybo" },
  { id: 3, sponsor: "Bane 3 – Schantz" },
  { id: 4, sponsor: "Bane 4 – 10-4" },
  { id: 5, sponsor: "Bane 5 – Slagteren" },
];

let courtsMeta = [...DEFAULT_COURTS_META];

// ==== STANDARD: hvilke baner vises på index.html når LUNAR ikke er aktivt ====
let standardVisibleCourts = [1, 2, 3, 4, 5];

// ==== BANESTATE ====
const courts = {};
for (let i = 1; i <= 5; i++) {
  courts[i] = {
    courtId: i,

    // Basisnavne (fra controller/ESP)
    homeName: "Hjemme",
    awayName: "Ude",

    // Admin-overrides (fri tekst)
    adminHomeName: null,
    adminAwayName: null,

    // Spiller-valg (1..16, null = ingen) – standardopsætning
    homeIdx1: null,
    homeIdx2: null,
    awayIdx1: null,
    awayIdx2: null,

    // Aktuel score
    homePoints: 0,
    awayPoints: 0,
    homePointsStr: "0",
    awayPointsStr: "0",
    homeGames: 0,
    awayGames: 0,
    homeSets: 0,
    awaySets: 0,

    // Set-historik (fra controlleren)
    // -1 betyder "ikke sat / ikke spillet"
    set1Home: -1,
    set1Away: -1,
    set1LoserTbPoints: -1,
    set1LoserIsHome: false,

    set2Home: -1,
    set2Away: -1,
    set2LoserTbPoints: -1,
    set2LoserIsHome: false,

    // valgfri fritekst – samlet set-resultat, fx "6-3,7-6(5),10-8(8)"
    setsStr: "",

    // Kampstatus (fra controller/bane-ESP)
    matchFinished: false, // true = kampen er slut
    winner: 0, // 0 = ingen, 1 = hjemme, 2 = ude
    mtb3rd: false, // true = 3. sæt er match-tie til 10

    online: false,
    lastUpdate: 0,
  };
}

// ==== LUNAR-STATE (i RAM) ====
let lunarEnabled = false; // true/false
let lunarCourts = []; // fx [1,2,3]
let lunarRound1 = []; // [{ courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 }, ...]
let lunarRound2 = []; // samme struktur
let lunarSuperMatchCourtId = null; // bane til SUPER MATCH-TIE (7. kamp)
let lunarSuperMatchPlayers = {
  homeIdx1: null,
  homeIdx2: null,
  awayIdx1: null,
  awayIdx2: null,
};

// ==== LUNAR RESULTATER ====
let lunarResults = []; // snapshots
let lunarHomeWinsTotal = 0;
let lunarAwayWinsTotal = 0;

// =====================
// STATE: LOAD/SAVE
// =====================
function saveStateToDisk() {
  const courtsAdminConfig = {};
  Object.values(courts).forEach((c) => {
    courtsAdminConfig[c.courtId] = {
      adminHomeName: c.adminHomeName,
      adminAwayName: c.adminAwayName,
      homeIdx1: c.homeIdx1,
      homeIdx2: c.homeIdx2,
      awayIdx1: c.awayIdx1,
      awayIdx2: c.awayIdx2,
    };
  });

  safeWriteJSON(STATE_FILE, {
    homePlayers,
    awayPlayers,
    courtsMeta,
    standardVisibleCourts,

    lunarEnabled,
    lunarCourts,
    lunarRound1,
    lunarRound2,
    lunarSuperMatchCourtId,
    lunarSuperMatchPlayers,
    lunarResults,
    lunarHomeWinsTotal,
    lunarAwayWinsTotal,

    courts: courtsAdminConfig,
  });
}

function loadStateFromDisk() {
  const s = safeReadJSON(STATE_FILE);
  if (!s) return;

  // Players
  if (Array.isArray(s.homePlayers)) {
    homePlayers = new Array(MAX_PLAYERS).fill("").map((_, i) =>
      typeof s.homePlayers[i] === "string" ? s.homePlayers[i] : ""
    );
  }
  if (Array.isArray(s.awayPlayers)) {
    awayPlayers = new Array(MAX_PLAYERS).fill("").map((_, i) =>
      typeof s.awayPlayers[i] === "string" ? s.awayPlayers[i] : ""
    );
  }

  // courtsMeta
  if (Array.isArray(s.courtsMeta)) {
    const cleaned = s.courtsMeta
      .map((x) => ({
        id: Number(x?.id),
        sponsor: typeof x?.sponsor === "string" ? x.sponsor.trim() : "",
      }))
      .filter((x) => Number.isFinite(x.id) && x.id >= 1 && x.id <= 5);

    const merged = [];
    for (let i = 1; i <= 5; i++) {
      const found = cleaned.find((c) => c.id === i);
      merged.push(found && found.sponsor ? { id: i, sponsor: found.sponsor } : DEFAULT_COURTS_META[i - 1]);
    }
    courtsMeta = merged;
  }

  // standardVisibleCourts
  if (Array.isArray(s.standardVisibleCourts)) {
    standardVisibleCourts = s.standardVisibleCourts
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
    if (standardVisibleCourts.length === 0) standardVisibleCourts = [1, 2, 3, 4, 5];
  }

  // Lunar config
  if (typeof s.lunarEnabled === "boolean") lunarEnabled = s.lunarEnabled;
  if (Array.isArray(s.lunarCourts)) {
    lunarCourts = s.lunarCourts.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  }
  if (Array.isArray(s.lunarRound1)) lunarRound1 = s.lunarRound1;
  if (Array.isArray(s.lunarRound2)) lunarRound2 = s.lunarRound2;

  if (s.lunarSuperMatchCourtId == null) lunarSuperMatchCourtId = null;
  else {
    const n = Number(s.lunarSuperMatchCourtId);
    lunarSuperMatchCourtId = Number.isFinite(n) ? n : null;
  }

  if (s.lunarSuperMatchPlayers && typeof s.lunarSuperMatchPlayers === "object") {
    lunarSuperMatchPlayers = {
      homeIdx1: s.lunarSuperMatchPlayers.homeIdx1 ?? null,
      homeIdx2: s.lunarSuperMatchPlayers.homeIdx2 ?? null,
      awayIdx1: s.lunarSuperMatchPlayers.awayIdx1 ?? null,
      awayIdx2: s.lunarSuperMatchPlayers.awayIdx2 ?? null,
    };
  }

  if (Array.isArray(s.lunarResults)) lunarResults = s.lunarResults;
  if (Number.isFinite(Number(s.lunarHomeWinsTotal))) lunarHomeWinsTotal = Number(s.lunarHomeWinsTotal);
  if (Number.isFinite(Number(s.lunarAwayWinsTotal))) lunarAwayWinsTotal = Number(s.lunarAwayWinsTotal);

  // Admin config pr court
  if (s.courts && typeof s.courts === "object") {
    Object.values(courts).forEach((c) => {
      const entry = s.courts[c.courtId];
      if (!entry || typeof entry !== "object") return;

      c.adminHomeName = typeof entry.adminHomeName === "string" ? entry.adminHomeName : null;
      c.adminAwayName = typeof entry.adminAwayName === "string" ? entry.adminAwayName : null;

      c.homeIdx1 = entry.homeIdx1 ?? null;
      c.homeIdx2 = entry.homeIdx2 ?? null;
      c.awayIdx1 = entry.awayIdx1 ?? null;
      c.awayIdx2 = entry.awayIdx2 ?? null;
    });
  }

  console.log("[STATE] Loaded:", STATE_FILE);
}

// =====================
// HJÆLPERE
// =====================
function buildNameFromIndices(side, idx1, idx2) {
  const list = side === "home" ? homePlayers : awayPlayers;
  const names = [];

  const indices = [idx1, idx2];
  indices.forEach((idx) => {
    if (typeof idx === "number" && idx >= 1 && idx <= MAX_PLAYERS) {
      const n = list[idx - 1];
      if (n && n.trim().length > 0) names.push(n.trim());
    }
  });

  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return names.join(" / ");
}

function computeEffectiveNames(c) {
  const isLunar = lunarEnabled && Array.isArray(lunarCourts) && lunarCourts.includes(c.courtId);
  const isSuperMatchTie = isLunar && lunarSuperMatchCourtId === c.courtId;

  let effHome = c.homeName;
  let effAway = c.awayName;

  let usedHomeIdx1 = c.homeIdx1;
  let usedHomeIdx2 = c.homeIdx2;
  let usedAwayIdx1 = c.awayIdx1;
  let usedAwayIdx2 = c.awayIdx2;
  let lunarRoundUsed = null;

  // LUNAR overrides (runde 2 prioritet)
  if (isLunar) {
    const r2 = Array.isArray(lunarRound2) ? lunarRound2.find((e) => e.courtId === c.courtId) : null;
    const r1 = Array.isArray(lunarRound1) ? lunarRound1.find((e) => e.courtId === c.courtId) : null;

    const hasR2 =
      r2 && (r2.homeIdx1 != null || r2.homeIdx2 != null || r2.awayIdx1 != null || r2.awayIdx2 != null);
    const hasR1 =
      r1 && (r1.homeIdx1 != null || r1.homeIdx2 != null || r1.awayIdx1 != null || r1.awayIdx2 != null);

    const src = hasR2 ? r2 : hasR1 ? r1 : null;
    if (src) {
      usedHomeIdx1 = src.homeIdx1 ?? null;
      usedHomeIdx2 = src.homeIdx2 ?? null;
      usedAwayIdx1 = src.awayIdx1 ?? null;
      usedAwayIdx2 = src.awayIdx2 ?? null;
      lunarRoundUsed = hasR2 ? 2 : 1;
    }
  }

  // SUPER MATCH-TIE override
  if (isLunar && isSuperMatchTie && lunarSuperMatchPlayers) {
    const p = lunarSuperMatchPlayers;
    const hasAny = p.homeIdx1 != null || p.homeIdx2 != null || p.awayIdx1 != null || p.awayIdx2 != null;
    if (hasAny) {
      usedHomeIdx1 = p.homeIdx1 ?? null;
      usedHomeIdx2 = p.homeIdx2 ?? null;
      usedAwayIdx1 = p.awayIdx1 ?? null;
      usedAwayIdx2 = p.awayIdx2 ?? null;
    }
  }

  // Admin navne
  if (c.adminHomeName) effHome = c.adminHomeName;
  if (c.adminAwayName) effAway = c.adminAwayName;

  // From roster indices
  const fromHomeRoster = buildNameFromIndices("home", usedHomeIdx1, usedHomeIdx2);
  const fromAwayRoster = buildNameFromIndices("away", usedAwayIdx1, usedAwayIdx2);

  if (fromHomeRoster) effHome = fromHomeRoster;
  if (fromAwayRoster) effAway = fromAwayRoster;

  return {
    effHome,
    effAway,
    isLunar,
    isSuperMatchTie,
    usedHomeIdx1,
    usedHomeIdx2,
    usedAwayIdx1,
    usedAwayIdx2,
    lunarRoundUsed,
  };
}

function pickPointsStr({ hp, ap, suppliedHomeStr, suppliedAwayStr }) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const hs = clean(suppliedHomeStr);
  const as = clean(suppliedAwayStr);

  const fallbackH = Number.isFinite(Number(hp)) ? String(Number(hp)) : "0";
  const fallbackA = Number.isFinite(Number(ap)) ? String(Number(ap)) : "0";

  return { home: hs !== "" ? hs : fallbackH, away: as !== "" ? as : fallbackA };
}

// =====================
// API: updateScore (controller/ESP)
// =====================
app.post("/api/updateScore", (req, res) => {
  const {
    courtId,
    homeName,
    awayName,
    homePoints,
    awayPoints,
    homePointsStr,
    awayPointsStr,
    homeGames,
    awayGames,
    homeSets,
    awaySets,

    set1Home,
    set1Away,
    set1LoserTbPoints,
    set1LoserIsHome,
    set2Home,
    set2Away,
    set2LoserTbPoints,
    set2LoserIsHome,

    setsStr,

    matchFinished,
    winner,
    mtb3rd,
  } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];
  const prevFinished = !!c.matchFinished;

  function toIntOrDefault(v, def) {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function toBool(v, def) {
    if (v === undefined || v === null) return def;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no") return false;
    }
    return def;
  }

  // Raw names
  if (homeName !== undefined) c.homeName = homeName;
  if (awayName !== undefined) c.awayName = awayName;

  // Score (numbers)
  if (homePoints !== undefined) c.homePoints = toIntOrDefault(homePoints, c.homePoints ?? 0);
  if (awayPoints !== undefined) c.awayPoints = toIntOrDefault(awayPoints, c.awayPoints ?? 0);
  if (homeGames !== undefined) c.homeGames = toIntOrDefault(homeGames, c.homeGames ?? 0);
  if (awayGames !== undefined) c.awayGames = toIntOrDefault(awayGames, c.awayGames ?? 0);
  if (homeSets !== undefined) c.homeSets = toIntOrDefault(homeSets, c.homeSets ?? 0);
  if (awaySets !== undefined) c.awaySets = toIntOrDefault(awaySets, c.awaySets ?? 0);

  // pointsStr
  const picked = pickPointsStr({
    hp: c.homePoints,
    ap: c.awayPoints,
    suppliedHomeStr: homePointsStr,
    suppliedAwayStr: awayPointsStr,
  });
  c.homePointsStr = picked.home;
  c.awayPointsStr = picked.away;

  // Set history
  if (set1Home !== undefined) c.set1Home = toIntOrDefault(set1Home, -1);
  if (set1Away !== undefined) c.set1Away = toIntOrDefault(set1Away, -1);
  if (set1LoserTbPoints !== undefined) c.set1LoserTbPoints = toIntOrDefault(set1LoserTbPoints, -1);
  if (set1LoserIsHome !== undefined) c.set1LoserIsHome = toBool(set1LoserIsHome, false);

  if (set2Home !== undefined) c.set2Home = toIntOrDefault(set2Home, -1);
  if (set2Away !== undefined) c.set2Away = toIntOrDefault(set2Away, -1);
  if (set2LoserTbPoints !== undefined) c.set2LoserTbPoints = toIntOrDefault(set2LoserTbPoints, -1);
  if (set2LoserIsHome !== undefined) c.set2LoserIsHome = toBool(set2LoserIsHome, false);

  if (setsStr !== undefined) {
    c.setsStr = typeof setsStr === "string" ? setsStr : setsStr != null ? String(setsStr) : "";
  }

  // Match status
  if (matchFinished !== undefined) c.matchFinished = toBool(matchFinished, false);
  if (winner !== undefined) c.winner = toIntOrDefault(winner, 0);
  if (mtb3rd !== undefined) c.mtb3rd = toBool(mtb3rd, false);

  // derive winner if missing
  if (c.matchFinished && (!c.winner || c.winner === 0)) {
    const hs = Number(c.homeSets || 0);
    const as = Number(c.awaySets || 0);
    if (hs > as) c.winner = 1;
    else if (as > hs) c.winner = 2;
  }

  // ---- LUNAR snapshot logic (samme som før) ----
  const newFinished = !!c.matchFinished;
  const newWinner = Number(c.winner || 0);

  const isLunar = lunarEnabled && Array.isArray(lunarCourts) && lunarCourts.includes(courtId);

  if (isLunar && newFinished) {
    const names = computeEffectiveNames(c);

    let round = 1;
    const hasR2 = Array.isArray(lunarRound2) && lunarRound2.some((e) => e.courtId === courtId);
    if (hasR2) round = 2;

    let isSuperMatchRound = false;
    if (lunarSuperMatchCourtId != null && lunarSuperMatchCourtId === courtId && lunarSuperMatchPlayers) {
      const sp = lunarSuperMatchPlayers;
      const haveSuperIndices = sp.homeIdx1 != null || sp.homeIdx2 != null || sp.awayIdx1 != null || sp.awayIdx2 != null;

      if (haveSuperIndices) {
        const sameHome = names.usedHomeIdx1 === sp.homeIdx1 && names.usedHomeIdx2 === sp.homeIdx2;
        const sameAway = names.usedAwayIdx1 === sp.awayIdx1 && names.usedAwayIdx2 === sp.awayIdx2;
        if (sameHome && sameAway) isSuperMatchRound = true;
      }
    }
    if (isSuperMatchRound) round = 7;

    if (!prevFinished) {
      if (newWinner === 1) lunarHomeWinsTotal++;
      else if (newWinner === 2) lunarAwayWinsTotal++;
    }

    const snapshot = {
      round,
      courtId,
      homeName: names.effHome,
      awayName: names.effAway,
      setsStr: c.setsStr || "",
      set1Home: c.set1Home,
      set1Away: c.set1Away,
      set1LoserTbPoints: c.set1LoserTbPoints,
      set1LoserIsHome: c.set1LoserIsHome,
      set2Home: c.set2Home,
      set2Away: c.set2Away,
      set2LoserTbPoints: c.set2LoserTbPoints,
      set2LoserIsHome: c.set2LoserIsHome,
      homeSets: Number(c.homeSets || 0),
      awaySets: Number(c.awaySets || 0),
      winner: newWinner,
    };

    const existingIndex = lunarResults.findIndex((r) => r.courtId === courtId && r.round === round);
    if (existingIndex >= 0) lunarResults[existingIndex] = snapshot;
    else lunarResults.push(snapshot);

    // Hvis du vil have LUNAR-resultater og totals til at overleve genstart:
    saveStateToDisk();
  }

  c.lastUpdate = Date.now();
  c.online = true;

  res.json({ status: "ok" });
});

// =====================
// ADMIN endpoints
// =====================

// POST /api/setNames  (valgfri admin override navne pr bane)
app.post("/api/setNames", (req, res) => {
  const { courtId, homeName, awayName } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  if (typeof homeName === "string") c.adminHomeName = homeName.trim() || null;
  if (typeof awayName === "string") c.adminAwayName = awayName.trim() || null;

  saveStateToDisk();

  return res.json({
    status: "ok",
    courtId,
    homeName: c.adminHomeName || c.homeName,
    awayName: c.adminAwayName || c.awayName,
  });
});

// POST /api/setRoster
app.post("/api/setRoster", (req, res) => {
  const body = req.body || {};
  const hp = Array.isArray(body.homePlayers) ? body.homePlayers : [];
  const ap = Array.isArray(body.awayPlayers) ? body.awayPlayers : [];

  homePlayers = new Array(MAX_PLAYERS)
    .fill("")
    .map((_, i) => (typeof hp[i] === "string" ? hp[i].trim() : ""));
  awayPlayers = new Array(MAX_PLAYERS)
    .fill("")
    .map((_, i) => (typeof ap[i] === "string" ? ap[i].trim() : ""));

  saveStateToDisk();

  return res.json({ status: "ok", homePlayers, awayPlayers });
});

// POST /api/setCourtPlayers
app.post("/api/setCourtPlayers", (req, res) => {
  const { courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  function normIdx(v) {
    if (v === null || v === undefined || v === "" || v === 0) return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    if (num < 1 || num > MAX_PLAYERS) return null;
    return num;
  }

  c.homeIdx1 = normIdx(homeIdx1);
  c.homeIdx2 = normIdx(homeIdx2);
  c.awayIdx1 = normIdx(awayIdx1);
  c.awayIdx2 = normIdx(awayIdx2);

  saveStateToDisk();

  return res.json({
    status: "ok",
    courtId,
    homeIdx1: c.homeIdx1,
    homeIdx2: c.homeIdx2,
    awayIdx1: c.awayIdx1,
    awayIdx2: c.awayIdx2,
  });
});

// POST /api/setStandardVisibleCourts
app.post("/api/setStandardVisibleCourts", (req, res) => {
  const body = req.body || {};
  const arr = body.standardVisibleCourts;

  if (!Array.isArray(arr)) {
    return res.status(400).json({ error: "standardVisibleCourts skal være et array" });
  }

  standardVisibleCourts = arr
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);

  if (standardVisibleCourts.length === 0) {
    // undgå tom visning, fallback til alle
    standardVisibleCourts = [1, 2, 3, 4, 5];
  }

  saveStateToDisk();

  return res.json({ status: "ok", standardVisibleCourts });
});

// POST /api/setCourtsMeta  (NYT: gem banenavne)
app.post("/api/setCourtsMeta", (req, res) => {
  const body = req.body || {};
  const arr = body.courtsMeta;

  if (!Array.isArray(arr)) {
    return res.status(400).json({ error: "courtsMeta skal være et array" });
  }

  const cleaned = arr
    .map((x) => ({
      id: Number(x?.id),
      sponsor: typeof x?.sponsor === "string" ? x.sponsor.trim() : "",
    }))
    .filter((x) => Number.isFinite(x.id) && x.id >= 1 && x.id <= 5);

  const merged = [];
  for (let i = 1; i <= 5; i++) {
    const found = cleaned.find((c) => c.id === i);
    merged.push(found && found.sponsor ? { id: i, sponsor: found.sponsor } : DEFAULT_COURTS_META[i - 1]);
  }

  courtsMeta = merged;

  saveStateToDisk();

  return res.json({ status: "ok", courtsMeta });
});

// POST /api/setLunarConfig
app.post("/api/setLunarConfig", (req, res) => {
  const body = req.body || {};
  const { lunarEnabled: enabledFromClient, lunarCourts: courtsFromClient, lunarSuperMatchCourtId: superFromClient } = body;

  lunarEnabled = !!enabledFromClient;

  // Hvis LUNAR slås FRA → nulstil LUNAR-state + resultater/stilling
  if (!lunarEnabled) {
    lunarCourts = [];
    lunarRound1 = [];
    lunarRound2 = [];
    lunarSuperMatchCourtId = null;
    lunarSuperMatchPlayers = { homeIdx1: null, homeIdx2: null, awayIdx1: null, awayIdx2: null };

    lunarHomeWinsTotal = 0;
    lunarAwayWinsTotal = 0;
    lunarResults = [];

    saveStateToDisk();

    return res.json({
      status: "ok",
      lunarEnabled,
      lunarCourts,
      lunarRound1,
      lunarRound2,
      lunarSuperMatchCourtId,
      lunarSuperMatchPlayers,
      lunarHomeWinsTotal,
      lunarAwayWinsTotal,
      lunarResults,
    });
  }

  // LUNAR courts
  if (Array.isArray(courtsFromClient)) {
    lunarCourts = courtsFromClient.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  } else {
    lunarCourts = [];
  }

  // Super match court must be among lunarCourts
  let superId = null;
  if (superFromClient !== undefined && superFromClient !== null && superFromClient !== "") {
    const n = Number(superFromClient);
    if (Number.isFinite(n) && n >= 1 && n <= 5 && lunarCourts.includes(n)) superId = n;
  }
  lunarSuperMatchCourtId = superId;

  saveStateToDisk();

  return res.json({
    status: "ok",
    lunarEnabled,
    lunarCourts,
    lunarRound1,
    lunarRound2,
    lunarSuperMatchCourtId,
    lunarSuperMatchPlayers,
    lunarHomeWinsTotal,
    lunarAwayWinsTotal,
    lunarResults,
  });
});

// POST /api/setLunarCourtPlayers
app.post("/api/setLunarCourtPlayers", (req, res) => {
  const { round, courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 } = req.body || {};
  const r = Number(round);
  const cid = Number(courtId);

  if (r !== 1 && r !== 2) return res.status(400).json({ error: "round skal være 1 eller 2" });
  if (!cid || cid < 1 || cid > 5) return res.status(400).json({ error: "Invalid courtId" });

  function normIdx(v) {
    if (v === null || v === undefined || v === "" || v === 0) return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    if (num < 1 || num > MAX_PLAYERS) return null;
    return num;
  }

  const targetArray = r === 1 ? lunarRound1 : lunarRound2;

  let entry = targetArray.find((c) => c.courtId === cid);
  if (!entry) {
    entry = { courtId: cid };
    targetArray.push(entry);
  }

  entry.homeIdx1 = normIdx(homeIdx1);
  entry.homeIdx2 = normIdx(homeIdx2);
  entry.awayIdx1 = normIdx(awayIdx1);
  entry.awayIdx2 = normIdx(awayIdx2);

  saveStateToDisk();

  return res.json({
    status: "ok",
    round: r,
    courtId: cid,
    homeIdx1: entry.homeIdx1,
    homeIdx2: entry.homeIdx2,
    awayIdx1: entry.awayIdx1,
    awayIdx2: entry.awayIdx2,
  });
});

// POST /api/setLunarSuperMatchPlayers
app.post("/api/setLunarSuperMatchPlayers", (req, res) => {
  const { homeIdx1, homeIdx2, awayIdx1, awayIdx2 } = req.body || {};

  function normIdx(v) {
    if (v === null || v === undefined || v === "" || v === 0) return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    if (num < 1 || num > MAX_PLAYERS) return null;
    return num;
  }

  lunarSuperMatchPlayers = {
    homeIdx1: normIdx(homeIdx1),
    homeIdx2: normIdx(homeIdx2),
    awayIdx1: normIdx(awayIdx1),
    awayIdx2: normIdx(awayIdx2),
  };

  saveStateToDisk();

  return res.json({ status: "ok", ...lunarSuperMatchPlayers });
});

// GET /api/adminState
app.get("/api/adminState", (req, res) => {
  const courtsAdmin = Object.values(courts).map((c) => ({
    courtId: c.courtId,
    adminHomeName: c.adminHomeName,
    adminAwayName: c.adminAwayName,
    homeIdx1: c.homeIdx1,
    homeIdx2: c.homeIdx2,
    awayIdx1: c.awayIdx1,
    awayIdx2: c.awayIdx2,
  }));

  res.json({
    homePlayers,
    awayPlayers,

    // NYT
    courtsMeta,
    standardVisibleCourts,

    courts: courtsAdmin,

    lunarEnabled,
    lunarCourts,
    lunarRound1,
    lunarRound2,
    lunarSuperMatchCourtId,
    lunarSuperMatchPlayers,
    lunarResults,
    lunarHomeWinsTotal,
    lunarAwayWinsTotal,
  });
});

// =====================
// SCOREBOARD: GET /api/courts
// =====================
app.get("/api/courts", (req, res) => {
  const now = Date.now();

  const list = Object.values(courts).map((c) => {
    const diffMs = now - c.lastUpdate;
    const online = diffMs < 5 * 60 * 1000; // 5 min

    const names = computeEffectiveNames(c);

    const hasMatchByPlayers =
      names.usedHomeIdx1 != null ||
      names.usedHomeIdx2 != null ||
      names.usedAwayIdx1 != null ||
      names.usedAwayIdx2 != null;

    const hasMatchByScore =
      c.homeGames > 0 ||
      c.awayGames > 0 ||
      c.homeSets > 0 ||
      c.awaySets > 0 ||
      c.homePoints > 0 ||
      c.awayPoints > 0;

    const hasMatch = hasMatchByPlayers || hasMatchByScore;

    return {
      ...c,
      online,
      hasMatch,
      homeName: names.effHome,
      awayName: names.effAway,
      isLunar: names.isLunar,
      isSuperMatchTie: names.isSuperMatchTie,
      lunarRoundUsed: names.lunarRoundUsed,
    };
  });

  res.json(list);
});

// =====================
// Static files
// =====================
app.use(express.static(path.join(__dirname, "public")));

// Load persisted state at startup
loadStateFromDisk();

// Start server
app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
