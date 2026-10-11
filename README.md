# First Alert 🚨

[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/avielshaar/first-alert)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-AI_Classification-8E75C2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)

> A real-time alert aggregation and distribution pipeline connecting Telegram broadcast channels to WhatsApp groups using AI intent classification and cross-source correlation.

---

## System architecture

```text
Telegram MTProto feeds
        ↓
Message ingestion + persisted per-channel cursors
        ↓
Hybrid classifier (deterministic filters + Gemini)
        ↓
Persisted event correlation and multi-channel confirmation
        ↓
WhatsApp dispatch with retry-aware event handling
        ↓
Target WhatsApp group
```

## Key features

- **Telegram ingestion:** Uses GramJS with a persisted message cursor per channel. Messages are read in chronological order and the cursor advances only after the message is safely processed.
- **Hybrid classification:** Combines Hebrew-specific deterministic rules with Google Gemini intent classification.
- **Cross-channel corroboration:** Correlates reports into a single pending event instead of keeping the same incident under multiple partial dictionary keys. Both initial alerts and updates require confirmation from the configured number of channels.
- **Retry-aware dispatch:** Failed WhatsApp sends leave event/cursor state pending for retry.
- **Restart recovery:** Cursors, last published alert, pending event state, Telegram session, and WhatsApp authentication data are stored under `./data` by default.

## Tech stack

- Runtime: Node.js 22+
- AI: Google Generative AI SDK (`@google/generative-ai`) with the stable `gemini-3.5-flash-lite` model by default
- Telegram: `telegram` (GramJS MTProto client)
- WhatsApp: `whatsapp-web.js`, Puppeteer, `qrcode-terminal`
- Configuration: `dotenv`

## Project structure

```text
first-alert/
├── src/
│   ├── clients/
│   │   ├── telegram.js
│   │   ├── whatsapp.js
│   │   └── handlers/ready.js
│   ├── messaging/
│   │   ├── classifier.js
│   │   └── processor.js
│   ├── utils/logger.js
│   ├── config.js
│   └── index.js
├── tests/
├── data/                 # Runtime state; do not commit
├── .env.example
├── Dockerfile
├── package.json
└── package-lock.json
```

## Configuration

Copy `.env.example` to `.env` and fill in your own values:

```env
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash
ALERT_CHANNELS=-1001234567890,-1009876543210
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
WHATSAPP_GROUPS=YourExactWhatsAppGroupName
TELEGRAM_CURSOR_FILE=./data/telegram-cursors.json
FIRST_ALERT_STATE_FILE=./data/processor-state.json
TELEGRAM_SESSION_FILE=./data/telegram_session
WHATSAPP_AUTH_PATH=./data/wwebjs_auth
```

`GEMINI_MODEL` is optional; the source defaults to `gemini-3.5-flash-lite`. WhatsApp group matching is exact: set `WHATSAPP_GROUPS` to the complete group name. If zero or multiple exact matches exist, sending is disabled rather than guessing.

## Run locally

```bash
npm ci
npm start
```

On first launch, scan the WhatsApp QR code and complete Telegram authentication. Existing local sessions in `.telegram_session` and `.wwebjs_auth` are migrated to `./data` if the new locations do not yet exist.

## Run with Docker

Build the image from the repository root:

```bash
docker build -t first-alert .
```

Persist runtime state between container replacements by mounting the data directory:

```bash
docker run --env-file .env -v "$PWD/data:/app/data" first-alert
```

Do not commit `.env`, Telegram sessions, WhatsApp authentication, or files under `data/`.

## Tests

```bash
npm test
```

Tests cover utility behavior and critical regressions such as classifier failures, relative time parsing, event deduplication, delivery retries, and update corroboration.
