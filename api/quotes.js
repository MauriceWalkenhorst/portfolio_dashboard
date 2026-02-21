// ── api/quotes.js ─────────────────────────────────────────────────────────
// Datenquellen (in Prioritaet):
//   1. CoinGecko – Krypto, kein Key, CORS-offen
//   2. Yahoo Finance v7 + Cookie/Crumb – wie yfinance Python, umgeht IP-Block
//   3. Stooq.com – Fallback fuer Aktien, anderer Provider, nicht geblockt

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── CoinGecko-Mapping ──────────────────────────────────────────────────────
const COINGECKO_IDS = {
  'BTC':      'bitcoin',  'BTC-EUR':  'bitcoin',  'BTC-USD':  'bitcoin',
  'ETH':      'ethereum', 'ETH-EUR':  'ethereum', 'ETH-USD':  'ethereum',
  'SOL':      'solana',   'SOL-EUR':  'solana',   'SOL-USD':  'solana',
  'ADA':      'cardano',  'ADA-EUR':  'cardano',  'ADA-USD':  'cardano',
  'XRP':      'ripple',   'XRP-EUR':  'ripple',   'XRP-USD':  'ripple',
  'DOT':      'polkadot', 'DOT-EUR':  'polkadot', 'DOT-USD':  'polkadot',
  'DOGE':     'dogecoin', 'DOGE-EUR': 'dogecoin', 'DOGE-USD': 'dogecoin',
};

function isCrypto(t) { return !!COINGECKO_IDS[t]; }
function cryptoCur(t) { return t.endsWith('-USD') ? 'usd' : 'eur'; }

// ── 1. CoinGecko ──────────────────────────────────────────────────────────
async function fetchCoinGecko(tickers) {
  const geckoIds   = [...new Set(tickers.map(t => COINGECKO_IDS[t]))];
  const currencies = [...new Set(tickers.map(cryptoCur))].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds.join(',')}&vs_currencies=${currencies}&include_24hr_change=true`;

  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const data = await resp.json();

  const results = {};
  for (const t of tickers) {
    const id    = COINGECKO_IDS[t];
    const cur   = cryptoCur(t);
    const price = data[id]?.[cur];
    if (price == null) continue;
    const change    = data[id][`${cur}_24h_change`] || 0;
    const prevClose = price / (1 + change / 100);
    results[t] = {
      price,
      previousClose: prevClose,
      change: price - prevClose,
      changePercent: change,
      source: 'coingecko',
    };
  }
  return results;
}

// ── 2a. Yahoo Finance Cookie+Crumb holen ──────────────────────────────────
async function getYahooCrumb() {
  // Schritt 1: fc.yahoo.com liefert den A1-Consent-Cookie
  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  });

  // Node 20 fetch unterstuetzt getSetCookie() fuer alle Set-Cookie-Header
  let setCookies = [];
  if (typeof r1.headers.getSetCookie === 'function') {
    setCookies = r1.headers.getSetCookie();
  } else {
    const raw = r1.headers.get('set-cookie');
    if (raw) setCookies = [raw];
  }
  const cookieStr = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');

  // Schritt 2: Crumb holen
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Cookie':     cookieStr,
      'Accept':     'text/plain, */*',
    },
  });
  const crumb = (await r2.text()).trim();

  // Crumb ist typischerweise 11 Zeichen, kein JSON, kein HTML
  if (!crumb || crumb.length > 50 || crumb.startsWith('{') || crumb.startsWith('<')) {
    throw new Error(`Ungueiltiger Crumb: "${crumb.slice(0, 40)}"`);
  }
  return { crumb, cookieStr };
}

// ── 2b. Yahoo Finance v7 mit Crumb ────────────────────────────────────────
async function fetchYahooWithCrumb(tickers) {
  const { crumb, cookieStr } = await getYahooCrumb();

  // EURUSD=X immer mitanfragen, um USD-Kurse in EUR umzurechnen
  const allSymbols = [...tickers, 'EURUSD=X'];

  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${allSymbols.map(encodeURIComponent).join(',')}` +
    `&crumb=${encodeURIComponent(crumb)}` +
    `&lang=en-US&region=US&formatted=false&corsDomain=finance.yahoo.com`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`Yahoo v7 HTTP ${resp.status}`);

  const data = await resp.json();
  const allResults = data.quoteResponse?.result || [];

  // EUR/USD-Kurs extrahieren (1 EUR = X USD → zum Umrechnen durch X dividieren)
  const fxQuote = allResults.find(q => q.symbol === 'EURUSD=X');
  const eurUsd = fxQuote?.regularMarketPrice || 1.05; // Fallback falls nicht verfuegbar

  const results = {};
  for (const q of allResults) {
    if (q.symbol === 'EURUSD=X') continue;
    if (!q.regularMarketPrice) continue;

    // Yahoo-Symbol → Portfolio-Ticker mappen
    const key = tickers.find(t => t.toUpperCase() === q.symbol.toUpperCase()) || q.symbol;

    // USD-Kurse in EUR umrechnen (teile durch EUR/USD-Rate)
    const isUsd = q.currency === 'USD';
    const fx = isUsd ? 1 / eurUsd : 1;

    results[key] = {
      price:         q.regularMarketPrice          * fx,
      previousClose: (q.regularMarketPreviousClose || q.regularMarketPrice) * fx,
      change:        (q.regularMarketChange        || 0) * fx,
      changePercent: q.regularMarketChangePercent  || 0,   // % bleibt gleich
      dayHigh:       (q.regularMarketDayHigh       || q.regularMarketPrice) * fx,
      dayLow:        (q.regularMarketDayLow        || q.regularMarketPrice) * fx,
      volume:        q.regularMarketVolume         || 0,
      name:          q.shortName || q.longName     || q.symbol,
      currency:      isUsd ? 'USD→EUR' : (q.currency || 'EUR'),
      source: 'yahoo',
    };
  }
  // eurUsd mitgeben damit Stooq-Fallback denselben Kurs verwenden kann
  return { results, eurUsd };
}

// EUR/USD-Kurs ohne Authentifizierung holen (fuer Stooq-Fallback)
async function fetchEurUsd() {
  try {
    const resp = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?interval=1d&range=1d',
      { headers: { 'User-Agent': UA } }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rate = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (rate && rate > 0.5 && rate < 2.5) return rate;
  } catch (e) {
    console.warn('EUR/USD-Abruf fehlgeschlagen, verwende Fallback 1.05:', e.message);
  }
  return 1.05; // vernuenftiger Standardwert
}

// ── 3. Stooq-Fallback ─────────────────────────────────────────────────────
// Stooq-Symbol: URTH→urth.us, RHM.DE→rhm.de, BTC-EUR→nicht unterstuetzt
function toStooqSym(ticker) {
  const t = ticker.toLowerCase();
  if (t.includes('.')) return t;      // RHM.DE → rhm.de
  return t + '.us';                   // URTH → urth.us
}

async function fetchStooqQuote(ticker, eurUsd = 1.05) {
  const sym = toStooqSym(ticker);
  const url = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcvn&e=json`;

  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Stooq HTTP ${resp.status}`);
  const data = await resp.json();

  const s = data.symbols?.[0];
  if (!s || !s.c || s.c === 'N/D') throw new Error('Keine Stooq-Daten');

  // US-Ticker (Suffix .us) werden von Stooq in USD zurueckgegeben → in EUR umrechnen
  const isUsd = sym.endsWith('.us');
  const fx = isUsd ? 1 / eurUsd : 1;

  const price = parseFloat(s.c) * fx;
  const open  = (parseFloat(s.o) || parseFloat(s.c)) * fx;
  return {
    price,
    previousClose: open,
    change:        price - open,
    changePercent: open ? ((price - open) / open) * 100 : 0,
    dayHigh:       parseFloat(s.h) * fx || price,
    dayLow:        parseFloat(s.l) * fx || price,
    volume:        parseInt(s.v)   || 0,
    name:          s.n || ticker,
    currency:      isUsd ? 'USD→EUR' : 'EUR',
    source: 'stooq',
  };
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols parameter required' });
  }

  const cryptoTickers = symbols.filter(isCrypto);
  const stockTickers  = symbols.filter(t => !isCrypto(t));
  const results = {};
  const errors  = [];

  // 1. Krypto via CoinGecko
  if (cryptoTickers.length > 0) {
    try {
      Object.assign(results, await fetchCoinGecko(cryptoTickers));
    } catch (e) {
      errors.push(`CoinGecko: ${e.message}`);
      console.error('CoinGecko fehlgeschlagen:', e.message);
    }
  }

  // 2. Aktien/ETFs: Yahoo v7+Crumb, dann Stooq als Fallback
  if (stockTickers.length > 0) {
    let yahooOk = false;
    let eurUsd   = 1.05; // Standardwert, wird durch Yahoo oder separaten Abruf ersetzt

    try {
      const { results: yahooResults, eurUsd: rate } = await fetchYahooWithCrumb(stockTickers);
      Object.assign(results, yahooResults);
      eurUsd   = rate;
      yahooOk  = true;
      console.log(`Yahoo v7+Crumb: ${Object.keys(yahooResults).length}/${stockTickers.length} Kurse | EUR/USD: ${eurUsd.toFixed(4)}`);
    } catch (e) {
      errors.push(`Yahoo: ${e.message}`);
      console.warn('Yahoo v7+Crumb fehlgeschlagen:', e.message);
      // EUR/USD separat holen damit Stooq korrekt konvertieren kann
      eurUsd = await fetchEurUsd();
    }

    // Stooq fuer alle Ticker die Yahoo nicht lieferte (oder Yahoo komplett fehlschlug)
    const needStooq = yahooOk
      ? stockTickers.filter(t => !results[t])
      : stockTickers;

    for (const t of needStooq) {
      try {
        results[t] = await fetchStooqQuote(t, eurUsd);
      } catch (e) {
        errors.push(`Stooq(${t}): ${e.message}`);
        console.warn(`Stooq fehlgeschlagen fuer ${t}:`, e.message);
      }
    }
  }

  const sources = [...new Set(Object.values(results).map(q => q.source))];
  console.log(`Quotes fertig: ${Object.keys(results).length}/${symbols.length} | Quellen: ${sources.join('+')} | Fehler: ${errors.length}`);

  res.json({
    quotes:    results,
    source:    sources.join('+') || 'none',
    errors:    errors.length ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
