# First Alert — Reliability and operations notes

This file describes the implementation in this repository; it is not an archive overlay or a set of instructions to copy files into another checkout.

## Implemented safeguards

1. **Classification failures:** Gemini transport errors and malformed model responses become retryable processing errors, not irrelevant messages. The Telegram cursor is not advanced on those failures.
2. **Prompt boundary:** Telegram text is JSON-encoded and explicitly designated as untrusted input in the classifier prompt.
3. **Ordered Telegram ingestion:** The poller iterates messages chronologically from the persisted per-channel cursor and commits the cursor only after processing succeeds.
4. **Cross-source confirmation:** New incidents and updates require confirmation from the configured number of distinct channels. Repeated messages from one channel do not satisfy that rule.
5. **Delivery retries:** Failed WhatsApp sends preserve the event and keep the cursor pending. Such delivery-pending events are not deleted by the ordinary two-minute correlation cleanup, so a longer WhatsApp outage does not silently discard them.
6. **State safety:** Processor state and Telegram cursors are written atomically. Corrupt Telegram cursor state or malformed pending-event state fails closed rather than silently resetting state, skipping messages, or losing cross-channel evidence. Restored event IDs are checked for collisions.
7. **Persistent sessions:** Telegram and WhatsApp session data default to ./data; WhatsApp's legacy ./.wwebjs_auth directory is migrated when the configured persistent destination does not already exist. In Docker, mount /app/data.
8. **WhatsApp group selection:** The configured exact group name must match exactly one group. No match or ambiguous duplicate names disable sending instead of selecting the first possible chat.
9. **Reconnection management:** WhatsApp initialization failures are handled, overlapping initialization attempts are blocked, stale client events are ignored, and shutdown cancels scheduled reconnects.
10. **Configuration and secrets:** Startup validates required values before creating messaging clients; .env, .env.* except .env.example, sessions, runtime data, and logs are ignored by Git.
11. **Dependency patching:** patches/whatsapp-web.js+1.34.7.patch is applied by patch-package during install. The Docker build applies it while development dependencies are present and prunes them only afterward.
12. **Maintained Gemini SDK:** The classifier uses Google's supported @google/genai SDK instead of the deprecated, unmaintained @google/generative-ai package.
13. **CI:** The beta branch runs a clean install, a JavaScript syntax check, Jest tests, and Docker image build. It also reports full and production dependency audit results; audit reporting is currently non-blocking because the existing WhatsApp/Puppeteer dependency chain has upstream advisories that need a separate compatibility-tested migration.

## Open security finding — not cleared

The most recent npm audit report for the current dependency graph showed **32 findings overall (13 high, 19 moderate)** and **9 high-severity findings in the production dependency graph** after development dependencies were pruned for the container. High findings include the Puppeteer/browser-download/proxy dependency chain and the WhatsApp client dependency. The automated npm audit fix proposal attempts downgrades that would risk invalidating the repository's WhatsApp Web patch, so this branch does not apply an unverified forced downgrade.

Treat this as an unresolved security risk before production deployment. Resolve it in a separate change by updating or replacing the affected WhatsApp/Puppeteer stack and validating a real authenticated WhatsApp send/receive session; a passing unit test and Docker build alone do not validate that runtime.

## Validate before deployment

From the repository root, run npm ci, npm test, and docker build -t first-alert . . GitHub Actions runs these same core checks on beta and the mainline branches.

## Important delivery limitation

This design improves retry behavior but does **not** guarantee exactly-once delivery. WhatsApp could accept a message and the process could crash before recording the result durably, which can produce a duplicate after restart. Exactly-once behavior would require a durable transactional outbox and a provider-side idempotency mechanism or equivalent reconciliation.

The WhatsApp Web patch touches internal web-client structures. CI verifies that the patch applies during install and that the project tests and container build succeed, but it cannot validate a live authenticated WhatsApp session. Recheck this patch whenever whatsapp-web.js is upgraded or WhatsApp Web changes materially.
