// Datenquellen: CoinGecko (Krypto), Yahoo Finance (Aktien/ETFs), Alpha Vantage (Fallback)
const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

// CoinGecko ID-Mapping
const COINGECKO_IDS = {
  'BTC': 'bitcoin',  'BTC-EUR': 'bitcoin',  'BTC-USD': 'bitcoin',
  'ETH': 'ethereum', 'ETH-EUR': 'ethereum', 'ETH-USD': 'ethereum',
  'SOL': 'solana',   'SOL-EUR': 'solana',   'SOL-USD': 'solana',
  'ADA': 'cardano',  'ADA-EUR': 'cardano',  'ADA-USD': 'cardano',
  'XRP': 'ripple',   'XRP-EUR': 'ripple',   'XRP-USD': 'ripple',
  'DOT': 'polkadot', 'DOT-EUR': 'polkadot', 'DOT-USD': 'polkadot',
  'DOGE': 'dogecoin','DOGE-EUR':'dogecoin', 'DOGE-USD':'dogecoin',
};

// Perioden-Mapping
const YAHOO_PERIOD_MAP = {
  '1W':  { range: '5d',  interval: '1d' },
  '1M':  { range: '1mo', interval: '1d' },
  '3M':  { range: '3mo', interval: '1d' },
  '6M':  { range: '6mo', interval: '1d' },
  '1J':  { range: '1y',  interval: '1wk' },
  '3J':  { range: '3y',  interval: '1wk' },
  'MAX': { range: 'max',  interval: '1mo' },
};

const GECKO_DAYS_MAP = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1J': 365, '3J': 1095, 'MAX': 'max' };
const AV_DAYS_MAP = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1J': 365, '3J': 1095, 'MAX': 3650 };

// CoinGecko Krypto-Historie
async function fetchCoinGeckoHistory(ticker, period) {
  const geckoId = COINGECKO_IDS[ticker];
  if (!geckoId) throw new Error(`No CoinGecko ID for ${ticker}`);
  const cur = ticker.endsWith('-USD') ? 'usd' : 'eur';
  const days = GECKO_DAYS_MAP[period] || 180;
  const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=${cur}&days=${days}&interval=daily`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.prices || data.prices.length === 0) throw new Error('No CoinGecko history data');

  return data.prices.map(([ts, price]) => ({
    date: new Date(ts).toISOString().slice(0, 10),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }));
}

// Yahoo Finance v8 Chart History
async function fetchYahooHistory(ticker, period) {
  const p = YAHOO_PERIOD_MAP[period] || YAHOO_PERIOD_MAP['6M'];
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${p.interval}&range=${p.range}&includePrePost=false`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      if (!resp.ok) { lastErr = new Error(`Yahoo ${host} HTTP ${resp.status}`); continue; }
      const json = await resp.json();
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp) { lastErr = new Error(`No data from ${host}`); continue; }

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
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo Finance history unavailable');
}

// Alpha Vantage Fallback
async function fetchAvHistory(ticker, period) {
  if (!AV_KEY) throw new Error('No AV key configured');
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

  // Krypto: CoinGecko zuerst
  if (COINGECKO_IDS[symbol]) {
    try {
      const data = await fetchCoinGeckoHistory(symbol, period);
      return res.json({ symbol, period, data, source: 'coingecko' });
    } catch (geckoErr) {
      console.warn(`CoinGecko history failed for ${symbol}: ${geckoErr.message}`);
      // Fallthrough zu Yahoo
    }
  }

  // Aktien/ETFs + Krypto-Fallback: Yahoo Finance
  try {
    const data = await fetchYahooHistory(symbol, period);
    return res.json({ symbol, period, data, source: 'yahoo' });
  } catch (yahooErr) {
    console.warn(`Yahoo history failed for ${symbol}: ${yahooErr.message}`);
    try {
      const data = await fetchAvHistory(symbol, period);
      return res.json({ symbol, period, data, source: 'alphavantage' });
    } catch (avErr) {
      console.warn(`All sources failed for ${symbol}`);
      return res.status(500).json({
        error: `Keine Historiedaten verfuegbar: ${yahooErr.message}`,
        symbol,
        period,
      });
    }
  }
}
