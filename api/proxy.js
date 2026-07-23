export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query?.type;

  // GET ?type=prices
  if (req.method === 'GET' && type === 'prices') {
    try {
      const data = await fetchPrices();
      return res.status(200).json({ ok: true, data, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // GET ?type=macro
  if (req.method === 'GET' && type === 'macro') {
    try {
      const data = await fetchMacro();
      return res.status(200).json({ ok: true, data, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // POST → Anthropic API
  if (req.method === 'POST') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    }
    try {
      const body = req.body;
      // Xác định beta header dựa trên tools được dùng
      const hasWebSearch = body?.tools?.some(t => t.type === 'web_search_20250305');
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
      if (hasWebSearch) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function fetchPrices() {
  const results = {};
  // 1. api.metals.live
  try {
    const r = await fetch('https://api.metals.live/v1/spot', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const d = await r.json();
      const spot = Array.isArray(d) ? d[0] : d;
      if (spot?.gold) results.xau = { value: spot.gold, source: 'metals.live' };
      if (spot?.silver) results.xag = { value: spot.silver, source: 'metals.live' };
    }
  } catch (_) {}

  // 2. Yahoo Finance
  try {
    const symbols = encodeURIComponent(['GC=F','SI=F','DX-Y.NYB','CL=F','^VIX'].join(','));
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.quoteResponse?.result || [];
      for (const q of quotes) {
        const price = q.regularMarketPrice;
        const chPct = q.regularMarketChangePercent?.toFixed(2);
        if (q.symbol === 'GC=F' && !results.xau) results.xau = { value: price, chPct, source: 'yahoo' };
        if (q.symbol === 'SI=F' && !results.xag) results.xag = { value: price, chPct, source: 'yahoo' };
        if (q.symbol === 'DX-Y.NYB') results.dxy = { value: price, chPct, source: 'yahoo' };
        if (q.symbol === 'CL=F') results.wti = { value: price, chPct, source: 'yahoo' };
        if (q.symbol === '^VIX') results.vix = { value: price, chPct, source: 'yahoo' };
      }
    }
  } catch (_) {}

  // 3. Tỷ giá USD/VNĐ
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const d = await r.json();
      if (d?.rates?.VND) results.usdvnd = { value: Math.round(d.rates.VND), source: 'er-api' };
    }
  } catch (_) {}

  // 4. GSR
  if (results.xau?.value && results.xag?.value) {
    results.gsr = { value: parseFloat((results.xau.value / results.xag.value).toFixed(1)), source: 'calc' };
  }

  // 5. Giá vàng VNĐ/lượng
  if (results.xau?.value && results.usdvnd?.value) {
    results.xau_vnd = {
      value: parseFloat((results.xau.value * 1.2057 * results.usdvnd.value / 1e6).toFixed(2)),
      unit: 'tr/lượng', source: 'calc'
    };
  }

  return results;
}

async function fetchMacro() {
  const results = {};
  try {
    const symbols = encodeURIComponent(['^TNX','^IRX','HG=F','BZ=F'].join(','));
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChangePercent`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const d = await r.json();
      const quotes = d?.quoteResponse?.result || [];
      for (const q of quotes) {
        const p = q.regularMarketPrice;
        const ch = q.regularMarketChangePercent?.toFixed(2);
        if (q.symbol === '^TNX') results.t10y = { value: p, chPct: ch };
        if (q.symbol === 'HG=F') results.copper = { value: p, chPct: ch };
        if (q.symbol === 'BZ=F') results.brent = { value: p, chPct: ch };
      }
    }
  } catch (_) {}
  return results;
}
