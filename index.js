const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const telBot = new Telegraf(TELEGRAM_TOKEN);

// Track active socket so we can close it before opening a new one
let activeSock = null;

function clearAuthState() {
    const authDir = path.join(__dirname, "auth_info");
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
}

// --- TELEGRAM COMMANDS ---
telBot.start((ctx) => {
    ctx.reply("Welcome to Phantom-X Bot! 🤖\n\nI am running on your VPS. To link your WhatsApp, use:\n/pair 2348102756072");
});

telBot.command('pair', async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply("Abeg, add your number! Example: /pair 2348102756072");

    // Close any existing socket connection first
    if (activeSock) {
        try { activeSock.end(); } catch (_) {}
        activeSock = null;
    }

    // Clear old session data so WhatsApp doesn't rate-limit us
    clearAuthState();

    ctx.reply("🔄 Generating your pairing code... please wait a few seconds.");
    startBot(input.trim(), ctx);
});

telBot.launch();

// Graceful stop
process.once("SIGINT", () => telBot.stop("SIGINT"));
process.once("SIGTERM", () => telBot.stop("SIGTERM"));

// --- WHATSAPP ENGINE ---
async function startBot(phoneNumber, ctx) {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
    });

    activeSock = sock;

    if (!sock.authState.creds.registered) {
        await delay(3000);
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            await ctx.reply(`✅ Your Pairing Code is:\n\n*${code}*\n\nOpen WhatsApp → Linked Devices → Link a Device → Enter code manually.`, { parse_mode: "Markdown" });
        } catch (err) {
            console.error("Pairing error:", err?.message || err);
            await ctx.reply("❌ Failed to generate pairing code. Please try again with /pair <your number>.");
        }
    } else {
        await ctx.reply("ℹ️ This session is already registered. Connecting to WhatsApp...");
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
            ctx.reply("🎊 WhatsApp Bot is now connected and LIVE!");
            console.log("WhatsApp connected!");
        } else if (connection === "close") {
            const reason = lastDisconnect?.error?.message || "unknown reason";
            console.log("Connection closed:", reason);
        }
    });
}
