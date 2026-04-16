const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
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

// Per-user state
const activeSockets = {};
const retryCounts = {};
const botOwners = {}; // userId -> ownerJid (the WhatsApp number they paired)

function getAuthDir(userId) {
    return path.join(__dirname, "auth_info", String(userId));
}

function clearAuthState(userId) {
    const authDir = getAuthDir(userId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
}

function formatUptime() {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
}

// Download a buffer from a URL
function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

// --- MENU TEXT ---
function buildMenuText() {
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    return `
╔═══════════════════════╗
║                                           ║
║   ░P░H░A░N░T░O░M░ ░X░   ║
║                                           ║
╚═══════════════════════╝

👋 *Welcome, Boss!*
Your WhatsApp automation beast is online and ready to go 🚀

━━━━━━━━━━━━━━━━━━━━━
📌 *BOT INFO*
━━━━━━━━━━━━━━━━━━━━━
🤖 Name      : *Phantom X*
🔖 Version   : *v${BOT_VERSION}*
🌐 Status    : *Public*
⏱️ Runtime   : *${formatUptime()}*
🕒 Time      : *${time}*
━━━━━━━━━━━━━━━━━━━━━

📋 *AVAILABLE COMMANDS*
━━━━━━━━━━━━━━━━━━━━━
⚙️ *.menu*       — Show this menu
ℹ️ *.info*       — Bot information
👥 *GROUP COMMANDS*
   *.add* <number>    — Add member
   *.kick* <@tag>     — Remove member
   *.promote* <@tag>  — Make admin
   *.demote* <@tag>   — Remove admin
   *.link*            — Get group link
   *.revoke*          — Reset group link
   *.mute*            — Mute group
   *.unmute*          — Unmute group

━━━━━━━━━━━━━━━━━━━━━
💡 _Phantom X — Built different. Built cold._
━━━━━━━━━━━━━━━━━━━━━
`.trim();
}

// --- MESSAGE HANDLER ---
async function handleMessage(sock, msg, userId) {
    try {
        if (!msg.message) return;
        if (msg.key.fromMe) return; // ignore messages the bot itself sends

        const type = getContentType(msg.message);
        const body =
            (type === "conversation" && msg.message.conversation) ||
            (type === "extendedTextMessage" && msg.message.extendedTextMessage?.text) ||
            (type === "imageMessage" && msg.message.imageMessage?.caption) ||
            "";

        if (!body) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const cmd = body.trim().toLowerCase().split(" ")[0];

        const reply = (text) =>
            sock.sendMessage(from, { text }, { quoted: msg });

        const replyImg = async (imageUrl, caption) => {
            const buf = await fetchBuffer(imageUrl);
            await sock.sendMessage(from, { image: buf, caption }, { quoted: msg });
        };

        switch (cmd) {
            case ".menu": {
                const menuImg = "https://i.imgur.com/6LxHxwY.jpeg"; // dark futuristic bot image
                try {
                    await replyImg(menuImg, buildMenuText());
                } catch {
                    // If image fails, fall back to text only
                    await reply(buildMenuText());
                }
                break;
            }

            case ".info": {
                await reply(
                    `*Phantom X Bot*\n\nVersion: v${BOT_VERSION}\nRuntime: ${formatUptime()}\nBuilt with: Baileys + Node.js\n\n_Built different. Built cold._ 🖤`
                );
                break;
            }

            case ".add": {
                if (!isGroup) return reply("This command only works in groups.");
                const num = body.trim().split(" ")[1];
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
                await reply("✅ Member removed from the group.");
                break;
            }

            case ".promote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person to promote. Usage: .promote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "promote");
                await reply("✅ Member promoted to admin.");
                break;
            }

            case ".demote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person to demote. Usage: .demote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "demote");
                await reply("✅ Admin privileges removed.");
                break;
            }

            case ".link": {
                if (!isGroup) return reply("This command only works in groups.");
                const inv = await sock.groupInviteCode(from);
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

            default:
                break; // ignore unknown commands
        }
    } catch (err) {
        console.error("Message handler error:", err?.message || err);
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

    // Request pairing code on fresh attempts only
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

    // Listen for incoming WhatsApp messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
            await handleMessage(sock, msg, userId);
        }
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            retryCounts[userId] = 0;
            ctx.reply("🎊 WhatsApp Bot is now connected and LIVE!\n\nSend *.menu* on WhatsApp to see all commands.");
            console.log(`User ${userId} connected!`);
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
