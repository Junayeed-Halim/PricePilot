// PricePilot AU — backend server
// Playwright scrapes JS-rendered AU retailer sites
// Returns real prices + direct product URLs

const express    = require("express");
const cors       = require("cors");
const { chromium } = require("playwright");

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ── Cache ─────────────────────────────────────────────────────
const CACHE = new Map();
const TTL   = 30 * 60 * 1000;
function fromCache(k) { const e = CACHE.get(k); if (!e || Date.now()-e.ts > TTL) { CACHE.delete(k); return null; } return e.v; }
function toCache(k,v) { CACHE.set(k,{v,ts:Date.now()}); if (CACHE.size>600) { const old=[...CACHE.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0]; CACHE.delete(old[0]); } }

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
  const t = q.toLowerCase().split(/\s+/).filter(s => s.length > 2);
  return t.length ? t.filter(s => title.toLowerCase().includes(s)).length / t.length : 0;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms=20000) => Promise.race([p, new Promise((_,rej) => setTimeout(()=>rej(new Error("timeout")),ms))]);

// ── Universal DOM extractor ───────────────────────────────────
// Finds price + direct product URL by DOM pattern, not class names.
// Works on any site regardless of how they structure their HTML.
const EXTRACTOR = `
(function(query, baseUrl) {
  function toPrice(text) {
    const m = (text||"").replace(/,/g,"").match(/\\$\\s*([0-9]+(?:\\.[0-9]{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function scoreTitle(title, q) {
    const toks = q.toLowerCase().split(/\\s+/).filter(t=>t.length>2);
    return toks.length ? toks.filter(t=>title.toLowerCase().includes(t)).length/toks.length : 0;
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

async function playwrightScrape({ searchUrl, retailer, baseUrl, query, waitFor, delay=700 }) {
  let page=null, ctx=null;
  try {
    ({page,ctx} = await openPage());
    await page.goto(searchUrl, { waitUntil:"domcontentloaded", timeout:22000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout:10000 }).catch(()=>{});
    else await page.waitForLoadState("networkidle", { timeout:8000 }).catch(()=>{});
    await sleep(delay);
    await page.evaluate(() => window.scrollBy(0,400));
    await sleep(400);
    const result = await page.evaluate(({ query, baseUrl, extractor }) => {
      return eval(extractor)(query, baseUrl);
    }, { query, baseUrl, extractor: EXTRACTOR });
    if (result?.price>0) console.log(`[PP] ${retailer}: $${result.price} "${result.title?.slice(0,50)}"`);
    else                 console.log(`[PP] ${retailer}: no result`);
    return result;
  } catch(e) { console.log(`[PP] ${retailer}: ${e.message}`); return null; }
  finally { if (page) await page.close().catch(()=>{}); if (ctx) await ctx.close().catch(()=>{}); }
}

// ── Retailer list ─────────────────────────────────────────────
const pw = (name, domain, urlFn, waitFor, delay) => ({
  name, domain,
  fn: q => playwrightScrape({ searchUrl: urlFn(q), retailer: name, baseUrl: `https://www.${domain}`, query: q, waitFor, delay })
});

const RETAILERS = [
  // HTTP fetchers (fast, no browser needed)
  { name:"Amazon AU",     domain:"amazon.com.au",
    fn: async q => {
      const r  = await fetch(`https://www.amazon.com.au/s?k=${encodeURIComponent(q)}`, {headers:{"User-Agent":UA,"Accept-Language":"en-AU"}});
      const pg = await r.text();
      const asins  = [...pg.matchAll(/data-asin="([A-Z0-9]{10})"/g)].map(m=>m[1]).filter(Boolean);
      const prices = [...pg.matchAll(/class="a-offscreen">\s*\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/g)].map(m=>parseFloat(m[1].replace(/,/g,""))).filter(p=>p>0);
      if (!asins.length||!prices.length) return null;
      let asin=asins[0], hi=0;
      for (const m of pg.matchAll(/data-asin="([A-Z0-9]{10})"[\s\S]{0,2000}?class="a-size-medium[^"]*"[^>]*>([^<]{5,200})</g)) { const s=score(m[2],q); if(s>hi){hi=s;asin=m[1];} }
      return { price:prices[0], url:`https://www.amazon.com.au/dp/${asin}`, shipping:prices[0]>=49?"Free delivery":"$6.99 delivery" };
    }
  },
  { name:"eBay AU",       domain:"ebay.com.au",
    fn: async q => {
      const r  = await fetch(`https://www.ebay.com.au/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`, {headers:{"User-Agent":UA}});
      const pg = await r.text();
      const urls   = [...pg.matchAll(/href="(https:\/\/www\.ebay\.com\.au\/itm\/[^"?#\s]+)/g)].map(m=>m[1]);
      const prices = [...pg.matchAll(/AU \$([0-9,]+(?:\.[0-9]{2})?)/g)].map(m=>parseFloat(m[1].replace(/,/g,""))).filter(p=>p>0);
      const titles = [...pg.matchAll(/class="s-item__title[^"]*"[^>]*>(?:<span[^>]*>)?([^<]{5,150})/g)].map(m=>m[1].replace(/New Listing/i,"").trim());
      if (!urls.length||!prices.length) return null;
      let idx=0,hi=0; titles.forEach((t,i)=>{const s=score(t,q);if(s>hi){hi=s;idx=i;}});
      return { price:prices[Math.min(idx,prices.length-1)], url:urls[Math.min(idx,urls.length-1)].split("?")[0], shipping:"See listing" };
    }
  },
  // Playwright scrapers for JS-rendered sites
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
  pw("Cotton On",     "cottonon.com",          q=>`https://www.cottonon.com/AU/search?q=${encodeURIComponent(q)}`,           "[class*='ProductCard']",                        800),
];

// ── API ───────────────────────────────────────────────────────
app.get("/health", (_,res) => res.json({ ok:true, cached:CACHE.size, browser:browser?.isConnected()||false }));

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
    targets.map(r => withTimeout(r.fn(query).catch(()=>null), 22000))
  );

  const prices = [];
  targets.forEach((r,i) => {
    const v = settled[i].status==="fulfilled" ? settled[i].value : null;
    if (v?.price>0) prices.push({ retailer:r.name, domain:r.domain, price:v.price, url:v.url, shipping:v.shipping||"Check shipping" });
  });
  prices.sort((a,b)=>a.price-b.price);

  const response = { prices, query, count:prices.length };
  toCache(key, response);
  console.log(`[PP] Done: ${prices.length} results`);
  res.json({...response, cached:false});
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[PP] Backend running on :${PORT}`);
  try { await getBrowser(); console.log("[PP] Browser ready"); }
  catch(e) { console.error("[PP] Browser error:", e.message); }
});
process.on("SIGTERM", async()=>{ if(browser) await browser.close(); process.exit(0); });
process.on("SIGINT",  async()=>{ if(browser) await browser.close(); process.exit(0); });
