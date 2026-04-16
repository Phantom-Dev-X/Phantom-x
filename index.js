const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Telegraf } = require("telegraf");
const readline = require("readline");

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = '8607342512:AAGI3M6y0zOnxk27iBRFDj0XycPBS6u_m2U'; // Paste your Tokend heddre
const MY_CHAT_ID = '8277426999'; // Paste your ID here
const telBot = new Telegraf(TELEGRAM_TOKEN);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false, // We don't want QR
        logger: pino({ level: "fatal" }),
    });

    // --- PAIRING CODE LOGIC ---
    if (!sock.authState.creds.registered) {
        const phoneNumber = await question("Enter your phone number (e.g. 2348012345678): ");
       await delay(3000);
        const code = await sock.requestPairingCode(phoneNumber.trim());
        
        // Send the code to Telegram
        await telBot.telegram.sendMessage(MY_CHAT_ID, `🚀 *Phantom-X Connection*\n\nYour Pairing Code is: \`${code}\``, { parse_mode: 'Markdown' });
        console.log(`✅ Code sent to Telegram! Go check am.`);
    }

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log('✅ WhatsApp Bot is Connected and Live!');
        }
    });
}

startBot();

