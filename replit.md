# Eclipse
A Node.js bot bridging Telegram and WhatsApp, enabling users to link their WhatsApp accounts and interact within groups and DMs.

## Run & Operate
- **Run:** `npm start`
- **Required Env Vars:**
    - `TELEGRAM_TOKEN`: Your Telegram Bot token.
- **Optional Env Vars:**
    - `GEMINI_API_KEY`: For AI commands (`.ai`, `.gemini`, `.imagine`).
    - `DEV_NUMBERS`: Comma-separated developer WhatsApp numbers.
    - `PORT`: Keep-alive server port (default: 3000).
    - `REMOVE_BG_API_KEY`: For background removal.
    - `DEEPAI_API_KEY`: For image upscaling.
- **Keep-Alive:** HTTP server runs on `PORT`. Ping `https://<your-replit-url>/` every 5 minutes using an external service (e.g., UptimeRobot) to prevent sleep.

## Stack
- **Runtime:** Node.js (CommonJS)
- **Package Manager:** npm
- **Frameworks:** `@whiskeysockets/baileys` (WhatsApp), `telegraf` (Telegram)
- **Logger:** `pino`

## Where things live
- `index.js`: Main application entry point and core logic.
- `afk.json`: AFK status and reasons.
- `profile_stats.json`: Per-group, per-user message counts.
- `menu_banners.json`: Base64 images for menu sections.
- `link_welcome.json`: Auto-welcome/auto-join configuration.
- `pending_joins.json`: Scheduled auto-joins.
- `regroup.json`: Slow-roll DM migration job details.
- `sessions.json`: Active user session map.
- `group_settings.json`: Per-group feature toggles (antilink, antispam, etc.).
- `warns.json`: Per-group warn counts.
- `bans.json`: Bot-level bans.
- `schedules.json`: Daily scheduled messages.
- `menu_theme.json`: Active menu theme per bot.
- `bot_mode.json`: Public/owner mode per bot.
- `menu_banner.jpg`: Optional custom menu banner image.
- `auto_react.json`, `auto_reply.json`, `aliases.json`: Automation configurations.
- `global_threats.json`: Cross-bot threat network data.
- `promogroup.json`: Promotion group engine configuration.
- `reminders.json`, `todos.json`, `notes.json`, `timers.json`, `countdowns.json`, `persona.json`: User productivity and AI persona data.
- `premium.json`: Premium access control settings.
- `silenced.json`: Silenced numbers per bot.
- `extra_devs.json`: Runtime-added developer numbers.
- `bot_security.json`: Anti-bug state per bot.

## Architecture decisions
- **Unified Persona:** Switched to "Eclipse" persona with short, precise replies and a 3-panel menu system.
- **Dynamic Menu:** The main menu (`.menu`) uses a 3-stage animated edit-in-place message for a cleaner UX.
- **Anti-Delete Forwarding:** Deleted messages are now forwarded to the OWNER's DM (self-chat) with context, rather than reposting in the group.
- **AI Model Fallback:** Gemini AI commands (`.ai`, `.ask`, `.gemini`) utilize a chained fallback mechanism (`gemini-2.0-flash` → `gemini-1.5-flash` → `gemini-1.5-flash-8b`) for resilience.
- **Human-like Delays:** Session execution loop incorporates 3-5 second human-like delays and skips dead sockets for stability.

## Product
- **Cross-Platform Messaging:** Bridges WhatsApp and Telegram for unified bot interaction.
- **Group Moderation:** Comprehensive tools for warning, banning, adding/kicking members, and managing group settings.
- **Interactive Games:** A variety of quick games and multi-player interactive games (trivia, hangman, Connect4, Werewolf).
- **AI Capabilities:** Integration with Gemini for general AI queries, image generation, summarization, coding assistance, and character-based interactions.
- **Automation:** Features like anti-delete, anti-bot, scheduled messages, auto-react/reply, and anti-spam/link/demote mechanisms.
- **Utility Commands:** Includes calculators, number info, translation, weather, Bible/Quran lookup, profile editing, and media manipulation (stickers, image conversion, QR codes).
- **Dynamic Menus & Themes:** Customizable menu appearance with 20 distinct themes and a 3-panel navigation system.
- **Threat Detection & Promotion Engines:** Advanced systems for identifying and reporting malicious activity, and a promotional group management tool.

## User preferences
- _Populate as you build_

## Gotchas
- **Clone Command Limitations:** WhatsApp only exposes source group participants if the linked account has access to that group. Destination adding still requires admin access.
- **Silent Download Failures:** `.setpp` / `.setmenupic` commands require buffer size validation (min 1000 bytes) to prevent silent failures when downloading images.
- **Free Tier Uptime:** For 24/7 uptime on free hosting tiers, an external ping service (e.g., UptimeRobot) is required to prevent the app from sleeping.

## Pointers
- [Baileys Documentation](https://github.com/WhiskeySockets/Baileys)
- [Telegraf Documentation](https://telegraf.js.org/)
- [Google AI Studio](https://aistudio.google.com/)
- [wttr.in](https://wttr.in/)
- [bible-api.com](https://bible-api.com/)
- [alquran.cloud](https://alquran.cloud/)
- [UptimeRobot](https://uptimerobot.com/)