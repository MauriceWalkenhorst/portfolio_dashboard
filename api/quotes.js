const AV_KEY = process.env.ALPHAVANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

async function avFetch(params) {
  if (!AV_KEY) {
    throw new Error('ALPHAVANTAGE_KEY not configured');
  }
  const url = new URL(AV_BASE);
  url.searchParams.set('apikey', AV_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data['Error Message']) throw new Error(data['Error Message']);
  if (data['Note']) throw new Error(`Rate limit: ${data['Note']}`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // Check if API key is configured
  if (!AV_KEY) {
    return res.status(500).json({ 
      error: 'Alpha Vantage API key not configured',
      quotes: {},
      timestamp: new Date().toISOString()
    });
  }

  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (symbols.length === 0) {
    return res.status(400).json({ error: 'symbols parameter required' });
  }

  const results = {};
  const errors = [];
  
  console.log(`Fetching quotes for: ${symbols.join(', ')}`);
  
  for (const sym of symbols) {
    try {
      const data = await avFetch({ function: 'GLOBAL_QUOTE', symbol: sym });
      console.log(`Response for ${sym}:`, JSON.stringify(data).slice(0, 200));
      
      const q = data['Global Quote'];
      if (q && q['05. price']) {
        results[sym] = {
          symbol: sym,
          price: parseFloat(q['05. price']),
          previousClose: parseFloat(q['08. previous close']),
          change: parseFloat(q['09. change']),
          changePercent: parseFloat(q['10. change percent']),
          dayHigh: parseFloat(q['03. high']),
          dayLow: parseFloat(q['04. low']),
          volume: parseInt(q['06. volume']),
          name: sym,
        };
        console.log(`✓ ${sym}: $${results[sym].price}`);
      } else {
        console.warn(`✗ ${sym}: No price data in response`);
        errors.push(`${sym}: No data returned`);
      }
      // Alpha Vantage Free Tier: max 5 calls per minute, 500 per day
      if (symbols.length > 1) await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`✗ Quote failed for ${sym}:`, e.message);
      errors.push(`${sym}: ${e.message}`);
    }
  }

  res.json({ 
    quotes: results, 
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString() 
  });
}
