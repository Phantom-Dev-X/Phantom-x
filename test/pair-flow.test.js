/**
 * pair-flow.test.js — End-to-end pairing propagation test.
 * ---------------------------------------------------------------------------
 * We act as BOTH upstream servers:
 *   • @whiskeysockets/baileys  -> the WhatsApp server (mocked)
 *   • telegraf                 -> the Telegram server (mocked)
 *
 * The REAL, unmodified index.js runs against these mocks. We give the bot a
 * random phone number, and when the bot asks WhatsApp to link (requestPairingCode)
 * our fake WA server replies with a RANDOM pairing code. We then assert the bot
 * relays *that exact code* back to:
 *   1. the website  (POST /api/pair JSON response)
 *   2. the Telegram chat  (ctx.reply)
 * and that the number the bot sent upstream matches the one we gave it.
 * ---------------------------------------------------------------------------
 */
"use strict";

const Module = require("module");
const http = require("http");
const { EventEmitter } = require("events");
const path = require("path");

// ── Shared spy state ────────────────────────────────────────────────────────
const WA = {
    pairCalls: [],          // { number, code } every requestPairingCode call
    lastCodeForNumber: {},  // number -> code we handed back
};
const TG = {
    commands: new Map(),    // command name -> handler
    startHandler: null,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomDigits(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
}
function randomPhone() {
    // E.164-ish: country code 234 + 10 digits = 13 digits (valid 8..15 range)
    return "234" + randomDigits(10);
}
function randomPairCode() {
    // WhatsApp-style 8-char code, formatted XXXX-XXXX
    const a = randomDigits(4), b = randomDigits(4);
    return `${a}-${b}`;
}

// ── Mock: WhatsApp socket ────────────────────────────────────────────────────
function makeMockSocket() {
    const ev = new EventEmitter();
    ev.setMaxListeners(0);

    const sock = {
        ev,
        user: { id: "234000000000:1@s.whatsapp.net" },
        authState: { creds: { registered: false } },
        ws: { close() {} },
        end() {},
        async requestPairingCode(number) {
            const code = randomPairCode();
            WA.pairCalls.push({ number, code });
            WA.lastCodeForNumber[number] = code;
            return code;
        },
        async sendMessage() { return { key: { id: "x" } }; },
        sendPresenceUpdate() {},
        async groupFetchAllParticipating() { return {}; },
        async groupMetadata() { return { id: "x", participants: [] }; },
        async groupMetadataFull() { return {}; },
    };

    // Simulate WhatsApp emitting the QR/link signal shortly after the socket
    // is created — this is the moment the bot is supposed to request the code.
    setTimeout(() => {
        try { ev.emit("connection.update", { qr: "MOCK-QR-STRING" }); } catch (_) {}
    }, 15);

    return sock;
}

// ── Mock module factory ──────────────────────────────────────────────────────
function deepProxy() {
    const fn = function () { return deepProxy(); };
    return new Proxy(fn, {
        get: () => deepProxy(),
        apply: () => deepProxy(),
        construct: () => deepProxy(),
    });
}

const baileysMock = {
    default: function makeWASocket() { return makeMockSocket(); },
    useMultiFileAuthState: async () => ({
        state: { creds: { registered: false }, keys: {} },
        saveCreds: async () => {},
    }),
    delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: {
        loggedOut: 401, forbidden: 403, badSession: 500,
        connectionReplaced: 440, connectionClosed: 428, restartRequired: 515,
        timedOut: 408, multideviceMismatch: 411,
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    getContentType: () => undefined,
    downloadMediaMessage: async () => Buffer.alloc(0),
    downloadContentFromMessage: async () => Buffer.alloc(0),
    generateWAMessageFromContent: () => ({ key: {}, message: {} }),
    proto: deepProxy(),
    jidDecode: (j) => ({ user: String(j).split("@")[0], server: "s.whatsapp.net" }),
    Browsers: { macOS: () => ["Mac OS", "Chrome", "1.0"], ubuntu: () => ["Ubuntu", "Chrome", "1.0"] },
    isJidGroup: (j) => String(j).endsWith("@g.us"),
    isJidBroadcast: () => false,
    isJidNewsletter: () => false,
};

// ── Mock: Telegraf ───────────────────────────────────────────────────────────
class MockTelegraf {
    constructor() { this.telegram = { sendMessage: async () => ({}) }; }
    command(name, handler) {
        const names = Array.isArray(name) ? name : [name];
        for (const n of names) TG.commands.set(n, handler);
    }
    start(handler) { TG.startHandler = handler; }
    on() {}
    use() {}
    action() {}
    hears() {}
    catch() {}
    async launch() { /* never actually connect */ }
    stop() {}
}
const telegrafMock = { Telegraf: MockTelegraf, Markup: { button: {}, keyboard: () => ({}) } };

// ── Intercept require() for the two server libs ──────────────────────────────
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "@whiskeysockets/baileys") return baileysMock;
    if (request === "telegraf") return telegrafMock;
    return realLoad.apply(this, arguments);
};

// ── Environment for the bot ──────────────────────────────────────────────────
const TEST_PORT = 4555;
process.env.PORT = String(TEST_PORT);
delete process.env.TELEGRAM_TOKEN;     // web-only launch path (no real TG connect)
delete process.env.GITHUB_TOKEN;       // disable github sync
delete process.env.BACKUP_CHANNEL_ID;

// ── Boot the real bot ────────────────────────────────────────────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
    console.log("── Booting real index.js against mocked WhatsApp + Telegram servers ──\n");
    require(path.join(__dirname, "..", "index.js"));

    // Give the HTTP server + command registration time to come up.
    await wait(800);

    let pass = 0, fail = 0;
    const ok = (m) => { pass++; console.log(`  \u2705 PASS: ${m}`); };
    const no = (m) => { fail++; console.log(`  \u274c FAIL: ${m}`); };

    // ===================================================================
    // TEST 1 — WEB PAIR PATH
    // ===================================================================
    console.log("\n[TEST 1] WEB pair path  (POST /api/pair)");
    const webPhone = randomPhone();
    console.log(`  → giving bot random number: ${webPhone}`);

    const webResp = await postJson(TEST_PORT, "/api/pair", { phone: webPhone });
    console.log(`  ← website response:`, JSON.stringify(webResp.body));

    const webCall = WA.pairCalls.find((c) => c.number === webPhone);
    if (webCall) ok(`bot asked WhatsApp to link the SAME number it was given (${webPhone})`);
    else no(`bot never requested a code for ${webPhone}. calls=${JSON.stringify(WA.pairCalls)}`);

    if (webResp.body && webResp.body.ok === true) ok("website response ok:true");
    else no(`website response not ok: ${JSON.stringify(webResp.body)}`);

    if (webCall && webResp.body && webResp.body.code === webCall.code) {
        ok(`website received the EXACT random code WA issued (${webCall.code})`);
    } else {
        no(`code mismatch — WA issued ${webCall && webCall.code}, website got ${webResp.body && webResp.body.code}`);
    }

    // ===================================================================
    // TEST 2 — TELEGRAM PAIR PATH
    // ===================================================================
    console.log("\n[TEST 2] TELEGRAM pair path  (/pair <number>)");
    const tgPhone = randomPhone();
    console.log(`  → giving bot random number: ${tgPhone}`);

    const pairHandler = TG.commands.get("pair");
    if (!pairHandler) { no("no /pair command registered on Telegram bot"); return finish(pass, fail); }

    const replies = [];
    const ctx = {
        from: { id: 987654321 },
        chat: { id: 987654321 },
        message: { text: `/pair ${tgPhone}` },
        reply: async (text, extra) => { replies.push({ text, extra }); return {}; },
        replyWithMarkdown: async (text) => { replies.push({ text }); return {}; },
        telegram: { sendMessage: async () => ({}) },
    };

    await pairHandler(ctx);
    // startBot() runs detached; wait for the qr emit -> requestPairingCode -> reply
    await wait(600);

    console.log(`  ← telegram replies:`);
    replies.forEach((r, i) => console.log(`      [${i}] ${String(r.text).replace(/\n/g, " ").slice(0, 70)}`));

    const tgCall = WA.pairCalls.find((c) => c.number === tgPhone);
    if (tgCall) ok(`bot asked WhatsApp to link the SAME number it was given (${tgPhone})`);
    else no(`bot never requested a code for ${tgPhone}. calls=${JSON.stringify(WA.pairCalls.map(c=>c.number))}`);

    if (tgCall) {
        const sent = replies.some((r) => String(r.text).includes(tgCall.code));
        if (sent) ok(`telegram chat received the EXACT random code WA issued (${tgCall.code})`);
        else no(`code ${tgCall.code} was never sent to the telegram chat`);
    }

    finish(pass, fail);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });

function finish(pass, fail) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log(`──────────────────────────────────────────────`);
    process.exit(fail === 0 ? 0 : 1);
}

// ── tiny HTTP JSON POST helper ───────────────────────────────────────────────
function postJson(port, pathname, obj) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(obj));
        const req = http.request(
            { host: "127.0.0.1", port, path: pathname, method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": data.length } },
            (res) => {
                let body = "";
                res.on("data", (c) => (body += c));
                res.on("end", () => {
                    let parsed; try { parsed = JSON.parse(body); } catch { parsed = body; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}
