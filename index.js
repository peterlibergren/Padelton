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
    matchFinished: false,   // true = kampen er slut
    winner: 0,              // 0 = ingen, 1 = hjemme, 2 = ude
    mtb3rd: false,          // true = 3. sæt er match-tie til 10

    online: false,
    lastUpdate: 0,
  };
}

// ==== LUNAR-STATE (i RAM) ====
// Om LUNAR-format er aktivt, hvilke baner der er valgt, og spillerpar for runde 1 og 2
let lunarEnabled = false;          // true/false
let lunarCourts = [];              // fx [1,2,3]
let lunarRound1 = [];              // [{ courtId, homeIdx1, homeIdx2, awayIdx1, awayIdx2 }, ...]
let lunarRound2 = [];              // samme struktur
let lunarSuperMatchCourtId = null; // bane til SUPER MATCH-TIE (7. kamp)
let lunarSuperMatchPlayers = {     // spiller-indices til 7. kamp
  homeIdx1: null,
  homeIdx2: null,
  awayIdx1: null,
  awayIdx2: null,
};

// ==== LUNAR RESULTATER ====
// Gemmer et "snapshot" for hver færdigspillet LUNAR-kamp
// round: 1, 2 eller 7 (Super)
// winner: 1 = hjemme, 2 = ude
let lunarResults = [];  // [{ round, courtId, homeName, awayName, setsStr, set1Home, ... , winner }]

// Globale LUNAR-stillinger (antal vundne kampe samlet)
let lunarHomeWinsTotal = 0;
let lunarAwayWinsTotal = 0;

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

// Giver samme "effektive" navne som scoreboardet bruger i /api/courts
function computeEffectiveNames(c) {
  const isLunar =
    lunarEnabled &&
    Array.isArray(lunarCourts) &&
    lunarCourts.includes(c.courtId);

  const isSuperMatchTie = isLunar && lunarSuperMatchCourtId === c.courtId;

  let effHome = c.homeName;
  let effAway = c.awayName;

  let usedHomeIdx1 = c.homeIdx1;
  let usedHomeIdx2 = c.homeIdx2;
  let usedAwayIdx1 = c.awayIdx1;
  let usedAwayIdx2 = c.awayIdx2;
  let lunarRoundUsed = null;

  // LUNAR round 1/2 overrides (samme logik som i /api/courts)
  if (isLunar) {
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
      lunarRoundUsed = hasR2 ? 2 : 1;
    }
  }

  // SUPER MATCH-TIE override (spillere til 7. kamp)
  if (isLunar && isSuperMatchTie && lunarSuperMatchPlayers) {
    const p = lunarSuperMatchPlayers;
    const hasAny =
      p.homeIdx1 != null || p.homeIdx2 != null ||
      p.awayIdx1 != null || p.awayIdx2 != null;

    if (hasAny) {
      usedHomeIdx1 = p.homeIdx1 ?? null;
      usedHomeIdx2 = p.homeIdx2 ?? null;
      usedAwayIdx1 = p.awayIdx1 ?? null;
      usedAwayIdx2 = p.awayIdx2 ?? null;
    }
  }

  // Admin-navne
  if (c.adminHomeName) effHome = c.adminHomeName;
  if (c.adminAwayName) effAway = c.adminAwayName;

  // Spillerlister → "Peter / Lars"
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

    // set-felter fra controller
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

    // kampstatus + 3. sæt-format
    matchFinished,
    winner,
    mtb3rd,
  } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  // Gem tidligere kampstatus for LUNAR-tælling og logging
  const prevFinished = !!c.matchFinished;
  const prevWinner   = Number(c.winner || 0); // 0,1,2

  // Hjælpere til parse ints/bools
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

  // Basisnavne (admin/spillerliste kan overskrive senere i /api/courts)
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

  // set-historik
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

  // Kampstatus + vinder + 3. sæt-format
  if (matchFinished !== undefined) {
    c.matchFinished = toBool(matchFinished, false);
  }
  if (winner !== undefined) {
    c.winner = toIntOrDefault(winner, 0); // 0,1,2
  }
  if (mtb3rd !== undefined) {
    c.mtb3rd = toBool(mtb3rd, false);
  }

  // 🔹 NYT: hvis kampen er markeret som færdig, men winner = 0/mangler,
  // så udled vinder ud fra antal vundne sæt.
  if (c.matchFinished && (!c.winner || c.winner === 0)) {
    const hs = Number(c.homeSets || 0);
    const as = Number(c.awaySets || 0);
    if (hs > as) {
      c.winner = 1;
    } else if (as > hs) {
      c.winner = 2;
    }
  }

  const newFinished = !!c.matchFinished;
  const newWinner   = Number(c.winner || 0);

  // Er denne bane en del af LUNAR?
  const isLunar =
    lunarEnabled &&
    Array.isArray(lunarCourts) &&
    lunarCourts.includes(courtId);

  // Kun relevant hvis det er en LUNAR-bane OG kampen er (eller er blevet) færdig
  if (isLunar && newFinished) {
    // Brug samme navne og spiller-indeks som scoreboardet
    const names = computeEffectiveNames(c);

    // Bestem grund-runden (1 eller 2) ud fra opsætningen
    let round = 1;
    const hasR2 =
      Array.isArray(lunarRound2) &&
      lunarRound2.some(e => e.courtId === courtId);
    if (hasR2) round = 2;

    // Er dette faktisk SUPER MATCH-kampen (7. kamp)?
    let isSuperMatchRound = false;
    if (
      lunarSuperMatchCourtId != null &&
      lunarSuperMatchCourtId === courtId &&
      lunarSuperMatchPlayers
    ) {
      const sp = lunarSuperMatchPlayers;
      const haveSuperIndices =
        sp.homeIdx1 != null || sp.homeIdx2 != null ||
        sp.awayIdx1 != null || sp.awayIdx2 != null;

      // Kun hvis der er defineret spillere til 7. kamp,
      // og den aktuelle kamp bruger præcis de samme indices,
      // kalder vi det runde 7.
      if (haveSuperIndices) {
        const sameHome =
          names.usedHomeIdx1 === sp.homeIdx1 &&
          names.usedHomeIdx2 === sp.homeIdx2;
        const sameAway =
          names.usedAwayIdx1 === sp.awayIdx1 &&
          names.usedAwayIdx2 === sp.awayIdx2;

        if (sameHome && sameAway) {
          isSuperMatchRound = true;
        }
      }
    }

    if (isSuperMatchRound) {
      round = 7;
    }

    // ⭐ Tæl kun sejren med i totalstillingen,
    // når vi går fra "ikke færdig" -> "færdig"
    if (!prevFinished) {
      if (newWinner === 1) {
        lunarHomeWinsTotal++;
      } else if (newWinner === 2) {
        lunarAwayWinsTotal++;
      }
    }

    // Byg snapshot af kampen til slutskærm (inkl. per-sæt data)
    const snapshot = {
      round,
      courtId,

      // Navne på det tidspunkt kampen (sidst) opdateres som færdig
      homeName: names.effHome,
      awayName: names.effAway,

      // Samlet set-streng (fx "6-4,5-7,7-6(4)" eller "6-4;5-7;7-6(4)")
      setsStr: c.setsStr || "",

      // Per-sæt score (de samme felter som scoreboardet bruger)
      set1Home: c.set1Home,
      set1Away: c.set1Away,
      set1LoserTbPoints: c.set1LoserTbPoints,
      set1LoserIsHome: c.set1LoserIsHome,

      set2Home: c.set2Home,
      set2Away: c.set2Away,
      set2LoserTbPoints: c.set2LoserTbPoints,
      set2LoserIsHome: c.set2LoserIsHome,

      // Totalt antal sæt vundet
      homeSets: typeof c.homeSets === "number" ? c.homeSets : Number(c.homeSets || 0),
      awaySets: typeof c.awaySets === "number" ? c.awaySets : Number(c.awaySets || 0),

      // Vinder af kampen
      winner: newWinner,
    };

    // 🔁 Enten opdatér eksisterende resultat for denne (bane, runde)
    // eller tilføj et nyt, hvis det er første gang
    const existingIndex = lunarResults.findIndex(
      r => r.courtId === courtId && r.round === round
    );

    if (existingIndex >= 0) {
      lunarResults[existingIndex] = snapshot;
      console.log(
        `🔹 LUNAR kamp opdateret på bane ${courtId} (runde ${round}) – vinder: ${newWinner}`
      );
    } else {
      lunarResults.push(snapshot);
      console.log(
        `🔹 LUNAR kamp afsluttet på bane ${courtId} (runde ${round}) – vinder: ${newWinner}`
      );
    }
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

// ==== LUNAR — GEM OPSÆTNING (ON/OFF + BANER + SUPER MATCH-TIE) ====
// POST /api/setLunarConfig
app.post("/api/setLunarConfig", (req, res) => {
  const body = req.body || {};
  const {
    lunarEnabled: enabledFromClient,
    lunarCourts: courtsFromClient,
    lunarSuperMatchCourtId: superFromClient,
  } = body;

  // On/off
  lunarEnabled = !!enabledFromClient;

  // Hvis LUNAR slås FRA → ryd alt LUNAR-state + stillinger + resultater
  if (!lunarEnabled) {
    lunarCourts = [];
    lunarRound1 = [];
    lunarRound2 = [];
    lunarSuperMatchCourtId = null;
    lunarSuperMatchPlayers = {
      homeIdx1: null,
      homeIdx2: null,
      awayIdx1: null,
      awayIdx2: null,
    };

    lunarHomeWinsTotal = 0;
    lunarAwayWinsTotal = 0;
    lunarResults = [];

    console.log("[LUNAR CONFIG] disabled + nulstil stilling + resultater");
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

  // Hvis vi ER her, er LUNAR slået TIL

  // Valgte LUNAR-baner
  if (Array.isArray(courtsFromClient)) {
    lunarCourts = courtsFromClient
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  } else {
    lunarCourts = [];
  }

  // SUPER MATCH-TIE bane (skal være en af LUNAR-banerne)
  let superId = null;
  if (superFromClient !== undefined && superFromClient !== null && superFromClient !== "") {
    const n = Number(superFromClient);
    if (Number.isFinite(n) && n >= 1 && n <= 5 && lunarCourts.includes(n)) {
      superId = n;
    }
  }

  lunarSuperMatchCourtId = superId;

  console.log("[LUNAR CONFIG] enabled:", lunarEnabled,
    "courts:", lunarCourts,
    "superMatchCourt:", lunarSuperMatchCourtId,
    "total H:", lunarHomeWinsTotal,
    "total A:", lunarAwayWinsTotal
  );

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

// ==== LUNAR — GEM SPILLERE TIL SUPER MATCH-TIE (7. kamp) ====
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

  console.log("[LUNAR SUPER MATCH PLAYERS]:", lunarSuperMatchPlayers);

  return res.json({
    status: "ok",
    ...lunarSuperMatchPlayers,
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
    lunarSuperMatchCourtId,
    lunarSuperMatchPlayers,
    lunarResults,
    lunarHomeWinsTotal,
    lunarAwayWinsTotal,
  });
});

// ==== SCOREBOARD & VIEW: HENT ALLE BANER ====
// GET /api/courts
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


// ==== STATISKE FILER (index.html, view.html, admin.html, ...) ====
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
