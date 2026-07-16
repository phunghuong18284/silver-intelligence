// ═══════════════════════════════════════════════════════════
//  Vercel Serverless Proxy — Panorama Gold & Silver
//  File: api/proxy.js
//  Chức năng:
//    POST /api/proxy        → chuyển tiếp đến Anthropic API
//    GET  /api/proxy?type=prices  → lấy giá XAU/XAG/DXY/WTI realtime
//    GET  /api/proxy?type=macro   → lấy macro indicators
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // ── CORS headers ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query?.type;

  // ════════════════════════════════
  //  GET ?type=prices — Giá realtime
  // ════════════════════════════════
  if (req.method === 'GET' && type === 'prices') {
    try {
      const data = await fetchPrices();
      return res.status(200).json({ ok: true, data, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ════════════════════════════════
  //  GET ?type=macro — Macro indicators
  // ════════════════════════════════
  if (req.method === 'GET' && type === 'macro') {
    try {
      const data = await fetchMacro();
      return res.status(200).json({ ok: true, data, ts: new Date().toISOString() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ════════════════════════════════
  //  POST — Anthropic API proxy
  // ════════════════════════════════
  if (req.method === 'POST') {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ════════════════════════════════════════════════════════
//  fetchPrices() — Lấy giá realtime từ nhiều nguồn
// ════════════════════════════════════════════════════════
async function fetchPrices() {
  const results = {};

  // ── 1. api.metals.live (miễn phí, không cần key) ──
  try {
    const r = await fetch('https://api.metals.live/v1/spot', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const d = await r.json();
      // Format: [{"gold": 4065.20, "silver": 57.68, ...}]
      const spot = Array.isArray(d) ? d[0] : d;
      if (spot?.gold) results.xau = { value: spot.gold, source: 'metals.live' };
      if (spot?.silver) results.xag = { value: spot.silver, source: 'metals.live' };
      if (spot?.platinum) results.xpt = { value: spot.platinum, source: 'metals.live' };
    }
  } catch (_) {}

  // ── 2. Yahoo Finance — Gold futures (GC=F), Silver (SI=F) ──
  if (!results.xau || !results.xag) {
    try {
      const symbols = ['GC=F', 'SI=F', 'DX-Y.NYB', 'CL=F', '%5EVIX'].join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose`;
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
          const prev = q.regularMarketPreviousClose;
          if (q.symbol === 'GC=F' && !results.xau)
            results.xau = { value: price, chPct, prev, source: 'yahoo' };
          if (q.symbol === 'SI=F' && !results.xag)
            results.xag = { value: price, chPct, prev, source: 'yahoo' };
          if (q.symbol === 'DX-Y.NYB')
            results.dxy = { value: price, chPct, prev, source: 'yahoo' };
          if (q.symbol === 'CL=F')
            results.wti = { value: price, chPct, prev, source: 'yahoo' };
          if (q.symbol === '^VIX')
            results.vix = { value: price, chPct, prev, source: 'yahoo' };
        }
      }
    } catch (_) {}
  }

  // ── 3. Tỷ giá USD/VNĐ — exchangerate-api (miễn phí) ──
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) {
      const d = await r.json();
      if (d?.rates?.VND) {
        results.usdvnd = { value: Math.round(d.rates.VND), source: 'exchangerate-api' };
      }
    }
  } catch (_) {}

  // ── 4. Tính GSR ──
  if (results.xau?.value && results.xag?.value) {
    results.gsr = {
      value: parseFloat((results.xau.value / results.xag.value).toFixed(1)),
      source: 'calculated'
    };
  }

  // ── 5. Giá vàng tính bằng VNĐ/lượng (ước tính) ──
  if (results.xau?.value && results.usdvnd?.value) {
    // 1 lượng = 37.5g = 1.2057 troy oz
    const luong = results.xau.value * 1.2057 * results.usdvnd.value / 1e6;
    results.xau_vnd = {
      value: parseFloat(luong.toFixed(2)),
      unit: 'tr/lượng',
      source: 'calculated'
    };
  }

  return results;
}

// ════════════════════════════════════════════════════════
//  fetchMacro() — Macro indicators từ Yahoo Finance
// ════════════════════════════════════════════════════════
async function fetchMacro() {
  const results = {};
  try {
    // Treasury yields: ^TNX = 10Y, ^IRX = 13W
    const symbols = ['^TNX', '^IRX', 'HG=F', 'BZ=F'].join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent`;
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
        if (q.symbol === '^TNX') results.t10y = { value: p, chPct: ch, label: 'US 10Y Treasury' };
        if (q.symbol === '^IRX') results.t3m = { value: p, chPct: ch, label: 'US 3M Treasury' };
        if (q.symbol === 'HG=F') results.copper = { value: p, chPct: ch, label: 'Copper (USD/lb)' };
        if (q.symbol === 'BZ=F') results.brent = { value: p, chPct: ch, label: 'Brent Crude' };
      }
    }
  } catch (_) {}
  return results;
}
