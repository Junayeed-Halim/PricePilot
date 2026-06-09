// PricePilot AU — content.js

const SKIP = ["google.","bing.","facebook.","instagram.","youtube.","twitter.","x.com",
              "reddit.","gmail.","wikipedia.","github.","stackoverflow.","anthropic.","claude.ai"];

function shouldSkip() {
  return SKIP.some(d => location.hostname.includes(d));
}

// ── Safety helpers ────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function safeUrl(u) {
  try { const p = new URL(u); return (p.protocol === "https:" || p.protocol === "http:") ? u : "#"; }
  catch (_) { return "#"; }
}
function urlHost(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}

// ── Product extraction ────────────────────────────────────────
function getProduct() {
  // 1. JSON-LD — works on Nike, Puma, JB Hi-Fi, Amazon, most modern sites
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const raw   = JSON.parse(el.textContent);
      const nodes = Array.isArray(raw) ? raw : raw["@graph"] ? raw["@graph"] : [raw];
      for (const n of nodes) {
        if (n["@type"] !== "Product") continue;
        const name = n.name?.trim();
        if (!name) continue;
        const gtin   = n.gtin13 || n.gtin12 || n.gtin8 || n.gtin || null;
        const offers = Array.isArray(n.offers) ? n.offers : n.offers ? [n.offers] : [];
        for (const o of offers) {
          const price = parseFloat(String(o.price ?? o.lowPrice ?? "0").replace(/[^0-9.]/g, ""));
          if (price > 0 && price < 99999) return { name, price, gtin };
        }
      }
    } catch (_) {}
  }
  // 2. OG meta tags
  const title = document.querySelector('meta[property="og:title"]')?.content?.trim();
  const ps    = document.querySelector('meta[property="product:price:amount"]')?.content
             || document.querySelector('[itemprop="price"]')?.getAttribute("content");
  if (title && ps) {
    const p = parseFloat(ps.replace(/[^0-9.]/g, ""));
    if (p > 0) return { name: title, price: p, gtin: null };
  }
  // 3. h1 + price element
  const h1 = document.querySelector("h1");
  if (!h1) return null;
  for (const el of document.querySelectorAll('[class*="price" i],[itemprop="price"],[data-price]')) {
    const txt = el.textContent || el.getAttribute("content") || el.getAttribute("data-price") || "";
    const m   = txt.match(/\$\s*([0-9]{2,5}(?:\.[0-9]{2})?)/);
    if (m) {
      const p = parseFloat(m[1]);
      if (p > 1) return { name: h1.textContent.trim(), price: p, gtin: null };
    }
  }
  return null;
}

function isProductPage() {
  const p = location.pathname.toLowerCase();
  if (["/product","/products/","/p/","/dp/","/itm/","/pd/","/item/","/buy/","/productdetails/"].some(s => p.includes(s))) return true;
  const hasP = !!(document.querySelector('[class*="price" i]') || document.querySelector('[itemprop="price"]') || document.querySelector('meta[property="product:price:amount"]'));
  return !!(document.querySelector("h1") && hasP);
}

// ── State ─────────────────────────────────────────────────────
let chatHistory = [];
let panelCtx    = null;

// ── Build panel ───────────────────────────────────────────────
function buildPanel(product) {
  if (document.getElementById("pp")) return;

  const el = document.createElement("div");
  el.id = "pp";
  el.innerHTML = `
    <div id="pp-bar">
      <span id="pp-logo">✈ PricePilot <em>AU</em></span>
      <div id="pp-btns">
        <button id="pp-bell">🔔</button>
        <button id="pp-min">—</button>
        <button id="pp-x">✕</button>
      </div>
    </div>

    <div id="pp-body">
      <div id="pp-product">
        <div id="pp-name" title="${escHtml(product.name)}">
          ${escHtml(product.name.length > 60 ? product.name.slice(0, 60) + "…" : product.name)}
        </div>
        <div id="pp-prow">
          <span id="pp-price">$${product.price.toFixed(2)}</span>
          <span id="pp-ptag">on this page</span>
          ${product.gtin ? `<span id="pp-exact" title="Barcode found — exact match">🎯 Exact</span>` : ""}
        </div>
      </div>

      <div class="pp-sec" id="pp-sec-prices">
        <div class="pp-sec-head">Live AU prices</div>
        <div id="pp-prices">
          <div class="pp-loading"><span class="pp-spin"></span>Fetching prices…</div>
        </div>
      </div>

      <div class="pp-sec" id="pp-sec-history" style="display:none">
        <div class="pp-sec-head">30-day price trend</div>
        <div id="pp-history"></div>
      </div>

      <div class="pp-sec" id="pp-sec-ai">
        <div class="pp-sec-head">
          <div id="pp-tabs">
            <button class="pp-tab active" data-tab="chat">Chat</button>
            <button class="pp-tab" data-tab="agent">🤖 Agent</button>
          </div>
          <span id="pp-ai-tag">Claude</span>
        </div>

        <div id="pp-tab-chat">
          <div id="pp-verdict">
            <div class="pp-loading"><span class="pp-spin"></span>Analysing…</div>
          </div>
          <div id="pp-chips">
            <button class="pp-chip" data-q="Is this a good deal right now?">Good deal?</button>
            <button class="pp-chip" data-q="When is the best time to buy this in Australia?">Best time?</button>
            <button class="pp-chip" data-q="Find me cheaper alternatives to this.">Alternatives?</button>
          </div>
          <div id="pp-chat"></div>
          <div id="pp-chat-row">
            <input id="pp-chat-in" placeholder="Ask anything about this product…" type="text" />
            <button id="pp-chat-send">↑</button>
          </div>
        </div>

        <div id="pp-tab-agent" style="display:none">
          <div id="pp-agent-intro">
            <p id="pp-agent-desc">Tell the agent what to find — it searches AU retailers on its own.</p>
            <div id="pp-agent-pills">
              <button class="pp-apill" data-r="Find the cheapest place to buy this right now.">Cheapest for this?</button>
              <button class="pp-apill" data-r="Compare this to similar products and find the best value.">Best value alternative?</button>
              <button class="pp-apill" data-r="Should I buy this now or wait for a sale?">Should I wait?</button>
            </div>
          </div>
          <div id="pp-agent-out"></div>
          <div id="pp-agent-row">
            <input id="pp-agent-in" placeholder="e.g. best phone under $600 AUD…" type="text" />
            <button id="pp-agent-send">↑</button>
          </div>
        </div>
      </div>

      <div class="pp-sec" id="pp-sec-alert" style="display:none">
        <div class="pp-sec-head">Price alert</div>
        <div id="pp-alert-row">
          <span>Alert me when price drops to</span>
          <span class="pp-sym">$</span>
          <input id="pp-alert-val" type="number" min="1" placeholder="${Math.floor(product.price * 0.85)}" />
          <span class="pp-sym">AUD</span>
          <button id="pp-alert-save">Set alert</button>
        </div>
        <div id="pp-alert-note">Checked every 6h · Chrome notification when triggered</div>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  wireEvents(el, product);
  loadPrices(el, product);
}

// ── Wire events ───────────────────────────────────────────────
function wireEvents(el, product) {
  el.querySelector("#pp-x").onclick = () => el.remove();

  let min = false;
  el.querySelector("#pp-min").onclick = () => {
    min = !min;
    el.querySelector("#pp-body").style.display = min ? "none" : "";
    el.querySelector("#pp-min").textContent    = min ? "□" : "—";
  };

  el.querySelector("#pp-bell").onclick = () => {
    const s = el.querySelector("#pp-sec-alert");
    s.style.display = s.style.display === "none" ? "" : "none";
  };

  el.querySelector("#pp-alert-save").onclick = () => {
    const val = parseFloat(el.querySelector("#pp-alert-val").value);
    if (!val || val <= 0) return;
    chrome.runtime.sendMessage({
      type: "TRACK_SAVE",
      item: { name: product.name, gtin: product.gtin, currentPrice: product.price, targetPrice: val, url: location.href }
    }, () => {
      const b = el.querySelector("#pp-alert-save");
      b.textContent = "✓ Saved!"; b.style.background = "#16a34a";
      setTimeout(() => { b.textContent = "Set alert"; b.style.background = ""; }, 2500);
    });
  };

  // AI tabs
  el.querySelectorAll(".pp-tab").forEach(tab => {
    tab.onclick = () => {
      el.querySelectorAll(".pp-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const isAgent = tab.dataset.tab === "agent";
      el.querySelector("#pp-tab-chat").style.display  = isAgent ? "none" : "";
      el.querySelector("#pp-tab-agent").style.display = isAgent ? "" : "none";
    };
  });

  // Chat chips
  el.querySelectorAll(".pp-chip").forEach(c => c.onclick = () => sendChat(el, c.dataset.q, product));

  // Chat input
  const ci = el.querySelector("#pp-chat-in");
  el.querySelector("#pp-chat-send").onclick = () => {
    const m = ci.value.trim(); if (!m) return; ci.value = ""; sendChat(el, m, product);
  };
  ci.addEventListener("keydown", e => { if (e.key === "Enter") el.querySelector("#pp-chat-send").click(); });

  // Agent pills
  el.querySelectorAll(".pp-apill").forEach(p => p.onclick = () => sendAgent(el, p.dataset.r, product));

  // Agent input
  const ai = el.querySelector("#pp-agent-in");
  el.querySelector("#pp-agent-send").onclick = () => {
    const m = ai.value.trim(); if (!m) return; ai.value = ""; sendAgent(el, m, product);
  };
  ai.addEventListener("keydown", e => { if (e.key === "Enter") el.querySelector("#pp-agent-send").click(); });

  // Drag
  const bar = el.querySelector("#pp-bar");
  let drag = false, sx, sy, ox, oy;
  bar.addEventListener("mousedown", e => {
    if (e.target.closest("button")) return;
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
  });
  document.addEventListener("mousemove", e => {
    if (!drag) return;
    el.style.right = "auto";
    el.style.left  = (ox + e.clientX - sx) + "px";
    el.style.top   = (oy + e.clientY - sy) + "px";
  });
  document.addEventListener("mouseup", () => { drag = false; });
}

// ── Load prices ───────────────────────────────────────────────
function loadPrices(el, product) {
  const pricesEl  = el.querySelector("#pp-prices");
  const verdictEl = el.querySelector("#pp-verdict");

  const giveUp = setTimeout(() => {
    pricesEl.innerHTML  = `<div class="pp-note err">Couldn't load prices — reload and try again.</div>`;
    verdictEl.innerHTML = "";
  }, 18000);

  chrome.runtime.sendMessage({
    type:   "FETCH",
    name:   product.name,
    gtin:   product.gtin || null,
    domain: location.hostname.replace("www.", "")
  }, res => {
    clearTimeout(giveUp);
    if (chrome.runtime.lastError || !res?.ok) {
      pricesEl.innerHTML = `<div class="pp-note err">Error loading prices — reload and try again.</div>`;
      verdictEl.innerHTML = "";
      return;
    }

    const { prices, searchLinks, debug, history } = res;
    panelCtx = { name: product.name, price: product.price, prices };
    renderPrices(pricesEl, prices, product.price, searchLinks, debug);
    if ((history || []).length >= 2) renderHistory(document.getElementById("pp-history"), history);

    // AI verdict
    chrome.runtime.sendMessage({ type: "AI_VERDICT", name: product.name, price: product.price, prices }, r => {
      verdictEl.innerHTML = r?.text
        ? `<div class="pp-verdict-box">🤖 ${escHtml(r.text)}</div>`
        : `<div class="pp-note">Add a Claude API key in settings for AI analysis.</div>`;
    });
  });
}

// ── Render prices ─────────────────────────────────────────────
function renderPrices(el, prices, cur, searchLinks, debug) {
  if (!prices.length) {
    const rows = (debug || []).map(d =>
      `<div class="pp-dbg-row"><span class="pp-dbg-src">${d.source}</span><span class="pp-dbg-val ${d.found ? "ok" : "miss"}">${d.found ? (d.price ? "$" + d.price : d.count + " stores") : (d.reason || "—")}</span></div>`
    ).join("");
    el.innerHTML = `
      <div class="pp-note">No prices found. Sources checked:</div>
      <div class="pp-dbg">${rows}</div>
    `;
    // Still show search pills even if no real prices
    if (searchLinks?.length) appendPills(el, searchLinks);
    return;
  }

  const cheapest = prices[0];
  const saving   = +(cur - cheapest.price).toFixed(2);

  let banner = "";
  if (saving > 0.5)
    banner = `<div class="pp-banner green">💰 Save $${saving.toFixed(2)} — cheapest at ${escHtml(cheapest.retailer)}</div>`;
  else if (prices.every(p => p.price >= cur - 0.5))
    banner = `<div class="pp-banner blue">✓ This page has the best price</div>`;

  const rows = prices.map((p, i) => {
    const diff  = +(p.price - cur).toFixed(2);
    const cheap = diff < -0.5;
    const dear  = diff > 0.5;
    const tag   = cheap ? `<span class="tag cheap">▼ $${Math.abs(diff).toFixed(2)} cheaper</span>`
                : dear  ? `<span class="tag dear">▲ $${diff.toFixed(2)} more</span>`
                :         `<span class="tag same">same price</span>`;
    const href   = safeUrl(p.url);
    const host   = urlHost(href);
    return `<tr class="${i === 0 && cheap ? "best" : dear ? "dearer" : ""}">
      <td class="td-r">${escHtml(p.retailer)}${host ? `<div class="td-url">${escHtml(host)}</div>` : ""}</td>
      <td class="td-p">$${p.price.toFixed(2)}</td>
      <td class="td-s">${escHtml(p.shipping)}</td>
      <td class="td-a">${tag}<a class="pp-view" href="${href}" target="_blank" rel="noopener">View →</a></td>
    </tr>`;
  }).join("");

  el.innerHTML = `
    ${banner}
    <table>
      <thead><tr><th>Retailer</th><th>Price</th><th>Delivery</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="pp-ts">Live · ${new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</div>
  `;

  if (searchLinks?.length) appendPills(el, searchLinks);
}

function appendPills(el, links) {
  const div = document.createElement("div");
  div.innerHTML = `
    <div class="pp-also">Also search on:</div>
    <div class="pp-pills">${links.map(r => `<a class="pp-pill" href="${safeUrl(r.url)}" target="_blank" rel="noopener">${escHtml(r.retailer)} →</a>`).join("")}</div>
  `;
  el.appendChild(div);
}

// ── Price history sparkline ───────────────────────────────────
function renderHistory(el, points) {
  if (!el || points.length < 2) return;
  document.getElementById("pp-sec-history").style.display = "";

  const W = 350, H = 52;
  const prices = points.map(p => p.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pad = 4;

  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (W - pad * 2));
  const ys = prices.map(p => pad + (1 - (p - min) / range) * (H - pad * 2));

  const poly  = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area  = `M${xs[0].toFixed(1)},${H} ` + xs.map((x, i) => `L${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ") + ` L${xs[xs.length-1].toFixed(1)},${H} Z`;
  const lx    = xs[xs.length-1].toFixed(1), ly = ys[ys.length-1].toFixed(1);

  const lo = min.toFixed(0), hi = max.toFixed(0);
  const pct = ((prices[prices.length-1] - min) / range * 100).toFixed(0);
  const trend = prices[prices.length-1] < prices[0] ? "↘ trending down" : prices[prices.length-1] > prices[0] ? "↗ trending up" : "→ stable";

  el.innerHTML = `
    <div class="pp-hist-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
        <defs>
          <linearGradient id="ppg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f46e5" stop-opacity="0.12"/>
            <stop offset="100%" stop-color="#4f46e5" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#ppg)"/>
        <polyline points="${poly}" fill="none" stroke="#4f46e5" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="${lx}" cy="${ly}" r="3" fill="#4f46e5"/>
      </svg>
      <div class="pp-hist-meta">
        <span>Low <strong class="lo">$${lo}</strong></span>
        <span>High <strong class="hi">$${hi}</strong></span>
        <span class="pp-hist-note">${points.length}d data · ${trend}</span>
      </div>
    </div>
  `;
}

// ── AI chat ───────────────────────────────────────────────────
function sendChat(el, msg, product) {
  const chat = el.querySelector("#pp-chat");
  bubble(chat, msg, "user");
  const loading = bubble(chat, "…", "ai loading");
  chrome.runtime.sendMessage({ type: "AI_CHAT", message: msg, context: panelCtx, history: chatHistory }, res => {
    loading.remove();
    if (res?.text) {
      bubble(chat, res.text, "ai");
      chatHistory.push({ role: "user", content: msg });
      chatHistory.push({ role: "assistant", content: res.text });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    } else {
      bubble(chat, res?.error || "Add a Claude API key in settings to use AI chat.", "ai");
    }
  });
}

// ── AI agent ─────────────────────────────────────────────────
function sendAgent(el, request, product) {
  const out   = el.querySelector("#pp-agent-out");
  const intro = el.querySelector("#pp-agent-intro");
  intro.style.display = "none";
  out.innerHTML = "";

  const reqEl = document.createElement("div");
  reqEl.className = "pp-agent-req";
  reqEl.textContent = request;
  out.appendChild(reqEl);

  const thinking = document.createElement("div");
  thinking.className = "pp-agent-thinking";
  thinking.innerHTML = `<span class="pp-spin"></span> Searching AU retailers…`;
  out.appendChild(thinking);

  chrome.runtime.sendMessage({
    type: "AGENT_RUN", request,
    currentProduct: product ? { name: product.name, price: product.price } : null
  }, res => {
    thinking.remove();

    if (!res || res.error === "no_key") {
      const e = document.createElement("div"); e.className = "pp-note";
      e.textContent = "Add a Claude API key in settings to use the agent.";
      out.appendChild(e); return;
    }
    if (res.error) {
      const e = document.createElement("div"); e.className = "pp-note err";
      e.textContent = "Error: " + res.error; out.appendChild(e); return;
    }

    // Show search results
    if (res.searches?.length) {
      res.searches.forEach(s => {
        const block = document.createElement("div"); block.className = "pp-agent-block";
        if (!s.prices?.length) {
          block.innerHTML = `<div class="pp-agent-query">🔍 ${escHtml(s.query)}</div><div class="pp-note">No results</div>`;
        } else {
          const rows = s.prices.map(p => {
            const href = safeUrl(p.url);
            const host = urlHost(href);
            return `<tr><td class="td-r">${escHtml(p.retailer)}${host ? `<div class="td-url">${escHtml(host)}</div>` : ""}</td><td class="td-p">$${p.price.toFixed(2)}</td><td class="td-s">${escHtml(p.shipping)}</td><td class="td-a"><a class="pp-view" href="${href}" target="_blank" rel="noopener">View →</a></td></tr>`;
          }).join("");
          block.innerHTML = `<div class="pp-agent-query">🔍 ${escHtml(s.query)}</div><table><tbody>${rows}</tbody></table>`;
        }
        out.appendChild(block);
      });
    }

    // Agent answer
    if (res.answer) {
      const ans  = document.createElement("div"); ans.className = "pp-agent-ans";
      const icon = document.createElement("span"); icon.className = "pp-agent-icon"; icon.textContent = "🤖";
      const txt  = document.createElement("span"); txt.textContent = res.answer;
      ans.appendChild(icon); ans.appendChild(txt);
      out.appendChild(ans);
    }
    out.scrollTop = out.scrollHeight;
  });
}

function bubble(chat, text, cls) {
  const d = document.createElement("div");
  d.className = `pp-bubble ${cls}`;
  const s = document.createElement("span");
  s.textContent = text;
  d.appendChild(s);
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

// ── Init ──────────────────────────────────────────────────────
function init() {
  if (shouldSkip() || document.getElementById("pp")) return;
  const tryIt = () => {
    if (document.getElementById("pp")) return true;
    if (!isProductPage()) return false;
    const p = getProduct();
    if (p?.price > 0) { buildPanel(p); return true; }
    return false;
  };
  if (tryIt()) return;
  let n = 0;
  const t = setInterval(() => { if (tryIt() || ++n >= 15) clearInterval(t); }, 900);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
