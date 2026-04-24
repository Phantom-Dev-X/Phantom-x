# Eclipse (formerly Phantom-X)

## Eclipse personality (Build Log — 2026-04-24)
The user-facing surface is now Eclipse. Bot replies are short and precise; menus are 30 chars wide with no emojis on borders.

- `.menu` / `.eclipse` / `.phantom` — 3-stage edited animation: init → "the void exists" → main picker (single message, edited in place via Baileys `edit: sent.key`, ~3s between stages).
- `.menu <num>` — Jump straight to the chosen top-level section.
- Removed: `.menu style`, `.menu all`, `.menu <num>` legacy paths, `.help <topic>` long branches. (`.menudesign` themes 1–20 still exist but are no longer wired into `.menu`.)
- Top-level sections (visible to all unless marked dev):
  - `.chains` — Chains of Binding (group control, tag, automation, protection, threshold, mirror/clone, judgment, arena, revelry, compass, conduit, hourglass, forge, pitch, oracle)
  - `.codex` — Codex of the End (pulse, ledger)
  - `.ascend` — Ascension Protocol (premium gate, dev contact)
  - `.flare` — Solar Flare (guide, revival, signal)
  - `.abyss` — Eye of the Abyss (dev only: throne, pact, vault, registry, silent chamber)
- `.dev` / `.devnumber` / `.devcontact` — Eclipse-themed dev contact card (uses first `DEV_NUMBERS` entry).
- Short replies via `eclipseSay(key)`: e.g. mute → "shackled.", ban → "extinguished.", antilink on → "the ward has been raised.", welcome on → "the threshold greets.", warn → "marked. n/3.", etc.
- All Eclipse helpers live in `index.js` between `// ECLIPSE PERSONALITY` block (~line 2577) and `function buildMenuText`. Section tree is in `getEclipseTree()`; phrase map is `ECLIPSE_PHRASES`.

## Out of scope (intentionally untouched)
The following code paths still exist but are NOT listed in the Eclipse menu and were not renamed/repackaged:
- Crash / freeze / forceclose / groupcrash / forwardstorm payload commands
- Spam / bomb / ghost-ping / zalgo flood commands
- `.report` / `.threats` / `.threatinfo` / `.unthreat` mass-report network
- `.promogroup` auto-promo engine

# Phantom-X (legacy notes below)

## State files (Batch 1)
- `afk.json` — per-jid AFK status & reason
- `profile_stats.json` — per-group, per-user message counts (.profile / .rank)
- `menu_banners.json` — base64 image per section index for the new section-picker menu
- `link_welcome.json` — auto-welcome/auto-join config: enabled, text, groupLink, delayHours (default 7), jitterMinutes (default 30), autoJoin
- `pending_joins.json` — scheduled auto-joins, persisted across restarts
- `regroup.json` — slow-roll DM migration job: text(+{LINK}), groupLink, perMessageDelaySeconds, jitterSeconds, skipAdmins, active{} (current job)



A Node.js bot bridging Telegram and WhatsApp via Baileys. Users link their WhatsApp account through a Telegram pairing code, then use the bot in groups and DMs.

## Architecture

- **Runtime**: Node.js (CommonJS)
- **Entry point**: `index.js` (~2700+ lines)
- **Package manager**: npm

## Key Libraries

- `@whiskeysockets/baileys` — WhatsApp Web API client (multi-device)
- `telegraf` — Telegram bot framework
- `pino` — Logger

## Storage Files

- `sessions.json` — Active user session map
- `group_settings.json` — Per-group toggles (antilink, antispam, antidelete, antibot, antidemote, welcome, goodbye)
- `warns.json` — Per-group warn counts `{ groupJid: { userJid: count } }`
- `bans.json` — Bot-level bans per botJid `{ botJid: [userJids...] }`
- `schedules.json` — Daily scheduled messages `{ groupJid: [{ time, message }] }`
- `menu_theme.json` — Active theme per botJid (1-20)
- `bot_mode.json` — public/owner mode per botJid
- `menu_banner.jpg` — Optional custom menu banner image
- `auto_react.json` / `auto_reply.json` / `aliases.json` — Automation config

## Features

### Moderation
- `.warn @user` — 3-strike auto-kick warn system
- `.warnlist / .resetwarn` — View / clear warns
- `.ban / .unban @user` — Bot-level bans

### Group Management
- `.add / .kick / .promote / .demote / .link / .revoke / .mute / .unmute`
- `.groupinfo / .adminlist / .membercount / .everyone`

### Games
- `.flip / .dice / .8ball / .rps / .slots` — Quick games
- `.trivia` — Trivia with hints and answers
- `.hangman` — Hangman letter-guessing game
- `.ttt / .truth / .dare / .wordchain` — Group games

### Fun
- `.joke / .fact / .quote / .roast @user / .compliment @user`

### Utilities
- `.calc` — Calculator
- `.numinfo <number> / .targetloc <number>` — Prefix-based phone number country/carrier info (not live GPS)
- `.ping` — Bot latency
- `.translate <lang> <text>` — MyMemory free translation
- `.weather <city>` — wttr.in weather
- `.bible <verse>` — bible-api.com
- `.quran <surah:ayah>` — alquran.cloud
- `.setstatus / .setname` — Profile editing

### AI & Media
- `.ai / .gemini` — Gemini AI (needs GEMINI_API_KEY secret)
- `.imagine` — Pollinations.ai free image generation
- `.song / .lyrics / .ss / .viewonce / .ocr`

### Automation
- `.restart / .reboot` — Owner-only WhatsApp session reconnect command; connection restored messages are sent to Telegram and WhatsApp self-chat
- `.autoreact / .autoreply / .setalias` — Group automation
- `.antidelete on/off` — Re-post deleted messages
- `.antibot on/off` — Auto-kick bot accounts
- `.antibug on/off/status` — Defensive shield for the linked bot number; deletes/ignores suspicious oversized, invisible, RTL, and Unicode-flood payloads
- `.schedule HH:MM <msg>` — Daily timed messages
- `.antilink / .antispam / .antidemote` — All integrated with 3-strike warn system
- `.tagadmin <msg>` — Mention group admins only

### Menus
- 20 unique themes: Ghost, Matrix, Royal, Inferno, Minimal, Void, Vaporwave, Gothic, Cursive, Cosmos, Soft, Diamond, Thunder, Warrior, Neon, Spy, Pirate, Shadow, BoldTech, Echo
- Switch with `.menudesign 1-20`
- Focused lists: `.list`, `.list group menu`, `.list bug menu`, `.list utility menu`, `.list owner menu`, `.list clone menu`, `.list tag menu`, `.help bug menu`, `.help group menu`

### GC Clone
- `.clone <source> <dest> <batch> <mins>` can now be started from any chat.
- WhatsApp only exposes source participants when the linked account can access that source group; destination adding still requires admin access.

### Bug Tools (Owner Only)
- `.bugmenu` — Show all bug/hack tools
- `.bugmenu android / ios / freeze / group / antibug` — Show section-specific bug menus
- `.crash @user` — Send a multi-layer lag bomb (zero-width chars + RTL override + Arabic flood)
- `.freeze @user` — Flood with 10,000+ invisible zero-width characters
- `.zalgo <text>` — Corrupt text with demonic combining characters
- `.bigtext <text>` — Convert text to giant emoji block letters
- `.invisible` — Send a perfectly blank/invisible message
- `.rtl <text>` — Flip text with right-to-left Unicode override
- `.mock <text>` — SpOnGeBoB mOcK tExT
- `.aesthetic <text>` — Ａｅｓｔｈｅｔｉｃ fullwidth text
- `.reverse <text>` — Reverse text backwards
- `.clap <text>` — Add 👏 between 👏 every 👏 word

### Extras
- `.sticker` — Reply to image with .sticker to convert it to a WhatsApp sticker
- `.toimg` — Reply to a sticker with .toimg to convert it back to image
- `.qr <text>` — Generate a QR code for any text or link
- `.genpwd <length>` — Generate a strong random password (6-64 chars)
- `.base64 encode/decode <text>` — Encode or decode Base64 text

## Keep-Alive

HTTP server runs on `PORT` env var (default 3000). Returns `👻 Phantom X is alive!` on any request. Use UptimeRobot or cron-job.org to ping `https://<your-replit-url>/` every 5 minutes.

## Configuration

- `TELEGRAM_TOKEN` — Required. Your Telegram Bot token from @BotFather.
- `GEMINI_API_KEY` — Optional. For `.ai` / `.gemini` / `.imagine` commands (from https://aistudio.google.com/).
- `DEV_NUMBERS` — Optional. Comma-separated developer numbers e.g. `2348102756072,2348012345678`. Defaults to `2348102756072`.
- `PORT` — Optional. Keep-alive server port (default: 3000).

## Premium / Access Control System

All commands are locked to premium users by default. The developer controls access:

| Command | What it does |
|---|---|
| `.unleash allcmds` | Open ALL commands to everyone (public mode) |
| `.unleash allcmds <number>` | Give one number full access to all commands |
| `.unleash <cmd> all` | Open one specific command to everyone |
| `.unleash <cmd> <number>` | Give one number access to one command |
| `.lock allcmds` | Re-lock everything (back to premium-only) |
| `.lock <cmd>` | Re-lock a specific command |
| `.premiumadd <number>` | Add a number to the permanent premium list |
| `.premiumremove <number>` | Remove a number from premium list |
| `.premiumlist` | View all premium numbers and unlocked commands |

## Developer Control Commands

| Command | What it does |
|---|---|
| `.adddev <number>` | Add a new developer number (full dev access) |
| `.removedev <number>` | Remove a developer number |
| `.devlist` | List all developer numbers |
| `.silencenumber <number>` | Bot ignores this number completely (per bot) |
| `.unsilencenumber <number>` | Restore a silenced number |
| `.silencelist` | View all silenced numbers on this bot |

## Storage Files (updated)

- `sessions.json` — Active user session map
- `group_settings.json` — Per-group toggles
- `warns.json` — Per-group warn counts
- `bans.json` — Bot-level bans per botJid
- `schedules.json` — Daily scheduled messages `{ groupJid: [{ time, message, botJid }] }`
- `premium.json` — Premium access control `{ global_unlock, premium_numbers, unlocked_cmds }`
- `silenced.json` — Silenced numbers per botJid `{ botJid: [numbers...] }`
- `extra_devs.json` — Runtime-added developer numbers
- `menu_theme.json` — Active theme per botJid (1-20)
- `bot_security.json` — antibug state per botJid
- `menu_banner.jpg / bug_banner.jpg` — Optional banners

### How to set these on different platforms

| Platform | How to set |
|----------|------------|
| **Replit** | Secrets tab (not `.env`) |
| **Render** | Dashboard → Environment → Add env var |
| **Railway** | Project → Variables |
| **Heroku** | Settings → Config Vars |
| **VPS / Local** | Copy `.env.example` to `.env` and fill it in |

## Running

```bash
npm start
```

## Recommended Free Hosting Platforms (24/7)

- **Render** (render.com) — Free tier available. Set `TELEGRAM_TOKEN` in Environment Variables. Use a background worker service.
- **Railway** (railway.app) — $5 free credit/month. Very easy deploy from GitHub.
- **Adaptable.io** — Free tier. Connect GitHub repo and set env vars.
- **Koyeb** (koyeb.com) — Free nano instance. Good uptime.
- **Fly.io** — Free allowance. Slightly more setup but reliable.

> For 24/7 uptime: ping your app URL every 5 minutes using **UptimeRobot** (uptimerobot.com, free) to prevent sleep on free tiers.

## Build Log — 2026-04-23 (Batch 3)
Massive feature drop, all in `index.js`:
- **Threat Network** — `.report <num> [cat] [note]`, `.threats`, `.threatinfo`, `.unthreat`. Cross-bot mass-block + WhatsApp report wave with 5–15s human-like stagger; auto re-report cycle every 30 min for 7 days. Stored in `global_threats.json`.
- **Stronger antibug** — replaced `isSuspiciousBugPayload` with multi-signal `detectBugPatterns` (zero-width, combining marks, newline floods, mention bombs, emoji floods, char-repeat). 3 hits in 30 min auto-adds the sender to threat network and triggers a wave.
- **Dev-only menu filter** — `THREAT NETWORK` & `PROMO ENGINE` sections plus `.menu all` now respect `isDev`.
- **PromoGroup engine** — `.promogroup` (status / setgroup / rate / interval / on-off-pause-resume / pool / add / remove / optout / runnow / reset). Per-bot deterministic stagger from hash(botJid), Lagos business-hour gating, falls back to DM invite when group-add returns 403/408/409. Stored in `promogroup.json`.
- **Productivity** — `.remind`, `.todo`, `.note`, `.timer`, `.countdown`, `.calendar` with persistence + auto re-arm on boot.
- **AI extras** — `.summarize`, `.atranslate`, `.codereview` (static-only), `.code`, `.explain`, `.persona`, `.aichat`. Generic `callGemini(prompt, opts)` reuses Gemini 2.0 Flash.
- **TTS** — `.tts`, `.voice`, `.tovn` via Google Translate free endpoint, multi-lang.
- **Image editor** — `.blur .invert .grayscale .brighten .darken .sharpen .pixelate .cartoon` via sharp; `.removebg` (REMOVE_BG_API_KEY) and `.upscale` placeholder (DEEPAI_API_KEY).
- **Games** — `.akinator` (Gemini-powered 20Q), `.guessflag`, `.math`, `.typingtest`, `.connect4` (2 players), `.werewolf` (4–6 players, role DMs).

New files at runtime: `global_threats.json`, `promogroup.json`, `reminders.json`, `todos.json`, `notes.json`, `timers.json`, `countdowns.json`, `persona.json`.

Optional env keys: `GEMINI_API_KEY` (AI/Akinator), `REMOVE_BG_API_KEY` (background removal), `DEEPAI_API_KEY` (upscale).
