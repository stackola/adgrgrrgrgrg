# Finding the BTC "Price to Beat" ($104,874.71)

## Problem
The actual BTC dollar price shown as "price to beat" on Polymarket is NOT appearing in our API response logs.

## What We've Tried
1. ✅ Gamma API market endpoints - only return market probability prices (0.505, 0.495)
2. ✅ CLOB API trade endpoints - return trade data but not reference price
3. ❌ Various price endpoints (all returned 404)
4. ❌ Condition/ancillary data endpoints (all returned 404)
5. ❌ External price APIs (CoinGecko, Coinbase, Binance) - not logged yet

## Likely Sources
The "price to beat" is the BTC price **at market start time** (13:15:00 UTC / 8:15 AM ET).

This could be:
1. **Frontend JavaScript** - Fetched dynamically via AJAX/Fetch when page loads
2. **GraphQL API** - Polymarket might use GraphQL for some data
3. **WebSocket (RTDS)** - Real Time Data Socket at wss://ws-realtime-data.polymarket.com
4. **Server-Side Rendered** - Embedded directly in the HTML
5. **Blockchain/Oracle Data** - Read from smart contract or Chainlink oracle
6. **UMA Ancillary Data** - Stored in the UMA optimistic oracle system

## How to Find It
**Option 1: Browser DevTools (RECOMMENDED)**
1. Open https://polymarket.com/event/btc-updown-15m-1762953300 in browser
2. Open DevTools (F12) → Network tab
3. Refresh page and look for:
   - XHR/Fetch requests containing the price
   - WebSocket messages
   - GraphQL queries
4. Filter by "104874" or similar to find the request

**Option 2: Inspect Page Source**
- View page source and search for "104874" or "price to beat"
- Check if it's embedded in HTML or a `<script>` tag

**Option 3: Reverse Engineer Frontend**
- Download and examine Polymarket's JavaScript bundles
- Look for price-fetching code

## Next Steps
User should inspect the Polymarket page in their browser to identify the exact API endpoint or data source.
