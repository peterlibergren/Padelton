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

// ==== ADMIN — SÆT HVILKE SPILLERE SPILLER PÅ EN BANE ====
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

    // 2) admin-fritekst overskriver
    if (c.adminHomeName) effHome = c.adminHomeName;
    if (c.adminAwayName) effAway = c.adminAwayName;

    // 3) spillerliste-assignments overskriver begge dele, hvis sat
    const fromHomeRoster = buildNameFromIndices(
      "home",
      c.homeIdx1,
      c.homeIdx2
    );
    const fromAwayRoster = buildNameFromIndices(
      "away",
      c.awayIdx1,
      c.awayIdx2
    );

    if (fromHomeRoster) effHome = fromHomeRoster;
    if (fromAwayRoster) effAway = fromAwayRoster;

    // 4) HAR VI OVERHOVEDET EN KAMP?
    const hasMatchByPlayers =
      c.homeIdx1 != null ||
      c.homeIdx2 != null ||
      c.awayIdx1 != null ||
      c.awayIdx2 != null;

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
