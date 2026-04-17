# Phantom-X

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
- `GEMINI_API_KEY` — Optional. For `.ai` / `.gemini` commands (from https://aistudio.google.com/).
- `PORT` — Optional. Keep-alive server port (default: 3000).

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
