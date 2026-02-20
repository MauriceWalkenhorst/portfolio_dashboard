// Yahoo Finance als Primary, Alpha Vantage als Backup
const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

// Ticker-Mapping fuer Yahoo Finance
function toYahooSymbol(ticker) {
  const cryptoMap = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', ADA: 'ADA-USD', XRP: 'XRP-USD', DOT: 'DOT-USD', DOGE: 'DOGE-USD' };
  if (cryptoMap[ticker]) return cryptoMap[ticker];
  if (ticker.endsWith('.DEX')) return ticker.replace('.DEX', '.DE');
  return ticker;
}

// Perioden-Mapping: Dashboard-Perioden → Yahoo Finance range + interval
const YAHOO_PERIOD_MAP = {
  '1W':  { range: '5d',  interval: '1d' },
  '1M':  { range: '1mo', interval: '1d' },
  '3M':  { range: '3mo', interval: '1d' },
  '6M':  { range: '6mo', interval: '1d' },
  '1J':  { range: '1y',  interval: '1wk' },
  '3J':  { range: '3y',  interval: '1wk' },
  'MAX': { range: 'max',  interval: '1mo' },
};

const AV_DAYS_MAP = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1J': 365, '3J': 1095, 'MAX': 3650 };

async function fetchYahooHistory(ticker, period) {
  const yahooSym = toYahooSymbol(ticker);
  const p = YAHOO_PERIOD_MAP[period] || YAHOO_PERIOD_MAP['6M'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${p.interval}&range=${p.range}&includePrePost=false`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioDashboard/1.0)' },
  });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp) throw new Error('No Yahoo history data');

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: quote.open[i],
    high: quote.high[i],
    low: quote.low[i],
    close: quote.close[i],
    volume: quote.volume[i] || 0,
  })).filter(d => d.close != null);
}

async function fetchAvHistory(ticker, period) {
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
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('outputsize', 'full');
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`AV HTTP ${resp.status}`);
  const data = await resp.json();
  if (data['Note']) throw new Error('Rate limit');
  const series = data[seriesKey];
  if (!series) throw new Error('No AV history data');

  return Object.entries(series)
    .map(([date, v]) => ({
      date,
      open: parseFloat(v['1. open']),
      high: parseFloat(v['2. high']),
      low: parseFloat(v['3. low']),
      close: parseFloat(v['4. close']),
      volume: parseInt(v['5. volume']),
    }))
    .filter(d => new Date(d.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol, period = '6M' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    // Yahoo Finance zuerst
    const data = await fetchYahooHistory(symbol, period);
    return res.json({ symbol, period, data, source: 'yahoo' });
  } catch (yahooErr) {
    console.warn(`Yahoo history failed for ${symbol}: ${yahooErr.message}, trying AV...`);
    try {
      const data = await fetchAvHistory(symbol, period);
      return res.json({ symbol, period, data, source: 'alphavantage' });
    } catch (avErr) {
      console.warn(`AV history also failed for ${symbol}: ${avErr.message}`);
      return res.status(500).json({ error: `Both sources failed: ${yahooErr.message} / ${avErr.message}` });
    }
  }
}
