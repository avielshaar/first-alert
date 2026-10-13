FROM node:22-bookworm-slim

# Runtime dependencies for Puppeteer's bundled Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# The postinstall patch must be present and applied before dev dependencies are pruned.
COPY patches ./patches
RUN npm ci
RUN npm prune --omit=dev --ignore-scripts
# Install the browser explicitly instead of assuming the Puppeteer postinstall download ran.
RUN rm -rf /root/.cache/puppeteer && ./node_modules/.bin/puppeteer browsers install chrome

# Exercise the actual production dependency graph while building the image. This catches
# Puppeteer/whatsapp-web.js module-format and Chromium runtime-library incompatibilities
# without needing Telegram, Gemini, or a logged-in WhatsApp account.
RUN node -e 'const { Client } = require("whatsapp-web.js"); const puppeteer = require("puppeteer"); if (typeof Client !== "function" || typeof puppeteer.launch !== "function") throw new Error("WhatsApp/Puppeteer runtime exports are unavailable"); (async () => { const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] }); try { const page = await browser.newPage(); await page.setContent("<title>First-Alert Chromium smoke test</title>"); if (await page.title() !== "First-Alert Chromium smoke test") throw new Error("Chromium page smoke test failed"); } finally { await browser.close(); } })().catch(error => { console.error(error); process.exit(1); });'

COPY . .
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["npm", "start"]
