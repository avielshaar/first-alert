# First Alert 🚨

[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/avielshaar/first-alert)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-AI_Classification-8E75C2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)

> A real-time, low-latency alert aggregation and distribution pipeline connecting official MTProto Telegram broadcast channels to WhatsApp groups using AI intent recognition and stateful deduplication.

---

## 📌 System Architecture

```
┌─────────────────────────┐
│ MTProto Telegram Feeds  │ (Official warning channels)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Ingestion Layer         │ (src/clients/telegram.js - GramJS)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Hybrid AI Classifier    │ (src/messaging/classifier.js)
│ - Regex Guardrails      │ -> Filters noise, news, and ads
│ - Google Gemini API     │ -> Zero-shot structured threat extraction
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Stateful Deduplicator   │ (src/messaging/processor.js)
│ - Sliding Time Window   │ -> Correlates multi-source broadcasts
│ - Anti-Spam Throttling  │ -> Prevents notification bursts
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Dispatch Gateway        │ (src/clients/whatsapp.js - Puppeteer / LocalAuth)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Target WhatsApp Groups  │ (Real-time subscriber delivery)
└─────────────────────────┘
```

---

## ✨ Key Features

- **Real-Time MTProto Ingestion**: Persistent listening to high-priority Telegram warning channels using GramJS with cached session authentication.
- **Hybrid AI & Deterministic Filtering**: Couples deterministic Hebrew regex/keyword whitelists/blacklists with Google Gemini API for fast, zero-shot threat identification without redundant API consumption.
- **Stateful Sliding-Window Deduplication**: Correlates concurrent multi-source reports within a sliding context window to merge duplicate regional alerts and prevent notification bursts.
- **Headless WhatsApp Dispatch**: Automated delivery to target groups via `whatsapp-web.js` with persistent local session management (`LocalAuth`).
- **Production Proven**: Actively deployed and serving 60+ live subscribers with ~5-second delivery latency under peak load.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES6+)
- **AI & Classification**: Google Generative AI SDK (`@google/generative-ai` / Gemini API)
- **Telegram Client**: `telegram` (GramJS MTProto client)
- **WhatsApp Gateway**: `whatsapp-web.js`, `qrcode-terminal`
- **Configuration & Utilities**: `dotenv`, `input`

---

## 📂 Project Structure

```
first-alert/
├── src/
│   ├── clients/
│   │   ├── telegram.js        # MTProto client connection & channel listener
│   │   ├── whatsapp.js        # WhatsApp Web client & message dispatcher
│   │   └── handlers/
│   │       └── ready.js       # Post-initialization event handler
│   ├── messaging/
│   │   ├── classifier.js      # Hybrid regex + Gemini AI intent recognition
│   │   └── processor.js       # Sliding-window deduplication & correlation engine
│   ├── config.js              # Environment & configuration loader
│   ├── index.js               # Application bootstrap & event orchestration
│   └── logger.js              # Centralized logging service
├── .gitignore
├── package.json
└── package-lock.json
```

---

## ⚙️ Environment Variables

Create a `.env` file in the root directory:

```env
# Telegram API Credentials (from https://my.telegram.org)
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash
ALERT_CHANNELS=-1001234567890,-1009876543210

# Google Gemini API
GEMINI_API_KEY=your_gemini_api_key

# WhatsApp Target
WHATSAPP_GROUPS=YourTargetGroupName
```

---

## 🚀 Getting Started

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/avielshaar/first-alert.git
cd first-alert
npm install
```

### 2. Run the Application
```bash
node src/index.js
```

1. Scan the terminal QR code with your WhatsApp app to establish the session.
2. Authenticate the Telegram client on the first run (SMS / Telegram code prompt).
