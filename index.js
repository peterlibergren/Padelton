const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));
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

    homeName: "Hjemme",
    awayName: "Ude",

    adminHomeName: null,
    adminAwayName: null,

    homeIdx1: null,
    homeIdx2: null,
    awayIdx1: null,
    awayIdx2: null,

    homePoints: 0,
    awayPoints: 0,
    homePointsStr: "0",
    awayPointsStr: "0",
    homeGames: 0,
    awayGames: 0,
    homeSets: 0,
    awaySets: 0,

    set1Home: -1,
    set1Away: -1,
    set1LoserTbPoints: -1,
    set1LoserIsHome: false,

    set2Home: -1,
    set2Away: -1,
    set2LoserTbPoints: -1,
    set2LoserIsHome: false,

    setsStr: "",

    matchFinished: false,
    winner: 0,
    mtb3rd: false,

    online: false,
    lastUpdate: 0,
  };
}

// ==== LUNAR-STATE (i RAM) ====
let lunarEnabled = false;
let lunarCourts = [];
let lunarRound1 = [];
let lunarRound2 = [];
let lunarSuperMatchCourtId = null;
let lunarSuperMatchPlayers = {
  homeIdx1: null,
  homeIdx2: null,
  awayIdx1: null,
  awayIdx2: null,
};

// ==== LUNAR RESULTATER ====
let lunarResults = [];
let lunarHomeWinsTotal = 0;
let lunarAwayWinsTotal = 0;

// =====================
// NEW: CLOUD SETUP / COMMANDS (CONFIG) STATE
// =====================

// Per-court "QR/admin key" (mobilen skal have key for at poste config)
// Ligger i state.json så de overlever deploy/restart.
let courtSetupKeys = {
  1: "",
  2: "",
  3: "",
  4: "",
  5: "",
};

// Per-court pending config (ESP32 poller efter disse)
const pendingConfigs = {
  1: null,
  2: null,
  3: null,
  4: null,
  5: null,
};

// Helper: random key
function makeKey(len = 12) {
  // URL-safe-ish
  return crypto.randomBytes(Math.ceil(len)).toString("base64url").slice(0, len);
}

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

    // NEW
    courtSetupKeys,
    pendingConfigs,
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

  // NEW: setup keys
  if (s.courtSetupKeys && typeof s.courtSetupKeys === "object") {
    for (let i = 1; i <= 5; i++) {
      const v = s.courtSetupKeys[i];
      if (typeof v === "string") courtSetupKeys[i] = v;
    }
  }

  // NEW: pending configs
  if (s.pendingConfigs && typeof s.pendingConfigs === "object") {
    for (let i = 1; i <= 5; i++) {
      const v = s.pendingConfigs[i];
      pendingConfigs[i] = v && typeof v === "object" ? v : null;
    }
  }

  console.log("[STATE] Loaded:", STATE_FILE);
}

// Ensure keys exist (create on first boot)
function ensureCourtKeys() {
  let changed = false;
  for (let i = 1; i <= 5; i++) {
    if (!courtSetupKeys[i] || String(courtSetupKeys[i]).trim().length < 6) {
      courtSetupKeys[i] = makeKey(16);
      changed = true;
    }
  }
  if (changed) {
    console.log("[SETUP] Generated new courtSetupKeys");
    saveStateToDisk();
  }
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

  if (c.adminHomeName) effHome = c.adminHomeName;
  if (c.adminAwayName) effAway = c.adminAwayName;

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

function toBool(v, def) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  }
  return def;
}

function cleanCourtId(req) {
  const cid = Number(req.params?.id);
  if (!Number.isFinite(cid) || cid < 1 || cid > 5) return null;
  return cid;
}

// =====================
// NEW: CLOUD SETUP API
// =====================

// POST /api/court/:id/config   (mobil UI -> cloud)
// Body: { key, goldenMT, countPoints, goldenPoint, bo3, mtb3 }
app.post("/api/court/:id/config", (req, res) => {
  const courtId = cleanCourtId(req);
  if (!courtId) return res.status(400).json({ error: "Invalid courtId" });

  const body = req.body || {};
  const key = typeof body.key === "string" ? body.key.trim() : "";

  if (!key || key !== courtSetupKeys[courtId]) {
    return res.status(403).json({ error: "Bad key" });
  }

  // sanitize booleans
  const cfg = {
    goldenMT: toBool(body.goldenMT, false),
    countPoints: toBool(body.countPoints, true),
    goldenPoint: toBool(body.goldenPoint, true),
    bo3: toBool(body.bo3, true),
    mtb3: toBool(body.mtb3, false),
  };

  // Enforce constraints (same as your UI logic)
  if (cfg.goldenMT) {
    // goldenMT mode ignores everything else
    cfg.countPoints = true;
    cfg.goldenPoint = false;
    cfg.bo3 = false;
    cfg.mtb3 = false;
  } else {
    // Parti => goldenPoint irrelevant
    if (!cfg.countPoints) cfg.goldenPoint = false;
    // Kont. => no mtb3
    if (!cfg.bo3) cfg.mtb3 = false;
  }

  const cfgId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 min

  pendingConfigs[courtId] = {
    cfgId,
    courtId,
    cfg,
    status: "pending",
    createdAt: now,
    expiresAt,
    appliedAt: null,
  };

  saveStateToDisk();

  return res.json({ status: "ok", cfgId, courtId });
});

// GET /api/court/:id/config/pending  (ESP32 -> cloud poll)
// Header: x-device-key: <optional> (kan du bruge cloudApiKey senere)
// Returns: { pending: true/false, cfgId, cfg } (+ timestamps)
app.get("/api/court/:id/config/pending", (req, res) => {
  const courtId = cleanCourtId(req);
  if (!courtId) return res.status(400).json({ error: "Invalid courtId" });

  const entry = pendingConfigs[courtId];
  if (!entry) return res.json({ pending: false });

  // expire
  if (Date.now() > Number(entry.expiresAt || 0)) {
    pendingConfigs[courtId] = null;
    saveStateToDisk();
    return res.json({ pending: false, expired: true });
  }

  return res.json({
    pending: true,
    cfgId: entry.cfgId,
    courtId,
    cfg: entry.cfg,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  });
});

// POST /api/court/:id/config/ack  (ESP32 -> cloud)
// Body: { cfgId, ok=true/false, message? }
app.post("/api/court/:id/config/ack", (req, res) => {
  const courtId = cleanCourtId(req);
  if (!courtId) return res.status(400).json({ error: "Invalid courtId" });

  const body = req.body || {};
  const cfgId = typeof body.cfgId === "string" ? body.cfgId.trim() : "";
  const ok = toBool(body.ok, true);
  const message = typeof body.message === "string" ? body.message.slice(0, 200) : "";

  const entry = pendingConfigs[courtId];
  if (!entry) return res.status(404).json({ error: "No pending config" });
  if (!cfgId || cfgId !== entry.cfgId) return res.status(409).json({ error: "cfgId mismatch" });

  // mark applied and clear pending (simple model)
  entry.status = ok ? "applied" : "failed";
  entry.appliedAt = Date.now();
  entry.message = message || null;

  // clear pending so it won't re-apply
  pendingConfigs[courtId] = null;

  saveStateToDisk();

  return res.json({ status: "ok" });
});

// GET /api/court/:id/setupKey  (OPTIONAL: admin/debug - fjern senere hvis du vil)
// app.get("/api/court/:id/setupKey", (req,res)=>{ ... })

// =====================
// NEW: Cloud setup UI page (very simple)
// =====================
// GET /court/:id/setup?key=XXXXX
app.get("/court/:id/setup", (req, res) => {
  const courtId = cleanCourtId(req);
  if (!courtId) return res.status(400).send("Bad court id");

  const key = typeof req.query.key === "string" ? req.query.key.trim() : "";
  if (!key || key !== courtSetupKeys[courtId]) {
    return res.status(403).send("Bad key");
  }

  const sponsor = (courtsMeta.find((c) => c.id === courtId)?.sponsor || `Court ${courtId}`).toString();

  // Minimal HTML UI (du kan senere erstatte med din egen admin.html styling)
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Setup – ${escapeHtml(sponsor)}</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:18px;max-width:780px}
    .card{border:1px solid #ddd;border-radius:12px;padding:14px;margin:12px 0}
    .section-title{font-weight:800;margin:12px 0 6px 0;font-size:16px}
    .hint{color:#555;font-size:13px;line-height:1.35;margin:6px 0 0 0}
    .setting{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;margin:14px 0}
    .setting .left,.setting .right{font-size:15px;text-align:center;line-height:1.2}
    .setting small{color:#666;font-size:12px}
    .switch{position:relative;width:56px;height:30px}
    .switch input{display:none}
    .slider{position:absolute;inset:0;background:#ccc;border-radius:999px;transition:.25s}
    .slider:before{content:"";position:absolute;height:24px;width:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.25s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
    .switch input:checked + .slider{background:#0b57d0}
    .switch input:checked + .slider:before{transform:translateX(26px)}
    .disabled{opacity:0.45;pointer-events:none}
    .btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    button{padding:10px 14px;border-radius:10px;border:1px solid #333;background:#111;color:#fff;font-size:16px}
    .pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#eee;font-size:12px}
  </style>
</head>
<body>
  <h2>Setup – ${escapeHtml(sponsor)}</h2>

  <div class="card">
    <b>Bane</b>: <span class="pill">${courtId}</span><br>
    <p class="hint">Når du trykker <b>Start match</b>, sendes opsætningen til boksen på banen.</p>
  </div>

  <div class="card">
    <form id="f">
      <div class="section-title">Kampformat</div>
      <div class="setting">
        <div class="left">Kamp<br><small>(partier & sets)</small></div>
        <label class="switch">
          <input id="goldenMT" type="checkbox">
          <span class="slider"></span>
        </label>
        <div class="right">Gold MT<br><small>(direkte MatchTB)</small></div>
      </div>

      <div id="grpRest">
        <div class="section-title">Tælling</div>
        <div class="setting">
          <div class="left">Parti<br><small>(hvert tryk = parti)</small></div>
          <label class="switch">
            <input id="countPoints" type="checkbox" checked>
            <span class="slider"></span>
          </label>
          <div class="right">Point<br><small>(0/15/30/40)</small></div>
        </div>

        <div id="grpGoldenPoint">
          <div class="section-title">Der spilles med...</div>
          <div class="setting">
            <div class="left">Fordel</div>
            <label class="switch">
              <input id="goldenPoint" type="checkbox" checked>
              <span class="slider"></span>
            </label>
            <div class="right">Golden</div>
          </div>
        </div>

        <div class="section-title">Sæt-tælling</div>
        <div class="setting">
          <div class="left">Kontinuerlig</div>
          <label class="switch">
            <input id="bo3" type="checkbox" checked>
            <span class="slider"></span>
          </label>
          <div class="right">3 sæt</div>
        </div>

        <div id="grpThirdSetMode">
          <div class="section-title">3. sæt afgøres med...</div>
          <div class="setting">
            <div class="left">Fuld 3.</div>
            <label class="switch">
              <input id="mtb3" type="checkbox">
              <span class="slider"></span>
            </label>
            <div class="right">MatchTB</div>
          </div>
        </div>
      </div>

      <div class="btnrow">
        <button type="submit">Start match</button>
      </div>

      <p id="status" class="hint"></p>
    </form>
  </div>

  <script>
    const KEY = ${JSON.stringify(key)};
    const COURT = ${JSON.stringify(courtId)};

    function $(id){ return document.getElementById(id); }
    function setDisabled(el, dis){ if(!el) return; if(dis) el.classList.add('disabled'); else el.classList.remove('disabled'); }

    function refreshUI(){
      const gmt = $('goldenMT').checked;
      const cp = $('countPoints').checked; // true=Point false=Parti
      const bo3 = $('bo3').checked;        // true=3set false=Kont
      setDisabled($('grpRest'), gmt);
      setDisabled($('grpGoldenPoint'), (!cp) && (!gmt));
      const disThird = (!bo3) && (!gmt);
      setDisabled($('grpThirdSetMode'), disThird);
      if(disThird) $('mtb3').checked = false;
    }

    ['goldenMT','countPoints','bo3','mtb3'].forEach(id => $(id).addEventListener('change', refreshUI));
    refreshUI();

    $('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('status').textContent = 'Sender...';
      try{
        const payload = {
          key: KEY,
          goldenMT: $('goldenMT').checked,
          countPoints: $('countPoints').checked,
          goldenPoint: $('goldenPoint').checked,
          bo3: $('bo3').checked,
          mtb3: $('mtb3').checked
        };
        const r = await fetch('/api/court/' + COURT + '/config', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        const j = await r.json();
        if(!r.ok){ throw new Error(j && j.error ? j.error : 'fail'); }
        $('status').textContent = 'Sendt ✅ (cfgId ' + j.cfgId + '). Boksen anvender den typisk indenfor 1-2 sek.';
      }catch(err){
        $('status').textContent = 'Fejl: ' + (err.message || err);
      }
    });
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

  if (c.matchFinished && (!c.winner || c.winner === 0)) {
    const hs = Number(c.homeSets || 0);
    const as = Number(c.awaySets || 0);
    if (hs > as) c.winner = 1;
    else if (as > hs) c.winner = 2;
  }

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

    saveStateToDisk();
  }

  c.lastUpdate = Date.now();
  c.online = true;

  res.json({ status: "ok" });
});

// =====================
// ADMIN endpoints (unchanged)
// =====================

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
    standardVisibleCourts = [1, 2, 3, 4, 5];
  }

  saveStateToDisk();

  return res.json({ status: "ok", standardVisibleCourts });
});

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

app.post("/api/setLunarConfig", (req, res) => {
  const body = req.body || {};
  const { lunarEnabled: enabledFromClient, lunarCourts: courtsFromClient, lunarSuperMatchCourtId: superFromClient } = body;

  lunarEnabled = !!enabledFromClient;

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

  if (Array.isArray(courtsFromClient)) {
    lunarCourts = courtsFromClient.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  } else {
    lunarCourts = [];
  }

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

    // NEW (useful for printing QR once)
    courtSetupKeys,
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

// Ensure per-court QR keys exist
ensureCourtKeys();

// Start server
app.listen(PORT, () => {
  console.log(`Padelton cloud server lytter på port ${PORT}`);
});
