// ============================================
// Binance AI Trading Bot v4.1 - Cloudflare Worker
// AI: Gemini 2.0 Flash + Groq Llama 3.3 70B
// Data: Binance Ücretsiz API
// ============================================

const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_DATA = "https://fapi.binance.com/futures/data";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Binance İmza (Web Crypto API) ─────────────
async function sign(qs, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(qs));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function binanceRequest(env, method, path, params = {}) {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts };
  const qs = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)])
  ).toString();
  const sig = await sign(qs, env.BINANCE_SECRET);
  const fullQs = `${qs}&signature=${sig}`;
  const url = `${BINANCE_BASE}${path}?${fullQs}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": env.BINANCE_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method !== "GET" ? fullQs : undefined,
  });
  if (!res.ok) throw new Error(`Binance: ${await res.text()}`);
  return res.json();
}

// ── Binance Public API ─────────────────────────
async function getAllTickers() {
  const res = await fetch(`${BINANCE_BASE}/fapi/v1/ticker/24hr`);
  return res.json();
}

async function getKlines(symbol, interval = "3m", limit = 100) {
  const res = await fetch(
    `${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();
  return data.map((k) => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function getOrderBook(symbol) {
  const res = await fetch(
    `${BINANCE_BASE}/fapi/v1/depth?symbol=${symbol}&limit=5`
  );
  return res.json();
}

// ── Binance Ücretsiz Piyasa Verileri ──────────
async function getOIHistory(symbol) {
  try {
    const res = await fetch(
      `${BINANCE_DATA}/openInterestHist?symbol=${symbol}&period=5m&limit=10`
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return null;
    const first = parseFloat(data[0].sumOpenInterestValue);
    const last = parseFloat(data[data.length - 1].sumOpenInterestValue);
    const changePct = ((last - first) / first) * 100;
    return {
      changePct: changePct.toFixed(2),
      trend: changePct > 2 ? "RISING" : changePct < -2 ? "FALLING" : "STABLE",
      currentUsd: last,
    };
  } catch { return null; }
}

async function getLongShortRatio(symbol) {
  try {
    const res = await fetch(
      `${BINANCE_DATA}/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=6`
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const latest = data[data.length - 1];
    const prev = data[0];
    const lsRatio = parseFloat(latest.longShortRatio);
    const prevRatio = parseFloat(prev.longShortRatio);
    return {
      ratio: lsRatio.toFixed(3),
      longPct: (parseFloat(latest.longAccount) * 100).toFixed(1),
      shortPct: (parseFloat(latest.shortAccount) * 100).toFixed(1),
      trend: lsRatio > prevRatio ? "MORE_LONGS" : "MORE_SHORTS",
      bias:
        lsRatio > 1.5 ? "OVERLEVERAGED_LONG" :
        lsRatio < 0.7 ? "SHORT_SQUEEZE_POTENTIAL" : "NEUTRAL",
    };
  } catch { return null; }
}

async function getFundingRate(symbol) {
  try {
    const res = await fetch(
      `${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
    );
    const data = await res.json();
    const rate = parseFloat(data.lastFundingRate) * 100;
    return {
      rate: rate.toFixed(4),
      sentiment:
        rate > 0.05 ? "OVERLEVERAGED_BULLS" :
        rate < -0.01 ? "OVERLEVERAGED_BEARS" : "NEUTRAL",
    };
  } catch { return null; }
}

async function getTakerVolume(symbol) {
  try {
    const res = await fetch(
      `${BINANCE_DATA}/takerbuysvol?symbol=${symbol}&period=5m&limit=6`
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const avg = data.reduce((a, d) => a + parseFloat(d.buySellRatio), 0) / data.length;
    return {
      buySellRatio: avg.toFixed(3),
      pressure:
        avg > 1.1 ? "BUY_PRESSURE" :
        avg < 0.9 ? "SELL_PRESSURE" : "BALANCED",
    };
  } catch { return null; }
}

// ── Teknik İndikatörler ───────────────────────
function calcRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  return 100 - 100 / (1 + ag / (al || 0.0001));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcBB(closes, period = 20) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}

function analyzeIndicators(klines) {
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const rsi = calcRSI(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const macd = calcEMA(closes, 12) - calcEMA(closes, 26);
  const bb = calcBB(closes);
  const price = closes[closes.length - 1];
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volumes[volumes.length - 1] / avgVol;
  return {
    rsi: +rsi.toFixed(2),
    ema20: +ema20.toFixed(6),
    ema50: +ema50.toFixed(6),
    macd: +macd.toFixed(6),
    bb_upper: +bb.upper.toFixed(6),
    bb_middle: +bb.middle.toFixed(6),
    bb_lower: +bb.lower.toFixed(6),
    currentPrice: +price.toFixed(6),
    volumeRatio: +volRatio.toFixed(2),
    trend: ema20 > ema50 ? "BULLISH" : "BEARISH",
  };
}

// ── Order Book Doğrulaması ────────────────────
async function validateEntry(symbol, indicatorPrice) {
  try {
    const book = await getOrderBook(symbol);
    const bestBid = parseFloat(book.bids[0][0]);
    const bestAsk = parseFloat(book.asks[0][0]);
    const spread = ((bestAsk - bestBid) / bestBid) * 100;
    const midPrice = (bestBid + bestAsk) / 2;
    const drift = Math.abs((midPrice - indicatorPrice) / indicatorPrice) * 100;
    return { valid: spread < 0.1 && drift < 0.5, spread: spread.toFixed(4), drift: drift.toFixed(4) };
  } catch { return { valid: true }; }
}

// ── Pump Dedektörü ────────────────────────────
async function detectPumps(tickers) {
  const pumps = [];
  for (const t of tickers) {
    if (!t.symbol.endsWith("USDT")) continue;
    const change = parseFloat(t.priceChangePercent);
    const volume = parseFloat(t.quoteVolume);
    if (Math.abs(change) < 8 || volume < 20_000_000) continue;
    try {
      const klines = await getKlines(t.symbol, "1m", 10);
      const closes = klines.map((k) => k.close);
      const volumes = klines.map((k) => k.volume);
      const recentChange = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
      const avgVol = volumes.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
      const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const volSpike = recentVol / avgVol;
      if (Math.abs(recentChange) > 3 && volSpike > 2) {
        pumps.push({
          symbol: t.symbol,
          change24h: change,
          recentChange: +recentChange.toFixed(2),
          volSpike: +volSpike.toFixed(2),
          rsi: +calcRSI(closes).toFixed(2),
          price: closes[closes.length - 1],
          direction: recentChange > 0 ? "PUMP" : "DUMP",
          timestamp: Date.now(),
        });
      }
    } catch { continue; }
  }
  return pumps.sort((a, b) => Math.abs(b.recentChange) - Math.abs(a.recentChange)).slice(0, 5);
}

// ── Gemini AI (Pump Avcısı) ───────────────────
async function getGeminiDecision(env, symbol, indicators, marketData) {
  const prompt = `You are a crypto futures expert in PUMP HUNTER mode. Respond ONLY with JSON, no markdown.

SYMBOL: ${symbol}
RSI: ${indicators.rsi} | Trend: ${indicators.trend} | Volume: ${indicators.volumeRatio}x
EMA20/50: ${indicators.ema20}/${indicators.ema50} | MACD: ${indicators.macd}
Price: ${indicators.currentPrice}
Long/Short: ${marketData.ls?.ratio || "N/A"} (${marketData.ls?.bias || "N/A"})
Funding: ${marketData.funding?.rate || "N/A"}% (${marketData.funding?.sentiment || "N/A"})
OI Trend: ${marketData.oi?.trend || "N/A"} (${marketData.oi?.changePct || "N/A"}%)
Taker: ${marketData.taker?.pressure || "N/A"}

Rules: SHORT_SQUEEZE_POTENTIAL+OI_RISING+BUY_PRESSURE=LONG, OVERLEVERAGED_LONG+RSI>75+OI_FALLING=SHORT, keep TP 1-3%, SL 0.5-1.5%, max 8x leverage.

{"action":"LONG or SHORT or SKIP","confidence":0-100,"leverage":2-8,"take_profit_pct":0.5-3,"stop_loss_pct":0.3-1.5,"reason":"Turkish one sentence"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
        }),
      }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { action: "SKIP", confidence: 0, reason: "Gemini hatası" };
  }
}

// ── Groq AI (Disiplinli Mod) ──────────────────
async function getGroqDecision(env, symbol, indicators, marketData) {
  const prompt = `Sen kripto futures uzmanısın. DİSİPLİNLİ mod — sadece güven 70+ işlem aç. SADECE JSON yanıt ver.

SEMBOL: ${symbol}
RSI: ${indicators.rsi} | Trend: ${indicators.trend} | Hacim: ${indicators.volumeRatio}x
EMA20/50: ${indicators.ema20}/${indicators.ema50} | MACD: ${indicators.macd}
BB: ${indicators.bb_upper}/${indicators.bb_middle}/${indicators.bb_lower}
Fiyat: ${indicators.currentPrice}
L/S Oranı: ${marketData.ls?.ratio || "N/A"} → ${marketData.ls?.bias || "N/A"}
Funding: %${marketData.funding?.rate || "N/A"} → ${marketData.funding?.sentiment || "N/A"}
OI: %${marketData.oi?.changePct || "N/A"} → ${marketData.oi?.trend || "N/A"}
Taker: ${marketData.taker?.pressure || "N/A"}

{"action":"LONG veya SHORT veya SKIP","confidence":0-100,"leverage":2-10,"take_profit_pct":1.5-8,"stop_loss_pct":0.8-3,"reason":"Türkçe tek cümle"}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 256,
        response_format: { type: "json_object" },
      }),
    });
    const data = await res.json();
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return { action: "SKIP", confidence: 0, reason: "Groq hatası" };
  }
}

// ── Hesap Yönetimi ─────────────────────────────
async function getAccountBalance(env) {
  const acc = await binanceRequest(env, "GET", "/fapi/v2/account");
  const usdt = acc.assets.find((a) => a.asset === "USDT");
  return parseFloat(usdt?.availableBalance || 0);
}

async function getOpenPositions(env) {
  const pos = await binanceRequest(env, "GET", "/fapi/v2/positionRisk");
  return pos
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      size: parseFloat(p.positionAmt),
      entryPrice: parseFloat(p.entryPrice),
      pnl: parseFloat(p.unrealizedProfit),
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
    }));
}

async function placeOrder(env, symbol, side, quantity, leverage, tpPct, slPct) {
  await binanceRequest(env, "POST", "/fapi/v1/leverage", { symbol, leverage });
  const order = await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side, type: "MARKET", quantity,
  });
  const entry = parseFloat(order.avgPrice || order.price);
  const isLong = side === "BUY";
  const tp = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = isLong ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side: isLong ? "SELL" : "BUY",
    type: "TAKE_PROFIT_MARKET",
    stopPrice: tp.toFixed(4),
    closePosition: true, timeInForce: "GTE_GTC",
  });
  await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side: isLong ? "SELL" : "BUY",
    type: "STOP_MARKET",
    stopPrice: sl.toFixed(4),
    closePosition: true, timeInForce: "GTE_GTC",
  });
  return { entry, tp, sl };
}

// ── KV Sinyal Geçmişi ──────────────────────────
async function saveSignal(env, signal) {
  if (!env.BOT_KV) return;
  await env.BOT_KV.put(
    `signal:${Date.now()}:${signal.symbol}`,
    JSON.stringify(signal),
    { expirationTtl: 86400 * 7 }
  );
}

async function getSignalHistory(env, limit = 50) {
  if (!env.BOT_KV) return [];
  const list = await env.BOT_KV.list({ prefix: "signal:" });
  const keys = list.keys.slice(-limit);
  const signals = await Promise.all(
    keys.map(async (k) => {
      const val = await env.BOT_KV.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  return signals.filter(Boolean).reverse();
}

// ── Ana Bot ────────────────────────────────────
async function runBot(env) {
  const logs = [];
  const signals = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log("🤖 Bot başlatıldı: " + new Date().toISOString());

  try {
    const [openPositions, balance, tickers] = await Promise.all([
      getOpenPositions(env),
      getAccountBalance(env),
      getAllTickers(),
    ]);

    log(`💰 Bakiye: $${balance.toFixed(2)} | 📊 ${openPositions.length}/5 pozisyon`);
    if (balance < 20) { log("⚠️ Yetersiz bakiye"); return { logs, signals }; }

    // ── PUMP AVCI (Gemini) ──
    log("\n🚀 Pump taraması (Gemini)...");
    const pumps = await detectPumps(tickers);
    log(`  ${pumps.length} pump/dump tespit edildi`);

    for (const pump of pumps) {
      if (openPositions.length >= 5) break;
      if (openPositions.find((p) => p.symbol === pump.symbol)) continue;
      log(`\n💥 ${pump.symbol} | ${pump.direction} %${pump.recentChange} | Vol: ${pump.volSpike}x`);

      const [klines, ls, funding, oi, taker] = await Promise.all([
        getKlines(pump.symbol, "1m", 60),
        getLongShortRatio(pump.symbol),
        getFundingRate(pump.symbol),
        getOIHistory(pump.symbol),
        getTakerVolume(pump.symbol),
      ]);

      const indicators = analyzeIndicators(klines);
      const marketData = { ls, funding, oi, taker };
      const decision = await getGeminiDecision(env, pump.symbol, indicators, marketData);
      log(`  🔵 Gemini: ${decision.action} | %${decision.confidence} | ${decision.reason}`);

      const signal = {
        id: `pump_${Date.now()}`,
        mode: "PUMP_HUNTER", ai: "Gemini 2.0 Flash",
        symbol: pump.symbol, action: decision.action,
        confidence: decision.confidence, reason: decision.reason,
        price: pump.price, rsi: indicators.rsi,
        volSpike: pump.volSpike, recentChange: pump.recentChange,
        direction: pump.direction, timestamp: Date.now(), executed: false,
      };

      if (decision.action !== "SKIP" && decision.confidence >= 65) {
        const validation = await validateEntry(pump.symbol, pump.price);
        if (!validation.valid) {
          log(`  ⚠️ Spread çok geniş: ${validation.spread}%`);
          signal.skipReason = "Spread çok geniş";
        } else {
          const qty = ((balance * 0.30 * decision.leverage) / pump.price).toFixed(3);
          const result = await placeOrder(env, pump.symbol,
            decision.action === "LONG" ? "BUY" : "SELL",
            qty, decision.leverage, decision.take_profit_pct, decision.stop_loss_pct);
          signal.executed = true;
          signal.entry = result.entry;
          signal.tp = result.tp;
          signal.sl = result.sl;
          log(`  ✅ GİRİŞ: $${result.entry} | TP: $${result.tp.toFixed(4)} | SL: $${result.sl.toFixed(4)}`);
        }
      } else {
        log(`  ⏭️ Atlandı`);
      }
      signals.push(signal);
      await saveSignal(env, signal);
    }

    // ── DİSİPLİNLİ MOD (Groq) ──
    if (openPositions.length < 5) {
      log("\n🤖 Disiplinli tarama (Groq)...");
      const topSymbols = tickers
        .filter((t) => t.symbol.endsWith("USDT") &&
          parseFloat(t.quoteVolume) > 30_000_000 &&
          Math.abs(parseFloat(t.priceChangePercent)) > 2)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 20).map((t) => t.symbol)
        .filter((s) => !openPositions.find((p) => p.symbol === s));

      for (const symbol of topSymbols.slice(0, 5)) {
        if (openPositions.length >= 5) break;
        log(`\n📈 ${symbol}`);

        const [klines, ls, funding, oi, taker] = await Promise.all([
          getKlines(symbol, "3m", 100),
          getLongShortRatio(symbol),
          getFundingRate(symbol),
          getOIHistory(symbol),
          getTakerVolume(symbol),
        ]);

        const indicators = analyzeIndicators(klines);
        const marketData = { ls, funding, oi, taker };
        const decision = await getGroqDecision(env, symbol, indicators, marketData);
        log(`  🟢 Groq: ${decision.action} | %${decision.confidence} | ${decision.reason}`);

        const signal = {
          id: `disc_${Date.now()}`,
          mode: "DISCIPLINED", ai: "Groq Llama 3.3 70B",
          symbol, action: decision.action,
          confidence: decision.confidence, reason: decision.reason,
          price: indicators.currentPrice, rsi: indicators.rsi,
          trend: indicators.trend, timestamp: Date.now(), executed: false,
        };

        if (decision.action !== "SKIP" && decision.confidence >= 70) {
          const validation = await validateEntry(symbol, indicators.currentPrice);
          if (validation.valid) {
            const qty = ((balance * 0.30 * decision.leverage) / indicators.currentPrice).toFixed(3);
            const result = await placeOrder(env, symbol,
              decision.action === "LONG" ? "BUY" : "SELL",
              qty, decision.leverage, decision.take_profit_pct, decision.stop_loss_pct);
            signal.executed = true;
            signal.entry = result.entry;
            signal.tp = result.tp;
            signal.sl = result.sl;
            log(`  ✅ GİRİŞ: $${result.entry}`);
            signals.push(signal);
            await saveSignal(env, signal);
            break;
          }
        } else {
          log(`  ⏭️ Atlandı`);
        }
        signals.push(signal);
        await saveSignal(env, signal);
      }
    }

  } catch (err) {
    log(`❌ Hata: ${err.message}`);
  }

  return { logs, signals };
}

// ── Worker Handler ─────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBot(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/api/run") {
      const result = await runBot(env);
      return jsonResp(result);
    }
    if (url.pathname === "/api/status") {
      const [balance, positions] = await Promise.all([
        getAccountBalance(env), getOpenPositions(env),
      ]);
      return jsonResp({ balance, positions, timestamp: Date.now() });
    }
    if (url.pathname === "/api/signals") {
      return jsonResp(await getSignalHistory(env));
    }
    if (url.pathname === "/api/market") {
      const tickers = await getAllTickers();
      const pumps = await detectPumps(tickers);
      const top = tickers
        .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 30_000_000)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 20)
        .map((t) => ({
          symbol: t.symbol,
          change: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume),
          price: parseFloat(t.lastPrice),
        }));
      return jsonResp({ topCoins: top, pumps, timestamp: Date.now() });
    }

    return new Response(
      "🤖 Binance AI Bot v4.1\n/api/run /api/status /api/signals /api/market",
      { headers: CORS }
    );
  },
};
