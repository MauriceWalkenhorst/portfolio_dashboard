// Datenquellen: CoinGecko (Krypto, kein Key), Yahoo Finance (Aktien/ETFs), Alpha Vantage (Fallback)
const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

// CoinGecko ID-Mapping fuer Krypto-Ticker
const COINGECKO_IDS = {
  'BTC': 'bitcoin',  'BTC-EUR': 'bitcoin',  'BTC-USD': 'bitcoin',
  'ETH': 'ethereum', 'ETH-EUR': 'ethereum', 'ETH-USD': 'ethereum',
  'SOL': 'solana',   'SOL-EUR': 'solana',   'SOL-USD': 'solana',
  'ADA': 'cardano',  'ADA-EUR': 'cardano',  'ADA-USD': 'cardano',
  'XRP': 'ripple',   'XRP-EUR': 'ripple',   'XRP-USD': 'ripple',
  'DOT': 'polkadot', 'DOT-EUR': 'polkadot', 'DOT-USD': 'polkadot',
  'DOGE': 'dogecoin','DOGE-EUR':'dogecoin', 'DOGE-USD':'dogecoin',
};

// Waehrung aus Krypto-Ticker bestimmen (BTC-EUR → eur, BTC-USD → usd, BTC → eur)
function cryptoCurrency(ticker) {
  if (ticker.endsWith('-USD')) return 'usd';
  return 'eur';
}

// Pruefe ob Ticker ein Krypto-Ticker ist
function isCrypto(ticker) {
  return !!COINGECKO_IDS[ticker];
}

// Yahoo Finance Symbol-Mapping fuer Aktien
function toYahooSymbol(ticker) {
  // Bereits korrekte Yahoo-Symbole direkt durchreichen
  if (ticker.includes('-') || ticker.includes('.')) return ticker;
  return ticker;
}

// CoinGecko – zuverlässig, kein API-Key, kein IP-Blocking
async function fetchCoinGeckoQuotes(tickers) {
  const geckoIds = [...new Set(tickers.map(t => COINGECKO_IDS[t]).filter(Boolean))];
  if (geckoIds.length === 0) return {};

  const currencies = [...new Set(tickers.map(cryptoCurrency))];
  const vsCurrencies = currencies.join(',');

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds.join(',')}&vs_currencies=${vsCurrencies}&include_24hr_change=true&include_24hr_vol=true`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
  const data = await resp.json();

  const results = {};
  for (const ticker of tickers) {
    const geckoId = COINGECKO_IDS[ticker];
    if (!geckoId || !data[geckoId]) continue;
    const cur = cryptoCurrency(ticker);
    const price = data[geckoId][cur];
    const change24h = data[geckoId][`${cur}_24h_change`] || 0;
    if (price == null) continue;
    const prevClose = price / (1 + change24h / 100);
    results[ticker] = {
      symbol: ticker,
      price,
      previousClose: prevClose,
      change: price - prevClose,
      changePercent: change24h,
      dayHigh: price,
      dayLow: price,
      volume: data[geckoId][`${cur}_24h_vol`] || 0,
      name: geckoId.charAt(0).toUpperCase() + geckoId.slice(1),
      source: 'coingecko',
    };
  }
  return results;
}

// Yahoo Finance v8 Chart API – query1 und query2 als Fallback
async function fetchYahooQuote(ticker) {
  const yahooSym = toYahooSymbol(ticker);
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d&includePrePost=false`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
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

// Alpha Vantage Fallback fuer Aktien
async function fetchAvQuote(ticker) {
  if (!AV_KEY) throw new Error('No AV key configured');
  const url = new URL(AV_BASE);
  url.searchParams.set('apikey', AV_KEY);
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', ticker);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`AV HTTP ${resp.status}`);
  const data = await resp.json();
  if (data['Note']) throw new Error('AV Rate limit');
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
  const errors = [];
  let yahooCount = 0;
  let geckoCount = 0;
  let avCount = 0;

  // Krypto-Ticker via CoinGecko (batch, zuverlaessig)
  const cryptoTickers = symbols.filter(isCrypto);
  const stockTickers = symbols.filter(s => !isCrypto(s));

  if (cryptoTickers.length > 0) {
    try {
      const geckoResults = await fetchCoinGeckoQuotes(cryptoTickers);
      Object.assign(results, geckoResults);
      geckoCount = Object.keys(geckoResults).length;
      const missed = cryptoTickers.filter(t => !geckoResults[t]);
      if (missed.length > 0) errors.push(`CoinGecko missing: ${missed.join(', ')}`);
    } catch (e) {
      console.error(`CoinGecko batch failed: ${e.message}`);
      errors.push(`CoinGecko: ${e.message}`);
    }
  }

  // Aktien/ETF via Yahoo Finance parallel
  const stockPromises = stockTickers.map(async (sym) => {
    try {
      const quote = await fetchYahooQuote(sym);
      results[sym] = quote;
      yahooCount++;
    } catch (yahooErr) {
      console.warn(`Yahoo failed for ${sym}: ${yahooErr.message}`);
      try {
        const quote = await fetchAvQuote(sym);
        results[sym] = quote;
        avCount++;
      } catch (avErr) {
        console.warn(`Both failed for ${sym}: Yahoo(${yahooErr.message}) AV(${avErr.message})`);
        errors.push(`${sym}: Yahoo(${yahooErr.message}) AV(${avErr.message})`);
      }
    }
  });

  await Promise.all(stockPromises);

  // Source-Label bestimmen
  const sources = [];
  if (geckoCount > 0) sources.push('coingecko');
  if (yahooCount > 0) sources.push('yahoo');
  if (avCount > 0) sources.push('alphavantage');
  const source = sources.join('+') || 'none';

  console.log(`Quotes: ${Object.keys(results).length}/${symbols.length} | Sources: ${source} | Errors: ${errors.length}`);

  res.json({
    quotes: results,
    source,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
