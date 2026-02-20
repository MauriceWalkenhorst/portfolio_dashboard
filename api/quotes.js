// Yahoo Finance als Primary, Alpha Vantage als Backup
const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

// Ticker-Mapping: Portfolio-Ticker → Yahoo Finance Symbol
// Ticker die bereits Yahoo-kompatibel sind (z.B. BTC-EUR, RHM.DE) werden durchgereicht
function toYahooSymbol(ticker) {
  // Bereits korrekte Yahoo-Symbole (BTC-EUR, ETH-USD, RHM.DE etc.) direkt durchreichen
  if (ticker.includes('-') || ticker.includes('.')) return ticker;
  // Alleinstehende Krypto-Ticker ohne Waehrung → USD-Paar
  const cryptoMap = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', ADA: 'ADA-USD', XRP: 'XRP-USD', DOT: 'DOT-USD', DOGE: 'DOGE-USD' };
  if (cryptoMap[ticker]) return cryptoMap[ticker];
  return ticker;
}

// Yahoo Finance v8 Chart API – kostenlos, kein API-Key noetig
// Versucht query1 und query2 als Fallback
async function fetchYahooQuote(ticker) {
  const yahooSym = toYahooSymbol(ticker);
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d&includePrePost=false`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!resp.ok) {
        lastErr = new Error(`Yahoo ${host} HTTP ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.meta) {
        lastErr = new Error(`No data from ${host}`);
        continue;
      }
      const m = result.meta;
      const prevClose = m.chartPreviousClose || m.previousClose || m.regularMarketPrice;
      const price = m.regularMarketPrice;
      return {
        symbol: ticker,
        price,
        previousClose: prevClose,
        change: price - prevClose,
        changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        dayHigh: m.regularMarketDayHigh || price,
        dayLow: m.regularMarketDayLow || price,
        volume: m.regularMarketVolume || 0,
        name: m.shortName || m.longName || ticker,
        source: 'yahoo',
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo Finance unavailable');
}

// Alpha Vantage Fallback
async function fetchAvQuote(ticker) {
  if (!AV_KEY) throw new Error('No AV key configured');
  const url = new URL(AV_BASE);
  url.searchParams.set('apikey', AV_KEY);
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', ticker);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`AV HTTP ${resp.status}`);
  const data = await resp.json();
  if (data['Note']) throw new Error('Rate limit');
  if (data['Error Message']) throw new Error(data['Error Message']);
  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error('No AV data');
  return {
    symbol: ticker,
    price: parseFloat(q['05. price']),
    previousClose: parseFloat(q['08. previous close']),
    change: parseFloat(q['09. change']),
    changePercent: parseFloat(q['10. change percent']),
    dayHigh: parseFloat(q['03. high']),
    dayLow: parseFloat(q['04. low']),
    volume: parseInt(q['06. volume']),
    name: ticker,
    source: 'alphavantage',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (symbols.length === 0) {
    return res.status(400).json({ error: 'symbols parameter required' });
  }

  const results = {};
  let source = 'yahoo';
  const errors = [];

  // Alle Symbole parallel via Yahoo Finance abrufen
  const promises = symbols.map(async (sym) => {
    try {
      const quote = await fetchYahooQuote(sym);
      results[sym] = quote;
    } catch (yahooErr) {
      console.warn(`Yahoo failed for ${sym}: ${yahooErr.message}, trying Alpha Vantage...`);
      try {
        const quote = await fetchAvQuote(sym);
        results[sym] = quote;
        source = 'mixed';
      } catch (avErr) {
        console.warn(`Both sources failed for ${sym}: ${avErr.message}`);
        errors.push(`${sym}: Yahoo(${yahooErr.message}) AV(${avErr.message})`);
      }
    }
  });

  await Promise.all(promises);

  res.json({
    quotes: results,
    source,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
