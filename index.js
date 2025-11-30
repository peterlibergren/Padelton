const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Simpel in-memory state for 5 baner
// (nulstilles hvis serveren genstartes – det er fint til nu)
const courts = {};
for (let i = 1; i <= 5; i++) {
  courts[i] = {
    courtId: i,
    // Navne fra controller/ESP (basisnavne)
    homeName: "Hjemme",
    awayName: "Ude",
    // Admin-overrides fra web-UI (kan være null)
    adminHomeName: null,
    adminAwayName: null,

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

// ===== Controller → cloud: scoreopdatering =====
// POST /api/updateScore
// kaldes af din controller-ESP når en bane ændrer score
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

  // Basisnavne kan evt. komme fra controlleren
  // (men admin-navne overskriver dem i /api/courts)
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

// ===== Admin → cloud: sæt spillernavne =====
// POST /api/setNames
// body: { courtId, homeName, awayName }
app.post("/api/setNames", (req, res) => {
  const { courtId, homeName, awayName } = req.body || {};

  if (!courtId || courtId < 1 || courtId > 5) {
    return res.status(400).json({ error: "Invalid courtId" });
  }

  const c = courts[courtId];

  // Gem som admin-overrides
  if (typeof homeName === "string") {
    c.adminHomeName = homeName.trim() || null;
  }
  if (typeof awayName === "string") {
    c.adminAwayName = awayName.trim() || null;
  }

  console.log(
    `[ADMIN] court ${courtId} names set to:`,
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

// ===== Scoreboard & view: hent alle baner =====
// GET /api/courts
app.get("/api/courts", (req, res) => {
  const now = Date.now();

  const list = Object.values(courts).map(c => {
    const online = now - c.lastUpdate < 10000; // online hvis opdateret inden for 10 sekunder

    // Effektive navne: admin-navn hvis sat, ellers basisnavn
    const effHomeName = c.adminHomeName || c.homeName;
    const effAwayName = c.adminAwayName || c.awayName;

    return {
      ...c,
      online,
      homeName: effHomeName,
      awayName: effAwayName,
    };
  });

  res.json(list);
});

// ===== Statisk hosting af public/ (index.html, view.html, admin.html, ...) =====
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
