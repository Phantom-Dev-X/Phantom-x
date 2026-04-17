const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const telBot = new Telegraf(TELEGRAM_TOKEN);
const MAX_RETRIES = 5;
const BOT_VERSION = "1.0.0";
const SETTINGS_FILE = path.join(__dirname, "group_settings.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const MODE_FILE = path.join(__dirname, "bot_mode.json");
const MENU_BANNER_FILE = path.join(__dirname, "menu_banner.jpg");
const THEME_FILE = path.join(__dirname, "menu_theme.json");

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

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

function containsLink(text) {
    return /https?:\/\/|wa\.me\/|chat\.whatsapp\.com\/|bit\.ly\/|t\.me\//i.test(text);
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

// --- OCR (Extract text from image via OCR.space free API) ---
function ocrFromBuffer(imageBuffer) {
    return new Promise((resolve, reject) => {
        const base64 = imageBuffer.toString("base64");
        const postData = `base64Image=data:image/jpeg;base64,${encodeURIComponent(base64)}&language=eng&isOverlayRequired=false`;
        const req = https.request({
            hostname: "api.ocr.space",
            path: "/parse/image",
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "apikey": "helloworld" },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const result = JSON.parse(data);
                    const text = result.ParsedResults?.[0]?.ParsedText || "";
                    resolve(text.trim());
                } catch { reject(new Error("OCR parse failed")); }
            });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

// --- FOOTBALL HELPERS (ESPN unofficial API) ---
const AUTO_REACT_EMOJIS = ["❤️", "🔥", "😂", "👍", "😍", "🎉", "💯", "🙏", "😎", "🤩"];

async function getPLTable() {
    const data = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings");
    const entries = data.standings?.[0]?.entries || [];
    let text = "🏆 *Premier League Table*\n━━━━━━━━━━━━━━━━━━━\n";
    for (let i = 0; i < Math.min(entries.length, 20); i++) {
        const e = entries[i];
        const stats = {};
        for (const s of e.stats || []) stats[s.name] = s.displayValue ?? s.value;
        text += `*${i + 1}.* ${e.team.displayName} — P:${stats.gamesPlayed || 0} W:${stats.wins || 0} D:${stats.ties || 0} L:${stats.losses || 0} *Pts:${stats.points || 0}*\n`;
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

async function getClubInfo(sock, from, teamName) {
    const teamsData = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/teams?limit=50");
    const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];
    const team = teams.find(t => t.team.displayName.toLowerCase().includes(teamName.toLowerCase()) || t.team.shortDisplayName.toLowerCase().includes(teamName.toLowerCase()));
    return team ? team.team : null;
}

async function getClubFixtures(teamName) {
    const teamsData = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/teams?limit=50");
    const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];
    const team = teams.find(t => t.team.displayName.toLowerCase().includes(teamName.toLowerCase()) || t.team.shortDisplayName.toLowerCase().includes(teamName.toLowerCase()));
    if (!team) return null;
    const id = team.team.id;
    const sched = await fetchJSON(`https://site.api.espn.com/apis/v2/sports/soccer/eng.1/teams/${id}/schedule`);
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

// --- LYRICS (lyrics.ovh, free, no key) ---
async function getLyrics(artist, title) {
    const data = await fetchJSON(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    return data.lyrics || null;
}

// --- IMAGE GENERATION (Pollinations.ai, completely free, no key needed) ---
function buildImageGenUrl(prompt) {
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true`;
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

async function getClubNews(teamName) {
    const teamsData = await fetchJSON("https://site.api.espn.com/apis/v2/sports/soccer/eng.1/teams?limit=50");
    const teams = teamsData.sports?.[0]?.leagues?.[0]?.teams || [];
    const team = teams.find(t => t.team.displayName.toLowerCase().includes(teamName.toLowerCase()) || t.team.shortDisplayName.toLowerCase().includes(teamName.toLowerCase()));
    if (!team) return null;
    const id = team.team.id;
    const newsData = await fetchJSON(`https://site.api.espn.com/apis/v2/sports/soccer/eng.1/news?team=${id}&limit=5`);
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
            ['.menu / .phantom', 'Show this menu'],
            ['.setpp', 'Set menu banner image (reply to image)'],
            ['.menudesign 1-5', 'Switch menu style'],
            ['.info', 'Bot info & uptime'],
            ['.help', 'Full command guide'],
            ['.mode public/owner', 'Switch access mode'],
        ]},
        { emoji: '📡', title: 'BROADCAST', items: [
            ['.broadcast ‹mins› ‹message›', 'Send to all groups on schedule'],
            ['.stopbroadcast', 'Stop active broadcast'],
        ]},
        { emoji: '👥', title: 'GROUP MANAGEMENT', items: [
            ['.add ‹number›', 'Add a member'],
            ['.kick @user', 'Remove a member'],
            ['.promote @user', 'Make someone admin'],
            ['.demote @user', 'Strip admin rights'],
            ['.link', 'Get group invite link'],
            ['.revoke', 'Reset group link'],
            ['.mute', 'Lock group (admins only)'],
            ['.unmute', 'Open group to everyone'],
        ]},
        { emoji: '🏷️', title: 'TAG & BROADCAST', items: [
            ['.hidetag', 'Silently tag all members'],
            ['.tagall', 'Tag all (shows @numbers)'],
            ['.readmore', 'Hide text behind Read More'],
        ]},
        { emoji: '⚙️', title: 'AUTOMATION', items: [
            ['.autoreact on/off/emoji', 'Auto-react to every message'],
            ['.autoreply add/remove/list', 'Keyword auto-replies'],
            ['.setalias ‹word› ‹.cmd›', 'Create command shortcut'],
            ['.delalias ‹word›', 'Delete a shortcut'],
            ['.aliases', 'List all shortcuts'],
        ]},
        { emoji: '🧠', title: 'AI & MEDIA', items: [
            ['.ai ‹question›', 'Ask Gemini AI'],
            ['.imagine ‹prompt›', 'Generate AI image'],
            ['.song ‹title›', 'Search songs (iTunes)'],
            ['.lyrics ‹artist› | ‹title›', 'Get song lyrics'],
            ['.ss ‹url›', 'Screenshot a website'],
            ['.viewonce', 'Reveal view-once (reply to it)'],
            ['.ocr', 'Extract text from image'],
        ]},
        { emoji: '🔍', title: 'UTILITIES', items: [
            ['.groupid', 'Get group / community ID'],
            ['.listonline', 'Show online members'],
            ['.listoffline', 'Show offline members'],
        ]},
        { emoji: '⚽', title: 'FOOTBALL', items: [
            ['.pltable', 'Premier League standings'],
            ['.live', 'Live PL scores'],
            ['.fixtures ‹club›', 'Club fixtures & results'],
            ['.fnews ‹club›', 'Club latest news'],
            ['.football ‹club›', 'Full club overview'],
        ]},
        { emoji: '🎮', title: 'GAMES', items: [
            ['.ttt @p1 @p2', 'Tic-Tac-Toe'],
            ['.truth', 'Truth question'],
            ['.dare', 'Dare challenge'],
            ['.wordchain [word]', 'Start word chain game'],
            ['.wordchain stop', 'End active game'],
        ]},
        { emoji: '🛡️', title: 'GROUP PROTECTION', items: [
            ['.antilink on/off', 'Block all links in group'],
            ['.antispam on/off', 'Block message spam'],
            ['.antidemote on/off', 'Punish demotions instantly'],
        ]},
        { emoji: '📣', title: 'NOTIFICATIONS', items: [
            ['.welcome on/off', 'Welcome new members'],
            ['.goodbye on/off', 'Goodbye on member exit'],
        ]},
        { emoji: '🔄', title: 'GC CLONE', items: [
            ['.clone ‹src› ‹dst› ‹batch› ‹mins›', 'Clone members to another group'],
            ['.stopclone', 'Stop active clone job'],
        ]},
    ];
}

// ─── THEME 1: GHOST (spaced, 〔〕 headers) ───
function buildThemeGhost(modeLabel, time, uptime, sections) {
    let out = `╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮
   ☠️  *P H A N T O M  ✘*  ☠️
   _The Ghost in Your Machine_ 👻
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯

◈ ◈ ◈  *S Y S T E M  S T A T U S*  ◈ ◈ ◈

  🤖  *Bot*      ›  Phantom X
  📌  *Version*  ›  v${BOT_VERSION}
  🌐  *Mode*     ›  ${modeLabel}
  ⏱️  *Uptime*   ›  ${uptime}
  🕐  *Time*     ›  ${time}
`;
    for (const sec of sections) {
        out += `\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n〔 ${sec.emoji} *${sec.title}* 〕\n\n`;
        for (const [cmd, desc] of sec.items) {
            out += `  ✦  *${cmd}*  —  ${desc}\n`;
        }
    }
    out += `\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n  💀 _Phantom X — Built Different. Built Cold._ 🖤\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
    return out.trim();
}

// ─── THEME 2: MATRIX (hacker / terminal) ───
function buildThemeMatrix(modeLabel, time, uptime, sections) {
    let out = `█▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀█
█   💻  *PHANTOM_X  v${BOT_VERSION}*  💻   █
█   _> SYSTEM ONLINE ✓_         █
█▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄█

*[ SYS_INFO ]*
  »  *Bot*    :  Phantom X
  »  *Mode*   :  ${modeLabel}
  »  *Uptime* :  ${uptime}
  »  *Time*   :  ${time}
`;
    for (const sec of sections) {
        out += `\n══════════════════════════════\n*[ MODULE :: ${sec.title} ]*  ${sec.emoji}\n`;
        for (const [cmd, desc] of sec.items) {
            out += `  *>*  \`${cmd}\`   //  ${desc}\n`;
        }
    }
    out += `\n══════════════════════════════\n_> PHANTOM_X — Ghost Protocol Active._ 👻`;
    return out.trim();
}

// ─── THEME 3: ROYAL (elegant crown style) ───
function buildThemeRoyal(modeLabel, time, uptime, sections) {
    let out = `♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛
         👑  *PHANTOM X*  👑
    _ꜱɪʟᴇɴᴛ. ᴅᴇᴀᴅʟʏ. ᴅɪɢɪᴛᴀʟ._
♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛

✦ *ROYAL STATUS* ✦

   ◆  *Bot*     ∷  Phantom X
   ◆  *Version* ∷  v${BOT_VERSION}
   ◆  *Mode*    ∷  ${modeLabel}
   ◆  *Uptime*  ∷  ${uptime}
   ◆  *Time*    ∷  ${time}
`;
    for (const sec of sections) {
        out += `\n═══════════════════════════════\n❖  *${sec.emoji} ${sec.title}*  ❖\n\n`;
        for (const [cmd, desc] of sec.items) {
            out += `   ◆  *${cmd}*  ▸  ${desc}\n`;
        }
    }
    out += `\n♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛\n  👑 _Phantom X — The Digital Monarch_ 🖤\n♛━━━━━━━━━━━━━━━━━━━━━━━━━━♛`;
    return out.trim();
}

// ─── THEME 4: INFERNO (fire / savage energy) ───
function buildThemeInferno(modeLabel, time, uptime, sections) {
    let out = `🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥
   💥  *P H A N T O M  X*  💥
   _No Cap. No Mercy. Built Cold._ 🥶
🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥

⚡ *SYSTEM STATUS* ⚡

  🔸  *Bot*     »  Phantom X
  🔸  *Version* »  v${BOT_VERSION}
  🔸  *Mode*    »  ${modeLabel}
  🔸  *Uptime*  »  ${uptime}
  🔸  *Time*    »  ${time}
`;
    for (const sec of sections) {
        out += `\n🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n💀 *${sec.emoji} ${sec.title}* 💀\n\n`;
        for (const [cmd, desc] of sec.items) {
            out += `  ⚡  *${cmd}*  ⟶  ${desc}\n`;
        }
    }
    out += `\n🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥\n  💀 _Phantom X — Straight Savage. No Filter._ 🔥\n🔥━━━━━━━━━━━━━━━━━━━━━━━━━━🔥`;
    return out.trim();
}

// ─── THEME 5: MINIMAL (clean, airy) ───
function buildThemeMinimal(modeLabel, time, uptime, sections) {
    let out = `─────────────────────────────
   ✧  *PHANTOM X*  ·  v${BOT_VERSION}  ✧
─────────────────────────────

  Bot    ·  Phantom X
  Mode   ·  ${modeLabel}
  Uptime ·  ${uptime}
  Time   ·  ${time}
`;
    for (const sec of sections) {
        out += `\n─────────────────────────────\n  *${sec.emoji} ${sec.title}*\n─────────────────────────────\n`;
        for (const [cmd, desc] of sec.items) {
            out += `  ›  *${cmd}*\n     ${desc}\n`;
        }
    }
    out += `\n─────────────────────────────\n  _Phantom X — Built Different_ 🖤\n─────────────────────────────`;
    return out.trim();
}

// --- MENU ---
function buildMenuText(mode, themeNum) {
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    const modeLabel = (mode || "public") === "owner" ? "👤 Owner Only" : "🌍 Public";
    const uptime = formatUptime();
    const n = Number(themeNum) || 1;
    const sections = getMenuSections();
    if (n === 2) return buildThemeMatrix(modeLabel, time, uptime, sections);
    if (n === 3) return buildThemeRoyal(modeLabel, time, uptime, sections);
    if (n === 4) return buildThemeInferno(modeLabel, time, uptime, sections);
    if (n === 5) return buildThemeMinimal(modeLabel, time, uptime, sections);
    return buildThemeGhost(modeLabel, time, uptime, sections);
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
        const botJid = sock.user?.id || null;
        const currentMode = getBotMode(botJid);
        // In owner mode, only process commands sent by the bot owner themselves (fromMe)
        if (currentMode === "owner" && !msg.key.fromMe && !isSelfChat) return;

        // --- GROUP PROTECTION (runs on every group message) ---
        if (isGroup) {
            // Anti-link
            if (getGroupSetting(from, "antilink") && rawBody && containsLink(rawBody)) {
                try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                await sock.sendMessage(from, {
                    text: `⚠️ @${senderJid.split("@")[0]}, links are not allowed here!`,
                    mentions: [senderJid],
                });
                return;
            }

            // Anti-spam
            if (getGroupSetting(from, "antispam") && rawBody) {
                if (isSpamming(senderJid)) {
                    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                    await sock.sendMessage(from, {
                        text: `🚫 @${senderJid.split("@")[0]}, slow down! You're sending messages too fast.`,
                        mentions: [senderJid],
                    });
                    return;
                }
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

        switch (cmd) {
            case ".menu":
            case ".phantom": {
                const menuText = buildMenuText(currentMode, getMenuTheme(botJid));
                if (fs.existsSync(MENU_BANNER_FILE)) {
                    try {
                        const bannerBuf = fs.readFileSync(MENU_BANNER_FILE);
                        await sock.sendMessage(from, { image: bannerBuf, caption: menuText }, { quoted: msg });
                    } catch (_) {
                        await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                    }
                } else {
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                }
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

            case ".mode": {
                const val = parts[1]?.toLowerCase();
                if (!["owner", "public"].includes(val)) {
                    return reply(
                        `⚙️ *Bot Mode Settings*\n\n` +
                        `Current mode: *${currentMode === "owner" ? "👤 Owner Only" : "🌍 Public"}*\n\n` +
                        `• *.mode public* — Anyone in groups can use commands\n` +
                        `• *.mode owner* — Only you (the bot owner) can use commands\n\n` +
                        `_Default is public._`
                    );
                }
                setBotMode(botJid, val);
                const label = val === "owner" ? "👤 Owner Only" : "🌍 Public";
                await reply(`✅ Bot mode set to *${label}*\n\n${val === "owner" ? "Only you can now trigger commands." : "Everyone in groups can now use commands."}`);
                break;
            }

            case ".menudesign": {
                const themeNames = {
                    1: "👻 Ghost — Spaced & Stylish",
                    2: "💻 Matrix — Hacker Terminal",
                    3: "👑 Royal — Elegant Crown",
                    4: "🔥 Inferno — Fire & Savage",
                    5: "✧ Minimal — Clean & Simple",
                };
                const n = parseInt(parts[1]);
                if (!n || n < 1 || n > 5) {
                    const current = getMenuTheme(botJid);
                    let list = `🎨 *Choose a Menu Design*\n\nCurrent: *${themeNames[current]}*\n\n`;
                    for (const [num, name] of Object.entries(themeNames)) {
                        list += `  *${num}.* ${name}\n`;
                    }
                    list += `\n_Usage: .menudesign 1  (or 2, 3, 4, 5)_`;
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

            case ".help": {
                await reply(
`📖 *Phantom X — Command Guide*
━━━━━━━━━━━━━━━━━━━━

📋 *GENERAL*
• *.menu* — Shows the main menu with bot info and a list of all commands
• *.info* — Shows the bot version and how long it's been running
• *.help* — Shows this guide explaining what every command does

━━━━━━━━━━━━━━━━━━━━
👥 *GROUP MANAGEMENT*
• *.add 234xxxxxxxx* — Adds a person to the group using their phone number (with country code, no +)
• *.kick @user* — Removes a tagged member from the group
• *.promote @user* — Makes a tagged member an admin
• *.demote @user* — Removes admin status from a tagged member
• *.link* — Gets the group's invite link and shares it in the chat
• *.revoke* — Resets the group invite link so the old one no longer works
• *.mute* — Locks the group so only admins can send messages
• *.unmute* — Unlocks the group so everyone can send messages again

━━━━━━━━━━━━━━━━━━━━
🛡️ *GROUP PROTECTION*
• *.antilink on/off* — When ON, any message containing a link (WhatsApp, website, etc.) is automatically deleted and the sender is warned
• *.antispam on/off* — When ON, anyone who sends more than 5 messages in 10 seconds gets their message deleted and receives a warning
• *.antidemote on/off* — When ON, if anyone tries to demote an admin, that person is immediately demoted as punishment and a message is sent saying the case is with the owner

━━━━━━━━━━━━━━━━━━━━
📣 *JOIN & LEAVE MESSAGES*
• *.welcome on/off* — When ON, the bot sends a welcome message every time a new member joins the group
• *.goodbye on/off* — When ON, the bot sends a farewell message whenever someone leaves the group

━━━━━━━━━━━━━━━━━━━━
🔄 *GC CLONE*
• *.clone <source-link> <dest-link> <per-batch> <mins>*
  Copies members from one group into another gradually.
  — source-link = group to copy members FROM
  — dest-link = group to add members TO
  — per-batch = how many people to add at once (1–10)
  — mins = how many minutes to wait between each batch (1–60)
  _Example: .clone link1 link2 2 5 = add 2 people every 5 mins_

• *.stopclone* — Stops a clone job that is currently running

━━━━━━━━━━━━━━━━━━━━
🚨 *AUTO-PROTECTION (always on)*
• If the bot is kicked from a group, you get an instant alert on Telegram and the bot automatically tries to rejoin the group on its own.

━━━━━━━━━━━━━━━━━━━━
💡 _Tip: All group commands require the bot to be an admin in the group._`
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
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antilink on/off");
                setGroupSetting(from, "antilink", val === "on");
                await reply(`🔗 Anti-link is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antispam": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antispam on/off");
                setGroupSetting(from, "antispam", val === "on");
                await reply(`🚫 Anti-spam is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antidemote": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antidemote on/off");
                setGroupSetting(from, "antidemote", val === "on");
                await reply(`🛡️ Anti-demote is now *${val.toUpperCase()}* in this group.`);
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
                if (!isGroup) return reply("This command only works in groups.");

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
                        sourceInfo = await sock.groupMetadata(sourceInput);
                        members = sourceInfo.participants.map(p => p.id);
                    } else {
                        const sourceCode = sourceInput.split("chat.whatsapp.com/")[1]?.trim();
                        if (!sourceCode) return reply("❌ Invalid source. Use a group link or group ID.");
                        sourceInfo = await sock.groupGetInviteInfo(sourceCode);
                        members = sourceInfo.participants.map(p => p.id);
                    }

                    if (!members.length) return reply("❌ No members found in the source group.");

                    // Resolve destination (link or group ID)
                    let destJid;
                    if (destInput.endsWith("@g.us")) {
                        destJid = destInput;
                    } else {
                        const destCode = destInput.split("chat.whatsapp.com/")[1]?.trim();
                        if (!destCode) return reply("❌ Invalid destination. Use a group link or group ID.");
                        try {
                            const destInfo = await sock.groupGetInviteInfo(destCode);
                            destJid = destInfo.id;
                        } catch {
                            destJid = await sock.groupAcceptInvite(destCode);
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

                    let index = 0;
                    const intervalMs = intervalMins * 60 * 1000;

                    const intervalId = setInterval(async () => {
                        if (index >= members.length) {
                            clearInterval(intervalId);
                            delete cloneJobs[from];
                            await sock.sendMessage(from, { text: "🎉 *Clone complete!* All members have been added to the destination group." });
                            return;
                        }

                        const batch = members.slice(index, index + batchSize);

                        for (const memberJid of batch) {
                            try {
                                await sock.groupParticipantsUpdate(destJid, [memberJid], "add");
                                await sock.sendMessage(from, {
                                    text: `➕ Added (${index + 1}/${members.length}): @${memberJid.split("@")[0]}`,
                                    mentions: [memberJid],
                                });
                            } catch (e) {
                                await sock.sendMessage(from, {
                                    text: `⚠️ Skipped @${memberJid.split("@")[0]}: ${e?.message || "failed"}`,
                                    mentions: [memberJid],
                                });
                            }
                            index++;
                        }
                    }, intervalMs);

                    cloneJobs[from] = { intervalId, members, total: members.length, index: 0 };
                } catch (err) {
                    console.error("Clone error:", err?.message || err);
                    await reply("❌ Failed to start clone. Check that both links are valid.");
                }
                break;
            }

            case ".stopclone": {
                if (!isGroup) return reply("This command only works in groups.");
                if (!cloneJobs[from]) return reply("⚠️ No active clone job in this group.");
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

            // --- READMORE ---
            case ".readmore": {
                // Usage: <visible text> .readmore <hidden text>
                // OR: .readmore <hidden text> (visible text taken as nothing)
                const fullText = body.trim();
                const readmoreIdx = fullText.toLowerCase().indexOf('.readmore');
                const beforeText = fullText.slice(0, readmoreIdx).trim();
                const afterText = fullText.slice(readmoreIdx + '.readmore'.length).trim();

                if (!afterText && !beforeText) {
                    return reply(
                        `❓ *How to use .readmore:*\n\n` +
                        `Type the visible part, then *.readmore*, then the hidden part.\n\n` +
                        `*Example:*\n` +
                        `_Everyone send acc .readmore Link: wa.me/xxx_\n\n` +
                        `Group members will see "Everyone send acc" and tap *Read more* to reveal the rest.`
                    );
                }

                // WhatsApp shows "Read more" after ~700 characters or many newlines
                const hiddenPadding = '\n'.repeat(700);
                const formattedMsg = `${beforeText || ''}${hiddenPadding}${afterText}`;
                await sock.sendMessage(from, { text: formattedMsg }, { quoted: msg });
                break;
            }

            // --- GROUP ID ---
            case ".groupid": {
                if (!isGroup) return reply("This command only works in groups.");
                await reply(`🆔 *Group ID:*\n\`${from}\``);
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
                    return reply("📸 Reply to an image with *.ocr* to extract the text from it.");
                }
                await reply("🔍 Extracting text from image...");
                try {
                    const fakeMsg = { ...msg, message: quoted };
                    const buf = await downloadMediaMessage(fakeMsg, "buffer", {}, { logger: pino({ level: "silent" }) });
                    const text = await ocrFromBuffer(buf);
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
                        `⚽ *Football Commands:*\n\n` +
                        `• *.pltable* — Premier League standings\n` +
                        `• *.live* — Live PL scores\n` +
                        `• *.fixtures* <club> — Upcoming fixtures\n` +
                        `• *.fnews* <club> — Club news\n` +
                        `• *.football* <club> — Full club overview\n\n` +
                        `_Example: .football Liverpool_`
                    );
                }
                await reply(`⏳ Fetching info for *${team}*...`);
                try {
                    const [fixtures, news] = await Promise.allSettled([getClubFixtures(team), getClubNews(team)]);
                    const fx = fixtures.status === "fulfilled" ? fixtures.value : null;
                    const nw = news.status === "fulfilled" ? news.value : null;
                    if (!fx && !nw) return reply(`❌ Club *${team}* not found. Check the spelling.`);
                    if (fx) await reply(fx);
                    if (nw) await reply(nw);
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
                    const ownerJid = sock.user?.id;
                    if (voType === "imageMessage") {
                        await sock.sendMessage(ownerJid, { image: buf, caption: `👁️ View-once image revealed` });
                        await reply("✅ Sent to your private chat!");
                    } else if (voType === "videoMessage") {
                        await sock.sendMessage(ownerJid, { video: buf, caption: `👁️ View-once video revealed` });
                        await reply("✅ Sent to your private chat!");
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
                const prompt = parts.slice(1).join(" ").trim();
                if (!prompt) return reply("Usage: .imagine <description>\nExample: .imagine a beautiful sunset over Lagos");
                await reply(`🎨 Generating image for: _${prompt}_\nThis may take 10-20 seconds...`);
                try {
                    const imgUrl = buildImageGenUrl(prompt);
                    const buf = await fetchBuffer(imgUrl);
                    await sock.sendMessage(from, { image: buf, caption: `🎨 *Generated Image*\n_${prompt}_` }, { quoted: msg });
                } catch (e) { await reply(`❌ Image generation failed: ${e?.message}`); }
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
                if (!GEMINI_KEY) return reply("⚠️ AI chat needs a Gemini API key.\n\nGet a FREE key at: https://aistudio.google.com/app/apikey\n\nThen add it as GEMINI_API_KEY in your Replit secrets.");
                await reply("🤖 Thinking...");
                try {
                    const reqBody = JSON.stringify({ contents: [{ parts: [{ text: question }] }] });
                    const aiReply = await new Promise((resolve, reject) => {
                        const req = https.request({
                            hostname: "generativelanguage.googleapis.com",
                            path: `/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
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
telBot.start((ctx) => {
    ctx.reply("Welcome to Phantom-X Bot! 🤖\n\nTo link your WhatsApp, use:\n/pair 2348102756072");
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

telBot.launch();

process.once("SIGINT", () => telBot.stop("SIGINT"));
process.once("SIGTERM", () => telBot.stop("SIGTERM"));

// --- AUTO-RECONNECT SAVED SESSIONS ON STARTUP ---
(async () => {
    const sessions = loadSessions();
    const entries = Object.entries(sessions);
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
            if (!isReconnect) {
                ctx.reply("🎊 WhatsApp Bot is now connected and LIVE!\n\nSend *.menu* on WhatsApp to see all commands.");
                // Send welcome message directly on WhatsApp (self-chat)
                try {
                    await delay(3000);
                    // Use number@s.whatsapp.net format for reliable self-message
                    const selfJid = (sock.user?.id || "").split(':')[0].split('@')[0] + "@s.whatsapp.net";
                    await sock.sendMessage(selfJid, {
                        text: `╔══════════════════════╗\n║  ✅  PHANTOM X LIVE  ✅  ║\n╚══════════════════════╝\n\n🔥 *Your bot is now CONNECTED!*\n\nYou can chat me here or use me in any group.\nType *.menu* to see all commands.\n━━━━━━━━━━━━━━━━━━━━`
                    });
                } catch (e) { console.error("Welcome WA msg error:", e?.message); }
            }
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
