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
- `.autoreact / .autoreply / .setalias` — Group automation
- `.antidelete on/off` — Re-post deleted messages
- `.antibot on/off` — Auto-kick bot accounts
- `.schedule HH:MM <msg>` — Daily timed messages
- `.antilink / .antispam / .antidemote` — All integrated with 3-strike warn system

### Menus
- 20 unique themes: Ghost, Matrix, Royal, Inferno, Minimal, Void, Vaporwave, Gothic, Cursive, Cosmos, Soft, Diamond, Thunder, Warrior, Neon, Spy, Pirate, Shadow, BoldTech, Echo
- Switch with `.menudesign 1-20`

## Keep-Alive

HTTP server runs on `PORT` env var (default 3000). Returns `👻 Phantom X is alive!` on any request. Use UptimeRobot or cron-job.org to ping `https://<your-replit-url>/` every 5 minutes.

## Configuration

- `TELEGRAM_TOKEN` — Telegram Bot token (Replit secret)
- `GEMINI_API_KEY` — Optional, for AI chat commands

## Running

```bash
npm start
```
