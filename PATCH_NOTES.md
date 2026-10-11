# First-Alert — Critical Reliability Patch

This archive is an overlay for the repository root. It contains updated `src/` files, regression tests, and an updated `.env.example`. Extract/merge it into your existing repository, replacing files when prompted. No GitHub changes have been pushed.

## Fixed

1. Switched the retired `gemini-3.1-flash-lite-preview` model to the current stable `gemini-3.5-flash-lite` model. Optional `GEMINI_MODEL` override is supported. The code loads `.env` before constructing the client.
2. Made AI failures and invalid model output return `PROCESSING_ERROR`, not `IRRELEVANT`; failed processing is not acknowledged by the Telegram poller and can be retried.
3. Replaced polling of only the newest Telegram message with chronological `iterMessages({ minId, reverse: true })` iteration, draining backlogs and processing each message before advancing its cursor.
4. Made alert/update callbacks return an explicit success boolean. Failed sends leave the event and Telegram cursor in place for retry.
5. Persisted Telegram cursors and pending processor state atomically to local JSON files so restarts can resume instead of skipping messages or losing cross-channel evidence. The cursor/state files are saved under `./data/` by default and excluded by `.gitignore`.
6. Replaced three partial dictionary keys per incident with one event object and conservative correlation. Also applies cross-channel corroboration to updates rather than immediately publishing an update from one channel.
7. Resolved relative arrival times from the Telegram message timestamp and added singular/plural hour parsing.
8. Made event expiry use the most recent corroborating message; added retry-aware message de-duplication inside each event.
9. Added regression tests for classifier failures, relative times, canonical event tracking, delivery retry, and update corroboration.
10. Added SIGTERM shutdown handling and restricted newly written Telegram session file permissions.
11. Updated the Docker base image to Node 22 and switched installation to `npm ci`; declared `/app/data` as persistent runtime storage. Telegram and WhatsApp authentication data use that directory by default, with migration from the old local paths.
12. Added `.dockerignore` so `.env`, authentication sessions, and runtime state are not copied into Docker image layers.

## Important notes

- This patch keeps the existing `@google/generative-ai` dependency to avoid an untested dependency/lockfile migration in the critical fix. Google's official documentation recommends migrating to `@google/genai`; do that in a separate tested change.
- The state files improve restart recovery, but they do not guarantee exactly-once delivery if WhatsApp accepts a message and the process crashes before recording the outcome. A transactional outbox/database and provider-side idempotency would be needed for that guarantee. When deploying in a replaceable Docker container, mount persistent storage for `./data/` (for example, `-v ./data:/app/data` in Docker).
- Use a current supported Node.js LTS runtime when deploying. Run `npm ci`, `npm test`, and `npm audit` in your repository before deploying.
- The new `tests/*.critical.test.js` files are intended to run with the repository's existing Jest setup.
