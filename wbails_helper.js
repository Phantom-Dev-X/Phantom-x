const { generateWAMessageFromContent, proto } = require("@fizzxydev/baileys-pro");

/**
 * wbails_helper.js — Phantom-X button helper
 *
 * Handles ALL interactive message formats:
 *   1. { buttons }            — quick_reply buttons
 *   2. { sections }           — single_select list
 *   3. { interactiveButtons } — raw nativeFlow button array (passthrough)
 *   4. { interactiveMessage } — fully pre-built interactiveMessage object (passthrough)
 *
 * Injects the biz/interactive/native_flow binary nodes that WhatsApp's server
 * requires to actually render buttons. Without these nodes WA silently drops
 * the button payload and shows a blank message.
 */

async function sendInteractiveMessage(sock, jid, content, options = {}) {
    const isGroup = String(jid || "").endsWith("@g.us");

    // ── Case 4: caller passed a fully pre-built interactiveMessage object ──────
    if (content.interactiveMessage) {
        return _relay(sock, jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {},
                    },
                    interactiveMessage: content.interactiveMessage,
                },
            },
        }, options, isGroup);
    }

    // ── Build nativeFlow buttons array ─────────────────────────────────────────
    let nativeButtons = [];

    // Case 3: raw interactiveButtons array passed directly (passthrough)
    if (content.interactiveButtons && content.interactiveButtons.length > 0) {
        nativeButtons = content.interactiveButtons;
    }
    // Case 1: quick_reply buttons  { id, text }
    else if (content.buttons && content.buttons.length > 0) {
        nativeButtons = content.buttons.map(btn => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: btn.text || btn.label || "",
                id: btn.id || btn.label || "",
            }),
        }));
    }
    // Case 2: single_select list  { sections: [{ title, rows: [{ title, description, id }] }] }
    else if (content.sections && content.sections.length > 0) {
        nativeButtons = [{
            name: "single_select",
            buttonParamsJson: JSON.stringify({
                title: options.buttonText || "Open List",
                sections: content.sections.map(sec => ({
                    title: sec.title || "",
                    rows: (sec.rows || []).map(row => ({
                        title: row.title || "",
                        description: row.description || row.desc || "",
                        id: row.id || row.rowId || "",
                    })),
                })),
            }),
        }];
    }

    // ── Build the interactiveMessage payload ───────────────────────────────────
    const interactiveMessage = {
        body:   { text: content.text   || "" },
        footer: { text: content.footer || "— Phantom-X" },
        header: {
            title:            content.title    || "",
            subtitle:         content.subtitle || "",
            hasMediaAttachment: false,
        },
        nativeFlowMessage: {
            buttons: nativeButtons,
        },
    };

    // Wrap in viewOnceMessage so WA renders it (required for native_flow)
    const payload = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                },
                interactiveMessage,
            },
        },
    };

    return _relay(sock, jid, payload, options, isGroup);
}

/**
 * Internal: generates the WA message and relays it with the required
 * biz/interactive/native_flow binary node injections.
 */
async function _relay(sock, jid, payload, options, isGroup) {
    const msg = generateWAMessageFromContent(
        jid,
        payload,
        {
            userJid: sock.user?.id,
            quoted:  options.quoted || undefined,
        }
    );

    // These binary nodes are CRITICAL — WA server rejects/strips interactive
    // messages that arrive without them.
    const additionalNodes = [
        {
            tag: "biz",
            attrs: {},
            content: [{
                tag: "interactive",
                attrs: { type: "native_flow", v: "1" },
                content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }],
            }],
        },
    ];

    // bot node — helps with DM rendering; skip for groups
    if (!isGroup) {
        additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
    }

    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
    });
}

/**
 * Convenience wrapper — sends quick_reply buttons.
 * content: { text, footer, buttons: [{ id, text }] }
 */
async function sendButtons(sock, jid, content, options = {}) {
    return sendInteractiveMessage(sock, jid, {
        text:    content.text,
        footer:  content.footer,
        buttons: content.buttons,
    }, options);
}

module.exports = {
    sendInteractiveMessage,
    sendButtons,
};
