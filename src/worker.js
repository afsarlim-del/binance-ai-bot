// ============================================
// Binance AI Trading Bot v4.1 - Cloudflare Worker
// AI: Gemini 2.0 Flash + Groq Llama 3.3 70B
// Data: Binance Ücretsiz API
// ============================================

import DASHBOARD_HTML from "../dashboard.html";

const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_DATA = "https://fapi.binance.com/futures/data";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Pozisyon Yönetimi Ayarları ────────────────
// NOT: ROI = marj bazlı kârlılık (PnL / başlangıç marjı), kaldıraç dahil.
// Örn. 8x kaldıraçta %30 ROI ≈ fiyatta %3.75 hareket demektir.
// Fiyat bazlı yüzde istersen ROI değerlerini kaldıraca bölerek düşün.
const ROI_TAKE_MIN = 25;   // % — bu kârlılıktan sonra kârı korumaya başla
const ROI_TAKE_MAX = 40;   // % — trend güçlü değilse burada kapat (yeterli)
const ADX_TREND    = 25;   // ADX bu değerin üstündeyse trend güçlü → açık tut
const TRAIL_MIN    = 0.4;  // trailing stop geri çekilme payı alt sınır (%)
const TRAIL_MAX    = 4.0;  // trailing stop geri çekilme payı üst sınır (%)

// ── Kaldıraç Kararı (bot verir, AI değil) ─────
const MARGIN_TYPE  = "ISOLATED"; // tüm işlemler izole marj
const LEV_BASE     = 10;   // taban kaldıraç
const LEV_AGGR     = 20;   // agresif kaldıraç (güçlü + temiz kurulum)
const LEV_AGGR_ADX = 28;   // 20x için min ADX (güçlü trend)
const LEV_AGGR_CONF= 75;   // 20x için min AI güveni
const LEV_AGGR_ATR = 1.5;  // 20x için max volatilite (ATR %); üstündeyse 10x

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

// ATR — Ortalama Gerçek Aralık (volatilite). Trailing mesafesini ayarlamak için.
function calcATR(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ADX (+DI / -DI) — Wilder. Trendin GÜCÜNÜ ölçer.
// ADX yüksek + DI yönlü = güçlü trend → pozisyonu açık tut. ADX düşük = trend yok → kârı al.
function calcADX(klines, period = 14) {
  const len = klines.length;
  if (len < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < len; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * (pS[i] / (trS[i] || 1e-9));
    const mDI = 100 * (mS[i] / (trS[i] || 1e-9));
    dx.push(100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1e-9));
  }
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  const lastTR = trS[trS.length - 1] || 1e-9;
  return {
    adx,
    plusDI: 100 * (pS[pS.length - 1] / lastTR),
    minusDI: 100 * (mS[mS.length - 1] / lastTR),
  };
}

function analyzeIndicators(klines) {
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const rsi = calcRSI(closes);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const macd = calcEMA(closes, 12) - calcEMA(closes, 26);
  const bb = calcBB(closes);
  const atr = calcATR(klines);
  const { adx, plusDI, minusDI } = calcADX(klines);
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
    atr: +atr.toFixed(6),
    atrPct: +((atr / price) * 100).toFixed(2),
    adx: +adx.toFixed(1),
    plusDI: +plusDI.toFixed(1),
    minusDI: +minusDI.toFixed(1),
    trend: ema20 > ema50 ? "BULLISH" : "BEARISH",
  };
}

// Kaldıracı pozisyon durumuna göre bot seçer: 20x sadece güçlü trend + yüksek
// güven + düşük volatilite varsa; aksi halde güvenli taban olan 10x.
function decideLeverage(decision, ind) {
  const strong    = (ind.adx || 0) >= LEV_AGGR_ADX;
  const confident = (decision.confidence || 0) >= LEV_AGGR_CONF;
  const calm      = (ind.atrPct || 99) <= LEV_AGGR_ATR;
  return (strong && confident && calm) ? LEV_AGGR : LEV_BASE;
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
ADX: ${indicators.adx} | +DI/-DI: ${indicators.plusDI}/${indicators.minusDI} | ATR: %${indicators.atrPct}

Rules: SHORT_SQUEEZE_POTENTIAL+OI_RISING+BUY_PRESSURE=LONG, OVERLEVERAGED_LONG+RSI>75+OI_FALLING=SHORT, prefer ADX>25 with aligned DI (trend strong), keep SL 0.5-1.5%, max 8x leverage. take_profit_pct is just a hint — exit is managed by trailing stop + ADX.

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
ADX: ${indicators.adx} | +DI/-DI: ${indicators.plusDI}/${indicators.minusDI} | ATR: %${indicators.atrPct}
NOT: Güçlü trend için ADX>25 ve DI yönü uyumlu olmalı. Çıkış trailing stop + ADX ile yönetiliyor, take_profit_pct sadece referans.

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

// ── Aktif Pozisyon Yönetimi ───────────────────
// Her döngüde açık pozisyonlara bakar:
//  • ROI < %ROI_TAKE_MIN  → dokunma (trailing/SL zaten korur)
//  • ROI ≥ eşik + trend güçlü (ADX)   → AÇIK TUT, koşmaya devam etsin
//  • ROI ≥ eşik + trend zayıf/dönüyor → kârı al, pozisyonu kapat
async function managePositions(env, log) {
  const pos = await binanceRequest(env, "GET", "/fapi/v2/positionRisk");
  const open = pos.filter((p) => parseFloat(p.positionAmt) !== 0);
  if (open.length === 0) { log("  (açık pozisyon yok)"); return; }

  for (const p of open) {
    const amt = parseFloat(p.positionAmt);
    const entry = parseFloat(p.entryPrice);
    const lev = parseFloat(p.leverage) || 1;
    const pnl = parseFloat(p.unRealizedProfit ?? p.unrealizedProfit ?? 0);
    const isLong = amt > 0;
    const margin = (Math.abs(amt) * entry) / lev;
    const roi = margin > 0 ? (pnl / margin) * 100 : 0;

    if (roi < ROI_TAKE_MIN) {
      log(`  ⏳ ${p.symbol}: ROI %${roi.toFixed(1)} (<${ROI_TAKE_MIN}) — bekleniyor`);
      continue;
    }

    // Trend gücünü ölç
    let ind;
    try {
      ind = analyzeIndicators(await getKlines(p.symbol, "3m", 100));
    } catch {
      log(`  ⚠️ ${p.symbol}: veri alınamadı, dokunulmadı`);
      continue;
    }
    const trendStrong =
      ind.adx >= ADX_TREND &&
      (isLong ? ind.plusDI > ind.minusDI && ind.rsi < 80
              : ind.minusDI > ind.plusDI && ind.rsi > 20);

    if (trendStrong) {
      log(`  🔥 ${p.symbol}: ROI %${roi.toFixed(1)} | ADX ${ind.adx} güçlü → AÇIK TUTULUYOR (trailing koruyor)`);
      continue; // fırsat sürüyor → bırak koşsun
    }

    // Trend zayıfladı ve kâr yeterli (≥%25, çoğu zaman %25-40 bandı) → bankala
    log(`  ✅ ${p.symbol}: ROI %${roi.toFixed(1)} | ADX ${ind.adx} zayıf → kâr alınıyor`);
    try {
      await closePosition(env, p.symbol, isLong, Math.abs(amt));
    } catch (e) {
      log(`  ⚠️ ${p.symbol} kapatılamadı: ${e.message}`);
    }
  }
}

async function closePosition(env, symbol, isLong, qty) {
  try { await binanceRequest(env, "DELETE", "/fapi/v1/allOpenOrders", { symbol }); } catch {}
  await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side: isLong ? "SELL" : "BUY",
    type: "MARKET", quantity: qty, reduceOnly: true,
  });
}

// Fiyatı kabaca tick'e uygun ondalığa yuvarla (sembol bazlı tam tick almadan güvenli yaklaşım)
function fmtPrice(p) {
  const dec = p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 6 : 8;
  return p.toFixed(dec);
}

async function placeOrder(env, symbol, side, quantity, leverage, slPct, atrPct) {
  // İzole marj moduna geç (sembol zaten izole ise Binance -4046 döner, yok sayarız)
  try {
    await binanceRequest(env, "POST", "/fapi/v1/marginType", { symbol, marginType: MARGIN_TYPE });
  } catch (e) { /* zaten ISOLATED → sorun değil */ }
  await binanceRequest(env, "POST", "/fapi/v1/leverage", { symbol, leverage });
  const order = await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side, type: "MARKET", quantity,
  });
  const entry = parseFloat(order.avgPrice || order.price);
  const isLong = side === "BUY";

  // 1) Sert stop-loss (felaket koruması) — pozisyon ne olursa olsun kapanır
  const sl = isLong ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  await binanceRequest(env, "POST", "/fapi/v1/order", {
    symbol, side: isLong ? "SELL" : "BUY",
    type: "STOP_MARKET",
    stopPrice: fmtPrice(sl),
    closePosition: true, timeInForce: "GTE_GTC",
  });

  // 2) Trailing take-profit — +%ROI_TAKE_MIN marj kârında devreye girer, sonra trendi takip eder.
  //    ROI fiyat hareketine çevrilir: roiHedef / kaldıraç.
  const activationMovePct = ROI_TAKE_MIN / leverage;
  const activation = isLong
    ? entry * (1 + activationMovePct / 100)
    : entry * (1 - activationMovePct / 100);
  // Geri çekilme payı volatiliteye (ATR) göre, makul sınırlar içinde
  const callbackRate = Math.min(TRAIL_MAX, Math.max(TRAIL_MIN, +((atrPct || 1) * 1.5).toFixed(1)));

  let tp = activation;
  try {
    await binanceRequest(env, "POST", "/fapi/v1/order", {
      symbol, side: isLong ? "SELL" : "BUY",
      type: "TRAILING_STOP_MARKET",
      quantity, reduceOnly: true,
      activationPrice: fmtPrice(activation),
      callbackRate,
    });
  } catch (e) {
    // Trailing reddedilirse en az ROI_TAKE_MIN kârını kilitleyen sabit TP'ye düş
    await binanceRequest(env, "POST", "/fapi/v1/order", {
      symbol, side: isLong ? "SELL" : "BUY",
      type: "TAKE_PROFIT_MARKET",
      stopPrice: fmtPrice(activation),
      closePosition: true, timeInForce: "GTE_GTC",
    });
  }
  return { entry, tp, sl, activation, callbackRate };
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
    const [balance, tickers] = await Promise.all([
      getAccountBalance(env),
      getAllTickers(),
    ]);
    if (balance < 20) { log("⚠️ Yetersiz bakiye"); return { logs, signals }; }

    // ── ÖNCE AÇIK POZİSYONLARI YÖNET ──
    log("\n🛡️ Açık pozisyon yönetimi (ADX + trailing)...");
    try { await managePositions(env, log); }
    catch (e) { log("  ⚠️ Yönetim hatası: " + e.message); }

    // Yönetim bazı pozisyonları kapatmış olabilir → güncel sayıyı al
    const openPositions = await getOpenPositions(env);
    log(`💰 Bakiye: $${balance.toFixed(2)} | 📊 ${openPositions.length}/5 pozisyon`);

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
          const lev = decideLeverage(decision, indicators);
          const qty = ((balance * 0.30 * lev) / pump.price).toFixed(3);
          const result = await placeOrder(env, pump.symbol,
            decision.action === "LONG" ? "BUY" : "SELL",
            qty, lev, decision.stop_loss_pct, indicators.atrPct);
          signal.executed = true;
          signal.entry = result.entry;
          signal.tp = result.activation;
          signal.sl = result.sl;
          signal.leverage = lev;
          signal.adx = indicators.adx;
          signal.trail = result.callbackRate;
          log(`  ✅ GİRİŞ: $${result.entry} | ${lev}x izole | Trailing aktivasyon: $${fmtPrice(result.activation)} (geri çekilme %${result.callbackRate}) | SL: $${fmtPrice(result.sl)}`);
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
            const lev = decideLeverage(decision, indicators);
            const qty = ((balance * 0.30 * lev) / indicators.currentPrice).toFixed(3);
            const result = await placeOrder(env, symbol,
              decision.action === "LONG" ? "BUY" : "SELL",
              qty, lev, decision.stop_loss_pct, indicators.atrPct);
            signal.executed = true;
            signal.entry = result.entry;
            signal.tp = result.activation;
            signal.sl = result.sl;
            signal.leverage = lev;
            signal.adx = indicators.adx;
            signal.trail = result.callbackRate;
            log(`  ✅ GİRİŞ: $${result.entry} | ${lev}x izole | Trailing $${fmtPrice(result.activation)} | SL $${fmtPrice(result.sl)}`);
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

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/run") {
          return jsonResp(await runBot(env));
        }
        if (url.pathname === "/api/status") {
          if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET) {
            return jsonResp({ error: "BINANCE_API_KEY / BINANCE_SECRET tanımlı değil. Cloudflare > Workers > Settings > Variables altına ekleyin." }, 500);
          }
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
        return jsonResp({ error: "Bilinmeyen endpoint" }, 404);
      } catch (err) {
        // Binance/işlem hatasını okunabilir şekilde dashboard'a ilet
        return jsonResp({ error: String(err.message || err) }, 500);
      }
    }

    // Kök adres → dashboard'u doğrudan sun
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response(
      "🤖 Binance AI Bot v4.1\n/api/run /api/status /api/signals /api/market",
      { headers: CORS }
    );
  },
};
