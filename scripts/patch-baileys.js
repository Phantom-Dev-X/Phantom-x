#!/usr/bin/env node
/**
 * patch-baileys.js
 * ----------------------------------------------------------------------------
 * NOTE: This project now uses the @fizzxydev/baileys-pro fork, which already
 * has correct pairing behaviour (no v7-rc auth regressions, and native custom
 * pairing-code support). So this script is normally a NO-OP.
 *
 * It is kept only as a safety net: if anyone ever switches back to a vanilla
 * @whiskeysockets/baileys 7.0.0-rc build, run `npm run patch-baileys` to revert
 * the three known auth-handshake regressions (passive / lidDbMigrated /
 * awaited noise.finishInit) that cause "Couldn't link device".
 * ----------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "node_modules", "@whiskeysockets", "baileys");
const BAILEYS = path.join(ROOT, "lib");

if (!fs.existsSync(BAILEYS)) {
    console.log("[patch-baileys] vanilla @whiskeysockets/baileys not installed (using fork) — nothing to patch.");
    process.exit(0);
}

let version = "unknown";
try { version = require(path.join(ROOT, "package.json")).version; } catch (_) {}
if (!/^7\.0\.0-rc/.test(version)) {
    console.log(`[patch-baileys] @whiskeysockets/baileys v${version} — stable line, no patch needed.`);
    process.exit(0);
}

console.log(`[patch-baileys] @whiskeysockets/baileys v${version} detected — applying RC auth fixes...`);

function patchFile(relPath, edits) {
    const file = path.join(BAILEYS, relPath);
    if (!fs.existsSync(file)) return;
    let src = fs.readFileSync(file, "utf8");
    let changed = false;
    for (const { find, replace, label } of edits) {
        if (src.includes(replace) && !src.includes(find)) { console.log(`[patch-baileys] ✓ already patched: ${label}`); continue; }
        if (src.includes(find)) { src = src.split(find).join(replace); changed = true; console.log(`[patch-baileys] ✓ patched: ${label}`); }
    }
    if (changed) fs.writeFileSync(file, src, "utf8");
}

patchFile("Utils/validate-connection.js", [
    { find: "passive: true,", replace: "passive: false,", label: "passive:true -> false" },
    { find: "        // TODO: investigate (hard set as false atm)\n        lidDbMigrated: false\n", replace: "", label: "remove lidDbMigrated" },
]);
(function () {
    const file = path.join(BAILEYS, "Utils/validate-connection.js");
    if (!fs.existsSync(file)) return;
    let src = fs.readFileSync(file, "utf8");
    if (src.includes("lidDbMigrated")) { src = src.replace(/,?\s*lidDbMigrated:\s*false/g, ""); fs.writeFileSync(file, src, "utf8"); }
})();
patchFile("Socket/socket.js", [
    { find: "await noise.finishInit();", replace: "noise.finishInit();", label: "drop await on finishInit" },
]);
console.log("[patch-baileys] Done.");
