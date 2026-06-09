// PricePilot AU — backend server
// Playwright scrapes JS-rendered AU retailer sites
// Returns real prices + direct product URLs
// Server-side alert monitoring sends email when target price is hit

const express      = require("express");
const cors         = require("cors");
const rateLimit    = require("express-rate-limit");
const cron         = require("node-cron");
const nodemailer   = require("nodemailer");
const fs           = require("fs");
const path         = require("path");
const { chromium } = require("playwright");

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────
app.use("/prices", rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));
app.use("/alerts", rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

// ── Optional shared-secret auth ───────────────────────────────
// Set BACKEND_SECRET env var on Railway to lock down /prices
const SECRET = process.env.BACKEND_SECRET || "";
app.use("/prices", (req, res, next) => {
  if (!SECRET) return next();
  if (req.headers["x-api-key"] === SECRET) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// ── Price cache ───────────────────────────────────────────────
const CACHE = new Map();
const TTL   = 30 * 60 * 1000;
function fromCache(k) { const e = CACHE.get(k); if (!e || Date.now()-e.ts > TTL) { CACHE.delete(k); return null; } return e.v; }
function toCache(k,v) { CACHE.set(k,{v,ts:Date.now()}); if (CACHE.size>600) { const old=[...CACHE.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0]; CACHE.delete(old[0]); } }

// ── Alert storage ─────────────────────────────────────────────
// Stored in ./data/alerts.json — mount a Railway volume at /app/data for persistence across deploys
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
let alerts = [];

function loadAlerts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    console.log(`[PP] Loaded ${alerts.length} alerts`);
  } catch (_) { alerts = []; }
}

function saveAlerts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch (e) { console.error("[PP] Could not save alerts:", e.message); }
}

// ── Price history ─────────────────────────────────────────────
// One entry per price check: { q, price (min across retailers), ts }
// Kept for 90 days; endpoint returns last 30 days grouped by day.
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
let priceHistory = [];

function loadHistory() {
  try { priceHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch (_) { priceHistory = []; }
}

function appendHistory(q, prices) {
  if (!prices.length) return;
  const minPrice = Math.min(...prices.map(p => p.price));
  priceHistory.push({ q, price: minPrice, ts: Date.now() });
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  if (priceHistory.length > 10000) priceHistory = priceHistory.filter(e => e.ts > cutoff);
  fs.writeFile(HISTORY_FILE, JSON.stringify(priceHistory), () => {});
}

function getHistory(q) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const relevant = priceHistory.filter(e => e.q === q && e.ts > cutoff);
  const byDay = {};
  for (const e of relevant) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    if (!byDay[day] || e.price < byDay[day]) byDay[day] = e.price;
  }
  return Object.entries(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, price]) => ({ date, price }));
}

loadAlerts();
loadHistory();

// ── Email ─────────────────────────────────────────────────────
// Set SMTP_USER + SMTP_PASS (+ optionally SMTP_HOST, SMTP_PORT, SMTP_FROM) in Railway env vars.
// Works with Gmail App Passwords or Resend (smtp.resend.com / port 587 / user "resend").
function getTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT  || "587"),
    secure: false,
    auth: { user, pass }
  });
}

async function sendAlertEmail(transporter, alert, prices) {
  const from    = process.env.SMTP_FROM || process.env.SMTP_USER;
  const best    = prices[0];
  const others  = prices.slice(1, 5);
  const name    = alert.name.length > 60 ? alert.name.slice(0, 60) + "…" : alert.name;

  await transporter.sendMail({
    from:    `PricePilot AU <${from}>`,
    to:      alert.email,
    subject: `💰 Price drop: ${name} is now $${best.price} at ${best.retailer}`,
    html: `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <div style="background:#4f46e5;border-radius:12px;padding:20px 24px;margin-bottom:24px">
    <h1 style="color:#fff;margin:0;font-size:20px">✈ PricePilot AU — Price Drop!</h1>
  </div>
  <p style="font-size:15px;color:#374151">Your alert for <strong>${name}</strong> was triggered.</p>
  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:16px 0">
    <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Best price found</div>
    <div style="font-size:28px;font-weight:800;color:#15803d">$${best.price.toFixed(2)}</div>
    <div style="font-size:14px;color:#374151;margin-top:2px">${best.retailer} · ${best.shipping}</div>
    <a href="${best.url}" style="display:inline-block;margin-top:14px;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-weight:600;font-size:14px">View deal →</a>
  </div>
  ${others.length ? `
  <p style="font-size:13px;font-weight:600;color:#6b7280;margin:16px 0 8px">Other prices found</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    ${others.map(p => `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:7px 0;font-weight:500">${p.retailer}</td>
      <td style="padding:7px 0;font-weight:700;text-align:right">$${p.price.toFixed(2)}</td>
      <td style="padding:7px 0 7px 12px;color:#9ca3af;text-align:right">${p.shipping}</td>
      <td style="padding:7px 0 7px 12px;text-align:right"><a href="${p.url}" style="color:#4f46e5;font-weight:600">View</a></td>
    </tr>`).join("")}
  </table>` : ""}
  <p style="font-size:12px;color:#d1d5db;margin-top:24px">Your target price was $${alert.targetPrice.toFixed(2)}. This alert will keep firing until you remove it.</p>
</body>
</html>`
  });
}

// ── Browser ───────────────────────────────────────────────────
let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage","--disable-gpu"]
    });
  }
  return browser;
}

async function openPage() {
  const b   = await getBrowser();
  const ctx = await b.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    locale: "en-AU", timezoneId: "Australia/Sydney",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": "en-AU,en;q=0.9" }
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",           { get: () => undefined });
    Object.defineProperty(navigator, "plugins",             { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, "languages",           { get: () => ["en-AU","en"] });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  await page.route("**/*", r => ["image","media","font"].includes(r.request().resourceType()) ? r.abort() : r.continue());
  return { page, ctx };
}

// ── Helpers ───────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

function clean(name) {
  return name
    .replace(/\b\d+(\.\d+)?\s*(uk|us|eu|cm|gb|tb|inch)\b/gi,"")
    .replace(/\b(black|white|grey|gray|navy|gold|silver|cream|coral|tan|olive|beige)\b/gi,"")
    .replace(/\b(size|new|used|men|women|kids|unisex|low|mid|high|og|retro|gore.tex|gtx)\b/gi,"")
    .replace(/['"()[\]]/g,"").replace(/\s+/g," ").trim().split(" ").slice(0,6).join(" ");
}

function score(title, q) {
  // Normalise storage/unit spacing so "256 GB" and "256GB" match identically
  const norm  = s => s.toLowerCase().replace(/(\d+)\s*(gb|tb|mb|inch)\b/gi, "$1$2");
  const t     = norm(title);
  const words = norm(q).split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return 0;

  // Tokens starting with a digit (model numbers, storage) are hard requirements —
  // a mismatch almost certainly means the wrong variant (128GB vs 256GB, S24 vs S25).
  const nums  = words.filter(w => /^\d/.test(w));
  const alpha = words.filter(w => !/^\d/.test(w) && w.length > 2);

  if (nums.length) {
    const hits = nums.filter(n => t.includes(n)).length;
    if (!hits) return 0.02; // wrong variant — penalise heavily
    const wordCov = alpha.length ? alpha.filter(w => t.includes(w)).length / alpha.length : 1;
    return wordCov * (hits / nums.length);
  }

  if (!alpha.length) return 0;
  const cov   = alpha.filter(w => t.includes(w)).length / alpha.length;
  // Slight penalty for bloated titles (bundle packs, accessories listed together)
  const noise = t.split(/\s+/).length > words.length * 3 ? 0.85 : 1;
  return cov * noise;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms=15000) => Promise.race([p, new Promise((_,rej) => setTimeout(()=>rej(new Error("timeout")),ms))]);

// ── Universal DOM extractor ───────────────────────────────────
const EXTRACTOR = `
(function(query, baseUrl) {
  function toPrice(text) {
    const m = (text||"").replace(/,/g,"").match(/\\$\\s*([0-9]+(?:\\.[0-9]{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function scoreTitle(title, q) {
    const norm  = s => s.toLowerCase().replace(/(\\d+)\\s*(gb|tb|mb)/gi, "$1$2");
    const t     = norm(title);
    const words = norm(q).split(/\\s+/).filter(w => w.length > 1);
    if (!words.length) return 0;
    const nums  = words.filter(w => /^\\d/.test(w));
    const alpha = words.filter(w => !/^\\d/.test(w) && w.length > 2);
    if (nums.length) {
      const hits = nums.filter(n => t.includes(n)).length;
      if (!hits) return 0.02;
      const wc = alpha.length ? alpha.filter(w => t.includes(w)).length / alpha.length : 1;
      return wc * (hits / nums.length);
    }
    if (!alpha.length) return 0;
    return alpha.filter(w => t.includes(w)).length / alpha.length;
  }
  const skip = [/\\/search/i,/\\?q=/,/\\?query=/,/\\/category/i,/\\/cart/i,/\\/account/i,/\\/login/i,/#$/];
  const links = [...document.querySelectorAll("a[href]")].filter(a => {
    try {
      const u = new URL(a.href);
      if (u.host !== window.location.host && !a.href.startsWith(baseUrl)) return false;
      if (skip.some(p=>p.test(u.pathname+u.search))) return false;
      return u.pathname.split("/").filter(Boolean).length >= 1;
    } catch { return false; }
  });
  let best = null, bestScore = -1;
  for (const link of links.slice(0,80)) {
    let anc = link;
    for (let d=0; d<8; d++) {
      anc = anc.parentElement;
      if (!anc || anc===document.body) break;
      const price = toPrice(anc.textContent);
      if (!price||price<1||price>99999) continue;
      const titleEl = anc.querySelector("h1,h2,h3,h4,[class*='name' i],[class*='title' i]");
      const title   = (titleEl?.textContent||"").trim();
      if (!title||title.length<3) continue;
      const priceEl = anc.querySelector("[class*='price' i],[data-price],[itemprop='price']");
      const exactP  = priceEl ? toPrice(priceEl.textContent||priceEl.getAttribute("data-price")||priceEl.getAttribute("content")||"") : null;
      const finalP  = exactP || price;
      const s = scoreTitle(title, query);
      if (s > bestScore) {
        bestScore = s;
        let href = link.href;
        if (href.startsWith("/")) href = baseUrl+href;
        best = { price: finalP, url: href, title };
      }
      break;
    }
  }
  return best;
})`;

async function playwrightScrape({ searchUrl, retailer, baseUrl, query, scoreQuery, waitFor, delay=700 }) {
  let page=null, ctx=null;
  try {
    ({page,ctx} = await openPage());
    await page.goto(searchUrl, { waitUntil:"domcontentloaded", timeout:15000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout:10000 }).catch(()=>{});
    else await page.waitForLoadState("networkidle", { timeout:8000 }).catch(()=>{});
    await sleep(delay);
    await page.evaluate(() => window.scrollBy(0,400));
    await sleep(400);
    const sq = scoreQuery || query;
    const result = await page.evaluate(({ query, baseUrl, extractor }) => {
      return eval(extractor)(query, baseUrl);
    }, { query: sq, baseUrl, extractor: EXTRACTOR });
    if (result?.price>0) console.log(`[PP] ${retailer}: $${result.price} "${result.title?.slice(0,50)}"`);
    else                 console.log(`[PP] ${retailer}: no result`);
    return result;
  } catch(e) { console.log(`[PP] ${retailer}: ${e.message}`); return null; }
  finally { if (page) await page.close().catch(()=>{}); if (ctx) await ctx.close().catch(()=>{}); }
}

// ── Retailer list ─────────────────────────────────────────────
const pw = (name, domain, urlFn, waitFor, delay) => ({
  name, domain,
  fn: (q, sq) => playwrightScrape({ searchUrl: urlFn(q), retailer: name, baseUrl: `https://www.${domain}`, query: q, scoreQuery: sq, waitFor, delay })
});

const RETAILERS = [
  { name:"Amazon AU", domain:"amazon.com.au",
    fn: async (q, sq) => {
      const r  = await fetch(`https://www.amazon.com.au/s?k=${encodeURIComponent(q)}`, {headers:{"User-Agent":UA,"Accept-Language":"en-AU"}});
      const pg = await r.text();
      const asins  = [...pg.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map(m=>m[1]).filter(Boolean);
      const prices = [...pg.matchAll(/class="a-offscreen">\s*\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/g)].map(m=>parseFloat(m[1].replace(/,/g,""))).filter(p=>p>0);
      if (!asins.length||!prices.length) return null;
      let asin=asins[0], hi=0;
      for (const m of pg.matchAll(/data-asin="([A-Z0-9]{10})"[\s\S]{0,2000}?class="a-size-medium[^"]*"[^>]*>([^<]{5,200})</g)) { const s=score(m[2],sq||q); if(s>hi){hi=s;asin=m[1];} }
      return { price:prices[0], url:`https://www.amazon.com.au/dp/${asin}`, shipping:prices[0]>=49?"Free delivery":"$6.99 delivery" };
    }
  },
  { name:"eBay AU", domain:"ebay.com.au",
    fn: async (q, sq) => {
      const r  = await fetch(`https://www.ebay.com.au/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`, {headers:{"User-Agent":UA}});
      const pg = await r.text();
      const items = [];
      const cardRe = /href="(https:\/\/www\.ebay\.com\.au\/itm\/[^"?#\s]+)"[\s\S]{0,1500}?class="s-item__title[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]{5,150})[\s\S]{0,600}?AU \$([0-9,]+(?:\.[0-9]{2})?)/g;
      for (const m of pg.matchAll(cardRe)) {
        const url=m[1].split("?")[0], title=m[2].replace(/New Listing/i,"").trim(), price=parseFloat(m[3].replace(/,/g,""));
        if (url&&title.length>3&&price>0) items.push({url,title,price});
      }
      if (!items.length) return null;
      let best=items[0], hi=0;
      for (const it of items) { const s=score(it.title,sq||q); if(s>hi){hi=s;best=it;} }
      return { price:best.price, url:best.url, shipping:"See listing" };
    }
  },
  pw("JB Hi-Fi",      "jbhifi.com.au",        q=>`https://www.jbhifi.com.au/search?query=${encodeURIComponent(q)}`,          "[class*='ProductCard'],[class*='product-tile']", 900),
  pw("Harvey Norman", "harveynorman.com.au",   q=>`https://www.harveynorman.com.au/search/?q=${encodeURIComponent(q)}`,       ".product-card,.product-item",                   800),
  pw("The Iconic",    "theiconic.com.au",      q=>`https://www.theiconic.com.au/search/?q=${encodeURIComponent(q)}`,          "[data-testid='product-card'],[class*='ProductCard']", 900),
  pw("JD Sports AU",  "jd-sports.com.au",      q=>`https://www.jd-sports.com.au/search/?q=${encodeURIComponent(q)}`,         ".c-product-tile,.product-tile",                 700),
  pw("Foot Locker AU","footlocker.com.au",     q=>`https://www.footlocker.com.au/search?query=${encodeURIComponent(q)}`,      ".c-product-tile,.ProductCard",                  700),
  pw("Rebel Sport",   "rebelsport.com.au",     q=>`https://www.rebelsport.com.au/search?q=${encodeURIComponent(q)}`,         "[class*='ProductCard']",                        700),
  pw("Myer",          "myer.com.au",           q=>`https://www.myer.com.au/search?query=${encodeURIComponent(q)}`,           "[class*='ProductCard'],[class*='ProductTile']",  800),
  pw("David Jones",   "davidjones.com",        q=>`https://www.davidjones.com/search?q=${encodeURIComponent(q)}`,            "[class*='ProductCard']",                        800),
  pw("Officeworks",   "officeworks.com.au",    q=>`https://www.officeworks.com.au/shop/officeworks/search?q=${encodeURIComponent(q)}&view=grid&sortby=tmp_priceSort&ascending=true`, "[class*='ProductTile']", 700),
  pw("Target AU",     "target.com.au",         q=>`https://www.target.com.au/c?text=${encodeURIComponent(q)}`,               "[class*='ProductCard']",                        700),
  pw("Big W",         "bigw.com.au",           q=>`https://www.bigw.com.au/search?q=${encodeURIComponent(q)}`,               "[class*='ProductCard']",                        700),
  pw("Kmart AU",      "kmart.com.au",          q=>`https://www.kmart.com.au/search?q=${encodeURIComponent(q)}`,              "[class*='ProductCard']",                        700),
  pw("The Good Guys", "thegoodguys.com.au",    q=>`https://www.thegoodguys.com.au/SearchDisplay?searchTerm=${encodeURIComponent(q)}`, "[class*='ProductCard'],[class*='product-tile']", 800),
  pw("Zara AU",       "zara.com",              q=>`https://www.zara.com/au/en/search?searchTerm=${encodeURIComponent(q)}`,   "[class*='product-grid-product']",               1200),
  pw("H&M AU",        "hm.com",               q=>`https://www2.hm.com/en_au/search-results.html?q=${encodeURIComponent(q)}`,"[class*='product-item']",                       1000),
  pw("ASOS AU",       "asos.com",              q=>`https://www.asos.com/au/search/?q=${encodeURIComponent(q)}`,              "[data-auto-id='productTile']",                  1000),
  pw("Cotton On",       "cottonon.com",            q=>`https://www.cottonon.com/AU/search?q=${encodeURIComponent(q)}`,                    "[class*='ProductCard']",                              800),
  pw("Chemist Warehouse","chemistwarehouse.com.au",q=>`https://www.chemistwarehouse.com.au/search?q=${encodeURIComponent(q)}`,              "[class*='product-item'],[class*='ProductCard']",       900),
  pw("Priceline",       "priceline.com.au",        q=>`https://www.priceline.com.au/search?q=${encodeURIComponent(q)}`,                        "[class*='ProductCard'],[class*='product-tile']",       900),
  pw("Dan Murphy's",    "danmurphys.com.au",        q=>`https://www.danmurphys.com.au/search?searchTerm=${encodeURIComponent(q)}`,             "[class*='ProductCard'],[data-testid*='product']",      1000),
  pw("Liquorland",      "liquorland.com.au",        q=>`https://www.liquorland.com.au/search?q=${encodeURIComponent(q)}`,                       "[class*='ProductCard']",                              900),
  pw("Woolworths",      "woolworths.com.au",         q=>`https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(q)}`,"[data-testid='product-tile'],[class*='product-tile']", 1200),
  pw("Coles",           "coles.com.au",              q=>`https://www.coles.com.au/search?q=${encodeURIComponent(q)}`,                           "[data-testid='product-tile'],[class*='ProductTile']",  1200),
  pw("My Chemist",      "mychemist.com.au",          q=>`https://www.mychemist.com.au/search?q=${encodeURIComponent(q)}`,                        "[class*='ProductCard'],[class*='product-item']",       800),
  pw("BWS",             "bws.com.au",                q=>`https://www.bws.com.au/search?q=${encodeURIComponent(q)}`,                             "[class*='ProductCard']",                              900),
];

// ── Price API ─────────────────────────────────────────────────
app.get("/health", (_,res) => res.json({ ok:true, cached:CACHE.size, browser:browser?.isConnected()||false, alerts:alerts.length }));


app.get("/prices", async (req, res) => {
  const { q, exclude } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  const query = clean(q);
  const key   = `${query}|${exclude||""}`;
  const hit   = fromCache(key);
  if (hit) { console.log(`[PP] Cache: ${query}`); return res.json({...hit, cached:true}); }

  console.log(`\n[PP] === "${query}" exclude:${exclude||"none"} ===`);
  const targets = RETAILERS.filter(r => !(exclude && r.domain.includes(exclude)));

  const settled = await Promise.allSettled(
    targets.map(r => withTimeout(r.fn(query, q).catch(()=>null), 15000))
  );

  const prices = [];
  targets.forEach((r,i) => {
    const v = settled[i].status==="fulfilled" ? settled[i].value : null;
    if (v?.price>0) prices.push({ retailer:r.name, domain:r.domain, price:v.price, url:v.url, shipping:v.shipping||"Check shipping" });
  });
  prices.sort((a,b)=>a.price-b.price);

  appendHistory(query, prices);
  const history  = getHistory(query);
  const response = { prices, query, count:prices.length, history };
  toCache(key, response);
  console.log(`[PP] Done: ${prices.length} results, ${history.length} history points`);
  res.json({...response, cached:false});
});

// ── Alert API ─────────────────────────────────────────────────
// POST /alerts/add  { email, name, targetPrice, currentPrice, url }
app.post("/alerts/add", (req, res) => {
  const { email, name, targetPrice, currentPrice, url } = req.body;
  if (!email || !name || targetPrice == null) return res.status(400).json({ error: "email, name, targetPrice required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (alerts.filter(a => a.email === email).length >= 50) return res.status(429).json({ error: "Max 50 alerts per email" });

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  alerts.push({ id, email, name, targetPrice: parseFloat(targetPrice), currentPrice: parseFloat(currentPrice||0), url: url||"", addedAt: new Date().toISOString() });
  saveAlerts();
  console.log(`[PP] Alert added: ${email} → ${name} @ $${targetPrice}`);
  res.json({ ok: true, id });
});

// DELETE /alerts/:id?email=user@example.com  (email used to verify ownership)
app.delete("/alerts/:id", (req, res) => {
  const { email } = req.query;
  const before = alerts.length;
  alerts = alerts.filter(a => !(a.id === req.params.id && (!email || a.email === email)));
  if (alerts.length < before) { saveAlerts(); console.log(`[PP] Alert deleted: ${req.params.id}`); }
  res.json({ ok: true });
});

// GET /alerts?email=user@example.com
app.get("/alerts", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email required" });
  res.json({ alerts: alerts.filter(a => a.email === email) });
});

// ── Alert cron — runs every 6 hours ──────────────────────────
async function runAlertChecks() {
  if (!alerts.length) return;
  console.log(`\n[PP] === Alert check: ${alerts.length} alerts ===`);
  const transporter = getTransporter();
  if (!transporter) console.log("[PP] No SMTP configured — logging only");

  for (const alert of [...alerts]) {
    try {
      const query   = clean(alert.name);
      const settled = await Promise.allSettled(
        RETAILERS.map(r => withTimeout(r.fn(query, alert.name).catch(()=>null), 15000))
      );
      const prices = [];
      RETAILERS.forEach((r,i) => {
        const v = settled[i].status==="fulfilled" ? settled[i].value : null;
        if (v?.price>0) prices.push({ retailer:r.name, price:v.price, url:v.url, shipping:v.shipping||"Check shipping" });
      });
      prices.sort((a,b)=>a.price-b.price);

      if (!prices.length) { console.log(`[PP] Alert: no prices for "${alert.name}"`); continue; }

      const best = prices[0];
      console.log(`[PP] Alert check: "${alert.name}" best=$${best.price} target=$${alert.targetPrice}`);

      if (best.price <= alert.targetPrice) {
        if (transporter) {
          await sendAlertEmail(transporter, alert, prices);
          console.log(`[PP] Email sent → ${alert.email}: $${best.price} at ${best.retailer}`);
        } else {
          console.log(`[PP] WOULD email ${alert.email}: "${alert.name}" dropped to $${best.price} at ${best.retailer}`);
        }
      }
    } catch (e) {
      console.log(`[PP] Alert check error for "${alert.name}": ${e.message}`);
    }
  }
}

// Every 6 hours at :00
cron.schedule("0 */6 * * *", runAlertChecks);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[PP] Backend running on :${PORT}`);
  try { await getBrowser(); console.log("[PP] Browser ready"); }
  catch(e) { console.error("[PP] Browser error:", e.message); }
});
process.on("SIGTERM", async()=>{ if(browser) await browser.close(); process.exit(0); });
process.on("SIGINT",  async()=>{ if(browser) await browser.close(); process.exit(0); });
