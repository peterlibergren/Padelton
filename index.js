const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// ==== SPILLER-LISTER (op til 16 pr. side) ====
const MAX_PLAYERS = 16;
let homePlayers = new Array(MAX_PLAYERS).fill("");
let awayPlayers = new Array(MAX_PLAYERS).fill("");

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

    // Spiller-valg (1..16, null = ingen)
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

    // NYT: set-historik (fra controlleren)
    // -1 betyder "ikke sat / ikke spillet"
    set1Home: -1,
    set1Away: -1,
    set1LoserTbPoints: -1,
    set1LoserIsHome: false,

    set2Home: -1,
    set2Away: -1,
    set2LoserTbPoints: -1,
    set2LoserIsHome: false,

    // valgfri fritekst, hvis du vil bruge den senere
    setsStr: "",

    online: false,
    lastUpdate: 0,
  };
}

// ==== LUNAR-STATE (i RAM) ====
// Om LUNAR-format er aktivt, hvilke baner der er valgt, og spillerpar for runde 1 og 2
let lunarEnabled = false;      // true/false
let lunarCourts = [];          // fx [1,2,3]
let lunarRound1 = [];          // [{ courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 }, ...]
let lunarRound2 = [];          // samme struktur som runde 1

// ==== HJÆLPER: lav "Peter / Lars" ud fra indices ====
function buildNameFromIndices(side, idx1, idx2) {
  const list = side === "home" ? homePlayers : awayPlayers;
  const names = [];

  const indices = [idx1, idx2];
  indices.forEach((idx) => {
    if (typeof idx === "number" && idx >= 1 && idx <= MAX_PLAYERS) {
      const n = list[idx - 1];
      if (n && n.trim().length > 0) {
        names.push(n.trim());
      }
    }
  });

  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return names.join(" / ");
}

// ==== CONTROLLER → CLOUD: scoreopdatering ====
// POST /api/updateScore
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

    // NYT: set-felter fra controller
    set1Home,
    set1Away,
    set1LoserTbPoints,
    set1LoserIsHome,
    set2Home,
    set2Away,
    set2LoserTbPoints,
    set2LoserIsHome,

    // valgfri samlet streng
    setsStr,
  } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  // Basisnavne (admin/spillerliste kan overskrive senere)
  if (homeName !== undefined) c.homeName = homeName;
  if (awayName !== undefined) c.awayName = awayName;

  if (homePoints !== undefined) c.homePoints = homePoints;
  if (awayPoints !== undefined) c.awayPoints = awayPoints;
  if (homePointsStr !== undefined) c.homePointsStr = homePointsStr;
  if (awayPointsStr !== undefined) c.awayPointsStr = awayPointsStr;

  if (homeGames !== undefined) c.homeGames = homeGames;
  if (awayGames !== undefined) c.awayGames = awayGames;
  if (homeSets !== undefined) c.homeSets = homeSets;
  if (awaySets !== undefined) c.awaySets = awaySets;

  // NYT: set-historik (konverter til tal/bool)
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

  if (set1Home !== undefined) c.set1Home = toIntOrDefault(set1Home, -1);
  if (set1Away !== undefined) c.set1Away = toIntOrDefault(set1Away, -1);
  if (set1LoserTbPoints !== undefined)
    c.set1LoserTbPoints = toIntOrDefault(set1LoserTbPoints, -1);
  if (set1LoserIsHome !== undefined)
    c.set1LoserIsHome = toBool(set1LoserIsHome, false);

  if (set2Home !== undefined) c.set2Home = toIntOrDefault(set2Home, -1);
  if (set2Away !== undefined) c.set2Away = toIntOrDefault(set2Away, -1);
  if (set2LoserTbPoints !== undefined)
    c.set2LoserTbPoints = toIntOrDefault(set2LoserTbPoints, -1);
  if (set2LoserIsHome !== undefined)
    c.set2LoserIsHome = toBool(set2LoserIsHome, false);

  if (setsStr !== undefined) {
    c.setsStr =
      typeof setsStr === "string" ? setsStr : setsStr != null ? String(setsStr) : "";
  }

  c.lastUpdate = Date.now();
  c.online = true;

  res.json({ status: "ok" });
});

// ==== (VALGFRI) DIREKTE ADMIN-NAVNE pr. bane ====
// POST /api/setNames
app.post("/api/setNames", (req, res) => {
  const { courtId, homeName, awayName } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  if (typeof homeName === "string") {
    c.adminHomeName = homeName.trim() || null;
  }
  if (typeof awayName === "string") {
    c.adminAwayName = awayName.trim() || null;
  }

  console.log(
    `[ADMIN NAMES] court ${courtId}:`,
    c.adminHomeName,
    "vs",
    c.adminAwayName
  );

  return res.json({
    status: "ok",
    courtId,
    homeName: c.adminHomeName || c.homeName,
    awayName: c.adminAwayName || c.awayName,
  });
});

// ==== ADMIN — GEM SPILLER-LISTER ====
// POST /api/setRoster
app.post("/api/setRoster", (req, res) => {
  const body = req.body || {};
  const hp = Array.isArray(body.homePlayers) ? body.homePlayers : [];
  const ap = Array.isArray(body.awayPlayers) ? body.awayPlayers : [];

  // Normaliser til længde 16
  homePlayers = new Array(MAX_PLAYERS)
    .fill("")
    .map((_, i) => (typeof hp[i] === "string" ? hp[i].trim() : ""));
  awayPlayers = new Array(MAX_PLAYERS)
    .fill("")
    .map((_, i) => (typeof ap[i] === "string" ? ap[i].trim() : ""));

  console.log("[ADMIN ROSTER] Hjemme:", homePlayers);
  console.log("[ADMIN ROSTER] Ude:", awayPlayers);

  return res.json({
    status: "ok",
    homePlayers,
    awayPlayers,
  });
});

// ==== ADMIN — SÆT HVILKE SPILLERE SPILLER PÅ EN BANE (STANDARD) ====
// POST /api/setCourtPlayers
app.post("/api/setCourtPlayers", (req, res) => {
  const { courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  // Tillad null eller 1..16
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

  console.log(
    `[ADMIN COURT PLAYERS] court ${courtId}:`,
    "Hjemme:",
    c.homeIdx1,
    c.homeIdx2,
    "| Ude:",
    c.awayIdx1,
    c.awayIdx2
  );

  return res.json({
    status: "ok",
    courtId,
    homeIdx1: c.homeIdx1,
    homeIdx2: c.homeIdx2,
    awayIdx1: c.awayIdx1,
    awayIdx2: c.awayIdx2,
  });
});

// ==== LUNAR — GEM OPSÆTNING (ON/OFF + BANER) ====
// POST /api/setLunarConfig
app.post("/api/setLunarConfig", (req, res) => {
  const body = req.body || {};
  const { lunarEnabled: enabledFromClient, lunarCourts: courtsFromClient } = body;

  lunarEnabled = !!enabledFromClient;

  if (Array.isArray(courtsFromClient)) {
    lunarCourts = courtsFromClient
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  } else {
    lunarCourts = [];
  }

  // Her kunne du evt. trimme til max 3 baner:
  // lunarCourts = lunarCourts.slice(0, 3);

  console.log("[LUNAR CONFIG] enabled:", lunarEnabled, "courts:", lunarCourts);

  return res.json({
    status: "ok",
    lunarEnabled,
    lunarCourts,
  });
});

// ==== LUNAR — GEM SPILLERPAR PR. BANE & RUNDE ====
// POST /api/setLunarCourtPlayers
app.post("/api/setLunarCourtPlayers", (req, res) => {
  const { round, courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 } = req.body || {};

  const r = Number(round);
  const cid = Number(courtId);

  if (r !== 1 && r !== 2) {
    return res.status(400).json({ error: "round skal være 1 eller 2" });
  }
  if (!cid || cid < 1 || cid > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  // Tillad null eller 1..16 (samme logik som ovenfor)
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

  console.log(
    `[LUNAR ROUND ${r}] court ${cid}:`,
    "Hjemme:",
    entry.homeIdx1,
    entry.homeIdx2,
    "| Ude:",
    entry.awayIdx1,
    entry.awayIdx2
  );

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

// ==== ADMIN — HENT HELE ADMIN-STATE ====
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
    courts: courtsAdmin,
    lunarEnabled,
    lunarCourts,
    lunarRound1,
    lunarRound2,
  });
});

// ==== SCOREBOARD & VIEW: HENT ALLE BANER ====
// GET /api/courts
app.get("/api/courts", (req, res) => {
  const now = Date.now();

  const list = Object.values(courts).map((c) => {
    // ONLINE: har vi hørt fra banen inden for de sidste 5 minutter?
    const diffMs = now - c.lastUpdate;
    const online = diffMs < 5 * 60 * 1000; // 5 min

    // 1) start med basisnavne (fra controller)
    let effHome = c.homeName;
    let effAway = c.awayName;

    // ==== NYT: find evt. LUNAR-indekser for denne bane ====
    let usedHomeIdx1 = c.homeIdx1;
    let usedHomeIdx2 = c.homeIdx2;
    let usedAwayIdx1 = c.awayIdx1;
    let usedAwayIdx2 = c.awayIdx2;

    if (lunarEnabled && Array.isArray(lunarCourts) && lunarCourts.includes(c.courtId)) {
      // prøv først at finde entry i runde 2, ellers runde 1
      let r2 = Array.isArray(lunarRound2)
        ? lunarRound2.find(e => e.courtId === c.courtId)
        : null;
      let r1 = Array.isArray(lunarRound1)
        ? lunarRound1.find(e => e.courtId === c.courtId)
        : null;

      const hasR2 =
        r2 &&
        (r2.homeIdx1 != null || r2.homeIdx2 != null || r2.awayIdx1 != null || r2.awayIdx2 != null);
      const hasR1 =
        r1 &&
        (r1.homeIdx1 != null || r1.homeIdx2 != null || r1.awayIdx1 != null || r1.awayIdx2 != null);

      const src = hasR2 ? r2 : hasR1 ? r1 : null;

      if (src) {
        usedHomeIdx1 = src.homeIdx1 ?? null;
        usedHomeIdx2 = src.homeIdx2 ?? null;
        usedAwayIdx1 = src.awayIdx1 ?? null;
        usedAwayIdx2 = src.awayIdx2 ?? null;
      }
    }

    // 2) admin-fritekst overskriver basisnavne
    if (c.adminHomeName) effHome = c.adminHomeName;
    if (c.adminAwayName) effAway = c.adminAwayName;

    // 3) spillerliste-assignments overskriver begge dele, hvis sat
    const fromHomeRoster = buildNameFromIndices(
      "home",
      usedHomeIdx1,
      usedHomeIdx2
    );
    const fromAwayRoster = buildNameFromIndices(
      "away",
      usedAwayIdx1,
      usedAwayIdx2
    );

    if (fromHomeRoster) effHome = fromHomeRoster;
    if (fromAwayRoster) effAway = fromAwayRoster;

    // 4) HAR VI OVERHOVEDET EN KAMP?
    const hasMatchByPlayers =
      usedHomeIdx1 != null ||
      usedHomeIdx2 != null ||
      usedAwayIdx1 != null ||
      usedAwayIdx2 != null;

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
      homeName: effHome,
      awayName: effAway,
    };
  });

  res.json(list);
});


// ==== STATISKE FILER (index.html, view.html, admin.html, ...) ====
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
