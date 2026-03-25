const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const net = require('net');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile',  width: 390,  height: 844, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' }
];

// Try common dev server ports
const COMMON_PORTS = [3000, 3001, 4000, 4200, 5173, 5174, 8080, 8000, 8888, 4321];

async function isPortOpen(port) {
  return new Promise(resolve => {
    const s = net.createConnection(port, 'localhost');
    s.setTimeout(600);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function findDevServer() {
  for (const port of COMMON_PORTS) {
    if (await isPortOpen(port)) return `http://localhost:${port}`;
  }
  return null;
}

async function takeScreenshots(taskId, screenshotsDir, logFn) {
  logFn(`[Screenshots] Looking for dev server...`);

  const url = await findDevServer();
  if (!url) {
    logFn(`[Screenshots] ⚠  No dev server found on common ports (${COMMON_PORTS.join(', ')})`);
    logFn(`[Screenshots] Start your dev server (npm run dev / npm start) before running tasks`);
    return [];
  }

  logFn(`[Screenshots] ✓ Found dev server at ${url}`);

  const taskDir = path.join(screenshotsDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const results = [];
  const browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    try {
      logFn(`[Screenshots] Capturing ${vp.name} (${vp.width}×${vp.height})...`);

      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        userAgent: vp.userAgent,
        isMobile: vp.isMobile || false,
        deviceScaleFactor: vp.isMobile ? 2 : 1
      });

      const page = await ctx.newPage();

      // Wait for network idle
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

      // Small settle delay for animations
      await page.waitForTimeout(800);

      const filename = `${vp.name}.png`;
      const filepath = path.join(taskDir, filename);
      await page.screenshot({ path: filepath, fullPage: false });

      results.push({ viewport: vp.name, width: vp.width, height: vp.height, path: filepath, url });
      logFn(`[Screenshots] ✓ ${vp.name} saved`);

      await ctx.close();
    } catch (err) {
      logFn(`[Screenshots] ✗ ${vp.name} failed: ${err.message}`);
    }
  }

  await browser.close();

  if (results.length > 0) {
    logFn(`[Screenshots] 📸 ${results.length} screenshot(s) captured from ${url}`);
  }

  return results;
}

module.exports = { takeScreenshots, findDevServer };