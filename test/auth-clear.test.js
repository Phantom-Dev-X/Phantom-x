/**
 * auth-clear.test.js — proves the bot WIPES auth on failed/terminal pairing.
 * ---------------------------------------------------------------------------
 * Reusing a half-written auth state is exactly what makes WhatsApp answer
 * "Couldn't link device" and can rate-limit / suspend pairing for the number.
 * This test makes our fake WhatsApp server FAIL the link, then asserts the
 * bot deleted the auth folder so the next attempt starts clean.
 *
 * We mock useMultiFileAuthState so that loading auth physically CREATES the
 * auth directory + a creds.json (mirroring the real Baileys helper). Then we
 * watch whether the bot removes that directory after a failed pairing.
 * ---------------------------------------------------------------------------
 */
"use strict";

const Module = require("module");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

// Isolated, persistent data dir so we can inspect the auth folder on disk.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phantomx-authtest-"));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = "4566";
delete process.env.TELEGRAM_TOKEN;
delete process.env.GITHUB_TOKEN;

// Toggle: when true, the fake WA server refuses to issue a pairing code.
const WA = { failNext: true, pairCalls: [] };

function randomDigits(n) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function randomPhone() { return "234" + randomDigits(10); }

function makeMockSocket() {
    const ev = new EventEmitter(); ev.setMaxListeners(0);
    const sock = {
        ev,
        user: { id: "234000000000:1@s.whatsapp.net" },
        authState: { creds: { registered: false } },
        ws: { close() {} },
        end() {},
        async requestPairingCode(number) {
            WA.pairCalls.push(number);
            if (WA.failNext) throw new Error("MOCK WA: refused to link (simulated failure)");
            return randomDigits(4) + "-" + randomDigits(4);
        },
        async sendMessage() { return { key: { id: "x" } }; },
        sendPresenceUpdate() {},
        async groupFetchAllParticipating() { return {}; },
        async groupMetadata() { return { id: "x", participants: [] }; },
    };
    setTimeout(() => { try { ev.emit("connection.update", { qr: "MOCK-QR" }); } catch (_) {} }, 15);
    return sock;
}

function deepProxy() {
    const fn = function () { return deepProxy(); };
    return new Proxy(fn, { get: () => deepProxy(), apply: () => deepProxy(), construct: () => deepProxy() });
}

// useMultiFileAuthState that ACTUALLY creates the auth dir + creds file,
// mirroring real Baileys so we can verify the bot deletes it.
async function mockUseMultiFileAuthState(folder) {
    fs.mkdirSync(folder, { recursive: true });
    const credsFile = path.join(folder, "creds.json");
    if (!fs.existsSync(credsFile)) fs.writeFileSync(credsFile, JSON.stringify({ registered: false }));
    return {
        state: { creds: { registered: false }, keys: {} },
        saveCreds: async () => { fs.writeFileSync(credsFile, JSON.stringify({ registered: false, ts: Date.now() })); },
    };
}

const baileysMock = {
    default: function makeWASocket() { return makeMockSocket(); },
    useMultiFileAuthState: mockUseMultiFileAuthState,
    delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    makeCacheableSignalKeyStore: (k) => k,
    DisconnectReason: { loggedOut: 401, forbidden: 403, badSession: 500, connectionReplaced: 440, timedOut: 408 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    getContentType: () => undefined,
    downloadMediaMessage: async () => Buffer.alloc(0),
    downloadContentFromMessage: async () => Buffer.alloc(0),
    generateWAMessageFromContent: () => ({ key: {}, message: {} }),
    proto: deepProxy(),
    jidDecode: (j) => ({ user: String(j).split("@")[0] }),
    Browsers: { macOS: () => ["Mac OS", "Chrome", "1.0"] },
    isJidGroup: () => false, isJidBroadcast: () => false, isJidNewsletter: () => false,
};

const TG = { commands: new Map() };
class MockTelegraf {
    constructor() { this.telegram = { sendMessage: async () => ({}) }; }
    command(n, h) { (Array.isArray(n) ? n : [n]).forEach((x) => TG.commands.set(x, h)); }
    start() {} on() {} use() {} action() {} hears() {} catch() {}
    async launch() {} stop() {}
}
const telegrafMock = { Telegraf: MockTelegraf, Markup: {} };

const realLoad = Module._load;
Module._load = function (request) {
    if (request === "@whiskeysockets/baileys") return baileysMock;
    if (request === "telegraf") return telegrafMock;
    return realLoad.apply(this, arguments);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function authDirFor(sessionId) { return path.join(DATA_DIR, "auth_info", String(sessionId)); }

(async function run() {
    console.log("── Auth-clearing test (DATA_DIR=" + DATA_DIR + ") ──\n");
    require(path.join(__dirname, "..", "index.js"));
    await wait(800);

    let pass = 0, fail = 0;
    const ok = (m) => { pass++; console.log(`  \u2705 PASS: ${m}`); };
    const no = (m) => { fail++; console.log(`  \u274c FAIL: ${m}`); };

    // ---- WEB: failed pairing must wipe auth ----
    console.log("[TEST A] WEB — failed pairing wipes auth folder");
    WA.failNext = true;
    const webPhone = randomPhone();
    const sid = "web_" + webPhone;
    await postJson(4566, "/api/pair", { phone: webPhone }).catch(() => {});
    await wait(300);
    const webDir = authDirFor(sid);
    if (!fs.existsSync(webDir)) ok(`auth folder for ${sid} was removed after failed pairing`);
    else no(`auth folder STILL EXISTS after failed web pairing: ${webDir} (contents: ${fs.readdirSync(webDir)})`);

    // ---- TELEGRAM: failed pairing must clear auth ----
    console.log("\n[TEST B] TELEGRAM — failed pairing clears auth folder");
    WA.failNext = true;
    const tgPhone = randomPhone();
    const userId = 55512345;
    const pairHandler = TG.commands.get("pair");
    const ctx = {
        from: { id: userId }, chat: { id: userId },
        message: { text: `/pair ${tgPhone}` },
        reply: async () => ({}), replyWithMarkdown: async () => ({}),
        telegram: { sendMessage: async () => ({}) },
    };
    await pairHandler(ctx);
    await wait(500);
    const tgDir = authDirFor(userId);
    if (!fs.existsSync(tgDir)) ok(`auth folder for tg user ${userId} was cleared after failed pairing`);
    else no(`auth folder STILL EXISTS after failed telegram pairing: ${tgDir} (contents: ${fs.readdirSync(tgDir)})`);

    // ---- Sanity: a SUCCESSFUL web pairing should KEEP auth (so reconnects work) ----
    console.log("\n[TEST C] WEB — successful pairing KEEPS auth folder (needed to reconnect)");
    WA.failNext = false;
    const okPhone = randomPhone();
    const okSid = "web_" + okPhone;
    const resp = await postJson(4566, "/api/pair", { phone: okPhone }).catch((e) => ({ body: { error: e.message } }));
    await wait(300);
    const okDir = authDirFor(okSid);
    if (resp.body && resp.body.ok && fs.existsSync(okDir)) ok(`auth folder for ${okSid} is preserved after successful code issue`);
    else no(`expected auth kept on success — ok=${resp.body && resp.body.ok}, exists=${fs.existsSync(okDir)}`);

    // cleanup
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

    console.log(`\n──────────────────────────────────────────────`);
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log(`──────────────────────────────────────────────`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });

function postJson(port, pathname, obj) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(obj));
        const req = http.request(
            { host: "127.0.0.1", port, path: pathname, method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": data.length } },
            (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
                let p; try { p = JSON.parse(b); } catch { p = b; } resolve({ status: res.statusCode, body: p });
            }); }
        );
        req.on("error", reject); req.write(data); req.end();
    });
}
