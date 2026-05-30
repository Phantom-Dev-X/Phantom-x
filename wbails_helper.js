// wbails_helper.js — Phantom-X / EVENTIDE OMEGA button helper
// ─────────────────────────────────────────────────────────────────────────────
// Upgraded to the @zeppeliorg/wbails "interactive v4" pipeline, which renders
// reliably across ALL WhatsApp versions. The key difference vs. the old helper:
// instead of injecting only the minimal `biz > interactive > native_flow` node,
// we inject the FULL engagement node set that wbails uses:
//
//   <biz actual_actors="2" host_storage="2" privacy_mode_ts="...">
//     <engagement customer_service_state="open" conversation_state="open"/>
//     <interactive type="native_flow" v="1">
//       <native_flow v="9" name="mixed"/>
//     </interactive>
//   </biz>
//
// Older WhatsApp builds silently drop interactive messages that arrive without
// the engagement/privacy nodes — that is why buttons were "not sending".
//
// We build the payload with wbails' own proto + generateWAMessageFromContent so
// the message body matches what WhatsApp expects, then relay it through the
// bot's existing socket (sock.relayMessage) with the rich additionalNodes.
// ─────────────────────────────────────────────────────────────────────────────

const {
    generateWAMessageFromContent,
    unixTimestampSeconds,
} = require("@zeppeliorg/wbails/lib/Utils");
const { proto } = require("@zeppeliorg/wbails/WAProto");

// Build the exact "never-fails" interactive node set (wbails getAdditionalNode).
function buildEngagementNodes() {
    const ts = unixTimestampSeconds(new Date()) - 77980457;
    return [
        {
            tag: "biz",
            attrs: {
                actual_actors: "2",
                host_storage: "2",
                privacy_mode_ts: `${ts}`,
            },
            content: [
                {
                    tag: "engagement",
                    attrs: {
                        customer_service_state: "open",
                        conversation_state: "open",
                    },
                },
                {
                    tag: "interactive",
                    attrs: { type: "native_flow", v: "1" },
                    content: [
                        {
                            tag: "native_flow",
                            attrs: { v: "9", name: "mixed" },
                            content: [],
                        },
                    ],
                },
            ],
        },
    ];
}

/**
 * sendInteractiveMessage — main entry.
 * content shapes (any one of):
 *   { text, footer, title, subtitle, buttons: [{ id, text }] }       quick_reply
 *   { text, footer, sections: [{ title, rows:[{title,description,id}] }] }  single_select
 *   { text, footer, interactiveButtons: [ <raw nativeFlow button> ] }      passthrough
 *   { interactiveMessage: <fully built object> }                          passthrough
 * options: { quoted, buttonText }
 */
async function sendInteractiveMessage(sock, jid, content, options = {}) {
    const isGroup = String(jid || "").endsWith("@g.us");

    // ── Build the nativeFlow button array ─────────────────────────────────────
    let nativeButtons = [];

    if (content.interactiveButtons && content.interactiveButtons.length > 0) {
        // Case: raw nativeFlow buttons passed through directly
        nativeButtons = content.interactiveButtons;
    } else if (content.buttons && content.buttons.length > 0) {
        // Case: quick_reply buttons { id, text }
        nativeButtons = content.buttons.map((btn) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: btn.text || btn.label || "",
                id: btn.id || btn.label || "",
            }),
        }));
    } else if (content.sections && content.sections.length > 0) {
        // Case: single_select list (used by .menu)
        nativeButtons = [
            {
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                    title: options.buttonText || "Open List",
                    sections: content.sections.map((sec) => ({
                        title: sec.title || "",
                        rows: (sec.rows || []).map((row) => ({
                            header: row.header || "",
                            title: row.title || "",
                            description: row.description || row.desc || "",
                            id: row.id || row.rowId || "",
                        })),
                    })),
                }),
            },
        ];
    }

    // ── Assemble the interactiveMessage (v4 layout) ───────────────────────────
    const interactiveMessage = {
        body: { text: content.text || "" },
        footer: { text: content.footer || "— EVENTIDE OMEGA" },
        header: {
            title: content.title || "",
            subtitle: content.subtitle || "",
            hasMediaAttachment: false,
        },
        nativeFlowMessage: { buttons: nativeButtons },
    };

    // If caller pre-built the whole interactiveMessage, honor it verbatim.
    const finalInteractive = content.interactiveMessage || interactiveMessage;

    const payload = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                },
                interactiveMessage: finalInteractive,
            },
        },
    };

    return _relay(sock, jid, payload, options, isGroup);
}

// Internal: generate the WA message and relay with the rich engagement nodes.
async function _relay(sock, jid, payload, options, isGroup) {
    const msg = generateWAMessageFromContent(jid, payload, {
        userJid: sock.user?.id,
        quoted: options.quoted || undefined,
    });

    const additionalNodes = buildEngagementNodes();
    // bot node helps DM rendering on some clients; skip in groups
    if (!isGroup) {
        additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
    }

    await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes,
    });

    return msg;
}

/**
 * sendButtons — convenience wrapper for quick_reply buttons.
 * content: { text, footer, buttons: [{ id, text }] }
 */
async function sendButtons(sock, jid, content, options = {}) {
    return sendInteractiveMessage(
        sock,
        jid,
        {
            text: content.text,
            footer: content.footer,
            buttons: content.buttons,
        },
        options
    );
}

module.exports = {
    sendInteractiveMessage,
    sendButtons,
    buildEngagementNodes,
};
