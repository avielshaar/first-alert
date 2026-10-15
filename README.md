# First Alert 🚨

[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/avielshaar/first-alert)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-AI_Classification-8E75C2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)

> A Telegram-to-WhatsApp alert aggregation pipeline using AI intent classification, deterministic Hebrew data extraction, and cross-channel confirmation.

This README describes the `beta` implementation. The application monitors multiple Telegram channels and publishes to **one exact-name WhatsApp group**.

---

## System architecture

```text
WhatsApp authentication + exact target-group selection
        ↓
Telegram MTProto polling
        ↓
Chronological ingestion + persisted per-channel cursors
        ↓
Hybrid classifier (deterministic rules + Gemini intent)
        ↓
Persisted event correlation + field-level confirmation
        ↓
WhatsApp alerts and updates + retry-aware processing
        ↓
One target WhatsApp group
```

## Key features

- **Ordered Telegram ingestion:** Uses GramJS to read new messages oldest-first from a persisted cursor for each channel. A cursor advances only after the processor reports success and the cursor write succeeds. Empty/non-text messages are skipped and acknowledged.
- **Hybrid classification:** Hebrew blacklist rules reject blocked content before calling Gemini. Gemini classifies intent as `LAUNCH_REPORT`, `UPDATE_TO_LAST`, or `IRRELEVANT`; deterministic rules extract source, target regions, and time, and can override the AI category. Pure region-only fragments are classified deterministically without a Gemini request and can contribute evidence only when they match one unique, recent incident.
- **Two-channel confirmation:** Initial alerts and updates pass the same distinct-channel gate. `MIN_CHANNELS_TO_ACT` is hardcoded to `2` in `src/config.js`, not an environment variable. Repeated messages from one channel do not count as independent confirmation.
- **Field-level verification:** Source and each target area need support from two distinct channels. A new alert also requires a confirmed target. An unconfirmed source is left blank for the WhatsApp formatter; unconfirmed target additions are withheld rather than inherited as new evidence.
- **ETA reconciliation:** Relative times use the original Telegram message timestamp and are formatted in `Asia/Jerusalem`. Hebrew future durations, singular minutes, and fractional-hour expressions are supported; elapsed or negated durations are not converted into future ETAs. A clearly labeled ETA clock time is preferred over unrelated report timestamps, and conflicting time candidates are omitted rather than guessed. Time reconciliation uses the latest valid estimate from each channel and needs at least two channels. A spread of up to three minutes produces a midpoint for two estimates or a median for three or more. Larger disagreements produce a range, with a median added for three or more estimates. Midnight crossings are handled.
- **Event correlation and deduplication:** Compatible partial reports are merged into one event. Conflicting known sources or disjoint targets are kept separate; ambiguous partial matches are not guessed. Each published event retains its own verified baseline, so a delayed report for an older concurrent incident is not compared against an unrelated alert that was published later. The event context window is two minutes of inactivity. Recent publications are used as a deduplication/update baseline for a separate configurable window.
- **Follow-up evidence:** Successfully published events stay open briefly so later channel reports can confirm omitted fields or refine the ETA. New information is published only after its field-level confirmation rules are met.
- **Retry-aware processing:** Gemini transport/schema failures request a retry rather than becoming irrelevant messages. Selected temporary API errors are retried up to three attempts with backoff. Failed WhatsApp delivery retains pending event state and holds the current Telegram cursor; delivery-pending events are excluded from ordinary context-window cleanup.
- **Restart recovery:** Telegram cursors, processor state, Telegram sessions, and WhatsApp authentication default to `./data`. Cursor and processor state use temporary-file writes followed by rename. Malformed cursor values and invalid publication baselines are rejected; recoverable per-incident publication state is restored across restarts. Invalid saved cursor or processor state fails closed instead of silently starting over.
- **WhatsApp lifecycle handling:** Exact group matching, legacy auth migration, reconnect scheduling, duplicate-initialization guards, stale-client event checks, retryable group discovery, Telegram-startup recovery, and shutdown cleanup are implemented.

## Tech stack

- Runtime: Node.js 22, used by CI and the Docker image
- AI: Google GenAI SDK (`@google/genai`); default model string: `gemini-3.5-flash-lite`
- Telegram: `telegram` (GramJS MTProto user-account client), `input`
- WhatsApp: `whatsapp-web.js` 1.34.7 with a local compatibility patch, Puppeteer 25.13.0, and `qrcode-terminal`
- Configuration: `dotenv`
- Tests: Jest
- Dependency compatibility patch: `patch-package`; `package.json` pins the WhatsApp Web client’s Puppeteer dependency to 25.13.0 through an override, with the lockfile regenerated and the local patch confirmed to apply in CI.

`GEMINI_MODEL` can override the code default. Model availability and API access must be checked with the Google account used for deployment; the unit tests mock Gemini and do not establish live model availability.

## Project structure

```text
first-alert/
├── .github/workflows/tests.yml
├── patches/
│   └── whatsapp-web.js+1.34.7.patch
├── src/
│   ├── clients/
│   │   ├── telegram.js
│   │   ├── telegram-cursor-store.js
│   │   ├── whatsapp.js
│   │   ├── whatsapp-helpers.js
│   │   └── handlers/ready.js
│   ├── messaging/
│   │   ├── classifier.js
│   │   └── processor.js
│   ├── utils/logger.js
│   ├── config.js
│   └── index.js
├── tests/                # Classifier, ETA edge cases, field-verification matrix, processor, state, and lifecycle tests
├── data/                 # Created at runtime; ignored by Git
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── PATCH_NOTES.md
├── README.md
├── package.json
└── package-lock.json
```

## Configuration

Copy `.env.example` to `.env` and fill in your own values:

```bash
cp .env.example .env
```

The checked-in example contains the basic credentials and destinations. The expanded example below includes the optional settings supported by the code:

```env
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash
ALERT_CHANNELS=-1001234567890,-1009876543210
TEST_CHANNELS=
GEMINI_API_KEY=your_gemini_api_key
WHATSAPP_GROUPS=YourExactWhatsAppGroupName
WHATSAPP_INVITE_LINK=https://chat.whatsapp.com/your-invite-code

# Optional overrides
LOG_TIME_ZONE=Asia/Jerusalem
GEMINI_MODEL=gemini-3.5-flash-lite
LAST_PUBLISHED_DEDUP_WINDOW_MINUTES=15
APP_DATA_DIR=./data
TELEGRAM_CURSOR_FILE=./data/telegram-cursors.json
FIRST_ALERT_STATE_FILE=./data/processor-state.json
TELEGRAM_SESSION_FILE=./data/telegram_session
WHATSAPP_AUTH_PATH=./data/wwebjs_auth
```

### Required settings

- `TELEGRAM_API_ID`: a positive safe integer for Telegram user-account authentication.
- `TELEGRAM_API_HASH`: Telegram API hash.
- `ALERT_CHANNELS` and/or `TEST_CHANNELS`: comma-separated channel identifiers. Startup requires at least one identifier across both lists, but publishing requires evidence from two distinct channels. Duplicates and empty entries are removed.
- `GEMINI_API_KEY`: Google Gemini API key.
- `WHATSAPP_GROUPS`: **one complete, exact group name**, despite the plural variable name. It is not a comma-separated destination list.
- `WHATSAPP_INVITE_LINK`: required join-link text appended to outgoing alerts and updates. The application does not use it to join a group automatically.

Startup reports these missing/invalid settings before creating messaging clients. It does not validate channel access, API credentials, invite-link format, or model availability in advance.

`TEST_CHANNELS` is not a dry-run mode. Its channels are monitored alongside `ALERT_CHANNELS` and can contribute to real publications.

The WhatsApp account must already have access to the target group. Exactly one group must match the configured name. No match, duplicate exact-name matches, or a same-name personal chat will not be selected. Initial Telegram startup occurs only after WhatsApp is ready and the group is found.

### Optional settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Model passed to the Google GenAI SDK. |
| `LAST_PUBLISHED_DEDUP_WINDOW_MINUTES` | `15` | Lifetime of the previous-publication baseline; `0` disables reuse. Non-finite, negative, or overflowing values fall back to `10`, not `15`. |
| `APP_DATA_DIR` | `./data` | Base directory for default Telegram session and WhatsApp auth paths only. |
| `TELEGRAM_CURSOR_FILE` | `./data/telegram-cursors.json` | Per-channel Telegram cursor state. |
| `FIRST_ALERT_STATE_FILE` | `./data/processor-state.json` | Pending events and previous-publication state. |
| `TELEGRAM_SESSION_FILE` | `<APP_DATA_DIR>/telegram_session` | Telegram session file; overrides the base directory. |
| `WHATSAPP_AUTH_PATH` | `<APP_DATA_DIR>/wwebjs_auth` | WhatsApp LocalAuth directory; overrides the base directory. |
| `LOG_TIME_ZONE` | `Asia/Jerusalem` | Timezone used for log timestamps; use a valid IANA timezone such as `UTC`. |

**Changing `APP_DATA_DIR` alone does not move the cursor or processor state files.** Set their path overrides too if relocating all runtime state. Mount every custom persistence location when running in Docker.

The two-minute context window and the two-channel publication threshold are code constants, not supported environment settings. Legacy publication state without `verificationVersion: 1` is not reused as verified evidence.

## Logging and troubleshooting

Every application log line uses one consistent format:

```text
[YYYY-MM-DD HH:mm:ss] [LEVEL] [Subsystem] message and diagnostic fields
```

Timestamps use `LOG_TIME_ZONE` (default: `Asia/Jerusalem`). Levels are `INFO` for normal flow, `WARN` for retries or waiting for more evidence, and `ERROR` for failed operations. Third-party `dotenv` startup tips are suppressed so they do not obscure application logs.

Useful fields and transitions:

- `[Telegram] Received message` records the channel, message ID, original Telegram timestamp, and cursor before processing. `[Telegram] Cursor persisted` confirms the new cursor was saved; if processing fails, the cursor stays put and the message is retried.
- `[Classifier] ... category=IRRELEVANT | scope=message-by-itself` means only that the message is not actionable by itself. `next_step=check-contextual-follow-up` means the processor will still check whether it belongs to an open incident.
- `[Correlation]` records whether a message created an event, merged into an existing event, or was attached as a region-only follow-up. It includes event ID, independent channel count, confirmed fields, and fields still awaiting confirmation.
- `[Dispatch] action=SEND_NEW_ALERT` or `action=SEND_UPDATE` marks the delivery attempt. `[WhatsApp][Delivery]` records the destination and the fields included, and `[Dispatch] outcome=ALERT_DELIVERED` or `UPDATE_DELIVERED` records the processor's successful delivery transition.
- A region-only message that cannot be matched uniquely is not guessed onto an event; the `[Correlation]` line explains why it was not attached.

The log output includes message previews for classification diagnostics, but never prints Telegram/Gemini credentials. When sharing logs publicly, still review message text and group names for sensitive information.

## Run locally

Use Node.js 22 and run from the repository root:

```bash
npm ci
npm start
```

`npm ci` applies the committed WhatsApp Web patch through the `postinstall` script. Do not omit development dependencies or skip install scripts for the initial installation: `patch-package` is a development dependency needed at this stage.

On first launch:

1. Scan the WhatsApp QR code with the account that can access the target group.
2. After WhatsApp is ready and finds the group, complete Telegram authentication in the terminal: phone number, login code, and two-factor password if enabled.
3. For each channel without a saved cursor, the application establishes a baseline at its latest message. **Existing channel history is not replayed on first setup.** Restarts resume after saved cursors and process the intervening backlog.

Legacy `.telegram_session` is copied to the configured session file when that destination is absent. Legacy `.wwebjs_auth` is copied to the configured auth path and then removed after successful migration, provided the destination does not already exist. Existing destinations are not overwritten.

Stop with `Ctrl+C` or send `SIGTERM` to shut down the clients and cancel scheduled WhatsApp reconnects.

## Run with Docker

Build the image from the repository root:

```bash
docker build -t first-alert .
```

The image uses `node:22-bookworm-slim`, installs Chromium runtime libraries, runs `npm ci` with the patch directory present, then prunes development dependencies without rerunning install scripts.

For first-time interactive authentication, keep the terminal attached:

```bash
docker run --name first-alert --env-file .env \
  -v "$PWD/data:/app/data" -it first-alert
```

Stop the interactive container before starting an unattended run with the same mounted state:

```bash
docker run --name first-alert-service --env-file .env \
  -v "$PWD/data:/app/data" -d first-alert
```

Watch logs if authentication or group selection needs attention:

```bash
docker logs -f first-alert-service
```

Use one running instance per state directory. The state files use fixed temporary-file names and have no cross-process locking. Removing a container does not remove its bind-mounted `data` directory.

Do not commit `.env`, other `.env.*` files except `.env.example`, session data, or runtime state. Git and Docker ignore the default sensitive paths; custom paths outside them need their own ignore rules. Back up sessions and state securely, since they include account access and retained Telegram message content.

If cursor state is malformed or has an invalid cursor for a configured channel, fresh baselining is refused. Unsupported, malformed, or unreadable processor state also prevents startup. Back up and repair the affected file before restarting. Deleting state is not a harmless reset: it can lose pending evidence and cause Telegram to baseline past unprocessed messages.

## Tests and CI

```bash
npm test
```

The test suite covers:

- Configuration validation and channel-list deduplication.
- Cursor recovery, malformed state, invalid cursors, and atomic writes.
- Deterministic target/time extraction, Gemini failures and response parsing, the configured model string, and JSON-encoded untrusted Telegram content in the prompt.
- Processor state recovery, invalid pending events, and event-ID collision checks.
- Distinct-channel confirmation for alerts and updates, source separation, message retry deduplication, and failed deliveries surviving context-window expiration.
- Per-field corroboration, withheld single-channel fields, legacy unverified baselines, ETA midpoint/median/range behavior, third-channel refinements, and midnight crossings.
- Previous-publication expiration, WhatsApp auth migration, and exact unique group selection.

GitHub Actions runs on pushes and pull requests targeting `main`, `master`, and `beta`. It uses Node.js 22 and performs:

1. `npm ci`, including patch application.
2. Full dependency audit reporting (informational) and a blocking production-only audit (`npm audit --omit=dev`).
3. JavaScript syntax checks across `src` and `tests`.
4. Jest tests.
5. A Docker image build that explicitly installs Chrome and runs a Chromium page smoke test against the production `whatsapp-web.js`/Puppeteer dependency graph.

Unit tests and a successful image build do not validate a live authenticated Telegram/Gemini/WhatsApp session.

## Operational limits and security

- **Not exactly-once delivery:** WhatsApp can accept a message before a crash or failed local state write. A retry or restart can send a duplicate. There is no provider-side idempotency key or transactional outbox.
- **Retries are not a delivery guarantee:** Pending delivery state and its verified publication baseline are now saved together after successful delivery; callback exceptions keep the event pending. This improves local consistency but is not a transactional outbox, and live recovery after outages and restarts still needs testing.
- **Short-lived evidence:** Ordinary pending events expire after two minutes of inactivity when cleanup next runs. Cross-channel confirmation means distinct configured channels, not proof that those channels have independent original sources.
- **WhatsApp Web compatibility:** The committed `whatsapp-web.js@1.34.7` patch normalizes internal IDs and isolates failures while resolving chats/channels and metadata. It touches private WhatsApp Web structures; revalidate patch application and a real authenticated session after client or web changes.
- **Dependency audit (latest CI result):** The full development graph reports 23 findings (19 moderate, 4 high); `npm audit --omit=dev` reports 0 known production vulnerabilities after the Puppeteer override. The remaining high findings are in development tooling (including `patch-package` and transitive dependencies). The full-graph audit is informational, while production audit blocks CI. Re-run both audits after dependency changes, and do not force-downgrade tooling without compatibility tests.
- **Browser runtime smoke test:** The Docker build explicitly clears partial Puppeteer cache, installs Chrome (using `unzip` for extraction), then launches Chromium and verifies a page title. This catches basic module, browser-download, and runtime-library issues, but it is not an authenticated WhatsApp test.
- **Browser isolation:** The WhatsApp client launches Puppeteer with sandbox-disabling flags. Account for this when deciding where and how to run it.

This project aggregates channel reports; corroboration and AI classification do not establish that a report is official or correct. Use official emergency guidance for safety decisions.
