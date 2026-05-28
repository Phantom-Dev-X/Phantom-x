const { generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys");

/**
 * wbails_helper.js - Optimized for official @whiskeysockets/baileys
 * Ensures buttons/lists render correctly by injecting 'biz' and 'interactive' nodes.
 */

async function sendInteractiveMessage(sock, jid, content, options = {}) {
    const { text, footer, title, subtitle, buttons, sections } = content;
    const isJidGroup = jid.endsWith("@g.us");

    // Build modern NativeFlow Message
    const interactiveMessage = {
        body: { text: text || "" },
        footer: { text: footer || "— Phantom-X" },
        header: {
            title: title || "",
            subtitle: subtitle || "",
            hasMediaAttachment: false,
        },
        nativeFlowMessage: {
            buttons: [],
        }
    };

    // Quick Reply Buttons
    if (buttons && buttons.length > 0) {
        interactiveMessage.nativeFlowMessage.buttons = buttons.map(btn => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: btn.text,
                id: btn.id,
            })
        }));
    } 
    // Single Select List
    else if (sections && sections.length > 0) {
        interactiveMessage.nativeFlowMessage.buttons = [{
            name: "single_select",
            buttonParamsJson: JSON.stringify({
                title: options.buttonText || "Open List",
                sections: sections.map(sec => ({
                    title: sec.title,
                    rows: sec.rows.map(row => ({
                        title: row.title,
                        description: row.description || "",
                        id: row.id,
                    }))
                }))
            })
        }];
    }

    const msg = generateWAMessageFromContent(jid, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                },
                interactiveMessage,
            },
        },
    }, {
        userJid: sock.user?.id,
        quoted: options.quoted,
    });

    // CRITICAL: The 'biz' node injection that makes it work on Whiskey
    const additionalNodes = [
        {
            tag: "biz",
            attrs: {},
            content: [{
                tag: "interactive",
                attrs: { type: "native_flow", v: "1" },
                content: [{ tag: "native_flow", attrs: { v: "1" } }],
            }],
        },
        ...(!isJidGroup ? [{ tag: "bot", attrs: { biz_bot: "1" } }] : []),
    ];

    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
    });
}

async function sendButtons(sock, jid, content, options = {}) {
    return sendInteractiveMessage(sock, jid, {
        text: content.text,
        footer: content.footer,
        buttons: content.buttons
    }, options);
}

module.exports = {
    sendInteractiveMessage,
    sendButtons
};
