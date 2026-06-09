const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Focused smoke test: visit retailer search/product pages, click first product when available,
// fall back to injecting a synthetic product element. Capture page/service-worker console
// and network requests/responses. Write a per-run log to `extension-run.log`.

async function run() {
  const extensionPath = path.resolve(__dirname, '..', '..', 'extension');
  const userDataDir = path.join(__dirname, 'tmp-user-data');
  const outLog = path.join(__dirname, 'extension-run.log');
  const append = (s) => fs.appendFileSync(outLog, s + '\n');

  if (!fs.existsSync(extensionPath)) {
    console.error('Extension folder not found at', extensionPath);
    process.exit(2);
  }

  if (fs.existsSync(outLog)) fs.unlinkSync(outLog);
  append('=== Playwright extension run — ' + new Date().toISOString() + ' ===');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  // Global request/response logging
  context.on('request', req => {
    try { append(`[REQ] ${req.method()} ${req.url()}`); } catch (e) {}
  });
  context.on('response', async res => {
    try {
      const url = res.url();
      const st = res.status();
      let body = '';
      try { body = await res.text(); if (body && body.length > 2000) body = body.slice(0,2000) + '...'; } catch(e) { body = '<non-text or truncated>'; }
      append(`[RES] ${st} ${url} \n${body}`);
    } catch (e) {}
  });

  const page = await context.newPage();

  // Reduce obvious bot signals (non-evasive): webdriver false, languages, platform
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-AU', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  page.on('console', msg => { try { append(`[PAGE CONSOLE] ${msg.type()} ${msg.text()}`); } catch (e) {} });

  // Attach to any existing service workers (best-effort)
  try {
    const sws = context.serviceWorkers();
    append(`Found ${sws.length} service workers at start`);
    for (const w of sws) {
      try { w.on('console', m => append(`[SW CONSOLE] ${m.text()}`)); append(`Attached to service worker: ${w.url()}`); } catch (e) { append('SW attach failed: ' + e.message); }
    }
  } catch (e) { append('serviceWorkers() not available: ' + e.message); }

  // Retailer list (focused on previously failing sites)
  const sites = [
    'https://www.jbhifi.com.au',
    'https://www.harveynorman.com.au',
    'https://www.theiconic.com.au',
    'https://www.amazon.com.au',
    'https://www.ebay.com.au',
    'https://www.officeworks.com.au',
    'https://www.kogan.com',
    'https://www.thegoodguys.com.au',
    'https://www.cottonon.com',
    'https://www.myer.com.au',
    'https://www.davidjones.com',
    'https://www.footlocker.com.au',
    'https://www.jd-sports.com.au',
    'https://www.rebelsport.com.au'
  ];

  const productName = 'Samsung Galaxy S25 256GB';
  const productPrice = 999.99;

  const searchMap = {
    'harveynorman.com.au': q => `https://www.harveynorman.com.au/search/?q=${q}`,
    'theiconic.com.au':    q => `https://www.theiconic.com.au/search/?q=${q}`,
    'amazon.com.au':       q => `https://www.amazon.com.au/s?k=${q}`,
    'officeworks.com.au':  q => `https://www.officeworks.com.au/shop/officeworks/search?q=${q}`,
    'thegoodguys.com.au':  q => `https://www.thegoodguys.com.au/SearchDisplay?searchTerm=${q}`,
    'cottonon.com':        q => `https://www.cottonon.com/search?q=${q}`,
    'myer.com.au':         q => `https://www.myer.com.au/search?query=${q}`,
    'davidjones.com':      q => `https://www.davidjones.com/search?q=${q}`,
    'jd-sports.com.au':    q => `https://www.jd-sports.com.au/search/?q=${q}`,
    'rebelsport.com.au':   q => `https://www.rebelsport.com.au/search?q=${q}`
  };

  for (const site of sites) {
    append('\n--- Visiting ' + site + ' ---');
    console.log('Visiting', site);
    try { await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { append('Navigation failed: ' + e.message); }

    const q = encodeURIComponent(productName);
    const host = new URL(site).hostname.replace(/^www\./, '');

    let navigatedToProduct = false;
    if (searchMap[host]) {
      try {
        append('Navigating to search page for ' + host);
        await page.goto(searchMap[host](q), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1200);
        const linkHandle = await page.$(`a[href*="/product"], a[href*="/products/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/itm/"], a[href*="/products/"]`);
        if (linkHandle) {
          try {
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }), linkHandle.click()]);
            navigatedToProduct = true; append('Clicked first product link on ' + host); await page.waitForTimeout(800);
          } catch (e) { append('Click navigation failed: ' + e.message); }
        } else { append('No obvious product link on search page for ' + host); }
      } catch (e) { append('Search navigation failed: ' + e.message); }
    }

    if (!navigatedToProduct) {
      try {
        await page.evaluate((name, price) => {
          const old = document.getElementById('pp-test-inject'); if (old) old.remove();
          const container = document.createElement('div'); container.id = 'pp-test-inject';
          const h1 = document.createElement('h1'); h1.textContent = name;
          const p = document.createElement('div'); p.className = 'price'; p.textContent = '$' + price;
          container.style.border = '2px dashed #4f46e5'; container.style.padding = '8px'; container.style.margin = '12px';
          container.appendChild(h1); container.appendChild(p); document.body.prepend(container);
        }, productName, productPrice);
        append('Injected synthetic product on ' + host);
      } catch (e) { append('Injection failed: ' + e.message); }
    }

    try {
      append('Waiting for injected panel (#pp) on ' + site);
      await page.waitForSelector('#pp', { state: 'attached', timeout: 20000 });
      append('Panel detected on ' + site + ' — waiting for prices to load');
      await page.waitForFunction(() => {
        const el = document.querySelector('#pp-prices'); if (!el) return false; const txt = el.innerText || ''; return txt && !txt.includes('Fetching prices') && !txt.includes("Couldn't load prices");
      }, { timeout: 30000 });

      const pricesText = await page.$eval('#pp-prices', e => e.innerText.trim());
      append(site + ' — Prices:\n' + pricesText);
      console.log(site, 'prices captured');
    } catch (e) {
      append(site + ' — Smoke step failed: ' + e.message);
      console.error(site, 'failed:', e.message);
    }

    await page.waitForTimeout(1200);
  }

  // finalize and close
  await new Promise(r => setTimeout(r, 1500));
  append('=== End run ===');
  await context.close();
  console.log('Log written to', outLog);
}

run().catch(e => { console.error('Run error:', e); process.exit(1); });

