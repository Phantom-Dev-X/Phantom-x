#!/usr/bin/env node
/**
 * patch-baileys.js
 * ----------------------------------------------------------------------------
 * Baileys 7.0.0-rc13 ships with three auth regressions that cause the
 * "Couldn't link device. Try again later." error on BOTH the QR and the
 * pairing-code login paths. This script surgically reverts the three lines to
 * the known-good 6.x behaviour.
 *
 * It runs automatically on `npm install` via the "postinstall" hook, so the fix
 * survives a fresh `node_modules` (e.g. on Render / Railway / Replit redeploys).
 *
 *  Patch 1  validate-connection.js : generateLoginNode -> passive: true  => false
 *  Patch 2  validate-connection.js : remove `lidDbMigrated: false`
 *  Patch 3  socket.js              : `await noise.finishInit()` => no await
 * ----------------------------------------------------------------------------
 */
const fs = require("fs");
const path = require("path");

const BAILEYS = path.join(
    __dirname,
    "..",
    "node_modules",
    "@whiskeysockets",
    "baileys",
    "lib"
);

if (!fs.existsSync(BAILEYS)) {
    console.log("[patch-baileys] Baileys not installed yet — skipping.");
    process.exit(0);
}

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
        // Only the login node uses `passive: true`. The register node already
        // uses `passive: false` so a blanket replace is safe here.
        find: "passive: true,",
        replace: "passive: false,",
        label: "generateLoginNode passive:true -> false",
    },
    {
        // Remove the lidDbMigrated field entirely (incl. trailing comma/newline).
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
