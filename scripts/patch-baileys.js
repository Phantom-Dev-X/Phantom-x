#!/usr/bin/env node
/**
 * patch-baileys.js
 * ----------------------------------------------------------------------------
 * The Baileys 7.0.0-rc line (rc9..rc13) shipped THREE auth-handshake
 * regressions that cause "Couldn't link device" / 401 device_removed on BOTH
 * the QR and pairing-code login paths. This script surgically reverts them.
 *
 * As of now the project is pinned to the stable `legacy` line (6.7.x), which
 * does NOT contain these bugs — so on 6.7.x this script is a harmless no-op.
 * It stays in place (and in the postinstall hook) so that if anyone ever bumps
 * back onto a v7 RC, pairing keeps working automatically.
 *
 *  Patch 1  validate-connection.js : generateLoginNode -> passive: true  => false
 *  Patch 2  validate-connection.js : remove `lidDbMigrated: false`
 *  Patch 3  socket.js              : `await noise.finishInit()` => no await
 * ----------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "node_modules", "@whiskeysockets", "baileys");
const BAILEYS = path.join(ROOT, "lib");

if (!fs.existsSync(BAILEYS)) {
    console.log("[patch-baileys] Baileys not installed yet — skipping.");
    process.exit(0);
}

// Detect version — only the v7 release candidates need patching.
let version = "unknown";
try { version = require(path.join(ROOT, "package.json")).version; } catch (_) {}
const needsPatch = /^7\.0\.0-rc/.test(version);

if (!needsPatch) {
    console.log(`[patch-baileys] Baileys v${version} detected — stable line, no patch needed.`);
    process.exit(0);
}

console.log(`[patch-baileys] Baileys v${version} detected — applying RC auth fixes...`);

function patchFile(relPath, edits) {
    const file = path.join(BAILEYS, relPath);
    if (!fs.existsSync(file)) {
        console.log(`[patch-baileys] ${relPath} not found — skipping.`);
        return;
    }
    let src = fs.readFileSync(file, "utf8");
    let changed = false;
    for (const { find, replace, label } of edits) {
        if (src.includes(replace) && !src.includes(find)) {
            console.log(`[patch-baileys] ✓ already patched: ${label}`);
            continue;
        }
        if (src.includes(find)) {
            src = src.split(find).join(replace);
            changed = true;
            console.log(`[patch-baileys] ✓ patched: ${label}`);
        } else {
            console.log(`[patch-baileys] ⚠ pattern not found (skipped): ${label}`);
        }
    }
    if (changed) fs.writeFileSync(file, src, "utf8");
}

// ── Patch 1 + 2 : validate-connection.js (generateLoginNode) ────────────────
patchFile("Utils/validate-connection.js", [
    {
        find: "passive: true,",
        replace: "passive: false,",
        label: "generateLoginNode passive:true -> false",
    },
    {
        find: "        // TODO: investigate (hard set as false atm)\n        lidDbMigrated: false\n",
        replace: "",
        label: "remove lidDbMigrated field",
    },
]);

// Fallback for the lidDbMigrated removal if the comment text differs.
(function looseLidDbRemoval() {
    const file = path.join(BAILEYS, "Utils/validate-connection.js");
    if (!fs.existsSync(file)) return;
    let src = fs.readFileSync(file, "utf8");
    if (src.includes("lidDbMigrated")) {
        src = src.replace(/,?\s*lidDbMigrated:\s*false/g, "");
        fs.writeFileSync(file, src, "utf8");
        console.log("[patch-baileys] ✓ patched (loose): removed lingering lidDbMigrated");
    }
})();

// ── Patch 3 : socket.js (noise.finishInit race) ─────────────────────────────
patchFile("Socket/socket.js", [
    {
        find: "await noise.finishInit();",
        replace: "noise.finishInit();",
        label: "drop await on noise.finishInit()",
    },
]);

console.log("[patch-baileys] Done.");
