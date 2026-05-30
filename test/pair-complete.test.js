/**
 * pair-complete.test.js — proves the bot COMPLETES pairing after the user
 * enters the code (the 515 restartRequired handshake).
 * ---------------------------------------------------------------------------
 * Real WhatsApp pairing sequence:
 *   1. socket opens -> emits qr signal
 *   2. bot calls requestPairingCode() -> shows code to user
 *   3. user types the code on their phone
 *   4. WhatsApp ACCEPTS -> closes the socket with code 515 (restartRequired)   <-- normal!
 *   5. bot MUST reopen the socket (keeping auth) -> connection 'open' -> linked
 *
 * The old code wiped auth on step 4 ("closed before connecting") and quit, so the
 * phone showed "couldn't link device" the instant the code was entered. This test
 * reproduces step 4 and asserts the bot reconnects + reaches 'open' WITHOUT
 * wiping the freshly-registered credentials.
 * ---------------------------------------------------------------------------
 */
"use strict";

const Module = require("module");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phantomx-complete-"));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = "4577";
delete process.env.TELEGRAM_TOKEN;
delete process.env.GITHUB_TOKEN;

const WA = { sockets: [], pairCalls: [] };

function rd(n) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function randomPhone() { return "234" + rd(10); }

// A mock socket that walks the REAL pairing handshake. Branch is decided ONCE
// at creation from the on-disk registered flag (so restarts behave correctly).
function diskRegistered() {
    try {
        const credsFile = path.join(DATA_DIR, "auth_info", "web_" + WA.currentPhone, "creds.json");
        return !!JSON.parse(fs.readFileSync(credsFile, "utf8")).registered;
    } catch (_) { return false; }
}
function makeMockSocket() {
    const ev = new EventEmitter(); ev.setMaxListeners(0);
    const idx = WA.sockets.length + 1;
    const registered = diskRegistered();

    const sock = {
        ev,
        __idx: idx,
        user: registered ? { id: WA.currentPhone + ":1@s.whatsapp.net" } : null,
        authState: { creds: { registered } },
        ws: { close() {} },
        end() {},
        async requestPairingCode(number, custom) {
            WA.pairCalls.push({ number, custom, sockIdx: idx });
            return custom || (rd(4) + "-" + rd(4));
        },
        async sendMessage() { return { key: { id: "x" } }; },
        sendPresenceUpdate() {},
        async groupFetchAllParticipating() { return {}; },
        async groupMetadata() { return { id: "x", participants: [] }; },
    };
    WA.sockets.push(sock);

    if (!registered) {
        // First socket: emit qr, then simulate user entering code -> WA accepts ->
        // close with 515 restartRequired (and persist registered=true to disk).
        setTimeout(() => ev.emit("connection.update", { qr: "MOCK-QR" }), 15);
        setTimeout(() => {
            try {
                const credsFile = path.join(DATA_DIR, "auth_info", "web_" + WA.currentPhone, "creds.json");
                fs.writeFileSync(credsFile, JSON.stringify({ registered: true }));
            } catch (_) {}
            ev.emit("connection.update", {
                connection: "close",
                lastDisconnect: { error: { output: { statusCode: 515 }, message: "restart required" } },
            });
        }, 120);
    } else {
        // Restarted socket (post-515): already registered -> go 'open' and STAY open.
        setTimeout(() => ev.emit("connection.update", { connection: "open" }), 30);
    }

    return sock;
}

function deepProxy() { const fn = function () { return deepProxy(); }; return new Proxy(fn, { get: () => deepProxy(), apply: () => deepProxy(), construct: () => deepProxy() }); }

async function mockAuthState(folder) {
    fs.mkdirSync(folder, { recursive: true });
    const credsFile = path.join(folder, "creds.json");
    let registered = false;
    if (fs.existsSync(credsFile)) {
        try { registered = !!JSON.parse(fs.readFileSync(credsFile, "utf8")).registered; } catch (_) {}
    } else {
        fs.writeFileSync(credsFile, JSON.stringify({ registered: false }));
    }
    return {
        state: { creds: { registered }, keys: {} },
        saveCreds: async () => {},
    };
}

const baileysMock = {
    default: function makeWASocket() { return makeMockSocket(); },
    useMultiFileAuthState: mockAuthState,
    delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    makeCacheableSignalKeyStore: (k) => k,
    DisconnectReason: { loggedOut: 401, forbidden: 403, badSession: 500, connectionReplaced: 440, timedOut: 408, restartRequired: 515 },
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

class MockTelegraf { constructor() { this.telegram = { sendMessage: async () => ({}) }; } command() {} start() {} on() {} use() {} action() {} hears() {} catch() {} async launch() {} stop() {} }
const telegrafMock = { Telegraf: MockTelegraf, Markup: {} };

const realLoad = Module._load;
Module._load = function (request) {
    if (request === "@itsukichan/baileys") return baileysMock;
    if (request === "telegraf") return telegrafMock;
    return realLoad.apply(this, arguments);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function authDir(sid) { return path.join(DATA_DIR, "auth_info", String(sid)); }

(async function run() {
    console.log("── Pair-COMPLETION test (515 restartRequired handshake) ──\n");
    require(path.join(__dirname, "..", "index.js"));
    await wait(800);

    let pass = 0, fail = 0;
    const ok = (m) => { pass++; console.log(`  \u2705 PASS: ${m}`); };
    const no = (m) => { fail++; console.log(`  \u274c FAIL: ${m}`); };

    const phone = randomPhone();
    WA.currentPhone = phone;
    const sid = "web_" + phone;
    console.log(`  → pairing number: ${phone}`);

    const resp = await postJson(4577, "/api/pair", { phone }).catch((e) => ({ body: { error: e.message } }));
    console.log(`  ← initial /api/pair:`, JSON.stringify(resp.body));

    if (resp.body && resp.body.ok) ok("code issued to website");
    else no(`no code issued: ${JSON.stringify(resp.body)}`);

    // Now WA emits 515 (~120ms) then the bot should restart (~1s) and reach 'open'.
    console.log("  … simulating user entering code -> WA sends 515 -> bot must reconnect");
    await wait(2500);

    // 1) auth must NOT have been wiped
    if (fs.existsSync(authDir(sid))) ok("auth folder SURVIVED the 515 (not wiped)");
    else no("auth folder was WIPED on 515 — this is the original 'couldn't link' bug!");

    // 2) bot must have opened a second socket (the restart)
    if (WA.sockets.length >= 2) ok(`bot restarted the socket after 515 (sockets opened: ${WA.sockets.length})`);
    else no(`bot did NOT restart after 515 (sockets opened: ${WA.sockets.length})`);

    // 3) final status should be connected
    const st = await postJsonGet(4577, "/api/status?id=" + encodeURIComponent(sid));
    console.log(`  ← final /api/status:`, JSON.stringify(st.body));
    if (st.body && st.body.status === "connected") ok("session reached CONNECTED after restart");
    else no(`session not connected: ${JSON.stringify(st.body)}`);

    // 4) custom code wired
    const usedCustom = WA.pairCalls.some((c) => c.custom === "12345678");
    if (usedCustom) ok("custom pairing code 12345678 was passed to WhatsApp");
    else no(`custom code not used. pairCalls=${JSON.stringify(WA.pairCalls)}`);

    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log(`──────────────────────────────────────────────`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });

function postJson(port, p, obj) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(obj));
        const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } },
            (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j }); }); });
        req.on("error", reject); req.write(data); req.end();
    });
}
function postJsonGet(port, p) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET" },
            (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j }); }); });
        req.on("error", reject); req.end();
    });
}
