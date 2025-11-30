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

    // Score
    homePoints: 0,
    awayPoints: 0,
    homePointsStr: "0",
    awayPointsStr: "0",
    homeGames: 0,
    awayGames: 0,
    homeSets: 0,
    awaySets: 0,

    online: false,
    lastUpdate: 0,
  };
}

// ==== HJÆLPER: lav "Peter / Lars" ud fra indices ====
function buildNameFromIndices(side, idx1, idx2) {
  const list = side === "home" ? homePlayers : awayPlayers;
  const names = [];

  const indices = [idx1, idx2];
  indices.forEach(idx => {
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

  c.lastUpdate = Date.now();
  c.online = true;

  res.json({ status: "ok" });
});

// ==== (VALGFRI) DIREKTE ADMIN-NAVNE pr. bane ====
// POST /api/setNames  (fra tidligere løsning – vi lader den leve)
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

// ==== NYT: ADMIN — GEM SPILLER-LISTER ====
// POST /api/setRoster
// body: { homePlayers: [str...], awayPlayers: [str...] }
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

// ==== NYT: ADMIN — SÆT HVELE SPILLERE SPILLER PÅ EN BANE ====
// POST /api/setCourtPlayers
// body: { courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 }
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

// ==== NYT: ADMIN — HENT HELE ADMIN-STATE ====
// GET /api/adminState
// Bruges af admin.html til at udfylde felter og dropdowns
app.get("/api/adminState", (req, res) => {
  const courtsAdmin = Object.values(courts).map(c => ({
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

  const list = Object.values(courts).map(c => {
    const online = now - c.lastUpdate < 10000; // 10 sek.

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

    return {
      ...c,
      online,
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
