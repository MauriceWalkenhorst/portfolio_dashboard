// Yahoo Finance als Primary, Alpha Vantage als Backup
const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

const INDEX_SYMBOLS = {
  msci_world:  { symbol: 'URTH', name: 'MSCI World' },
  sp500:       { symbol: 'SPY',  name: 'S&P 500' },
  eurostoxx50: { symbol: 'FEZ',  name: 'EURO STOXX 50' },
  dax:         { symbol: 'EWG',  name: 'DAX' },
  nasdaq100:   { symbol: 'QQQ',  name: 'NASDAQ 100' },
  msci_em:     { symbol: 'EEM',  name: 'MSCI Emerging Markets' },
};

// Perioden-Mapping: Dashboard → Yahoo Finance range + interval
const YAHOO_PERIOD_MAP = {
  '1M':  { range: '1mo', interval: '1d' },
  '3M':  { range: '3mo', interval: '1d' },
  '6M':  { range: '6mo', interval: '1d' },
  '1J':  { range: '1y',  interval: '1wk' },
  '3J':  { range: '3y',  interval: '1wk' },
  'MAX': { range: 'max',  interval: '1mo' },
};

const AV_DAYS_MAP = { '1M': 30, '3M': 90, '6M': 180, '1J': 365, '3J': 1095, 'MAX': 3650 };

// Yahoo Finance: Historische Daten fuer einen Index
async function fetchYahooIndex(symbol, period) {
  const p = YAHOO_PERIOD_MAP[period] || YAHOO_PERIOD_MAP['6M'];
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${p.interval}&range=${p.range}&includePrePost=false`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!resp.ok) { lastErr = new Error(`Yahoo ${host} HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp) { lastErr = new Error(`No data from ${host}`); continue; }

      const timestamps = result.timestamp;
      const closes = result.indicators.quote[0].close;

      const points = timestamps
        .map((ts, i) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          close: closes[i],
        }))
        .filter(d => d.close != null);

      if (points.length === 0) { lastErr = new Error('No data points'); continue; }

      const base = points[0].close;
      return points.map(d => ({
        date: d.date,
        close: d.close,
        returnPct: ((d.close - base) / base) * 100,
      }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo Finance index unavailable');
}

// Alpha Vantage Fallback
async function fetchAvIndex(symbol, period) {
  if (!AV_KEY) throw new Error('No AV key');
  const isLong = ['1J', '3J', 'MAX'].includes(period);
  const fn = isLong ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY';
  const seriesKey = isLong ? 'Weekly Time Series' : 'Time Series (Daily)';
  const maxDays = AV_DAYS_MAP[period] || 180;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);

  const url = new URL(AV_BASE);
  url.searchParams.set('apikey', AV_KEY);
  url.searchParams.set('function', fn);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('outputsize', 'full');
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`AV HTTP ${resp.status}`);
  const data = await resp.json();
  if (data['Note']) throw new Error('Rate limit');
  const series = data[seriesKey];
  if (!series) throw new Error('No AV data');

  const points = Object.entries(series)
    .map(([date, v]) => ({ date, close: parseFloat(v['4. close']) }))
    .filter(d => new Date(d.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (points.length === 0) throw new Error('No data points');

  const base = points[0].close;
  return points.map(d => ({
    date: d.date,
    close: d.close,
    returnPct: ((d.close - base) / base) * 100,
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { period = '6M' } = req.query;
  const results = {};
  let source = 'yahoo';

  // Alle Indizes parallel abrufen
  const promises = Object.entries(INDEX_SYMBOLS).map(async ([key, info]) => {
    try {
      const data = await fetchYahooIndex(info.symbol, period);
      results[key] = { symbol: info.symbol, name: info.name, data };
    } catch (yahooErr) {
      console.warn(`Yahoo index ${key} failed: ${yahooErr.message}, trying AV...`);
      try {
        const data = await fetchAvIndex(info.symbol, period);
        results[key] = { symbol: info.symbol, name: info.name, data };
        source = 'mixed';
      } catch (avErr) {
        console.warn(`AV index ${key} also failed: ${avErr.message}`);
      }
    }
  });

  await Promise.all(promises);

  res.json({ indices: results, period, source, timestamp: new Date().toISOString() });
}
