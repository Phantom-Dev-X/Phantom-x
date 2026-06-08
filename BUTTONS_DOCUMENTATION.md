# WhatsApp Interactive Buttons (v4) — Technical Documentation

This guide explains how to build and send interactive buttons and lists that reliably deliver to all modern WhatsApp versions (Android, iOS, Web, and Business).

## The "Engagement" Problem
Standard Baileys `sendMessage` buttons often fail because WhatsApp now requires specific **binary nodes** to be present in the message stanza. If these are missing, the message may not deliver, or the buttons may be invisible.

### Required Binary Nodes
To ensure delivery, the message must be sent using `sock.relayMessage` with these `additionalNodes`:
1.  `biz`: Contains privacy and actor metadata.
2.  `engagement`: Signals that the message is part of an active conversation.
3.  `interactive`: Defines the `native_flow` version.

---

## 1. The Implementation (`wbails_helper.js`)

The core logic resides in `wbails_helper.js`. It uses the `@zeppeliorg/wbails` library to construct the internal protobuf structures.

### Payload Structure
Buttons are wrapped in a `viewOnceMessage` to ensure they render as the "new" interactive style.

```javascript
const payload = {
    viewOnceMessage: {
        message: {
            messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
            },
            interactiveMessage: {
                body: { text: "Main body text" },
                footer: { text: "Footer text" },
                header: { title: "Title", hasMediaAttachment: false },
                nativeFlowMessage: { 
                    buttons: [
                        {
                            name: "quick_reply",
                            buttonParamsJson: JSON.stringify({
                                display_text: "Button Label",
                                id: "unique_id"
                            })
                        }
                    ] 
                },
            },
        },
    },
};
```

### The Relay Mechanism
The message is sent via `relayMessage` with the `engagement` nodes:

```javascript
await sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id,
    additionalNodes: [
        {
            tag: "biz",
            attrs: { actual_actors: "2", host_storage: "2", privacy_mode_ts: "..." },
            content: [
                { tag: "engagement", attrs: { customer_service_state: "open", conversation_state: "open" } },
                { tag: "interactive", attrs: { type: "native_flow", v: "1" }, 
                  content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" }, content: [] }] 
                },
            ],
        },
    ],
});
```

---

## 2. Handling Button Responses

In your main message handler (`handleMessage`), you must look for multiple message types because different WhatsApp clients return different response formats.

### Tapped ID Extraction
```javascript
const type = getContentType(msg.message);
let buttonId = "";

if (type === "interactiveResponseMessage") {
    // Response from new "native_flow" buttons
    const params = JSON.parse(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
    buttonId = params.id;
} else if (type === "listResponseMessage") {
    // Response from single-select lists
    buttonId = content.listResponseMessage.singleSelectReply.selectedRowId;
} else if (type === "buttonsResponseMessage") {
    // Legacy button response
    buttonId = content.buttonsResponseMessage.selectedButtonId;
}
```

---

## 3. The Numbered Fallback (Safety Net)
To support users on extremely old devices or modified clients that don't support buttons, the bot implements a "numbered fallback":
1.  When sending a menu, store the row IDs in a global map: `global.menuStateMap[jid] = ["id1", "id2", "id3"]`.
2.  In the message handler, if `buttonId` is empty but the user sent a number (e.g., "1"), look up that index in the map.
3.  Execute the corresponding command.

---

## Summary for Developers
- **Don't** use `sock.sendMessage(..., { buttons: [...] })` directly if you want 100% reliability.
- **Do** use `relayMessage` with the `biz/engagement` nodes.
- **Always** wrap interactive content in `viewOnceMessage`.
- **Handle** both `interactiveResponseMessage` and `listResponseMessage`.
- **Always** provide a text-based fallback for accessibility.
