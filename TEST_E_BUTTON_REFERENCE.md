# ✅ TEST E — The Button Format That Works on BOTH WhatsApp & WhatsApp Business

This is the single most compatible interactive UI we found. It renders **and** the
tap responds on normal WhatsApp **and** on WhatsApp Business. Save this forever.

The secret: it does **NOT** use the modern `nativeFlowMessage` / `interactiveMessage`
buttons (which Business app silently drops). Instead it sends the **legacy
`listMessage`** (the old "tap to open a list" UI) — which both apps still render —
and wraps it with `patchMessageBeforeSending` so the newer clients accept it too.

---

## 1. The EXACT Test E code (verbatim from index.js)

This is sent through `sock.sendMessage` using the library's `{ sections, buttonText }`
shorthand. The fork (`@fizzxydev/baileys-pro`) turns that shorthand into a
`listMessage` internally.

```js
// "E — legacy listMessage through sendMessage + patchMessageBeforeSending"
await sock.sendMessage(target, {
    text: 'Legacy listMessage test.',
    footer: 'legacy list + patchMessageBeforeSending',
    title: 'Test E List',
    buttonText: 'Open Legacy List',
    sections: [{
        title: 'Choose One',
        rows: mkRows('e').map(r => ({ title: r.title, rowId: r.id, description: r.desc }))
    }],
    viewOnce: true,
});

// where mkRows builds rows like:
//   [{ title: 'One', desc: 'row one', id: 'btnt_e_1' },
//    { title: 'Two', desc: 'row two', id: 'btnt_e_2' }]
// and each row becomes { title, rowId, description }
```

### The patch that makes it work (socket config: `patchMessageBeforeSending`)

```js
function patchLegacyInteractiveForWhiskey(message) {
    try {
        const requiresPatch = !!(
            message?.buttonsMessage ||
            message?.templateMessage ||
            message?.listMessage
        );
        if (!requiresPatch) return message;
        return {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {},
                    },
                    ...message,
                },
            },
        };
    } catch (_) {
        return message;
    }
}

// passed into makeWASocket:
const sock = makeWASocket({
    // ...other config
    patchMessageBeforeSending: patchLegacyInteractiveForWhiskey,
});
```

---

## 2. Working Mechanism — WHY this renders on both apps

1. **It's the LEGACY list UI, not the new button UI.**
   WhatsApp gated the new `nativeFlowMessage` interactive buttons behind the paid
   Business *API*. The free Business *app* silently drops them — that's why the
   `.menu` native_flow button showed title+footer but no button. The **old
   `listMessage`** (`listType: SINGLE_SELECT`) predates that gating and is still
   rendered by both the normal app and the Business app.

2. **`{ sections, buttonText }` → `listMessage`.**
   Baileys' `generateWAMessageContent` sees `sections` in the content and builds:
   ```
   listMessage = {
       title, buttonText,
       footerText: footer,
       description: text,
       sections,
       listType: SINGLE_SELECT
   }
   ```
   It also attaches a `messageContextInfo.messageSecret`.

3. **`patchMessageBeforeSending` wraps it in `viewOnceMessage` + `deviceListMetadata`.**
   Some newer client builds require the `viewOnce` envelope + a
   `messageContextInfo.deviceListMetadata` block before they will display a
   list/button message. The patch injects exactly that, only for
   `buttonsMessage` / `templateMessage` / `listMessage`. Without the patch, newer
   clients may drop it; without the legacy listMessage, Business drops it. Together
   = renders everywhere.

4. **The tap comes back as `listResponseMessage`.**
   When the user opens the list and taps a row, WhatsApp replies with:
   ```
   message.listResponseMessage.singleSelectReply.selectedRowId  // = the row's rowId
   ```
   So the bot reads `selectedRowId` to know which option was tapped. (The newer
   native_flow path instead returns `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`.)

5. **`viewOnce: true`** tells Baileys to use the view-once envelope (matches what the
   official client emits for these), improving acceptance.

### One-line summary
> Send the **old `listMessage` (SINGLE_SELECT)** + wrap it via
> `patchMessageBeforeSending` (viewOnce + deviceListMetadata). Read the tap from
> `listResponseMessage.singleSelectReply.selectedRowId`.

---

## 3. How to implement on @whiskeysockets/baileys

⚠️ **Important:** whiskeysockets **6.7.x removed the `{ sections, buttonText }`
shorthand** — its `generateWAMessageContent` no longer builds `listMessage` for you.
BUT the proto type still exists (`proto.Message.ListMessage`, with `Section`, `Row`,
and `ListType.SINGLE_SELECT`). So on whiskey you must **hand-build the listMessage**,
then relay it. The bytes on the wire are identical to Test E.

### Step 1 — keep the patch in the socket config (same as the fork)
```js
const { makeWASocket, generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');

const sock = makeWASocket({
    // ...auth, version, etc.
    patchMessageBeforeSending: patchLegacyInteractiveForWhiskey, // (function above)
});
```

### Step 2 — hand-build the listMessage and relay it
```js
/**
 * sendLegacyList — Test-E compatible list for @whiskeysockets/baileys.
 * rows: [{ title, rowId, description }]
 */
async function sendLegacyList(sock, jid, { text, footer, title, buttonText, rows }, quoted) {
    const listMessage = proto.Message.ListMessage.create({
        title: title || '',
        description: text || '',
        footerText: footer || '',
        buttonText: buttonText || 'Open List',
        listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
        sections: [{
            title: 'Available Options',
            rows: rows.map(r => ({
                title: r.title,
                rowId: r.rowId || r.id,
                description: r.description || r.desc || '',
            })),
        }],
    });

    // Wrap exactly like patchMessageBeforeSending does (viewOnce + deviceListMetadata).
    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                },
                listMessage,
            },
        },
    };

    const waMsg = generateWAMessageFromContent(jid, content, {
        userJid: sock.user?.id,
        quoted,
    });

    await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
    return waMsg;
}
```

### Step 3 — read the tapped row (response handler)
```js
sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
        const lrm = msg.message?.listResponseMessage
            || msg.message?.viewOnceMessage?.message?.listResponseMessage;
        const rowId = lrm?.singleSelectReply?.selectedRowId;
        if (rowId) {
            // rowId === the row's rowId you sent, e.g. 'menu_owner'
            await handleMenuNavigation(sock, msg.key.remoteJid, msg, rowId, /*isDev*/ false);
        }
    }
});
```

### Always include a NUMBER FALLBACK (best practice)
Even legacy lists can fail on ancient clients. Register a map so users can reply 1-5:
```js
global.menuStateMap = global.menuStateMap || {};
global.menuStateMap[jid] = rows.map(r => r.rowId || r.id);
// then if no rowId and body is a digit, map number -> rowId
```

---

## 4. Quick checklist
- [ ] `patchMessageBeforeSending: patchLegacyInteractiveForWhiskey` in socket config
- [ ] Send a **listMessage** (SINGLE_SELECT) — shorthand on the fork, hand-built on whiskey
- [ ] Set `viewOnce: true` (fork) / wrap in `viewOnceMessage` (whiskey)
- [ ] Read taps from `listResponseMessage.singleSelectReply.selectedRowId`
- [ ] Keep a numbered (1-5) text fallback

> This format is what powers `sendListSelect` in this bot (so `.menu` and all section
> menus use it). If buttons ever "die" again, this is the known-good baseline.
