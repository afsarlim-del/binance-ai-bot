# 🤖 Binance AI Trading Bot

Claude AI destekli Binance Futures trading botu. Cloudflare Workers üzerinde çalışır, her 15 dakikada bir piyasayı tarar.

## ✨ Özellikler

- 🧠 **Claude AI** karar motoru
- 📊 **RSI + EMA + MACD + Bollinger Bands** analizi
- 🔍 **Otomatik token tarama** (hacim + momentum bazlı)
- 🛡️ **Otomatik Stop-Loss & Take-Profit**
- ⚡ **Cloudflare Workers** üzerinde serverless çalışır
- 🔄 **GitHub Actions** ile otomatik deploy

---

## 🚀 Kurulum Adımları

### 1. GitHub Repo Oluştur

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/KULLANICI_ADIN/binance-ai-bot.git
git push -u origin main
```

### 2. Wrangler Kur ve Giriş Yap

```bash
npm install
npx wrangler login
```

### 3. Secret'ları Ekle (API Key'ler)

```bash
# Binance API Key
npx wrangler secret put BINANCE_API_KEY
# → Binance'den aldığın API key'i yapıştır

# Binance Secret Key
npx wrangler secret put BINANCE_SECRET
# → Binance'den aldığın secret key'i yapıştır

# Claude API Key
npx wrangler secret put CLAUDE_API_KEY
# → console.anthropic.com'dan aldığın key'i yapıştır
```

### 4. Deploy Et

```bash
npm run deploy
```

### 5. GitHub Actions için Cloudflare Token

GitHub repo → Settings → Secrets → Actions → New secret:
- Name: `CLOUDFLARE_API_TOKEN`
- Value: Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template

Artık `main` branch'e her push'ta otomatik deploy olur!

---

## 📡 Endpoints

Botun URL'i: `https://binance-ai-bot.KULLANICI_ADIN.workers.dev`

| Endpoint | Açıklama |
|----------|----------|
| `/` | Bot durumu |
| `/run` | Manuel çalıştır |
| `/status` | Bakiye ve açık pozisyonlar |

---

## ⚙️ Binance API Ayarları

Binance'de API oluştururken:
- ✅ **Futures Trading** izni ver
- ✅ **IP kısıtlaması YOK** (Cloudflare'nin IP'si değişken)
- ❌ **Withdrawal izni VERME** (güvenlik)

---

## 🔧 Bot Mantığı

```
Her 15 dakika:
1. Top 15 Futures tokeni tara (hacim > 50M, değişim > %3)
2. Her token için RSI, EMA20/50, MACD, Bollinger hesapla
3. Claude AI'a indikatörleri gönder
4. Claude kararı: LONG / SHORT / SKIP
5. Güven skoru ≥ 65 ise işlem aç
6. Pozisyon: Bakiyenin %30'u
7. Otomatik TP ve SL yerleştir
8. Max 3 açık pozisyon
```

---

## ⚠️ Risk Uyarısı

Bu bot **%30 bakiye** ile işlem açar. Futures + kaldıraç = **yüksek risk**.
Gerçek para ile kullanmadan önce **Binance Testnet** üzerinde dene:
- Testnet URL: `https://testnet.binancefuture.com`
- `worker.js` içindeki `BINANCE_BASE` değişkenini testnet URL'i ile değiştir

---

## 🧪 Testnet ile Test

`src/worker.js` dosyasında bu satırı değiştir:

```js
// Canlı:
const BINANCE_BASE = "https://fapi.binance.com";

// Testnet:
const BINANCE_BASE = "https://testnet.binancefuture.com";
```

---

## 📊 Strateji Parametreleri

| Parametre | Değer | Açıklama |
|-----------|-------|----------|
| Tarama sıklığı | 15 dk | Wrangler cron |
| Min hacim | 50M USDT | Düşük hacimli tokenları filtreler |
| Min değişim | %3 | Momentum filtresi |
| Max pozisyon | 3 | Aynı anda max açık işlem |
| Pozisyon büyüklüğü | %30 bakiye | Her işlem için |
| Min güven skoru | 65/100 | Claude AI skoru |
| Kaldıraç | 3x-10x | Claude'un kararına göre |
