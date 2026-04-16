const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, jidNormalizedUser } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Telegraf } = require("telegraf");

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const telBot = new Telegraf(TELEGRAM_TOKEN);

// --- TELEGRAM COMMANDS ---
telBot.start((ctx) => {
    ctx.reply("Welcome to Phantom-X Bot! 🤖\n\nI am running on your VPS. To link your WhatsApp, use:\n/pair 2348102756072");
});

telBot.command('pair', async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply("Abeg, add your number! Example: /pair 2348102756072");
    
    ctx.reply("Generating your pairing code... please wait 5 seconds.");
    startBot(input, ctx);
});

telBot.launch();

// --- WHATSAPP ENGINE ---
async function startBot(phoneNumber, ctx) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
    });

    if (!sock.authState.creds.registered) {
        await delay(5000); // 5 second wait to avoid 428 error
        try {
            const code = await sock.requestPairingCode(phoneNumber.trim());
            await ctx.reply(`✅ Your Pairing Code is: ${code}`);
            await ctx.reply("Copy this code and click the notification on your WhatsApp to link.");
        } catch (err) {
            console.error(err);
            ctx.reply("❌ Error: WhatsApp blocked the request. Wait 20 mins and try again.");
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            ctx.reply("🎊 WhatsApp Bot is now connected and LIVE!");
            console.log("Connected!");
        }
    });
}

