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
const SETTINGS_FILE = path.join(__dirname, "group_settings.json");

// Per-user state
const activeSockets = {};
const retryCounts = {};
const botJids = {};        // userId -> bot's own WhatsApp JID
const telegramCtxs = {};   // userId -> telegram ctx (for alerts)

// Anti-spam tracker: { jid: { count, lastTime } }
const spamTracker = {};

// GC Clone jobs: { groupJid: { members: [], index, interval } }
const cloneJobs = {};

// Saved group invite links for auto-rejoin: { groupJid: inviteCode }
const savedGroupLinks = {};
// Saved group names: { groupJid: groupName }
const groupNames = {};

// --- SETTINGS ---
function loadSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getGroupSetting(groupJid, key, def = false) {
    const s = loadSettings();
    return s[groupJid]?.[key] ?? def;
}

function setGroupSetting(groupJid, key, value) {
    const s = loadSettings();
    if (!s[groupJid]) s[groupJid] = {};
    s[groupJid][key] = value;
    saveSettings(s);
}

// --- HELPERS ---
function getAuthDir(userId) {
    return path.join(__dirname, "auth_info", String(userId));
}

function clearAuthState(userId) {
    const authDir = getAuthDir(userId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
}

function formatUptime() {
    const s = Math.floor(process.uptime());
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

function containsLink(text) {
    return /https?:\/\/|wa\.me\/|chat\.whatsapp\.com\/|bit\.ly\/|t\.me\//i.test(text);
}

// --- MENU ---
function buildMenuText() {
    const time = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
    return `
╔══════════════════════╗
║  ░▒▓  PHANTOM X  ▓▒░  ║
╚══════════════════════╝

🌟 *Hey Boss, Welcome Back!*
Your WhatsApp automation beast is online 🔥

━━━━━━━━━━━━━━━━━━━━
📌 *BOT INFO*
━━━━━━━━━━━━━━━━━━━━
🤖 Name      : *Phantom X*
🔖 Version   : *v${BOT_VERSION}*
🌐 Status    : *Public*
⏱️ Runtime   : *${formatUptime()}*
🕐 Time (NG) : *${time}*
━━━━━━━━━━━━━━━━━━━━

📋 *GENERAL COMMANDS*
  *.menu*   — Show this menu
  *.info*   — Bot info

👥 *GROUP COMMANDS*
  *.add* <number>      — Add member
  *.kick* @user        — Remove member
  *.promote* @user     — Make admin
  *.demote* @user      — Remove admin
  *.link*              — Get group link
  *.revoke*            — Reset group link
  *.mute*              — Only admins can chat
  *.unmute*            — Everyone can chat

🛡️ *GROUP PROTECTION*
  *.antilink on/off*   — Block links in group
  *.antispam on/off*   — Block message spam
  *.antidemote on/off* — Punish anyone who demotes an admin

📣 *NOTIFICATIONS*
  *.welcome on/off*    — Welcome new members
  *.goodbye on/off*    — Goodbye message on exit

🔄 *GC CLONE*
  *.clone* <source-link> <dest-link> <per-batch> <mins>
  _e.g. .clone link1 link2 2 5 = 2 people every 5 mins_
  *.stopclone*  — Stop an active clone job

━━━━━━━━━━━━━━━━━━━━
💀 _Phantom X — Built different. Built cold._ 🖤
━━━━━━━━━━━━━━━━━━━━
`.trim();
}

// --- ANTI-SPAM CHECK ---
function isSpamming(jid) {
    const now = Date.now();
    if (!spamTracker[jid]) spamTracker[jid] = { count: 0, lastTime: now };
    const tracker = spamTracker[jid];
    // Reset count if last message was more than 10 seconds ago
    if (now - tracker.lastTime > 10000) {
        tracker.count = 1;
        tracker.lastTime = now;
    } else {
        tracker.count++;
        tracker.lastTime = now;
    }
    // Flag as spam if more than 5 messages in 10 seconds
    return tracker.count > 5;
}

// --- MESSAGE HANDLER ---
async function handleMessage(sock, msg) {
    try {
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const type = getContentType(msg.message);
        const body =
            (type === "conversation" && msg.message.conversation) ||
            (type === "extendedTextMessage" && msg.message.extendedTextMessage?.text) ||
            (type === "imageMessage" && msg.message.imageMessage?.caption) ||
            "";

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const senderJid = isGroup
            ? msg.key.participant || msg.participant
            : from;

        const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg });
        const replyImg = async (imageUrl, caption) => {
            const buf = await fetchBuffer(imageUrl);
            await sock.sendMessage(from, { image: buf, caption }, { quoted: msg });
        };

        // --- GROUP PROTECTION (runs on every group message) ---
        if (isGroup) {
            // Anti-link
            if (getGroupSetting(from, "antilink") && body && containsLink(body)) {
                try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                await sock.sendMessage(from, {
                    text: `⚠️ @${senderJid.split("@")[0]}, links are not allowed here!`,
                    mentions: [senderJid],
                });
                return;
            }

            // Anti-spam
            if (getGroupSetting(from, "antispam") && body) {
                if (isSpamming(senderJid)) {
                    try { await sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                    await sock.sendMessage(from, {
                        text: `🚫 @${senderJid.split("@")[0]}, slow down! You're sending messages too fast.`,
                        mentions: [senderJid],
                    });
                    return;
                }
            }
        }

        if (!body) return;
        const parts = body.trim().split(" ");
        const cmd = parts[0].toLowerCase();

        switch (cmd) {
            case ".menu": {
                try {
                    const buf = await fetchBuffer("https://i.imgur.com/6LxHxwY.jpeg");
                    await sock.sendMessage(from, { image: buf, caption: buildMenuText() }, { quoted: msg });
                } catch {
                    await reply(buildMenuText());
                }
                break;
            }

            case ".info": {
                await reply(
                    `🤖 *Phantom X Bot*\n\nVersion: v${BOT_VERSION}\nRuntime: ${formatUptime()}\nBuilt with: Baileys + Node.js\n\n_Built different. Built cold._ 🖤`
                );
                break;
            }

            // --- GROUP ADMIN COMMANDS ---
            case ".add": {
                if (!isGroup) return reply("This command only works in groups.");
                const num = parts[1];
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
                await reply("✅ Member removed.");
                break;
            }

            case ".promote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person. Usage: .promote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "promote");
                await reply("✅ Promoted to admin.");
                break;
            }

            case ".demote": {
                if (!isGroup) return reply("This command only works in groups.");
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) return reply("Tag the person. Usage: .demote @user");
                await sock.groupParticipantsUpdate(from, mentioned, "demote");
                await reply("✅ Admin privileges removed.");
                break;
            }

            case ".link": {
                if (!isGroup) return reply("This command only works in groups.");
                const inv = await sock.groupInviteCode(from);
                // Save invite code for auto-rejoin if bot gets kicked
                savedGroupLinks[from] = inv;
                try {
                    const meta = await sock.groupMetadata(from);
                    groupNames[from] = meta.subject;
                } catch (_) {}
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

            // --- PROTECTION TOGGLES ---
            case ".antilink": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antilink on/off");
                setGroupSetting(from, "antilink", val === "on");
                await reply(`🔗 Anti-link is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antispam": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antispam on/off");
                setGroupSetting(from, "antispam", val === "on");
                await reply(`🚫 Anti-spam is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".antidemote": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .antidemote on/off");
                setGroupSetting(from, "antidemote", val === "on");
                await reply(`🛡️ Anti-demote is now *${val.toUpperCase()}* in this group.`);
                break;
            }

            case ".welcome": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .welcome on/off");
                setGroupSetting(from, "welcome", val === "on");
                await reply(`📣 Welcome messages are now *${val.toUpperCase()}*.`);
                break;
            }

            case ".goodbye": {
                if (!isGroup) return reply("This command only works in groups.");
                const val = parts[1]?.toLowerCase();
                if (!["on", "off"].includes(val)) return reply("Usage: .goodbye on/off");
                setGroupSetting(from, "goodbye", val === "on");
                await reply(`👋 Goodbye messages are now *${val.toUpperCase()}*.`);
                break;
            }

            // --- GC CLONE ---
            case ".clone": {
                if (!isGroup) return reply("This command only works in groups.");

                // Usage: .clone <source-link> <dest-link> <per-batch> <interval-mins>
                const sourceLink = parts[1];
                const destLink = parts[2];
                const batchSize = parseInt(parts[3]) || 1;
                const intervalMins = parseInt(parts[4]) || 10;

                if (
                    !sourceLink || !sourceLink.includes("chat.whatsapp.com/") ||
                    !destLink || !destLink.includes("chat.whatsapp.com/")
                ) {
                    return reply(
                        `❓ *How to use .clone:*\n\n` +
                        `*.clone* <source-link> <dest-link> <per-batch> <every-X-mins>\n\n` +
                        `*Examples:*\n` +
                        `• _.clone link1 link2 1 10_ — 1 person every 10 mins\n` +
                        `• _.clone link1 link2 2 5_ — 2 people every 5 mins\n` +
                        `• _.clone link1 link2 3 1_ — 3 people every 1 min\n\n` +
                        `📌 _source-link_ = group to copy members FROM\n` +
                        `📌 _dest-link_ = group to add members TO\n\n` +
                        `_Tip: Keep it slow to avoid WhatsApp banning the group._`
                    );
                }

                if (cloneJobs[from]) {
                    return reply("⚠️ A clone job is already running.\n\nUse *.stopclone* to stop it first.");
                }

                if (batchSize < 1 || batchSize > 10) return reply("❌ Batch size must be between 1 and 10.");
                if (intervalMins < 1 || intervalMins > 60) return reply("❌ Interval must be between 1 and 60 minutes.");

                await reply("⏳ Fetching members from source group...");

                try {
                    const sourceCode = sourceLink.split("chat.whatsapp.com/")[1].trim();
                    const destCode = destLink.split("chat.whatsapp.com/")[1].trim();

                    // Fetch source members
                    const sourceInfo = await sock.groupGetInviteInfo(sourceCode);
                    const members = sourceInfo.participants.map((p) => p.id);

                    if (!members.length) return reply("❌ No members found in the source group.");

                    // Get destination group JID — join if not already a member
                    let destJid;
                    try {
                        const destInfo = await sock.groupGetInviteInfo(destCode);
                        destJid = destInfo.id;
                    } catch {
                        // If we can't get info, try joining
                        destJid = await sock.groupAcceptInvite(destCode);
                    }

                    if (!destJid) return reply("❌ Could not access the destination group. Make sure the link is valid.");

                    const totalBatches = Math.ceil(members.length / batchSize);
                    const estTime = totalBatches * intervalMins;

                    await reply(
                        `✅ *Clone job started!*\n\n` +
                        `📤 Source: _${sourceInfo.subject}_\n` +
                        `📥 Destination: group ready\n` +
                        `👥 Members found: *${members.length}*\n\n` +
                        `📋 *Clone Plan:*\n` +
                        `• *${batchSize}* person(s) every *${intervalMins} min(s)*\n` +
                        `• Total batches: *${totalBatches}*\n` +
                        `• Est. time: *~${estTime} minutes*\n\n` +
                        `Use *.stopclone* to stop anytime. Starting now... 🚀`
                    );

                    let index = 0;
                    const intervalMs = intervalMins * 60 * 1000;

                    const intervalId = setInterval(async () => {
                        if (index >= members.length) {
                            clearInterval(intervalId);
                            delete cloneJobs[from];
                            await sock.sendMessage(from, { text: "🎉 *Clone complete!* All members have been added to the destination group." });
                            return;
                        }

                        const batch = members.slice(index, index + batchSize);

                        for (const memberJid of batch) {
                            try {
                                await sock.groupParticipantsUpdate(destJid, [memberJid], "add");
                                await sock.sendMessage(from, {
                                    text: `➕ Added (${index + 1}/${members.length}): @${memberJid.split("@")[0]}`,
                                    mentions: [memberJid],
                                });
                            } catch (e) {
                                await sock.sendMessage(from, {
                                    text: `⚠️ Skipped @${memberJid.split("@")[0]}: ${e?.message || "failed"}`,
                                    mentions: [memberJid],
                                });
                            }
                            index++;
                        }
                    }, intervalMs);

                    cloneJobs[from] = { intervalId, members, total: members.length, index: 0 };
                } catch (err) {
                    console.error("Clone error:", err?.message || err);
                    await reply("❌ Failed to start clone. Check that both links are valid.");
                }
                break;
            }

            case ".stopclone": {
                if (!isGroup) return reply("This command only works in groups.");
                if (!cloneJobs[from]) return reply("⚠️ No active clone job in this group.");
                clearInterval(cloneJobs[from].intervalId);
                const done = cloneJobs[from].members.filter((_, i) => i < cloneJobs[from].total).length;
                delete cloneJobs[from];
                await reply(`🛑 *Clone stopped.*\n\nJob cancelled successfully.`);
                break;
            }

            default:
                break;
        }
    } catch (err) {
        console.error("Message handler error:", err?.message || err);
    }
}

// --- GROUP EVENTS HANDLER ---
async function handleGroupUpdate(sock, update, ctx, botJid) {
    const { id: groupJid, participants, action } = update;

    try {
        // Save group name whenever we see any event from a group
        try {
            if (!groupNames[groupJid]) {
                const meta = await sock.groupMetadata(groupJid);
                groupNames[groupJid] = meta.subject;
                // Also save invite link for auto-rejoin
                const code = await sock.groupInviteCode(groupJid);
                savedGroupLinks[groupJid] = code;
            }
        } catch (_) {}

        // Detect when the bot itself is removed/kicked from a group
        if (action === "remove" && botJid && participants.includes(botJid)) {
            const gName = groupNames[groupJid] || groupJid;
            const savedCode = savedGroupLinks[groupJid];

            // Alert owner on Telegram immediately
            try {
                await ctx.reply(
                    `🚨 *ALERT: Bot was kicked!*\n\n` +
                    `I was removed from the group:\n*"${gName}"*\n\n` +
                    `⚠️ Someone may be trying to steal or takeover that group.\n\n` +
                    `${savedCode ? "🔄 Attempting to auto-rejoin now..." : "❌ No saved invite link — I can't rejoin automatically. Use *.link* in a group next time to enable auto-rejoin."}`
                );
            } catch (_) {}

            // Try to auto-rejoin if we have a saved invite link
            if (savedCode) {
                try {
                    await delay(3000);
                    await sock.groupAcceptInvite(savedCode);
                    await ctx.reply(`✅ Successfully rejoined *"${gName}"*. I'm back in the group!`);
                } catch (rejoinErr) {
                    await ctx.reply(`❌ Auto-rejoin failed for *"${gName}"*: ${rejoinErr?.message || "link may have expired or been changed."}`);
                }
            }
            return;
        }

        if (action === "add" && getGroupSetting(groupJid, "welcome")) {
            for (const jid of participants) {
                const name = `@${jid.split("@")[0]}`;
                await sock.sendMessage(groupJid, {
                    text: `🎉 Welcome to the group, ${name}! 👋\n\nWe're glad to have you here. Please read the group rules and enjoy your stay! 🙏`,
                    mentions: [jid],
                });
            }
        }

        if (action === "remove" && getGroupSetting(groupJid, "goodbye")) {
            for (const jid of participants) {
                const name = `@${jid.split("@")[0]}`;
                await sock.sendMessage(groupJid, {
                    text: `👋 ${name} has left the group.\n\nSafe travels! 🕊️`,
                    mentions: [jid],
                });
            }
        }

        if (action === "demote" && getGroupSetting(groupJid, "antidemote")) {
            const culprit = update.author; // the person who did the demoting
            for (const jid of participants) {
                try {
                    // Immediately demote the person who triggered this
                    if (culprit && culprit !== jid) {
                        await sock.groupParticipantsUpdate(groupJid, [culprit], "demote");
                    }
                    await sock.sendMessage(groupJid, {
                        text:
                            `⚠️ *Anti-Demote Alert!*\n\n` +
                            `@${culprit ? culprit.split("@")[0] : "Someone"} tried to demote @${jid.split("@")[0]}.\n\n` +
                            `⚡ *@${culprit ? culprit.split("@")[0] : "The culprit"}* has been demoted immediately as punishment.\n\n` +
                            `📋 *@${jid.split("@")[0]}* — your case is now with the group owner. Awaiting owner's verdict. 👑`,
                        mentions: culprit ? [jid, culprit] : [jid],
                    });
                } catch (e) {
                    console.error("Anti-demote error:", e?.message);
                }
            }
        }
    } catch (err) {
        console.error("Group update handler error:", err?.message || err);
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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
            await handleMessage(sock, msg);
        }
    });

    sock.ev.on("group-participants.update", async (update) => {
        await handleGroupUpdate(sock, update, ctx, botJids[userId]);
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            retryCounts[userId] = 0;
            // Store the bot's own JID so we can detect when it gets kicked
            botJids[userId] = sock.user?.id || sock.user?.jid || null;
            telegramCtxs[userId] = ctx;
            ctx.reply("🎊 WhatsApp Bot is now connected and LIVE!\n\nSend *.menu* on WhatsApp to see all commands.");
            console.log(`User ${userId} connected! Bot JID: ${botJids[userId]}`);
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
