# First Alert — Reliability and operations notes

This file describes the implementation in this repository; it is not an archive overlay or a set of instructions to copy files into another checkout.

## Implemented safeguards

1. **Classification failures:** Gemini transport errors and malformed model responses become retryable processing errors, not irrelevant messages. The Telegram cursor is not advanced on those failures.
2. **Prompt boundary:** Telegram text is JSON-encoded and explicitly designated as untrusted input in the classifier prompt.
3. **Ordered Telegram ingestion:** The poller iterates messages chronologically from the persisted per-channel cursor and commits the cursor only after processing succeeds.
4. **Cross-source confirmation:** New incidents and updates require confirmation from distinct Telegram channels. Each source country and target area is verified independently; a field reported by only one channel is omitted or labeled unverified rather than treated as fact.
5. **Delivery retries:** Failed WhatsApp sends preserve the event and keep the cursor pending. Such delivery-pending events are not deleted by the ordinary two-minute correlation cleanup, so a longer WhatsApp outage does not silently discard them.
6. **State safety:** Processor state and Telegram cursors are written atomically. Corrupt Telegram cursor state or malformed pending-event state fails closed rather than silently resetting state, skipping messages, or losing cross-channel evidence. Restored event IDs are checked for collisions.
7. **Persistent sessions:** Telegram and WhatsApp session data default to ./data; WhatsApp's legacy ./.wwebjs_auth directory is migrated when the configured persistent destination does not already exist. In Docker, mount /app/data.
8. **WhatsApp group selection:** The configured exact group name must match exactly one group. No match or ambiguous duplicate names disable sending instead of selecting the first possible chat.
9. **Reconnection management:** WhatsApp initialization failures are handled, overlapping initialization attempts are blocked, stale client events are ignored, and shutdown cancels scheduled reconnects.
10. **Configuration and secrets:** Startup validates required values before creating messaging clients; .env, .env.* except .env.example, sessions, runtime data, and logs are ignored by Git.
11. **Dependency patching:** patches/whatsapp-web.js+1.34.7.patch is applied by patch-package during install. The Docker build applies it while development dependencies are present and prunes them only afterward.
12. **Maintained Gemini SDK:** The classifier uses Google's supported @google/genai SDK instead of the deprecated, unmaintained @google/generative-ai package.
13. **CI:** The beta branch runs a clean install, a JavaScript syntax check, Jest tests, and a Docker image build. Full dependency audit reporting is informational; `npm audit --omit=dev` is a blocking CI gate. The current production-only audit passes with zero known vulnerabilities.
14. **Field-level verification and ETA reconciliation:** A source country or target area is accepted only with support from distinct channels. ETA estimates with a spread of 3 minutes or less are combined using the midpoint for two estimates or the median for 3+ estimates. Larger disagreements are shown as a range (plus a median with 3+ estimates). If a field is not corroborated, WhatsApp labels it "לא מאומת" and the event remains eligible for further corroboration within the short context window. Legacy publication state without the verification marker is not reused as verified source, target, or time data.
15. **False-positive guard:** Short-message fallback now requires a clear tactical launch/siren signal; generic words such as "דיווח" or a region-only mention are not enough. Regression tests cover geography-only, generic report, and explicit short launch messages.
16. **WhatsApp group discovery:** If the client becomes ready before chats synchronize, exact target-group discovery retries without guessing between ambiguous groups.
17. **Startup recovery:** Telegram startup retries independently of the WhatsApp ready handler after transient failures. Invalid persisted cursor state is marked non-retryable and requires operator repair.
18. **Polling and cursor recovery:** Unexpected Telegram polling-loop exits are supervised with bounded exponential restart delays. A first-seen cursor baseline is held while state persistence is retrying; the bot does not keep re-reading "latest" and advance past messages because of a storage error.
19. **Publication-state consistency:** Processor state now records the verified publication baseline in the same atomic write as the post-delivery event state. Delivery callback exceptions are treated as failed sends, preserving pending state instead of escaping without a retry decision.
20. **Dependency remediation:** The locked WhatsApp/Puppeteer tree was updated to Puppeteer 25.13.0 and @puppeteer/browsers 3.2.4 using a package.json override and regenerated lockfile. CI confirms the whatsapp-web.js 1.34.7 patch still applies after a clean install.
21. **Docker browser smoke test:** The production image explicitly installs Chrome after pruning development dependencies, uses `unzip` for extraction, and starts Chromium to load a test page and verify its title. The test exposed and corrected the missing browser binary and missing archive extractor; the current CI build passes this smoke test.

## Current dependency audit status

The latest clean-install CI audit after regenerating the lockfile reports **23 findings in the full development graph (19 moderate, 4 high)** and **0 known vulnerabilities in production dependencies** (`npm audit --omit=dev`). The remaining high findings are in development/tooling dependencies such as `patch-package` and its transitive dependencies; the production Puppeteer/browser-download/proxy findings no longer appear in the production-only audit.

The full-graph audit report remains informational, while `npm audit --omit=dev` is enforced as a blocking CI step. Operators should continue to review the full report when changing dependencies. Do not downgrade `patch-package` to the audit tool's suggested older major release without compatibility testing. Puppeteer is now overridden to 25.13.0 while `whatsapp-web.js` remains 1.34.7; the current patch applies successfully in CI, but a real authenticated WhatsApp session is still required to validate runtime compatibility.

## Validate before deployment

From the repository root, run npm ci, npm test, and docker build -t first-alert . . GitHub Actions runs these same core checks on beta and the mainline branches.

## Important delivery limitation

This design improves retry behavior but does **not** guarantee exactly-once delivery. WhatsApp could accept a message and the process could crash before recording the result durably, which can produce a duplicate after restart. Exactly-once behavior would require a durable transactional outbox and a provider-side idempotency mechanism or equivalent reconciliation.

The WhatsApp Web patch touches internal web-client structures. CI verifies that the patch applies during install and that the project tests and container build succeed, but it cannot validate a live authenticated WhatsApp session. Recheck this patch whenever whatsapp-web.js is upgraded or WhatsApp Web changes materially.
