# Phantom-X

A Node.js bot that bridges Telegram and WhatsApp. It allows users to link their WhatsApp accounts via a pairing code requested through a Telegram bot command.

## Architecture

- **Runtime**: Node.js (CommonJS)
- **Entry point**: `index.js`
- **Package manager**: npm

## Key Libraries

- `@whiskeysockets/baileys` — WhatsApp Web API client (multi-device)
- `telegraf` — Telegram bot framework
- `pino` — Logger

## How It Works

1. User sends `/pair <phone_number>` to the Telegram bot
2. Bot connects to WhatsApp via Baileys and requests a pairing code
3. Pairing code is sent back to the user via Telegram
4. User enters the code on their WhatsApp to link the account

## Configuration

- `TELEGRAM_TOKEN` — Telegram Bot token (stored as a Replit secret), obtained from @BotFather

## Running

```bash
npm start
```

Auth state for WhatsApp is persisted in the `auth_info/` directory (auto-created at runtime).
