// ================================================================
// PricePilot AU — background.js
// Real-time price fetching for Australian retailers.
//
// Without backend:  Amazon AU, eBay AU, StaticICE, Shopify stores
// With backend:     All of the above + JB Hi-Fi, Harvey Norman,
//                   The Iconic, JD Sports, Foot Locker, Myer,
//                   David Jones, Zara, H&M, ASOS, Rebel Sport etc.
// ================================================================

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

// Cross-browser storage wrapper: uses `browser` when available (Firefox),
// falls back to `chrome` for Chromium browsers. Provides Promise-based
// `get` and `set` helpers to unify callback vs promise APIs.
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
const storage = {
  get: (keys) => new Promise(resolve => browserAPI.storage.local.get(keys, resolve)),
  set: (obj)  => new Promise(resolve => browserAPI.storage.local.set(obj, resolve))
};

// ── Query cleaner ─────────────────────────────────────────────
function clean(name) {
  return name
    .replace(/\b\d+(\.\d+)?\s*(uk|us|eu|cm|gb|tb|inch)\b/gi, "")
    .replace(/\b(black|white|grey|gray|navy|gold|silver|cream|coral|tan|olive|beige)\b/gi, "")
    .replace(/\b(size|new|used|men|women|kids|unisex|low|mid|high|og|retro|gore.tex|gtx)\b/gi, "")
    .replace(/['"()[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

function score(title, q) {
  // Normalise storage/unit spacing so "256 GB" and "256GB" match identically
  const norm  = s => s.toLowerCase().replace(/(\d+)\s*(gb|tb|mb|inch|")\b/gi, "$1$2");
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

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-AU,en;q=0.9" }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const race = (p, ms = 10000) =>
  Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

// ── Category detection ────────────────────────────────────────
function detectCategory(name) {
  const n = name.toLowerCase();
  const electronics = /\b(phone|mobile|iphone|samsung|galaxy|pixel|oneplus|oppo|xiaomi|motorola|huawei|laptop|notebook|tablet|ipad|macbook|imac|monitor|television|\btv\b|headphone|earphone|airpod|earbuds|camera|printer|ps5|playstation|xbox|nintendo|console|router|modem|smartwatch|a\d\d|s\d\d|fold\b|flip\b)\b/;
  const shoes       = /\b(shoe|sneaker|boot|sandal|runner|trainer|loafer|footwear|nike|adidas|puma|reebok|new balance|vans|converse|hoka|salomon|jordan|yeezy|dunk|air max|air force|chuck|skechers|asics|saucony|brooks)\b/;
  const fashion     = /\b(shirt|dress|pants|jeans|jacket|coat|sweater|hoodie|skirt|shorts|blouse|\btee\b|clothing|apparel|zara|uniqlo|cotton on|h&m)\b/;
  if (electronics.test(n)) return "electronics";
  if (shoes.test(n))       return "shoes";
  if (fashion.test(n))     return "fashion";
  return "general";
}

// Search-link pills per category (retailers we can't scrape, shown as quick links)
const SEARCH_LINKS = {
  electronics: [
    { retailer: "JB Hi-Fi",       url: q => `https://www.jbhifi.com.au/search?query=${encodeURIComponent(q)}` },
    { retailer: "Harvey Norman",  url: q => `https://www.harveynorman.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "The Good Guys",  url: q => `https://www.thegoodguys.com.au/SearchDisplay?searchTerm=${encodeURIComponent(q)}` },
    { retailer: "Officeworks",    url: q => `https://www.officeworks.com.au/shop/officeworks/search?q=${encodeURIComponent(q)}` },
    { retailer: "Kogan",          url: q => `https://www.kogan.com/au/shop/?q=${encodeURIComponent(q)}` },
    { retailer: "Bing Lee",       url: q => `https://www.binglee.com.au/search?q=${encodeURIComponent(q)}` },
  ],
  shoes: [
    { retailer: "The Iconic",     url: q => `https://www.theiconic.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "Rebel Sport",    url: q => `https://www.rebelsport.com.au/search?q=${encodeURIComponent(q)}` },
    { retailer: "Foot Locker AU", url: q => `https://www.footlocker.com.au/search?query=${encodeURIComponent(q)}` },
    { retailer: "JD Sports AU",   url: q => `https://www.jd-sports.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "Skechers AU",    url: q => `https://www.skechers.com.au/search?q=${encodeURIComponent(q)}` },
  ],
  fashion: [
    { retailer: "The Iconic",     url: q => `https://www.theiconic.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "Myer",           url: q => `https://www.myer.com.au/search?query=${encodeURIComponent(q)}` },
    { retailer: "David Jones",    url: q => `https://www.davidjones.com/search?q=${encodeURIComponent(q)}` },
    { retailer: "Cotton On",      url: q => `https://www.cottonon.com/AU/search?q=${encodeURIComponent(q)}` },
    { retailer: "ASOS AU",        url: q => `https://www.asos.com/au/search/?q=${encodeURIComponent(q)}` },
  ],
  general: [
    { retailer: "The Iconic",     url: q => `https://www.theiconic.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "Kmart AU",       url: q => `https://www.kmart.com.au/search?q=${encodeURIComponent(q)}` },
    { retailer: "Big W",          url: q => `https://www.bigw.com.au/search?q=${encodeURIComponent(q)}` },
    { retailer: "Catch.com.au",   url: q => `https://www.catch.com.au/search/?q=${encodeURIComponent(q)}` },
    { retailer: "Target AU",      url: q => `https://www.target.com.au/c?text=${encodeURIComponent(q)}` },
  ]
};

// ── Amazon AU ─────────────────────────────────────────────────
// Per-card parsing: correlates ASIN + price + title from same block
async function amazon(q, sq) {
  console.log("[PP] Amazon:", q);
  const html = await get(`https://www.amazon.com.au/s?k=${encodeURIComponent(q)}`);
  if (!html.includes("data-asin=")) {
    console.log("[PP] Amazon: no product cards (possible CAPTCHA)");
    return { source: "Amazon AU", result: null, reason: "No product cards" };
  }

  const cardRe = /data-asin="([A-Z0-9]{10})"([\s\S]{0,3000}?)(?=data-asin="|<\/body>)/g;
  let best = null, bestScore = -1;

  for (const card of html.matchAll(cardRe)) {
    const asin  = card[1];
    const block = card[2];
    const pm    = block.match(/class="a-offscreen">\s*\$\s*([0-9,
      ]+(?:\.[0-9]{1,2})?)/);
    if (!pm) continue;
    const price = parseFloat(pm[1].replace(/,/g, ""));
    if (!price || price < 1 || price > 99999) continue;

    const tm = block.match(/class="a-size-medium[^"]*"[^>]*>([^<]{5,200})/)
            || block.match(/class="a-size-base-plus[^"]*"[^>]*>([^<]{5,200})/)
            || block.match(/<h2[^>]*>[\s\S]{0,100}?<span[^>]*>([^<]{5,200})/);
    const title = tm ? tm[1].trim() : "";
    const s     = score(title, q);

    if (s > bestScore || (bestScore < 0.3 && !best)) {
      bestScore = s; best = { asin, price, title };
    }
  }

  if (!best) return { source: "Amazon AU", result: null, reason: "No price+title pairs found" };
  console.log("[PP] Amazon:", best.price, best.title.slice(0, 50));
  return {
    source: "Amazon AU",
    result: { retailer: "Amazon AU", price: best.price, url: `https://www.amazon.com.au/dp/${best.asin}`, shipping: best.price >= 49 ? "Free delivery" : "$6.99 delivery" },
    reason: "OK"
  };
}

// ── eBay AU ───────────────────────────────────────────────────
async function ebay(q) {
  console.log("[PP] eBay:", q);
  const html = await get(`https://www.ebay.com.au/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`);

  // Parse per card: the item link wraps the title and price is in the same block,
  // so extract all three together to avoid index-mismatch with sponsored items.
  const items = [];
  const cardRe = /href="(https:\/\/www\.ebay\.com\.au\/itm\/[^"?#\s]+)"[\s\S]{0,1500}?class="s-item__title[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?([^<]{5,150})[\s\S]{0,600}?AU \$([0-9,]+(?:\.[0-9]{2})?)/g;
  for (const m of html.matchAll(cardRe)) {
    const url   = m[1].split("?")[0];
    const title = m[2].replace(/New Listing/i, "").trim();
    const price = parseFloat(m[3].replace(/,/g, ""));
    if (url && title.length > 3 && price > 0) items.push({ url, title, price });
  }

  console.log("[PP] eBay:", items.length, "items");
  if (!items.length) return { source: "eBay AU", result: null, reason: "No items parsed" };

  let best = items[0], hi = 0;
  for (const it of items) { const s = score(it.title, q); if (s > hi) { hi = s; best = it; } }

  console.log("[PP] eBay:", best.price, best.url.slice(0, 60));
  return { source: "eBay AU", result: { retailer: "eBay AU", price: best.price, url: best.url, shipping: "See listing" }, reason: "OK" };
}

// ── StaticICE ─────────────────────────────────────────────────
// AU price aggregator for electronics — indexes JB Hi-Fi, Harvey Norman,
// The Good Guys, Mwave, Umart, MobileCiti, Centrecom, Bing Lee etc.
async function staticice(q) {
  console.log("[PP] StaticICE:", q);
  const html = await get(
    `https://www.staticice.com.au/cgi-bin/search.cgi?q=${encodeURIComponent(q)}&stype=1&etype=0&sortby=1&perpage=25`
  );

  const results = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = row[1];
    if (!r.includes("$")) continue;

    const pm = r.match(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
    if (!pm) continue;
    const price = parseFloat(pm[1].replace(/,/g, ""));
    if (!price || price < 1 || price > 99999) continue;

    // Retailer name
    const rm = r.match(/\b(JB Hi-Fi|Harvey Norman|The Good Guys|Mwave|Umart|Centrecom|MobileCiti|Shopping Express|Bing Lee|Appliances Online|Kogan)\b/i);
    const retailer = rm ? rm[1] : null;

    // URL — keep full StaticICE urchin.cgi tracking URL (preserves referrer for retailer access)
    const um = r.match(/urchin\.cgi\/(https?[^"?#\s]+)/i);
    let url  = null;
    if (um) {
      // Full urchin URL so StaticICE handles the redirect with proper referrer headers
      url = `https://www.staticice.com.au/cgi-bin/urchin.cgi/${um[1]}`;
    } else {
      const dm = r.match(/href="(https?:\/\/(?!(?:www\.)?staticice)[^"]{15,300})"/i);
      if (dm) url = dm[1];
    }

    if (!url) {
      // Fallback to search URL for known retailers
      const fallbacks = {
        "JB Hi-Fi":          `https://www.jbhifi.com.au/search?query=${encodeURIComponent(q)}`,
        "Harvey Norman":     `https://www.harveynorman.com.au/search/?q=${encodeURIComponent(q)}`,
        "The Good Guys":     `https://www.thegoodguys.com.au/SearchDisplay?searchTerm=${encodeURIComponent(q)}`,
        "Mwave":             `https://www.mwave.com.au/category/search?q=${encodeURIComponent(q)}`,
        "Umart":             `https://www.umart.com.au/search.phtml?q=${encodeURIComponent(q)}`,
        "Bing Lee":          `https://www.binglee.com.au/search?q=${encodeURIComponent(q)}`,
        "MobileCiti":        `https://www.mobileciti.com.au/catalogsearch/result/?q=${encodeURIComponent(q)}`,
      };
      if (retailer && fallbacks[retailer]) url = fallbacks[retailer];
    }
    if (!url || !retailer) continue;

    results.push({ retailer, price, url, shipping: "Check shipping" });
  }

  const seen = new Map();
  for (const r of results) {
    const k = r.retailer.toLowerCase();
    if (!seen.has(k) || r.price < seen.get(k).price) seen.set(k, r);
  }
  const final = [...seen.values()];
  console.log("[PP] StaticICE:", final.length, "retailers:", final.map(r => r.retailer).join(", "));
  return { source: "StaticICE", results: final, reason: final.length ? "OK" : "No rows matched" };
}

// ── Shopify stores ────────────────────────────────────────────
// Tries /search/suggest.json first (more reliable), falls back to /search.json
async function shopify(domain, q) {
  const name = domain.split(".")[0];
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);

  // Try predictive search API first
  try {
    const r = await fetch(
      `https://www.${domain}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=8`,
      { headers: { "User-Agent": UA, "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" } }
    );
    if (r.ok) {
      const text = await r.text();
      if (text.trim().startsWith("{")) {
        const data     = JSON.parse(text);
        const products = data.resources?.results?.products || [];
        if (products.length) {
          let top = products[0], hi = 0;
          for (const p of products) { const s = score(p.title || "", q); if (s > hi) { hi = s; top = p; } }
          const price = parseFloat(String(top.price || top.price_min || "0").replace(/[^0-9.]/g, ""));
          if (price > 0) {
            const url2 = top.url
              ? (top.url.startsWith("http") ? top.url : `https://www.${domain}${top.url}`)
              : `https://www.${domain}/search?q=${encodeURIComponent(q)}`;
            return { source: domain, result: { retailer: displayName, price, url: url2, shipping: price >= 100 ? "Free shipping" : "$9.95 shipping" }, reason: "OK" };
          }
        }
      }
    }
  } catch (_) {}

  // Fallback to search.json
  try {
    const r = await fetch(
      `https://www.${domain}/search.json?q=${encodeURIComponent(q)}&type=product&limit=12`,
      { headers: { "User-Agent": UA, "Accept": "application/json" } }
    );
    if (!r.ok) return { source: domain, result: null, reason: `HTTP ${r.status}` };
    const text = await r.text();
    if (text.trim().startsWith("<")) return { source: domain, result: null, reason: "HTML returned" };
    const data    = JSON.parse(text);
    const results = data.results || [];
    if (!results.length) return { source: domain, result: null, reason: "0 results" };
    let top = results[0], hi = 0;
    for (const res of results) { const s = score(res.title || "", q); if (s > hi) { hi = s; top = res; } }
    const raw   = top.price_min ?? top.price;
    const price = typeof raw === "number" ? (raw > 1000 ? raw / 100 : raw) : parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    if (!price || price <= 0) return { source: domain, result: null, reason: "No valid price" };
    const handle = top.handle || (top.url || "").replace(/^\/products\//, "").split("?")[0];
    return {
      source: domain,
      result: { retailer: displayName, price, url: handle ? `https://www.${domain}/products/${handle}` : `https://www.${domain}/search?q=${encodeURIComponent(q)}`, shipping: price >= 100 ? "Free shipping" : "$9.95 shipping" },
      reason: "OK"
    };
  } catch (e) {
    return { source: domain, result: null, reason: e.message };
  }
}

// ── Backend (optional, adds full retailer coverage) ───────────
// Set DEFAULT_BACKEND to your Railway URL after deploying
const DEFAULT_BACKEND = "https://robust-patience-production-8176.up.railway.app";

async function backendPrices(name, domain) {
  const { backendUrl } = await storage.get("backendUrl");
  const base = backendUrl || DEFAULT_BACKEND;
  if (!base) return null;
  try {
    const p = new URLSearchParams({ q: name });
    if (domain) p.set("exclude", domain);
    const r = await Promise.race([
      fetch(`${base}/prices?${p}`, { headers: { "User-Agent": UA } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 14000))
    ]);
    if (!r.ok) return null;
    return ((await r.json()).prices || []).filter(p => p.price > 0);
  } catch (e) {
    console.log("[PP] Backend unavailable:", e.message);
    return null;
  }
}

// ── Main price fetcher ────────────────────────────────────────
async function fetchAll(name, gtin, domain) {
  const q        = clean(name);
  const category = detectCategory(name);
  console.log(`[PP] ═══ "${q}" | ${category} | exclude: ${domain || "none"} ═══`);

  // Try backend first — gets real prices from JS-rendered sites
  const backend = await backendPrices(name, domain);
  if (backend?.length) {
    console.log("[PP] Backend:", backend.length, "results");
    return { prices: backend.sort((a, b) => a.price - b.price).slice(0, 6), searchLinks: [], debug: [] };
  }

  // Shopify stores — only relevant for shoes/fashion
  const shopifyDomains = (category === "shoes" || category === "fashion" || category === "general")
    ? ["culturekings.com.au", "gluestore.com.au"] : [];

  // StaticICE — electronics aggregator, skip for shoes/fashion
  const useStaticICE = (category === "electronics" || category === "general");

  const [amz, ebyRes, sice, ...shopRes] = await Promise.all([
    race(amazon(q).catch(e => ({ source: "Amazon AU",  result: null, reason: e.message }))),
    race(ebay(q).catch(e   => ({ source: "eBay AU",    result: null, reason: e.message }))),
    useStaticICE
      ? race(staticice(q).catch(e => ({ source: "StaticICE", results: [], reason: e.message })))
      : Promise.resolve({ source: "StaticICE", results: [], reason: "skipped ("+category+")" }),
    ...shopifyDomains.map(d => race(shopify(d, q).catch(e => ({ source: d, result: null, reason: e.message }))))
  ]);

  const singleSources = [amz, ebyRes, ...shopRes].filter(Boolean);
  const allResults = [
    ...singleSources.filter(s => s?.result).map(s => s.result),
    ...(sice?.results || [])
  ].filter(r => r?.price > 0 && r?.url && r?.retailer);

  const debug = [
    ...singleSources.map(s => ({ source: s.source, found: !!s.result, price: s.result?.price, reason: s.reason })),
    { source: "StaticICE", found: (sice?.results || []).length > 0, count: (sice?.results || []).length, reason: sice?.reason }
  ];

  // Deduplicate by retailer, remove current site, sort cheapest first
  const filtered = allResults.filter(r => !domain || !r.url.includes(domain));
  const seen = new Map();
  for (const r of filtered) {
    const k = r.retailer.toLowerCase();
    if (!seen.has(k) || r.price < seen.get(k).price) seen.set(k, r);
  }
  const prices = [...seen.values()].sort((a, b) => a.price - b.price).slice(0, 6);

  // Search-link pills — category-appropriate, exclude current site
  const searchLinks = (SEARCH_LINKS[category] || SEARCH_LINKS.general)
    .map(r => ({ retailer: r.retailer, url: r.url(q) }))
    .filter(r => !domain || !r.url.includes(domain));

  console.log(`[PP] ${prices.length} prices: ${prices.map(r => r.retailer + " $" + r.price).join(", ") || "none"}`);
  return { prices, searchLinks, debug };
}

// ── Price tracking ────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "pp-check") return;
  const res = await storage.get({ tracked: [] });
  const tracked = res.tracked || [];
  for (const item of tracked) {
    try {
      const { prices } = await fetchAll(item.name, null, "");
      if (prices[0]?.price <= item.targetPrice) {
        chrome.notifications.create(`pp-${item.id}`, {
          type: "basic", iconUrl: "icons/icon48.png",
          title: "PricePilot — Price Drop! 🎉",
          message: `${item.name.slice(0, 50)} is now $${prices[0].price} at ${prices[0].retailer}`
        });
      }
    } catch (_) {}
  }
});

// ── AI ────────────────────────────────────────────────────────
async function callClaude(messages, system, tools = null) {
  const { apiKey } = await storage.get("apiKey");
  if (!apiKey) return null;
  const body = { model: "claude-sonnet-4-6", max_tokens: 1024, system, messages };
  if (tools) body.tools = tools;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `API ${r.status}`); }
  return r.json();
}

const AGENT_TOOLS = [{
  name: "search_au_prices",
  description: "Search live prices for any product across Australian retailers right now. Call multiple times to compare different products.",
  input_schema: {
    type: "object",
    properties: { product_name: { type: "string", description: "Product with brand + model e.g. Samsung Galaxy S25 256GB" } },
    required: ["product_name"]
  }
}];

async function runAgent(request, currentProduct) {
  const { apiKey } = await storage.get("apiKey");
  if (!apiKey) return { error: "no_key" };

  const system = "You are PricePilot, an expert AU shopping agent. Use search_au_prices to find real live prices. Always search before making price claims. Give direct recommendations with exact prices in AUD. 3-5 sentences max.";
  let msg = request;
  if (currentProduct?.name) msg = `Viewing: "${currentProduct.name}" at $${currentProduct.price} AUD.\n${request}`;

  const messages = [{ role: "user", content: msg }];
  const searches = [];

  for (let i = 0; i < 6; i++) {
    const res      = await callClaude(messages, system, AGENT_TOOLS);
    if (!res)      return { error: "no_key" };
    const tools    = (res.content || []).filter(b => b.type === "tool_use");
    const texts    = (res.content || []).filter(b => b.type === "text");
    if (!tools.length || res.stop_reason === "end_turn")
      return { ok: true, answer: texts.map(b => b.text).join("\n").trim(), searches };

    messages.push({ role: "assistant", content: res.content });
    const results = [];
    for (const tool of tools) {
      if (tool.name !== "search_au_prices") continue;
      let prices = [], txt = "";
      try {
        prices = (await fetchAll(tool.input.product_name, null, "")).prices;
        txt    = prices.length
          ? `${prices.length} results for "${tool.input.product_name}":\n` + prices.map(p => `- ${p.retailer}: $${p.price} AUD`).join("\n")
          : `No results for "${tool.input.product_name}"`;
        searches.push({ query: tool.input.product_name, prices });
      } catch (e) { txt = `Search failed: ${e.message}`; searches.push({ query: tool.input.product_name, prices: [] }); }
      results.push({ type: "tool_result", tool_use_id: tool.id, content: txt });
    }
    messages.push({ role: "user", content: results });
  }
  return { ok: true, answer: "Search complete.", searches };
}

// ── Message router ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _, respond) => {

  if (msg.type === "FETCH") {
    fetchAll(msg.name, msg.gtin || null, msg.domain)
      .then(r => respond({ ok: true, prices: r.prices, searchLinks: r.searchLinks, debug: r.debug }))
      .catch(e => { console.error("[PP]", e); respond({ ok: false, prices: [], searchLinks: [], debug: [] }); });
    return true;
  }

  if (msg.type === "AI_VERDICT") {
    const real = (msg.prices || []);
    if (!real.length) { respond({ text: null }); return true; }
    const ctx = real.map(p => `${p.retailer} $${p.price}`).join(", ");
    callClaude(
      [{ role: "user", content: `Product: ${msg.name}\nCurrent: $${msg.price} AUD\nOther AU retailers: ${ctx}\nGive a 1-sentence deal verdict. Be direct and specific.` }],
      "Sharp AU shopping assistant. 1 sentence. AUD. Be specific."
    ).then(r => respond({ text: r?.content?.[0]?.text || null })).catch(() => respond({ text: null }));
    return true;
  }

  if (msg.type === "AI_CHAT") {
    const sys = `AU shopping assistant. Product: ${msg.context?.name} at $${msg.context?.price}. Prices: ${(msg.context?.prices || []).map(p => `${p.retailer} $${p.price}`).join(", ") || "none"}. 2-3 sentences. AUD.`;
    callClaude([...(msg.history || []), { role: "user", content: msg.message }], sys)
      .then(r => respond({ text: r?.content?.[0]?.text || null }))
      .catch(e => respond({ text: null, error: e.message }));
    return true;
  }

  if (msg.type === "AGENT_RUN") {
    runAgent(msg.request, msg.currentProduct)
      .then(r => respond(r))
      .catch(e => respond({ error: e.message }));
    return true;
  }
  if (msg.type === "TRACK_SAVE") {
    (async () => {
      const res     = await storage.get({ tracked: [], backendUrl: DEFAULT_BACKEND, alertEmail: "" });
      let tracked   = res.tracked || [];
      if (tracked.find(t => t.url === msg.item.url)) { respond({ ok: true }); return; }

      const id      = Date.now();
      const entry   = { ...msg.item, id };

      // Register with backend for 24/7 server-side monitoring if email is set
      const base    = res.backendUrl || DEFAULT_BACKEND;
      const email   = res.alertEmail || "";
      if (base && email) {
        try {
          const r = await Promise.race([
            fetch(`${base}/alerts/add`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify({ email, name: msg.item.name, targetPrice: msg.item.targetPrice, currentPrice: msg.item.currentPrice, url: msg.item.url })
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))
          ]);
          if (r.ok) {
            const data = await r.json();
            if (data.id) entry.backendId = data.id;
            console.log("[PP] Alert synced to backend:", data.id);
          }
        } catch (e) { console.log("[PP] Backend alert sync failed:", e.message); }
      }

      tracked.push(entry);
      await storage.set({ tracked });
      try { chrome.alarms.create("pp-check", { periodInMinutes: 360 }); } catch (_) {}
      respond({ ok: true });
    })();
    return true;
  }

  if (msg.type === "TRACK_GET") {
    (async () => { const d = await storage.get({ tracked: [] }); respond({ tracked: d.tracked || [] }); })();
    return true;
  }

  if (msg.type === "TRACK_DEL") {
    (async () => {
      const res   = await storage.get({ tracked: [], backendUrl: DEFAULT_BACKEND, alertEmail: "" });
      const item  = (res.tracked || []).find(t => t.id === msg.id);
      const tracked = (res.tracked || []).filter(t => t.id !== msg.id);
      await storage.set({ tracked });

      // Remove from backend if it was synced
      const backendId = msg.backendId || item?.backendId;
      if (backendId) {
        const base  = res.backendUrl || DEFAULT_BACKEND;
        const email = res.alertEmail || "";
        try {
          await fetch(`${base}/alerts/${backendId}?email=${encodeURIComponent(email)}`, { method: "DELETE", headers: { "User-Agent": UA } });
          console.log("[PP] Alert removed from backend:", backendId);
        } catch (e) { console.log("[PP] Backend alert delete failed:", e.message); }
      }
      respond({ ok: true });
    })();
    return true;
  }

  if (msg.type === "SETTINGS_SAVE") {
    (async () => {
      const payload = { apiKey: msg.apiKey || "", backendUrl: msg.backendUrl || "", alertEmail: msg.alertEmail || "" };
      await storage.set(payload);
      respond({ ok: true });
    })();
    return true;
  }

  if (msg.type === "SETTINGS_GET") {
    (async () => { const d = await storage.get({ apiKey: "", backendUrl: DEFAULT_BACKEND, alertEmail: "" }); respond(d); })();
    return true;
  }

});
