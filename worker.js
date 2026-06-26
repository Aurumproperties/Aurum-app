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
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    // ── STATUS ──────────────────────────────────────────
    if (!action) {
      return json({ status: 'AURUM Worker v4 — Land Registry + Comparables Ready' });
    }

    // ── POSTCODE LOOKUP (postcodes.io) ──────────────────
    if (action === 'postcode-lookup') {
      const postcode = url.searchParams.get('postcode') || '';
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const d = await r.json();
        return json(d);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── POSTCODE AUTOCOMPLETE ────────────────────────────
    if (action === 'postcode-autocomplete') {
      const q = url.searchParams.get('q') || '';
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}/autocomplete`);
        const d = await r.json();
        return json(d);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── POSTCODES WITHIN RADIUS ──────────────────────────
    if (action === 'postcodes-radius') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      const radius = url.searchParams.get('radius') || 1000;
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&radius=${radius}&limit=100`);
        const d = await r.json();
        return json(d);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── LAND REGISTRY SOLD PRICES ────────────────────────
    // Uses HM Land Registry Price Paid Data (open data, no auth needed)
    if (action === 'sold-prices') {
      const postcode = (url.searchParams.get('postcode') || '').toUpperCase().trim();
      const propertyType = url.searchParams.get('type') || ''; // T=Terraced, S=Semi, D=Detached, F=Flat
      const limit = parseInt(url.searchParams.get('limit') || '50');

      if (!postcode) return json({ error: 'postcode required' }, 400);

      try {
        // Land Registry SPARQL endpoint — public, free, no API key
        let typeFilter = '';
        if (propertyType) {
          typeFilter = `FILTER(?propertyType = <http://landregistry.data.gov.uk/def/ppi/propertyType/${
            propertyType === 'T' ? 'terraced' :
            propertyType === 'S' ? 'semiDetached' :
            propertyType === 'D' ? 'detached' :
            propertyType === 'F' ? 'flatMaisonette' : 'terraced'
          }>)`;
        }

        const sparql = `
          PREFIX ppi: <http://landregistry.data.gov.uk/def/ppi/>
          PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
          PREFIX sr: <http://data.ordnancesurvey.co.uk/ontology/spatialrelations/>
          PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>

          SELECT ?paon ?saon ?street ?town ?county ?postcode ?amount ?date ?propertyType ?estateType
          WHERE {
            ?addr lrcommon:postcode "${postcode}"^^xsd:string .
            ?transx ppi:propertyAddress ?addr ;
                    ppi:pricePaid ?amount ;
                    ppi:transactionDate ?date ;
                    ppi:propertyType ?propertyType ;
                    ppi:estateType ?estateType .
            OPTIONAL { ?addr lrcommon:paon ?paon }
            OPTIONAL { ?addr lrcommon:saon ?saon }
            OPTIONAL { ?addr lrcommon:street ?street }
            OPTIONAL { ?addr lrcommon:town ?town }
            OPTIONAL { ?addr lrcommon:county ?county }
            OPTIONAL { ?addr lrcommon:postcode ?postcode }
            ${typeFilter}
          }
          ORDER BY DESC(?date)
          LIMIT ${limit}
        `;

        const r = await fetch(
          'https://landregistry.data.gov.uk/app/ppd/ppd_data.csv?' +
          new URLSearchParams({ query: sparql }),
          { headers: { 'Accept': 'application/sparql-results+json' } }
        );

        // Try the JSON endpoint
        const r2 = await fetch(
          'https://landregistry.data.gov.uk/app/ppd/ppd_data.json?' +
          new URLSearchParams({ query: sparql })
        );

        if (r2.ok) {
          const data = await r2.json();
          return json({ success: true, source: 'land_registry', data });
        }

        // Fallback: use the open data API
        const r3 = await fetch(
          `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?` +
          new URLSearchParams({
            'propertyAddress.postcode': postcode,
            '_page': '0',
            '_pageSize': limit.toString(),
            '_sort': '-transactionDate',
          })
        );

        if (r3.ok) {
          const data = await r3.json();
          return json({ success: true, source: 'land_registry_api', data });
        }

        return json({ error: 'Land Registry unavailable', fallback: true }, 503);

      } catch (e) {
        return json({ error: e.message, fallback: true }, 500);
      }
    }

    // ── LAND REGISTRY via linked data API ────────────────
    if (action === 'sold-prices-v2') {
      const postcode = (url.searchParams.get('postcode') || '').toUpperCase().replace(/\s/g, '+');
      const propertyType = url.searchParams.get('type') || '';
      const limit = url.searchParams.get('limit') || '50';

      try {
        const typeMap = { T:'terraced', S:'semi-detached', D:'detached', F:'flat-maisonette' };
        const typeParam = propertyType && typeMap[propertyType] ? `&propertyType=${typeMap[propertyType]}` : '';

        const apiUrl = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${postcode}${typeParam}&_page=0&_pageSize=${limit}&_sort=-transactionDate`;

        const r = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json' }
        });

        if (!r.ok) {
          return json({ error: `Land Registry returned ${r.status}`, fallback: true }, r.status);
        }

        const raw = await r.json();

        // Parse the results into clean format
        const items = raw.result?.items || [];
        const transactions = items.map(item => {
          const addr = item.propertyAddress || {};
          const typeUri = (item.propertyType?.['@id'] || '').split('/').pop();
          const typeLabel = { terraced:'T', 'semi-detached':'S', detached:'D', 'flat-maisonette':'F' }[typeUri] || typeUri;
          return {
            price: item.pricePaid,
            date: item.transactionDate,
            address: [addr.paon, addr.saon, addr.street].filter(Boolean).join(' '),
            postcode: addr.postcode,
            town: addr.town,
            type: typeLabel,
            typeLabel: { T:'Terraced', S:'Semi-Detached', D:'Detached', F:'Flat/Maisonette' }[typeLabel] || typeLabel,
            newBuild: item.newBuild === 'Y',
            tenure: (item.estateType?.['@id'] || '').split('/').pop(),
          };
        });

        return json({
          success: true,
          postcode: postcode.replace('+', ' '),
          count: transactions.length,
          transactions,
          source: 'hm_land_registry',
          note: 'HM Land Registry Price Paid Data. Crown Copyright.'
        });

      } catch (e) {
        return json({ error: e.message, fallback: true }, 500);
      }
    }

    // ── NEARBY SOLD PRICES (radius search) ──────────────
    if (action === 'nearby-sold') {
      const postcode = url.searchParams.get('postcode') || '';
      const propertyType = url.searchParams.get('type') || 'T';
      const radiusMetres = url.searchParams.get('radius') || '800';

      try {
        // Step 1: Get lat/lon for postcode
        const pcRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const pcData = await pcRes.json();

        if (!pcData.result) {
          return json({ error: 'Invalid postcode', postcode }, 400);
        }

        const { latitude, longitude } = pcData.result;

        // Step 2: Get all postcodes within radius
        const nearbyRes = await fetch(
          `https://api.postcodes.io/postcodes?lon=${longitude}&lat=${latitude}&radius=${radiusMetres}&limit=20`
        );
        const nearbyData = await nearbyRes.json();
        const nearbyPCs = (nearbyData.result || []).map(p => p.postcode).slice(0, 10);

        // Step 3: Get sold prices for each nearby postcode
        const typeMap = { T:'terraced', S:'semi-detached', D:'detached', F:'flat-maisonette' };
        const typeParam = typeMap[propertyType] ? `&propertyType=${typeMap[propertyType]}` : '';

        const allTransactions = [];
        const errors = [];

        // Fetch from Land Registry for each postcode (parallel)
        const fetches = nearbyPCs.slice(0, 6).map(async pc => {
          try {
            const pcEncoded = pc.replace(/\s/g, '+');
            const r = await fetch(
              `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${pcEncoded}${typeParam}&_page=0&_pageSize=15&_sort=-transactionDate`,
              { headers: { 'Accept': 'application/json' } }
            );
            if (!r.ok) return;
            const raw = await r.json();
            const items = raw.result?.items || [];
            items.forEach(item => {
              const addr = item.propertyAddress || {};
              const typeUri = (item.propertyType?.['@id'] || '').split('/').pop();
              const typeLabel = { terraced:'T', 'semi-detached':'S', detached:'D', 'flat-maisonette':'F' }[typeUri] || 'O';
              allTransactions.push({
                price: item.pricePaid,
                date: item.transactionDate,
                address: [addr.paon, addr.saon, addr.street].filter(Boolean).join(' '),
                postcode: addr.postcode || pc,
                town: addr.town,
                type: typeLabel,
                typeLabel: { T:'Terraced', S:'Semi-Detached', D:'Detached', F:'Flat/Maisonette' }[typeLabel] || typeLabel,
                newBuild: item.newBuild === 'Y',
                distanceMetres: null, // calculated client side
              });
            });
          } catch(e) {
            errors.push({ pc, error: e.message });
          }
        });

        await Promise.all(fetches);

        // Sort by date desc
        allTransactions.sort((a,b) => (b.date||'').localeCompare(a.date||''));

        // Calculate stats
        const prices = allTransactions.filter(t=>t.price>0).map(t=>t.price);
        const avgPrice = prices.length ? Math.round(prices.reduce((s,p)=>s+p,0)/prices.length) : 0;
        const medianPrice = prices.length ? prices.sort((a,b)=>a-b)[Math.floor(prices.length/2)] : 0;
        const minPrice = prices.length ? Math.min(...prices) : 0;
        const maxPrice = prices.length ? Math.max(...prices) : 0;

        return json({
          success: true,
          searchPostcode: postcode,
          propertyType: propertyType,
          searchRadius: `${radiusMetres}m`,
          centreLatLon: { lat: latitude, lon: longitude },
          nearbyPostcodes: nearbyPCs,
          count: allTransactions.length,
          stats: { avgPrice, medianPrice, minPrice, maxPrice, sampleSize: prices.length },
          transactions: allTransactions.slice(0, 50),
          errors,
          source: 'hm_land_registry',
          rightmoveUrl: `https://www.rightmove.co.uk/house-prices/${postcode.toLowerCase().replace(/\s/g,'-')}.html`,
          note: 'HM Land Registry Price Paid Data. Crown Copyright.'
        });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── RENTAL ESTIMATE (based on yield data) ────────────
    if (action === 'rental-estimate') {
      const postcode = (url.searchParams.get('postcode') || '').toUpperCase().trim();
      const beds = parseInt(url.searchParams.get('beds') || '3');
      const propertyType = url.searchParams.get('type') || 'T';

      // Regional rental data (Rightmove/Zoopla averages 2026)
      const RENTAL_DATA = {
        // Format: postcode_prefix: { 1bed, 2bed, 3bed, 4bed }
        'SR': { 1:520, 2:650, 3:780, 4:950 },
        'L':  { 1:700, 2:850, 3:1000, 4:1250 },
        'HU': { 1:550, 2:680, 3:780, 4:950 },
        'DN': { 1:500, 2:620, 3:720, 4:880 },
        'TS': { 1:540, 2:660, 3:760, 4:930 },
        'DL': { 1:550, 2:680, 3:780, 4:950 },
        'NE': { 1:700, 2:850, 3:980, 4:1200 },
        'S':  { 1:650, 2:800, 3:950, 4:1150 },
        'LS': { 1:750, 2:920, 3:1100, 4:1350 },
        'M':  { 1:800, 2:1000, 3:1200, 4:1450 },
        'CV': { 1:750, 2:900, 3:1050, 4:1300 },
        'ME': { 1:850, 2:1050, 3:1250, 4:1500 },
        'LU': { 1:950, 2:1150, 3:1400, 4:1700 },
        'N':  { 1:1400, 2:1750, 3:2200, 4:2800 },
        'EN': { 1:1300, 2:1600, 3:2000, 4:2500 },
        'E':  { 1:1500, 2:1900, 3:2400, 4:3000 },
        'SE': { 1:1400, 2:1800, 3:2200, 4:2800 },
        'SW': { 1:1500, 2:1900, 3:2400, 4:3000 },
        'W':  { 1:1600, 2:2000, 3:2500, 4:3200 },
        'WC': { 1:1800, 2:2200, 3:2800, 4:3500 },
        'EC': { 1:1800, 2:2200, 3:2800, 4:3500 },
      };

      const prefix2 = postcode.slice(0,2).replace(/\d/g,'');
      const prefix1 = postcode.slice(0,1);
      const data = RENTAL_DATA[prefix2] || RENTAL_DATA[prefix1] || { 1:600, 2:750, 3:900, 4:1100 };
      const clampedBeds = Math.min(4, Math.max(1, beds));
      const baseRent = data[clampedBeds];

      // Type adjustment
      const typeAdj = { T:1.0, S:1.05, D:1.15, F:0.85 };
      const estimatedRent = Math.round(baseRent * (typeAdj[propertyType]||1.0) / 25) * 25;

      return json({
        success: true,
        postcode,
        beds,
        propertyType,
        estimatedMonthlyRent: estimatedRent,
        estimatedAnnualRent: estimatedRent * 12,
        range: { low: Math.round(estimatedRent*0.85/25)*25, high: Math.round(estimatedRent*1.15/25)*25 },
        source: 'rightmove_zoopla_averages_2026',
        rightmoveRentUrl: `https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=POSTCODE%5E${encodeURIComponent(postcode)}&maxBedrooms=${beds}&minBedrooms=${beds}`,
      });
    }

    // ── ANTHROPIC AI PROXY (existing) ───────────────────
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = request.headers.get('x-api-key');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        return json(data, r.status);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Unknown action', availableActions: ['postcode-lookup','postcode-autocomplete','postcodes-radius','sold-prices-v2','nearby-sold','rental-estimate'] }, 400);
  }
};
