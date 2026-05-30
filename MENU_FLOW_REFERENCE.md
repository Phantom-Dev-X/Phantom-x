# `.menu` — Exact 3-Stage Flow Reference

This documents **exactly what the bot sends to WhatsApp** when a user taps/types `.menu`,
so you can rebuild it in a new bot.

> ## ‼️ CRITICAL RULE FOR THE NEW BOT
> **Send every ASCII-art block in this file EXACTLY as written — character for character.**
> - Do **NOT** add, remove, or normalize spaces, tabs, or blank lines.
> - Do **NOT** re-indent, center, or "clean up" the alignment.
> - Do **NOT** wrap it in a code block or apply markdown — send it as a raw text message.
> - The wide/uneven spacing is deliberate; it is hand-tuned to render correctly on the
>   WhatsApp mobile app. Any reformatting will break the layout on the user's phone.
> - Keep WhatsApp formatting markers (`*bold*`, `_italic_`) intact where shown.

The orchestrator is `sendPersonaMenu(sock, from, msg, isDev, botJid)` in `index.js`.
There are **two animation styles** (switchable with `.menustyle`):

- `"loading"` (default) — stage 1 shows a live 4-frame progress bar that fills over ~4s
- `"classic"` — stage 1 just sits still for 4s, no progress bar

There are also **two personas** (switchable with `.persona`): `eclipse` (dark, default)
and `astraea` (golden). The structure is identical; only the text differs.

**KEY MECHANIC:** All three stages are the **same message bubble**. Stage 1 is sent with
`sock.sendMessage(...)`, and stages 2 & 3 **edit** that same message using
`{ text: ..., edit: sentKey }`. The final stage then sends a **separate** interactive
list-button message (and optional banner image).

---

## Timing

```
STAGE_GAP = 4000 ms   (gap between stage 2 -> 3, and stage1 hold in classic)
frameMs   = 1000 ms   (each progress-bar frame in loading style)
```

In `loading` style stage 1 lasts ~4s (4 frames × 1s + 1s settle), then stage 2 holds 4s, then stage 3.

---

## STAGE 1 — EVENTIDE OMEGA boot sequence (Eclipse, premium)

Sent with: `sock.sendMessage(from, { text: STAGE1 }, { quoted: msg })`
→ returns `sent.key` which is reused for ALL edits (frames + micro-fills).

> ⚠️ **REPRODUCE EXACTLY — BYTE FOR BYTE.** Do NOT trim, re-indent, collapse, or add
> spaces/tabs/blank lines. Keep the `*bold*` markers. Send as a plain text message (the
> code fences below are only for readability — do NOT include the ``` in the message).

### The fill mechanic (read this)
The progress bar is **ONE continuous bar of 12 cells** that fills gradually across the
WHOLE of Stage 1. It does **not** reset between frames. There are **4 frames**, each held
**2 seconds** (Stage 1 total = ~8s). The bar keeps creeping forward the entire time:

- The **bar** advances by ~1 cell every ~0.66s (so ~3 cells per 2-sec frame) via tiny edits.
- The **glyph + status line + telemetry dots** only change when a new frame begins.
- So within Frame 1's 2 seconds, cells 1→3 fill gently; just as the 4th cell is about to
  light, the text flips to Frame 2 (and the bar continues from cell 4), and so on.

```
edit cadence (all on the SAME bubble via { text, edit: sent.key }):

t=0.00s  ► SEND  Frame 1  bar=01/12  (08%)
t=0.66s  ► edit  bar=02/12  (16%)        <- only the bar line changes
t=1.33s  ► edit  bar=03/12  (25%)
t=2.00s  ► edit  Frame 2  bar=04/12  (33%)   <- glyph+status+telemetry change too
t=2.66s  ► edit  bar=05/12  (41%)
t=3.33s  ► edit  bar=06/12  (50%)
t=4.00s  ► edit  Frame 3  bar=07/12  (58%)
t=4.66s  ► edit  bar=08/12  (66%)
t=5.33s  ► edit  bar=09/12  (75%)
t=6.00s  ► edit  Frame 4  bar=10/12  (83%)
t=6.66s  ► edit  bar=11/12  (91%)
t=7.33s  ► edit  bar=12/12  (100%)
t=8.00s  ► edit  STAGE 2 (the void)
t=12.0s  ► edit  STAGE 3 (eclipse main) + send the list button
```

Bar cell states (empty `▱`, filled `▰`). The bar line format is:
`   ⟢ <12 cells> ⟣   <pct>%`

```
01  ⟢ ▰▱▱▱▱▱▱▱▱▱▱▱ ⟣   08%
02  ⟢ ▰▰▱▱▱▱▱▱▱▱▱▱ ⟣   16%
03  ⟢ ▰▰▰▱▱▱▱▱▱▱▱▱ ⟣   25%
04  ⟢ ▰▰▰▰▱▱▱▱▱▱▱▱ ⟣   33%
05  ⟢ ▰▰▰▰▰▱▱▱▱▱▱▱ ⟣   41%
06  ⟢ ▰▰▰▰▰▰▱▱▱▱▱▱ ⟣   50%
07  ⟢ ▰▰▰▰▰▰▰▱▱▱▱▱ ⟣   58%
08  ⟢ ▰▰▰▰▰▰▰▰▱▱▱▱ ⟣   66%
09  ⟢ ▰▰▰▰▰▰▰▰▰▱▱▱ ⟣   75%
10  ⟢ ▰▰▰▰▰▰▰▰▰▰▱▱ ⟣   83%
11  ⟢ ▰▰▰▰▰▰▰▰▰▰▰▱ ⟣   91%
12  ⟢ ▰▰▰▰▰▰▰▰▰▰▰▰ ⟣  100%
```

---

### FRAME 1 — `◐` initiating  (held 0s–2s, bar fills 01→03)
```
╔═◈══════════════════════════◈═╗
   E V E N T I D E   O M E G A
        ⟁  *eclipse core*  ⟁
╚═◈══════════════════════════◈═╝

   ◐ initiating umbral protocol
   ⟢ ▰▱▱▱▱▱▱▱▱▱▱▱ ⟣   08%
   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   ◌ core    ◌ cipher    ◌ void
```
*(during these 2s the bar line edits 01→02→03; everything else stays)*

### FRAME 2 — `◑` collapsing  (held 2s–4s, bar fills 04→06)
```
╔═◈══════════════════════════◈═╗
   E V E N T I D E   O M E G A
        ⟁  *eclipse core*  ⟁
╚═◈══════════════════════════◈═╝

   ◑ collapsing quantum states
   ⟢ ▰▰▰▰▱▱▱▱▱▱▱▱ ⟣   33%
   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   ✔ core    ◌ cipher    ◌ void
```

### FRAME 3 — `◒` severing  (held 4s–6s, bar fills 07→09)
```
╔═◈══════════════════════════◈═╗
   E V E N T I D E   O M E G A
        ⟁  *eclipse core*  ⟁
╚═◈══════════════════════════◈═╝

   ◒ severing the last anchor
   ⟢ ▰▰▰▰▰▰▰▱▱▱▱▱ ⟣   58%
   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   ✔ core    ✔ cipher    ◌ void
```

### FRAME 4 — `◓` breaching  (held 6s–8s, bar fills 10→12)
```
╔═◈══════════════════════════◈═╗
   E V E N T I D E   O M E G A
        ⟁  *eclipse core*  ⟁
╚═◈══════════════════════════◈═╝

   ◓ eclipse breaching the veil
   ⟢ ▰▰▰▰▰▰▰▰▰▰▱▱ ⟣   83%
   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   ✔ core    ✔ cipher    ✔ void
```

At t=8s the SAME bubble edits into **STAGE 2 (the void)** below. Then 4s later it edits into
**STAGE 3 (eclipse main)** and the list button is sent.

> The glyph wanes across the frames: `◐ → ◑ → ◒ → 🌑`. The telemetry flips `◌ → ✔`
> one node per frame. The bar NEVER jumps — it only ever moves forward one cell at a time.

---

## STAGE 2 — edit to the "void" scene

Sent with: `sock.sendMessage(from, { text: STAGE2, edit: sent.key })`

`STAGE2 = buildEclipseVoid()`:
```
.
        ◢██◣
     ◢████◣.           ╔═════════
    ◢██  ██◣.          ║     T H E   V O I D ║ 
◢██   🌑   ██◣.    ║          E X S I T S  ║
    ◥██      ██◤.        ╚══════════╝.
     ◥██  ██◤
         ◢██◣

════════════════════════════════════
   even in your darkest hour...
════════════════════════════════════
```
Then waits `STAGE_GAP` (4s).

---

## STAGE 3 — edit to the final "main" terminal, THEN send the list button

This is `sendFinal(sent.key)`. It does up to **3 separate sends**:

### 3a) Edit the same bubble to the final text
`sock.sendMessage(from, { text: STAGE3, edit: sent.key })`

`STAGE3 = buildEclipseMain(isDev)`:
```
╔══════════╦══════════════╗
║       ⚠ EVENTIDE OMEGA TERMINAL 
║                           ACCESS                                                                         
╚═══════════╩═════════════╝

                ═══ E C L I P S E ═══
             " i am what remains when 
              everything else is deleted ."

╔══════════════════════╦══════════════════════╗
║ VOID SIGNATURE    ║     SYSTEM CORE          ║
║ 👤 @Unknown        ║    ECLIPSE: 100%     ║
║ ⚠ APOTHEOSIS     ║⚡ CORE:ABS ZERO     ║
║ 🩸 CORRUPT ███        ║                      ║
╚══════════════════════╩══════════════════════╝

                   🌑 THE FINAL DUSK 🌑
            " when the last star dies, 
              i will still be typing ."

📡 SECURE │ Ω │ Vessels: ∞
 You have summoned what 
 cannot be unsummoned
```

### 3b) (Optional) Send the banner image — ONLY if a menu banner is set
`sock.sendMessage(from, { image: bannerBuf, caption: "" }, { quoted: msg })`
(skipped if no `menu_banner.jpg` exists)

### 3c) Send the interactive single-select list button (a NEW message)
Via `sendListSelect(...)` with:
- **body text:** `🌑 *Tap the button below to open the Phantom-X menu sections:*`
- **button label:** `🌑 ⟢ NAVIGATE THE VOID ⟣ 🌑`
- **rows:**
  | id | title | description |
  |----|-------|-------------|
  | `menu_owner` | 👑 OWNER MENU | commands for the sovereign |
  | `menu_bug`   | 🐞 BUG MENU   | bug reports, shields & threat tools |
  | `menu_group` | 👥 GROUP MENU | group management & protection |
  | `menu_fun`   | 🎮 FUN MENU   | games, jokes & entertainment |
  | `menu_dev`*  | 🔴 DEV MENU   | the silent throne — dev only |

  *`menu_dev` row only added when `isDev` is true.

Throughout all stages the bot also fires presence updates:
`sock.sendPresenceUpdate("composing", from)` before each stage, and `"paused"` at the end.

---

## ASTRAEA persona equivalents (same 3 stages, different text)

**Stage 1** `buildAstraeaInit()` + frame, frames are:
```
[░░░░░░░░░░]   0%   ☀ purging shadows
[████░░░░░░]  40%   ☀ igniting divine core
[████████░░]  80%   ☀ opening golden court
[██████████] 100%  ☀ ASTRAEA HAS DESCENDED
```
Init art:
```
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
✦   *[CELESTIAL FORGE] — SUMMONING*  ✦
✦                            *ASTRAEA* ...                  ✦              
✦   > Purging shadows...              [✓]        ✦
✦   > Igniting divine core...     [✓]      .       ✦              
✦   > Opening the golden court...     [✓]   ✦
✦                                                                .✦
✦   ☀️ *ASTRAEA HAS DESCENDED.*        ✦
✦                                                                ✦ 
✦                                                                 ✦                                                          
✦ " *I DO NOT DELETE. I JUDGE, FOR I AM* ✦
✦                          *ASTRAEA* "                    ✦                                                            
✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦✦
```

**Stage 2** `buildAstraeaMid()`:
```
.            ✦✦✦
      ✦✦✦✦✦✦✦
    ✦✦✦  ☀️  ✦✦✦   ╔═══════════╗
 ✦✦✦✦✦✦✦✦✦✦  ║  J U D G M E N T ║
    ✦✦✦✦✦✦✦✦      ║  A R R I V E S       ║
        ✦✦✦✦✦✦         ╚═══════════╝
             ✦✦✦
```

**Stage 3** `buildAstraeaMain(isDev)`:
```
╔══════════╦══════════════╗
║        ☀ *ASTRAEA* — *DIVINE* *SYSTEM ACCESS*               
╚══════════╩══════════════╝

              ═══ ✦ *J U D G M E N T* ✦ ═══
          " *i do not delete. i judge* ."

╔══════════════════════╦══════════════════════╗
║ *DIVINE CORE*        ║  *SYSTEM BALANCE* ║
║☀ GOLDEN: 100%║⚖ READY: EQUAL ║
║🔥WRATH: MODE ║ GRACE: ████░░   ║
╚══════════════════════╩══════════════════════╝

                 🌑 *THE GOLDEN COURT* 🌑
        " *every vessel stands trial* ."

📡 Uplink: *DIVINE* │ ☀ │ *Souls* : ∞
" *the light does not ask permission. it simply arrives* ."
```

---

## The actual WhatsApp wire payload for the final list button

`sendListSelect` → `wbails_helper.sendInteractiveMessage`. The bot builds an
**interactiveMessage** wrapped in **viewOnceMessage**, with a `single_select`
nativeFlow button, then relays it with the required `biz/interactive/native_flow`
binary nodes (WhatsApp drops the buttons if these nodes are missing).

```js
// payload passed to generateWAMessageFromContent(jid, payload, { userJid, quoted })
{
  viewOnceMessage: {
    message: {
      messageContextInfo: {
        deviceListMetadataVersion: 2,
        deviceListMetadata: {}
      },
      interactiveMessage: {
        body:   { text: "🌑 *Tap the button below to open the Phantom-X menu sections:*" },
        footer: { text: "— Phantom-X" },
        header: { title: "", subtitle: "", hasMediaAttachment: false },
        nativeFlowMessage: {
          buttons: [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "🌑 ⟢ NAVIGATE THE VOID ⟣ 🌑",
                sections: [{
                  title: "Available Options",
                  rows: [
                    { title: "👑 OWNER MENU", description: "commands for the sovereign",        id: "menu_owner" },
                    { title: "🐞 BUG MENU",   description: "bug reports, shields & threat tools", id: "menu_bug"   },
                    { title: "👥 GROUP MENU", description: "group management & protection",       id: "menu_group" },
                    { title: "🎮 FUN MENU",   description: "games, jokes & entertainment",        id: "menu_fun"   }
                    // + { title:"🔴 DEV MENU", description:"the silent throne — dev only", id:"menu_dev" } when isDev
                  ]
                }]
              })
            }
          ]
        }
      }
    }
  }
}
```

Then relayed:

```js
await sock.relayMessage(jid, msg.message, {
  messageId: msg.key.id,
  additionalNodes: [
    {
      tag: "biz",
      attrs: {},
      content: [{
        tag: "interactive",
        attrs: { type: "native_flow", v: "1" },
        content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }]
      }]
    }
    // + { tag: "bot", attrs: { biz_bot: "1" } }   // only for DMs, not groups
  ]
});
```

---

## Minimal reproduction (drop-in for a new bot)

```js
async function sendThreeStageMenu(sock, from, msg, isDev = false) {
  const STAGE_GAP = 4000, frameMs = 1000;
  const init = buildEclipseInit();                 // your stage-1 art
  const frames = [
    "[░░░░░░░░░░]   0%   ▸ bypassing solar interference",
    "[████░░░░░░]  40%   ▸ collapsing quantum states",
    "[████████░░]  80%   ▸ severing last anchor",
    "[██████████] 100%  ▸ ECLIPSE IS AWAKE",
  ];

  // STAGE 1 — send + animate the progress bar by editing the SAME bubble
  await sock.sendPresenceUpdate("composing", from);
  const sent = await sock.sendMessage(from, { text: init + "\n\n" + frames[0] }, { quoted: msg });
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, frameMs));
    await sock.sendMessage(from, { text: init + "\n\n" + frames[i], edit: sent.key });
  }
  await new Promise(r => setTimeout(r, frameMs));

  // STAGE 2 — edit same bubble to the "void" scene, hold 4s
  await sock.sendMessage(from, { text: buildEclipseVoid(), edit: sent.key });
  await new Promise(r => setTimeout(r, STAGE_GAP));

  // STAGE 3 — edit same bubble to final terminal, then send the list button
  await sock.sendMessage(from, { text: buildEclipseMain(isDev), edit: sent.key });

  const rows = [
    { id: "menu_owner", title: "👑 OWNER MENU", description: "commands for the sovereign" },
    { id: "menu_bug",   title: "🐞 BUG MENU",   description: "bug reports, shields & threat tools" },
    { id: "menu_group", title: "👥 GROUP MENU", description: "group management & protection" },
    { id: "menu_fun",   title: "🎮 FUN MENU",   description: "games, jokes & entertainment" },
  ];
  if (isDev) rows.push({ id: "menu_dev", title: "🔴 DEV MENU", description: "the silent throne — dev only" });

  // uses the wbails_helper.sendInteractiveMessage shown above
  await sendInteractiveMessage(sock, from, {
    text: "🌑 *Tap the button below to open the Phantom-X menu sections:*",
    sections: [{ title: "Available Options", rows }],
  }, { quoted: msg, buttonText: "🌑 ⟢ NAVIGATE THE VOID ⟣ 🌑" });

  await sock.sendPresenceUpdate("paused", from);
}
```
