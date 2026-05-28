const https = require('https');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

let syncTimer = null;
let nextSyncTime = 0;
let isSyncing = false;
let lastConfigWarningAt = 0;

// Telegram backup channel flow
// 1. Build snapshot of auth/session files
// 2. Gzip it
// 3. Upload as a document to a PRIVATE Telegram channel
// 4. Pin the newest backup message
// 5. On startup, read the pinned message from the channel and restore it
const BACKUP_CAPTION_TAG = 'PHANTOMX_BACKUP_V1';
const MAX_BACKUP_SIZE = 45 * 1024 * 1024; // stay safely below Telegram bot document limits

function getConfig() {
    return {
        telegramToken: process.env.TELEGRAM_TOKEN || '',
        backupChannelId: process.env.BACKUP_CHANNEL_ID || '',
        ownerId: process.env.OWNER_ID || '',
    };
}

function dataDir() {
    return process.env.DATA_DIR || __dirname;
}

function hasRequiredConfig() {
    const { telegramToken, backupChannelId } = getConfig();
    return !!telegramToken && !!backupChannelId;
}

async function notifyFailure(stage, errText) {
    const text = `❌ *TELEGRAM BACKUP ${stage.toUpperCase()} FAILED*\n\n${String(errText || 'unknown error').slice(0, 3000)}`;
    console.error(`[Telegram Backup] ${stage} failed:`, errText);

    try {
        if (global.notifyOwner) {
            await global.notifyOwner(text);
        }
    } catch (_) {}

    const { ownerId, telegramToken } = getConfig();
    if (!ownerId || !telegramToken) return;

    try {
        const body = Buffer.from(`chat_id=${encodeURIComponent(ownerId)}&text=${encodeURIComponent(text)}&parse_mode=Markdown`);
        await httpRequest('POST', telegramApiUrl('sendMessage'), body, {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(body.length),
        });
    } catch (_) {}
}

function warnMissingConfig() {
    const now = Date.now();
    if (now - lastConfigWarningAt < 10 * 60 * 1000) return;
    lastConfigWarningAt = now;
    const { telegramToken, backupChannelId } = getConfig();
    const msg =
        `Telegram backup not configured.\n` +
        `• TELEGRAM_TOKEN: ${telegramToken ? 'set' : 'missing'}\n` +
        `• BACKUP_CHANNEL_ID: ${backupChannelId ? backupChannelId : 'missing'}`;
    console.log('[Telegram Backup] ' + msg.replace(/\n/g, ' | '));
    notifyFailure('config', msg).catch(() => {});
}

function httpRequest(method, urlString, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const req = https.request({
            method,
            hostname: url.hostname,
            path: url.pathname + url.search,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function telegramApiUrl(method) {
    return `https://api.telegram.org/bot${getConfig().telegramToken}/${method}`;
}

async function telegramCall(method, formFields = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(formFields)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
    }
    const body = Buffer.from(params.toString());
    const res = await httpRequest('POST', telegramApiUrl(method), body, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(body.length),
    });

    let parsed = {};
    try { parsed = JSON.parse(res.body.toString('utf8') || '{}'); } catch {
        throw new Error(`${method} returned non-JSON response (HTTP ${res.status})`);
    }
    if (!parsed.ok) {
        throw new Error(`${method} failed (HTTP ${res.status}${parsed.error_code ? ` / TG ${parsed.error_code}` : ''}): ${parsed.description || 'unknown Telegram API error'}`);
    }
    return parsed.result;
}

function buildMultipartForm(fields, fileFieldName, filename, contentType, fileBuffer) {
    const boundary = '----phantomx' + Date.now().toString(16);
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
            `${String(v)}\r\n`
        ));
    }

    parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    return {
        boundary,
        body: Buffer.concat(parts),
    };
}

async function telegramSendDocument(chatId, filename, fileBuffer, caption) {
    const { boundary, body } = buildMultipartForm(
        { chat_id: chatId, caption },
        'document',
        filename,
        'application/gzip',
        fileBuffer
    );

    const res = await httpRequest('POST', telegramApiUrl('sendDocument'), body, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
    });

    let parsed = {};
    try { parsed = JSON.parse(res.body.toString('utf8') || '{}'); } catch {
        throw new Error(`sendDocument returned non-JSON response (HTTP ${res.status})`);
    }
    if (!parsed.ok) {
        throw new Error(`sendDocument failed (HTTP ${res.status}${parsed.error_code ? ` / TG ${parsed.error_code}` : ''}): ${parsed.description || 'unknown Telegram API error'}`);
    }
    return parsed.result;
}

async function telegramDeleteMessage(chatId, messageId) {
    return telegramCall('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
    });
}


async function startupProbe() {
    if (!hasRequiredConfig()) {
        warnMissingConfig();
        return false;
    }
    try {
        const { backupChannelId } = getConfig();
        const stamp = new Date().toISOString();
        await telegramCall('sendMessage', {
            chat_id: backupChannelId,
            text: `🔄 Phantom-X deploy check\nTime: ${stamp}`,
        });
        console.log('[Telegram Backup] Startup deploy-check message sent to backup channel.');
        return true;
    } catch (e) {
        await notifyFailure('probe', `Could not send startup deploy-check message to BACKUP_CHANNEL_ID.\n\nReason: ${e?.message || e}`);
        return false;
    }
}

async function telegramGetFilePath(fileId) {
    const result = await telegramCall('getFile', { file_id: fileId });
    if (!result?.file_path) throw new Error('getFile succeeded but no file_path was returned');
    return result.file_path;
}

async function telegramDownloadFile(filePath) {
    const token = getConfig().telegramToken;
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await httpRequest('GET', url, null, { 'User-Agent': 'Phantom-X/1.0' });
    if (res.status !== 200) {
        throw new Error(`file download failed (HTTP ${res.status}) from Telegram file API`);
    }
    return res.body;
}

function listAuthFiles(rootDir, sub = '') {
    const out = [];
    const full = path.join(rootDir, sub);
    if (!fs.existsSync(full)) return out;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = path.join(sub, entry.name);
        if (entry.isDirectory()) out.push(...listAuthFiles(rootDir, rel));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

function buildSnapshot() {
    const root = dataDir();
    const files = {};
    const rootFiles = [
        'sessions.json',
        'web_sessions_tokens.json',
        'web_users.json',
        'web_user_sessions.json',
        'welcome_config.json',
    ];

    for (const rel of rootFiles) {
        const abs = path.join(root, rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            files[rel] = fs.readFileSync(abs).toString('base64');
        }
    }

    const authRoot = path.join(root, 'auth_info');
    for (const rel of listAuthFiles(authRoot)) {
        const abs = path.join(authRoot, rel);
        files[path.posix.join('auth_info', rel.split(path.sep).join('/'))] = fs.readFileSync(abs).toString('base64');
    }

    return {
        version: 2,
        createdAt: Date.now(),
        files,
    };
}

function encodeSnapshot(snapshot) {
    const json = Buffer.from(JSON.stringify(snapshot));
    return zlib.gzipSync(json, { level: 9 });
}

function decodeSnapshot(buffer) {
    const json = zlib.gunzipSync(buffer).toString('utf8');
    return JSON.parse(json);
}

function applySnapshot(snapshot) {
    const root = dataDir();
    const files = snapshot?.files || {};
    for (const [rel, b64] of Object.entries(files)) {
        const safeRel = rel.replace(/^\/+/, '');
        const abs = path.join(root, safeRel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
    }
}

async function restoreFromRemote() {
    if (!hasRequiredConfig()) {
        warnMissingConfig();
        return { ok: false, restored: false, reason: 'not configured' };
    }

    const { backupChannelId } = getConfig();

    try {
        const chat = await telegramCall('getChat', { chat_id: backupChannelId });
        const pinned = chat?.pinned_message;

        // ── No pinned message or pinned message is not a valid backup ──────────
        // This happens when: pin was deleted, channel was reset, or first-ever deploy.
        // In all these cases we start fresh — do NOT crash.
        if (!pinned) {
            console.log('[Telegram Backup] No pinned message found — starting fresh (no restore).');
            try {
                await telegramCall('sendMessage', {
                    chat_id: backupChannelId,
                    text: `ℹ️ Phantom-X started fresh — no pinned backup found. A new backup will be created shortly.`,
                });
            } catch (_) {}
            return { ok: true, restored: false, reason: 'no pinned message — fresh start' };
        }

        if (!pinned.document) {
            console.log('[Telegram Backup] Pinned message has no document — starting fresh.');
            try {
                await telegramCall('sendMessage', {
                    chat_id: backupChannelId,
                    text: `ℹ️ Pinned message is not a backup document — starting fresh. A new backup will be created shortly.`,
                });
            } catch (_) {}
            return { ok: true, restored: false, reason: 'pinned message is not a document — fresh start' };
        }

        const caption = String(pinned.caption || '');
        if (!caption.includes(BACKUP_CAPTION_TAG)) {
            console.log('[Telegram Backup] Pinned document is not a Phantom-X backup — starting fresh.');
            try {
                await telegramCall('sendMessage', {
                    chat_id: backupChannelId,
                    text: `ℹ️ Pinned document is not a recognised Phantom-X backup — starting fresh. A new backup will be created shortly.`,
                });
            } catch (_) {}
            return { ok: true, restored: false, reason: 'pinned document missing backup tag — fresh start' };
        }

        const fileId = pinned.document.file_id;
        if (!fileId) {
            console.log('[Telegram Backup] Pinned backup document has no file_id — starting fresh.');
            return { ok: true, restored: false, reason: 'no file_id on pinned document — fresh start' };
        }

        // ── Valid backup found — restore it ────────────────────────────────────
        const filePath = await telegramGetFilePath(fileId);
        const fileBuf = await telegramDownloadFile(filePath);
        const snapshot = decodeSnapshot(fileBuf);
        applySnapshot(snapshot);
        const count = Object.keys(snapshot.files || {}).length;
        console.log(`[Telegram Backup] Restored ${count} file(s) from pinned Telegram backup.`);
        try {
            const stamp = new Date().toISOString();
            await telegramCall('sendMessage', {
                chat_id: backupChannelId,
                text: `✅ Phantom-X restore successful\nTime: ${stamp}\nFiles: ${count}`,
            });
        } catch (_) {}
        return { ok: true, restored: true, fileCount: count };

    } catch (e) {
        // Network/API error — log and continue fresh, do NOT crash the bot
        const reason = e?.message || String(e);
        console.error(`[Telegram Backup] Restore error (starting fresh): ${reason}`);
        try {
            await telegramCall('sendMessage', {
                chat_id: backupChannelId,
                text: `⚠️ Phantom-X restore encountered an error — starting fresh.\nReason: ${String(reason).slice(0, 2000)}`,
            });
        } catch (_) {}
        return { ok: false, restored: false, reason };
    }
}

async function syncToRemote() {
    if (!hasRequiredConfig() || isSyncing) {
        if (!hasRequiredConfig()) warnMissingConfig();
        return;
    }
    isSyncing = true;

    try {
        const { backupChannelId } = getConfig();
        let previousPinnedBackupMessageId = null;
        try {
            const currentChat = await telegramCall('getChat', { chat_id: backupChannelId });
            const prevPinned = currentChat?.pinned_message;
            if (prevPinned?.document && String(prevPinned.caption || '').includes(BACKUP_CAPTION_TAG)) {
                previousPinnedBackupMessageId = prevPinned.message_id || null;
            }
        } catch (e) {
            console.log('[Telegram Backup] Could not inspect previous pinned backup before upload:', e?.message || e);
        }
        const snapshot = buildSnapshot();
        const fileCount = Object.keys(snapshot.files || {}).length;
        if (!fileCount) {
            throw new Error('No auth/session files were found to back up. Nothing was uploaded.');
        }

        const gz = encodeSnapshot(snapshot);
        if (gz.length > MAX_BACKUP_SIZE) {
            throw new Error(`Backup archive is too large (${(gz.length / 1024 / 1024).toFixed(2)} MB). Telegram bot upload limit would likely reject it.`);
        }

        const stamp = new Date(snapshot.createdAt).toISOString();
        const filename = `phantomx-backup-${Date.now()}.json.gz`;
        const caption = `${BACKUP_CAPTION_TAG}\ncreated=${stamp}\nfiles=${fileCount}`;

        const sent = await telegramSendDocument(backupChannelId, filename, gz, caption);
        const msgId = sent?.message_id;
        const fileId = sent?.document?.file_id;
        if (!msgId || !fileId) {
            throw new Error('Backup upload returned success, but Telegram did not return message_id/document.file_id.');
        }

        try {
            await telegramCall('pinChatMessage', {
                chat_id: backupChannelId,
                message_id: msgId,
                disable_notification: true,
            });
        } catch (pinErr) {
            // Upload succeeded, but restore will continue to use the previous pinned backup.
            await notifyFailure('pin', `Backup file uploaded successfully, but pinning the new backup failed. The previous pinned backup remains the active restore point.\n\nReason: ${pinErr?.message || pinErr}`);
            console.log('[Telegram Backup] Upload succeeded but pin failed. Previous pinned backup remains active.');
            return;
        }

        if (previousPinnedBackupMessageId && previousPinnedBackupMessageId !== msgId) {
            try {
                await telegramDeleteMessage(backupChannelId, previousPinnedBackupMessageId);
            } catch (delErr) {
                await notifyFailure('cleanup', `New backup uploaded and pinned successfully, but deleting the older pinned backup message failed.\n\nOld message ID: ${previousPinnedBackupMessageId}\nReason: ${delErr?.message || delErr}`);
            }
        }

        console.log('[Telegram Backup] Backup uploaded, pinned, and older pinned backup cleaned up successfully.');
        if (global.notifyOwner) {
            await global.notifyOwner(`✅ *TELEGRAM BACKUP UPDATED*\n\nLatest backup uploaded to the private Telegram channel and pinned successfully.\n\n• Files: ${fileCount}\n• Size: ${(gz.length / 1024).toFixed(1)} KB\n• Created: ${stamp}`);
        }
    } catch (e) {
        await notifyFailure('upload', e?.message || e);
    } finally {
        isSyncing = false;
    }
}

function triggerSync(immediate = false) {
    if (!hasRequiredConfig()) {
        warnMissingConfig();
        return;
    }

    const now = Date.now();
    const delay = immediate ? 5000 : 300000;
    const targetTime = now + delay;

    if (!syncTimer || targetTime < nextSyncTime) {
        if (syncTimer) clearTimeout(syncTimer);
        nextSyncTime = targetTime;
        syncTimer = setTimeout(() => {
            syncTimer = null;
            syncToRemote().catch((e) => {
                notifyFailure('upload', e?.message || e).catch(() => {});
                isSyncing = false;
            });
        }, Math.max(0, nextSyncTime - Date.now()));
    }
}

module.exports = {
    triggerSync,
    restoreFromRemote,
    startupProbe,
    isConfigured: hasRequiredConfig,
};
