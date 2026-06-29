export default {
  async fetch(request, env) {

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, x-action',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    // ── STATUS ──────────────────────────────────────────────────────
    if (!action) {
      return json({ status: 'AURUM Worker v5 — Land Registry + Rightmove + Zoopla' });
    }

    // ── POSTCODE LOOKUP ─────────────────────────────────────────────
    if (action === 'postcode-lookup') {
      const postcode = url.searchParams.get('postcode') || '';
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const d = await r.json();
        return json(d);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── POSTCODE AUTOCOMPLETE ────────────────────────────────────────
    if (action === 'postcode-autocomplete') {
      const q = url.searchParams.get('q') || '';
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}/autocomplete`);
        const d = await r.json();
        return json(d);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── POSTCODES WITHIN RADIUS ──────────────────────────────────────
    if (action === 'postcodes-radius') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      const radius = url.searchParams.get('radius') || 1000;
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&radius=${radius}&limit=100`);
        const d = await r.json();
        return json(d);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── LAND REGISTRY SOLD PRICES ────────────────────────────────────
    if (action === 'sold-prices') {
      const postcode = url.searchParams.get('postcode') || '';
      const limit = url.searchParams.get('limit') || 50;
      try {
        const lrUrl = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?_page=0&_pageSize=${limit}&propertyAddress.postcode=${encodeURIComponent(postcode)}&_sort=-transactionDate`;
        const r = await fetch(lrUrl, { headers: { 'Accept': 'application/json' } });
        const d = await r.json();
        return json(d);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── BULK SOLD PRICES ─────────────────────────────────────────────
    if (action === 'bulk-sold-prices') {
      const body = await request.json();
      const postcodes = body.postcodes || [];
      const results = {};
      await Promise.all(postcodes.map(async (pc) => {
        try {
          const lrUrl = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?_page=0&_pageSize=30&propertyAddress.postcode=${encodeURIComponent(pc)}&_sort=-transactionDate`;
          const r = await fetch(lrUrl, { headers: { 'Accept': 'application/json' } });
          const d = await r.json();
          const items = d?.result?.items || [];
          results[pc] = items.map(i => ({
            address: `${i.propertyAddress?.paon || ''} ${i.propertyAddress?.street || ''}`.trim(),
            price: i.pricePaid,
            date: i.transactionDate,
            type: i.propertyType,
            postcode: pc
          }));
        } catch (e) { results[pc] = []; }
      }));
      return json({ results });
    }

    // ── RIGHTMOVE RENTAL SCRAPE ──────────────────────────────────────
    // Scrapes Rightmove rental listings for a given postcode + beds
    if (action === 'rightmove-rents') {
      const postcode = (url.searchParams.get('postcode') || '').trim().toUpperCase();
      const beds = url.searchParams.get('beds') || '3';
      const propType = url.searchParams.get('type') || ''; // houses / flats

      if (!postcode) return json({ error: 'postcode required' }, 400);

      try {
        // Step 1: Get Rightmove location identifier for postcode
        const searchUrl = `https://www.rightmove.co.uk/typeAhead/uknoauth?input=${encodeURIComponent(postcode)}&numberOfResults=5`;
        const searchRes = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://www.rightmove.co.uk/',
          }
        });

        let locationId = null;
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const match = (searchData.typeAheadLocations || []).find(l =>
            l.displayName?.toUpperCase().includes(postcode) || l.locationIdentifier?.includes('POSTCODE')
          );
          if (match) locationId = match.locationIdentifier;
        }

        // Step 2: Scrape rental listings
        const typeParam = propType === 'F' ? '&propertyTypes=flat' : propType === 'T' || propType === 'S' || propType === 'D' ? '&propertyTypes=semi-detached%2Cterraced%2Cdetached' : '';
        const rmUrl = locationId
          ? `https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=${encodeURIComponent(locationId)}&minBedrooms=${beds}&maxBedrooms=${beds}${typeParam}&_includeLetAgreed=false&sortType=6`
          : `https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=POSTCODE%5E${encodeURIComponent(postcode.replace(/\s/g,''))}&minBedrooms=${beds}&maxBedrooms=${beds}${typeParam}&sortType=6`;

        const rmRes = await fetch(rmUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-GB,en;q=0.9',
            'Referer': 'https://www.rightmove.co.uk/',
            'Cache-Control': 'no-cache',
          }
        });

        if (!rmRes.ok) {
          return json({ error: `Rightmove returned ${rmRes.status}`, fallback: true }, 200);
        }

        const html = await rmRes.text();

        // Extract prices from HTML — Rightmove embeds JSON data in window.jsonModel
        const prices = [];
        const addresses = [];

        // Method 1: Extract from jsonModel script tag
        const jsonModelMatch = html.match(/window\.jsonModel\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
        if (jsonModelMatch) {
          try {
            const jsonModel = JSON.parse(jsonModelMatch[1]);
            const props = jsonModel?.properties || [];
            props.forEach(p => {
              if (p.price?.amount && p.price.amount > 0) {
                // Rightmove shows weekly or monthly — convert if weekly
                let monthly = p.price.amount;
                if (p.price.frequency === 'weekly') monthly = Math.round(monthly * 52 / 12);
                prices.push(monthly);
                addresses.push({
                  address: p.displayAddress || '',
                  price: monthly,
                  beds: p.bedrooms,
                  type: p.propertySubType || p.propertyTypeFullDescription || '',
                  added: p.addedOrReduced || '',
                  url: `https://www.rightmove.co.uk${p.propertyUrl || ''}`,
                });
              }
            });
          } catch (e) {}
        }

        // Method 2: Regex fallback — extract prices from HTML
        if (prices.length === 0) {
          // Match patterns like "£1,250 pcm" or "£1250 per month"
          const priceRegexPCM = /£([\d,]+)\s*(?:pcm|per\s*month|pm)/gi;
          const priceRegexPW = /£([\d,]+)\s*(?:pw|per\s*week)/gi;
          let m;
          while ((m = priceRegexPCM.exec(html)) !== null) {
            const p = parseInt(m[1].replace(/,/g, ''));
            if (p > 200 && p < 20000) prices.push(p);
          }
          while ((m = priceRegexPW.exec(html)) !== null) {
            const p = Math.round(parseInt(m[1].replace(/,/g, '')) * 52 / 12);
            if (p > 200 && p < 20000) prices.push(p);
          }
        }

        if (prices.length === 0) {
          return json({
            success: false,
            error: 'No listings found or Rightmove blocked scraping',
            fallback: true,
            rightmoveUrl: rmUrl,
          }, 200);
        }

        // Remove outliers (top and bottom 10%)
        const sorted = [...prices].sort((a, b) => a - b);
        const trimStart = Math.floor(sorted.length * 0.1);
        const trimEnd = Math.ceil(sorted.length * 0.9);
        const trimmed = sorted.slice(trimStart, trimEnd);

        const avg = trimmed.length ? Math.round(trimmed.reduce((s, p) => s + p, 0) / trimmed.length / 25) * 25 : 0;
        const median = trimmed.length ? trimmed[Math.floor(trimmed.length / 2)] : 0;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        return json({
          success: true,
          postcode,
          beds: parseInt(beds),
          listingsFound: prices.length,
          avgRent: avg,
          medianRent: median,
          minRent: min,
          maxRent: max,
          listings: addresses.slice(0, 15),
          allPrices: sorted,
          rightmoveUrl: rmUrl,
          source: 'rightmove_live',
          note: 'Live Rightmove rental listings. Prices in £/month.',
        });

      } catch (e) {
        return json({ error: e.message, fallback: true }, 200);
      }
    }

    // ── ZOOPLA RENTAL FALLBACK ────────────────────────────────────────
    if (action === 'zoopla-rents') {
      const postcode = (url.searchParams.get('postcode') || '').trim().toUpperCase();
      const beds = url.searchParams.get('beds') || '3';

      try {
        const pcSlug = postcode.toLowerCase().replace(/\s/g, '-');
        const zUrl = `https://www.zoopla.co.uk/to-rent/property/${pcSlug}/?beds_min=${beds}&beds_max=${beds}&results_sort=newest_listings&search_source=to-rent`;

        const zRes = await fetch(zUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'en-GB,en;q=0.9',
            'Referer': 'https://www.zoopla.co.uk/',
          }
        });

        if (!zRes.ok) return json({ error: `Zoopla ${zRes.status}`, fallback: true }, 200);

        const html = await zRes.text();
        const prices = [];

        // Extract from __NEXT_DATA__ JSON
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
          try {
            const nextData = JSON.parse(nextDataMatch[1]);
            const listings = nextData?.props?.pageProps?.regularListingsFormatted ||
                             nextData?.props?.pageProps?.listings?.regular || [];
            listings.forEach(l => {
              const p = l.price || l.rentPerMonth || l.pricing?.label;
              if (typeof p === 'number' && p > 200 && p < 20000) prices.push(p);
              if (typeof p === 'string') {
                const n = parseInt(p.replace(/[£,]/g, ''));
                if (n > 200 && n < 20000) prices.push(n);
              }
            });
          } catch (e) {}
        }

        // Regex fallback
        if (prices.length === 0) {
          const priceRegex = /£([\d,]+)\s*(?:pcm|per\s*month|pm)/gi;
          let m;
          while ((m = priceRegex.exec(html)) !== null) {
            const p = parseInt(m[1].replace(/,/g, ''));
            if (p > 200 && p < 20000) prices.push(p);
          }
        }

        if (!prices.length) return json({ error: 'No Zoopla listings found', fallback: true }, 200);

        const sorted = [...prices].sort((a, b) => a - b);
        const avg = Math.round(sorted.reduce((s, p) => s + p, 0) / sorted.length / 25) * 25;
        const median = sorted[Math.floor(sorted.length / 2)];

        return json({
          success: true,
          postcode,
          beds: parseInt(beds),
          listingsFound: prices.length,
          avgRent: avg,
          medianRent: median,
          minRent: sorted[0],
          maxRent: sorted[sorted.length - 1],
          allPrices: sorted,
          zooplaUrl: zUrl,
          source: 'zoopla_live',
        });
      } catch (e) {
        return json({ error: e.message, fallback: true }, 200);
      }
    }

    // ── ANTHROPIC PROXY ──────────────────────────────────────────────
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = request.headers.get('x-api-key');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body)
        });
        const data = await r.json();
        return json(data, r.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return json({ error: 'Unknown action' }, 400);
  }
};
