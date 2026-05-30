/**
Saved backup of the old poll-based menu design.
This file is intentionally non-executable reference material.

/**
 * Backup of the old poll-based menu design.
 * Saved before switching back to button/list-only menu flow.
 * /

async function sendListSelect(sock, jid, quotedMsg, bodyText, buttonLabel, rows) {
    // 2026 WORKAROUND FOR WHATSAPP BUSINESS BUTTON BAN
    // Meta completely blocked interactive messages on WA Business. 
    // The community workaround is to use POLLS instead! 
    
    // Add the beautiful multi-line ASCII descriptions into the main text body so they can read what each button does!
    // Track state so we can intercept the poll votes or numeric replies
    if (!global.menuStateMap) global.menuStateMap = {};
    global.menuStateMap[jid] = rows.map(r => r.id);

    // The main body text (Stage 3 ASCII art) was ALREADY edited and displayed by the caller (sendPersonaMenu).
    // We only need to send the secondary message containing the interactive UI (the Poll).
    let pollTitle = `╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃ ⟡ EVENTIDE OMEGA TERMINAL
┃ ⟡ ${buttonLabel || "CHOOSE YOUR PATH"}
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

    // The actual poll options (the buttons they tap) styled beautifully
    const pollOptions = rows.map((r, i) => `╰┈➤ [ ${i + 1}. ${r.title} ]`);
    try {
        const pollMsg = await sock.sendMessage(jid, {
            poll: {
                name: pollTitle,
                values: pollOptions,
                selectableCount: 1
            }
        }, quotedMsg ? { quoted: quotedMsg } : {});
        
        // Cache the sent poll message so we can decrypt votes on it later!
        if (pollMsg?.key?.id) pollCreationCache[pollMsg.key.id] = pollMsg;
        return;
    } catch (err) {
        console.error("[sendListSelect] Poll format failed:", err.message);
    }
}

// Poll intercept block 1


        // INTERCEPT POLL VOTES FOR WA BUSINESS MENU WORKAROUND
        if (msg.message.pollUpdateMessage && global.menuStateMap && global.menuStateMap[from]) {
            try {
                const { getAggregateVotesInPollMessage } = require("@whiskeysockets/baileys");
                const pollUpdate = msg.message.pollUpdateMessage;
                const pollCreationMsg = pollCreationCache[pollUpdate.pollCreationMessageKey.id];
                
                if (pollCreationMsg) {
                    const decrypted = getAggregateVotesInPollMessage({
                        message: pollCreationMsg,
                        pollUpdates: [msg]
                    });
                    
                    if (decrypted && decrypted.length > 0) {
                        const selectedOptionText = decrypted[0].name; // e.g. "╰┈➤ [ 1. 👑 OWNER MENU ]"
                        // Extract the number from the beautiful ASCII string using regex
                        const match = selectedOptionText.match(/\[\s*(\d+)\./);
                        if (match) {
                            const num = parseInt(match[1].trim());
                            
                            if (!isNaN(num) && num > 0 && num <= global.menuStateMap[from].length) {
                                const buttonId = global.menuStateMap[from][num - 1];
                                delete global.menuStateMap[from]; // Clear state
                                
                                const isDev = isOwner || false; // Approximation for routing
                                if (buttonId.startsWith("menu_") || buttonId.startsWith("owner_") || buttonId.startsWith("group_") || buttonId.startsWith("dev_") || buttonId === "back_to_main") {
                                    await handleMenuNavigation(sock, from, msg, buttonId, isDev);
                                    return; // Handled!
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // If decryption fails (e.g., cache missed), ask them to type the number
                try {
                    await sock.sendMessage(from, { text: "⚠️ _To select an option, please reply with the *Number* (e.g. 1, 2) in the chat instead of voting on the poll!_" }, { quoted: msg });
                } catch (_) {}
            }
        }



*/
