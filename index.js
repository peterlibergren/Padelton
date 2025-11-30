const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Tillad JSON-body
app.use(express.json());

// Tillad CORS (så din browser kan kalde API’et fra andre domæner)
app.use(cors());

// Simpel in-memory state for 5 baner
const courts = {};
for (let i = 1; i <= 5; i++) {
  courts[i] = {
    courtId: i,
    homeName: "Hjemme",
    awayName: "Ude",
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

// API som controller-ESP kalder
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

// API som scoreboardet kalder
// GET /api/courts
app.get("/api/courts", (req, res) => {
  const now = Date.now();

  const list = Object.values(courts).map(c => {
    const online = now - c.lastUpdate < 10000; // 10 sekunder
    return {
      ...c,
      online,
    };
  });

  res.json(list);
});

// Server statiske filer fra ./public (scoreboard.html)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
