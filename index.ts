// index.ts (ESM, TypeScript-friendly)
// npm i ws undici chalk
import { WebSocket } from "ws";
import { fetch } from "undici";
import chalk from "chalk";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

function getCurrent15mMarketUrl() {
  // current UTC time in seconds
  const now = Math.floor(Date.now() / 1000);

  // 15 minutes = 900 seconds
  const aligned = Math.floor(now / 900) * 900;

  // Polymarket BTC 15m event base (example pattern)
  const base = "https://polymarket.com/event/btc-updown-15m";

  // create a random but deterministic-looking tid (like in your example)
  const tid = aligned * 10 + Math.floor(Math.random() * 999);

  return `${base}-${aligned}?tid=${tid}`;
}

// Example:
console.log(getCurrent15mMarketUrl());
// ================== CONFIG ==================
const FRONTEND_URL = getCurrent15mMarketUrl();

const DEBUG_LOG_FILE = join(process.cwd(), "btc_price_debug.log");
const SIM_LOG_FILE = join(process.cwd(), "sim_trades.log");
const chainlinkCache = new Map<string, { price: number; ts: number }>();
const startingPriceCache = new Map<string, { price: number | null; source: string; ts: number }>();
let lastBtcPrice: number | null = null;
let lastBtcPriceTs = 0;
let btcPriceRequest: Promise<number | null> | null = null;

class AsyncLogWriter {
  private buffer: string[] = [];
  private flushing = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly file: string,
    private readonly flushIntervalMs = 250,
    private readonly maxBatchBytes = 16_384,
  ) {}

  write(chunk: string) {
    this.buffer.push(chunk);
    const bufferedBytes = this.buffer.reduce((total, part) => total + Buffer.byteLength(part), 0);
    if (bufferedBytes >= this.maxBatchBytes) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      const timeout = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushIntervalMs);
      timeout.unref?.();
      this.timer = timeout;
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const payload = this.buffer.join("");
    this.buffer = [];
    this.flushing = true;
    try {
      await appendFile(this.file, payload);
    } catch (err) {
      console.error(`Failed to append ${this.file}:`, err);
    } finally {
      this.flushing = false;
      if (this.buffer.length) {
        void this.flush();
      }
    }
  }
}

const debugLogWriter = new AsyncLogWriter(DEBUG_LOG_FILE);
const simLogWriter = new AsyncLogWriter(SIM_LOG_FILE);

async function flushLogWriters() {
  await Promise.allSettled([debugLogWriter.flush(), simLogWriter.flush()]);
}

process.on("beforeExit", () => {
  void flushLogWriters();
});

// WS endpoint: base path (no trailing /market)
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Heartbeat & reconnection
const HEARTBEAT_SEC = 20;               // if no book/price/trade in this many seconds, reconnect
const PING_EVERY_MS = 10_000;           // server keepalive
const UI_RENDER_MS = 500;               // reduce UI frequency to avoid blocking fast logic
const BTC_POLL_MS = 100;                // HIGH FREQUENCY: 100ms polling for sub-second scalping
const EXPIRY_CHECK_MS = 5_000;
const RECONNECT_BASE_MS = 1_000;        // backoff base
const RECONNECT_MAX_MS = 15_000;        // backoff cap
const BTC_HISTORY_MAX = 2000;           // 2000 samples @ 100ms = 200 seconds of history
const CHAINLINK_CACHE_TTL_MS = 60_000;
const STARTING_PRICE_CACHE_TTL_MS = 60_000;
const BTC_PRICE_CACHE_TTL_MS = 750;

// ----------------- logging helper -----------------
function logApiResponse(endpoint: string, response: any, context = "") {
  const timestamp = new Date().toISOString();
  let body = "";
  try {
    body = JSON.stringify(response, null, 2);
  } catch {
    body = String(response);
  }
  const logLine = `${timestamp} [${context}] ${endpoint}\n${body}\n${"-".repeat(80)}\n`;
  debugLogWriter.write(logLine);
}

// Dedicated simulator logger (JSON Lines)
function logSim(event: any) {
  try {
    const line = JSON.stringify(
      {
        ts: new Date().toISOString(),
        ...event,
      },
      null,
      2
    );
    simLogWriter.write(line + "\n");
  } catch {}
}

// ----------------- utilities -----------------
const slugFromUrl = (url: string) => {
  const m = url.match(/\/(?:event|market)\/([^/?#]+)/i);
  if (!m) throw new Error("No slug found in URL");
  return decodeURIComponent(m[1]);
};

function normalizeAssetIds(raw: unknown): string[] {
  const out: string[] = [];
  const pushMaybe = (s: unknown) => {
    if (!s) return;
    if (typeof s === "string") {
      const trimmed = s.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try { const arr = JSON.parse(trimmed); if (Array.isArray(arr)) arr.forEach(pushMaybe); return; } catch {}
      }
      const m = trimmed.match(/(\d{18,})/); // accept 18+ digits; polymarket token ids are long decimal strings
      if (m) out.push(m[1]);
    } else if (Array.isArray(s)) {
      s.forEach(pushMaybe);
    } else if (typeof s === "object" && s) {
      Object.values(s as Record<string, unknown>).forEach(pushMaybe);
    }
  };
  pushMaybe(raw);
  // stable order: numeric compare by length then lexicographic
  const uniq = [...new Set(out)];
  uniq.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  return uniq;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 3_000): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOutcomeLabel(raw: unknown): "Up" | "Down" | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/\b(up|yes|over|above|greater|>=|higher)\b/.test(normalized)) return "Up";
  if (/\b(down|no|under|below|less|<=|lower)\b/.test(normalized)) return "Down";
  return undefined;
}

function extractTokenOutcome(token: any): "Up" | "Down" | undefined {
  if (!token || typeof token !== "object") return undefined;
  if (typeof token.is_yes === "boolean") return token.is_yes ? "Up" : "Down";
  if (typeof token.is_up === "boolean") return token.is_up ? "Up" : "Down";
  const fields = [
    token.outcome,
    token.outcomeName,
    token.outcome_name,
    token.outcomeLabel,
    token.name,
    token.ticker,
    token.symbol,
    token.side,
    token.title,
  ];
  for (const field of fields) {
    const normalized = normalizeOutcomeLabel(field);
    if (normalized) return normalized;
  }
  if (typeof token.side === "string") {
    const normalized = normalizeOutcomeLabel(token.side);
    if (normalized) return normalized;
  }
  return undefined;
}

function collectTokenOutcomes(
  source: any,
  target: Record<string, "Up" | "Down">,
) {
  if (!source) return;
  const entries = Array.isArray(source) ? source : [source];
  for (const entry of entries) {
    if (!entry) continue;
    if (Array.isArray(entry.tokens)) {
      collectTokenOutcomes(entry.tokens, target);
      continue;
    }
    const ids = normalizeAssetIds(
      entry?.clobTokenId ??
      entry?.clob_token_id ??
      entry?.token_id ??
      entry?.tokenId ??
      entry?.id ??
      entry
    );
    if (!ids.length) continue;
    const outcome = extractTokenOutcome(entry);
    if (outcome) {
      for (const id of ids) {
        target[id] = outcome;
      }
    }
  }
}

function parseOutcomeStrings(raw: any): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v) => typeof v === "string").map((v) => v as string);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v) => typeof v === "string").map((v) => v as string);
      }
    } catch {}
    return raw.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

async function tryGammaForTokenIds(slug: string): Promise<{ assetIds: string[]; marketId?: string; marketObj?: any; tokenOutcomes?: Record<string, "Up" | "Down"> }> {
  // 1) market-by-slug
  try {
    const endpoint = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    const r = await fetch(endpoint);
    if (r.ok) {
      const mk = await r.json();
      logApiResponse(endpoint, mk, "MARKET_BY_SLUG - Could contain starting price info");
      const raw = mk?.clobTokenIds ?? mk?.clob_token_ids ?? mk?.tokens?.map((t: any) => t?.token_id ?? t?.tokenId ?? t?.id) ?? mk;
      const ids = normalizeAssetIds(raw);
      if (ids.length >= 2) {
        const tokenOutcomes: Record<string, "Up" | "Down"> = {};
        collectTokenOutcomes(mk, tokenOutcomes);
        collectTokenOutcomes(mk?.condition, tokenOutcomes);
        collectTokenOutcomes(mk?.markets, tokenOutcomes);
        if (Array.isArray(mk?.markets)) {
          for (const market of mk.markets) {
            collectTokenOutcomes(market?.condition, tokenOutcomes);
          }
        }

        if (Object.keys(tokenOutcomes).length < ids.length) {
          const outcomesList = parseOutcomeStrings(mk?.outcomes ?? mk?.outcomeLabels ?? mk?.outcome_labels);
          if (outcomesList.length === ids.length) {
            outcomesList.forEach((label, index) => {
              const outcome = normalizeOutcomeLabel(label);
              if (outcome) tokenOutcomes[ids[index]] = outcome;
            });
          }
        }

        if (Object.keys(tokenOutcomes).length < ids.length && Array.isArray(mk?.tokens)) {
          mk.tokens.forEach((token: any, index: number) => {
            const outcome = extractTokenOutcome(token);
            const idCandidates = normalizeAssetIds(
              token?.clobTokenId ?? token?.clob_token_id ?? token?.token_id ?? token?.tokenId ?? token?.id
            );
            const targetId = idCandidates[0] ?? ids[index];
            if (targetId && outcome) tokenOutcomes[targetId] = outcome;
          });
        }

        if (Object.keys(tokenOutcomes).length === 0) {
          console.warn(chalk.yellow("Warning: Unable to confidently map token IDs to outcomes."));
        } else {
          console.log("\n" + chalk.bgYellow.black(" TOKEN MAPPING " ));
          ids.forEach((id, idx) => {
            const outcome = tokenOutcomes[id] ?? "?";
            console.log(chalk.cyan(`  [${idx}] ${id.slice(0, 12)}...${id.slice(-12)} → ${outcome}`));
          });
        }

        return { assetIds: ids, marketId: mk?.id, marketObj: mk, tokenOutcomes };
      }
    }
  } catch {}

  // 2) event-by-slug
  try {
    const endpoint2 = `https://gamma-api.polymarket.com/events/slug/${slug}`;
    const r2 = await fetch(endpoint2);
    if (r2.ok) {
      const ev = await r2.json();
      logApiResponse(endpoint2, ev, "EVENT_BY_SLUG - Could contain starting price info");
      const bag: string[] = [];
      for (const m of ev?.markets ?? []) {
        const raw = m?.clobTokenIds ?? m?.clob_token_ids ?? m?.tokens?.map((t: any) => t?.token_id ?? t?.tokenId ?? t?.id) ?? m;
        bag.push(...normalizeAssetIds(raw));
      }
      const uniq = [...new Set(bag)];
      if (uniq.length >= 2) return { assetIds: uniq, marketObj: ev };
    }
  } catch {}

  // 3) gamma search -> market by id
  try {
    const qs = new URLSearchParams({ q: slug, limit_per_type: "5", keep_closed_markets: "1" });
    const endpoint3 = `https://gamma-api.polymarket.com/search?${qs.toString()}`;
    const r3 = await fetch(endpoint3);
    if (r3.ok) {
      const res = await r3.json();
      logApiResponse(endpoint3, res, "GAMMA_SEARCH - Could contain starting price info");
      const cand = (res?.markets ?? [])[0];
      if (cand?.id) {
        const endpoint4 = `https://gamma-api.polymarket.com/markets/${cand.id}`;
        const r4 = await fetch(endpoint4);
        if (r4.ok) {
          const mk = await r4.json();
          logApiResponse(endpoint4, mk, "MARKET_BY_ID - Could contain starting price info");
          const raw = mk?.clobTokenIds ?? mk?.clob_token_ids ?? mk?.tokens?.map((t: any) => t?.token_id ?? t?.tokenId ?? t?.id) ?? mk;
          const ids = normalizeAssetIds(raw);
          if (ids.length >= 2) return { assetIds: ids, marketId: mk?.id, marketObj: mk };
        }
      }
    }
  } catch {}

  return { assetIds: [], marketId: undefined, marketObj: undefined };
}

// ----------------- BTC price fetching -----------------
async function fetchChainlinkPrice(
  conditionId?: string,
  slug?: string,
  eventStartTime?: string,
  endDate?: string,
): Promise<number | null> {
  const cacheKey = [conditionId ?? "", slug ?? "", eventStartTime ?? "", endDate ?? ""].join("|");
  const cached = chainlinkCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < CHAINLINK_CACHE_TTL_MS) {
    return cached.price;
  }

  const endpoints: string[] = [];

  if (eventStartTime && endDate) {
    endpoints.push(
      `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${encodeURIComponent(eventStartTime)}&variant=fifteen&endDate=${encodeURIComponent(endDate)}`
    );
  }

  endpoints.push(
    "https://data-api.polymarket.com/prices/btc",
    "https://clob.polymarket.com/prices/btc",
    "https://gamma-api.polymarket.com/prices/btc",
    "https://gamma-api.polymarket.com/prices/crypto/btc",
    "https://data-api.polymarket.com/crypto-prices/btc"
  );

  if (conditionId) {
    endpoints.push(
      `https://gamma-api.polymarket.com/conditions/${conditionId}/price`,
      `https://data-api.polymarket.com/conditions/${conditionId}`,
      `https://gamma-api.polymarket.com/ancillary/${conditionId}`
    );
  }
  if (slug) {
    endpoints.push(
      `https://gamma-api.polymarket.com/markets/${slug}/reference-price`,
      `https://gamma-api.polymarket.com/markets/${slug}/ancillary`
    );
  }

  endpoints.push(
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
  );

  const uniqueEndpoints = [...new Set(endpoints)];

  const requests = uniqueEndpoints.map(async (endpoint) => {
    const data = await fetchJsonWithTimeout(endpoint, 4_000);
    if (!data) return null;
    logApiResponse(endpoint, data, "BTC_REFERENCE_PRICE_ENDPOINT");

    let price: unknown =
      (data as any)?.openPrice ??
      (data as any)?.startPrice ?? (data as any)?.start_price ??
      (data as any)?.priceAtStart ?? (data as any)?.initialPrice ??
      (data as any)?.price ?? (data as any)?.btc ?? (data as any)?.value ??
      (data as any)?.answer ?? (data as any)?.current ?? (data as any)?.referencePrice ??
      (data as any)?.ancillaryData;

    if ((data as any)?.bitcoin?.usd) price = (data as any).bitcoin.usd;
    if ((data as any)?.data?.amount) price = Number((data as any).data.amount);
    if ((data as any)?.price && typeof (data as any).price === "string") {
      price = Number((data as any).price);
    }

    const numeric = typeof price === "number" ? price : Number(price);
    return Number.isFinite(numeric) ? numeric : null;
  });

  const responses = await Promise.allSettled(requests);
  for (const response of responses) {
    if (response.status === "fulfilled" && typeof response.value === "number" && Number.isFinite(response.value)) {
      chainlinkCache.set(cacheKey, { price: response.value, ts: Date.now() });
      return response.value;
    }
  }

  return cached?.price ?? null;
}

// ----------------- starting price discovery -----------------
async function fetchStartingPrice(
  marketObj: any,
  marketId: string | undefined,
  assetIds: string[],
): Promise<{ price: number | null; source: string }> {
  const cacheKey = marketId ?? marketObj?.slug ?? assetIds.join(",");
  const cached = cacheKey ? startingPriceCache.get(cacheKey) : undefined;
  if (cached && Date.now() - cached.ts < STARTING_PRICE_CACHE_TTL_MS) {
    return { price: cached.price, source: cached.source };
  }

  const remember = (price: number | null, source: string) => {
    if (cacheKey) {
      startingPriceCache.set(cacheKey, { price, source, ts: Date.now() });
    }
    return { price, source };
  };

  if (marketObj) {
    for (const key of [
      "opening_price",
      "starting_price",
      "openingPrice",
      "start_price",
      "initial_price",
      "initialMarkPrice",
      "initial_mark_price",
    ]) {
      const value = marketObj[key];
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric) && numeric > 0) {
        return remember(numeric, `gamma.market.${key}`);
      }
    }
  }

  const tradeRequests: Array<Promise<{ price: number; source: string } | null>> = [];

  if (marketId) {
    const endpoint = `https://clob.polymarket.com/markets/${marketId}/trades?limit=1&sort=asc`;
    tradeRequests.push(
      (async () => {
        const data = await fetchJsonWithTimeout(endpoint, 4_000);
        if (!data) return null;
        logApiResponse(endpoint, data, "EARLIEST_TRADE_BY_MARKET");
        const arr = data?.data ?? data;
        if (!Array.isArray(arr) || !arr.length) return null;
        const value = Number(arr[0]?.price ?? arr[0]?.px ?? arr[0]?.price_decimal ?? arr[0]?.priceUsd);
        return Number.isFinite(value) ? { price: value, source: "clob.market.trades.earliest" } : null;
      })(),
    );
  }

  for (const aid of assetIds) {
    const endpoint = `https://clob.polymarket.com/trades?asset_id=${encodeURIComponent(aid)}&limit=1&sort=asc`;
    tradeRequests.push(
      (async () => {
        const data = await fetchJsonWithTimeout(endpoint, 4_000);
        if (!data) return null;
        logApiResponse(endpoint, data, `EARLIEST_TRADE_BY_ASSET ${aid}`);
        const arr = data?.data ?? data;
        if (!Array.isArray(arr) || !arr.length) return null;
        const value = Number(arr[0]?.price ?? arr[0]?.px ?? arr[0]?.price_decimal ?? arr[0]?.priceUsd);
        return Number.isFinite(value) ? { price: value, source: `clob.asset.${aid}.earliest` } : null;
      })(),
    );
  }

  if (tradeRequests.length) {
    const trades = await Promise.allSettled(tradeRequests);
    for (const trade of trades) {
      if (trade.status === "fulfilled" && trade.value) {
        return remember(trade.value.price, trade.value.source);
      }
    }
  }

  if (marketObj?.slug) {
    const endpoint = `https://gamma-api.polymarket.com/markets/slug/${marketObj.slug}`;
    const mk2 = await fetchJsonWithTimeout(endpoint, 4_000);
    if (mk2) {
      logApiResponse(endpoint, mk2, "MARKET_MID_PRICE_FALLBACK");
      const mid = Number(mk2?.mid_price ?? mk2?.mid ?? mk2?.current_mid);
      if (!Number.isNaN(mid) && Number.isFinite(mid)) {
        return remember(mid, "gamma.mid");
      }
    }
  }

  return remember(null, "none_found");
}

// ----------------- console UI -----------------
type TopBook = { bid?: { px: number; sz?: number }; ask?: { px: number; sz?: number }; outcome?: string };
type Position = { side: "Up" | "Down"; size: number; entryPrice: number; entryTime: number; tokenId: string };
type SimTrade = { time: number; action: "BUY" | "SELL"; side: "Up" | "Down"; price: number; size: number; pnl?: number; reason: string };
type SimState = {
  position: Position | null;
  trades: SimTrade[];
  totalPnl: number;
  cash: number;
};
type Fill = { px: number; sz: number; fee: number };
type FeeModel = { takerBps: number };
const FEE: FeeModel = { takerBps: 200 }; // 2.00% taker fee
type Trade = { ts: number; px: number; sz?: number; side?: "buy" | "sell" | string };
type BtcPriceSample = { ts: number; price: number; hrts: number }; // hrts = high-res timestamp for microsecond precision
type BtcMetrics = {
  current: number;
  // Sub-second changes for scalping
  change100ms: number | null;
  change250ms: number | null;
  change500ms: number | null;
  // Second-level changes
  change1s: number | null;
  change5s: number | null;
  change30s: number | null;
  // Statistical measures
  volatility: number | null;   // standard deviation over last 5s
  volatility30s: number | null; // std dev over 30s
  trend: number | null;        // linear regression slope ($ per second)
  // Rate of change (velocity)
  roc100ms: number | null;     // % change per 100ms
  roc1s: number | null;        // % change per second
};

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function formatMoney(n: number | null) {
  if (n == null) return chalk.gray("—");
  if (!Number.isFinite(n)) return chalk.gray("—");
  return n >= 1000 ? n.toFixed(2) : (n >= 1 ? n.toFixed(4) : n.toPrecision(6));
}

function formatPrice(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(4);
}

function formatSize(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return "?";
  return n.toFixed(1);
}

function renderUI(state: {
  marketSlug: string;
  marketId?: string;
  startingPrice: number | null;
  startingPriceSource: string;
  btcReferencePrice: number | null;
  currentBtcPrice: number | null;
  btcMetrics: BtcMetrics | null;
  btcHistory: BtcPriceSample[];
  topBooks: Record<string, TopBook>;
  mid: number | null;
  spreadPct: number | null;
  trades: Trade[];
  log: string[];
  status: string;
  eventStartTime?: string;
  endDate?: string;
  simState: SimState;
}) {
  clearScreen();
  const cols = Math.max(80, process.stdout.columns ?? 120);
  const col1w = Math.floor(cols * 0.30);
  const col2w = Math.floor(cols * 0.40);
  const col3w = cols - col1w - col2w - 4;

  const left: string[] = [];
  left.push(chalk.bgBlack.white.bold(" H A C K E R S - C O N S O L E "));
  left.push("");
  left.push(chalk.bold("Market: ") + chalk.cyan(state.marketSlug));
  left.push(chalk.bold("MarketId: ") + chalk.gray(state.marketId ?? "—"));
  left.push("");
  left.push(chalk.bold("BTC Price to Beat: ") + chalk.yellow(state.btcReferencePrice ? `$${formatMoney(state.btcReferencePrice)}` : "$—"));
  left.push(chalk.bold("Current BTC Price: ") + chalk.green(state.currentBtcPrice ? `$${formatMoney(state.currentBtcPrice)}` : "$—"));
  
  // BTC metrics for modeling (scalping-focused)
  if (state.btcMetrics) {
    const m = state.btcMetrics;
    const delta = state.btcReferencePrice && state.currentBtcPrice ? state.currentBtcPrice - state.btcReferencePrice : null;
    if (delta !== null) {
      const color = delta >= 0 ? chalk.green : chalk.red;
      left.push(chalk.bold("BTC vs Start: ") + color(`${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`) + color(` (${((delta / state.btcReferencePrice!) * 100).toFixed(3)}%))`));
    }
    // SUB-SECOND CHANGES (key for scalping)
    if (m.change100ms !== null) {
      const color = Math.abs(m.change100ms) > 1 ? chalk.yellow : chalk.dim;
      left.push(color(`  Δ100ms: ${m.change100ms >= 0 ? "+" : ""}$${m.change100ms.toFixed(3)}${m.roc100ms !== null ? ` (${m.roc100ms.toFixed(4)}%)` : ""}`));
    }
    if (m.change250ms !== null) left.push(chalk.dim(`  Δ250ms: ${m.change250ms >= 0 ? "+" : ""}$${m.change250ms.toFixed(2)}`));
    if (m.change500ms !== null) left.push(chalk.dim(`  Δ500ms: ${m.change500ms >= 0 ? "+" : ""}$${m.change500ms.toFixed(2)}`));
    if (m.change1s !== null) left.push(chalk.dim(`  Δ1s: ${m.change1s >= 0 ? "+" : ""}$${m.change1s.toFixed(2)}${m.roc1s !== null ? ` (${m.roc1s.toFixed(3)}%)` : ""}`));
    if (m.trend !== null) left.push(chalk.dim(`  Trend: ${m.trend >= 0 ? "+" : ""}$${m.trend.toFixed(4)}/s`));
    if (m.volatility !== null) left.push(chalk.dim(`  Vol(5s): $${m.volatility.toFixed(2)}`));
  }
  left.push("");
  left.push(chalk.bold("Starting Price: ") + chalk.yellow(formatMoney(state.startingPrice)));
  left.push(chalk.dim(`(source: ${state.startingPriceSource})`));
  left.push("");
  left.push(chalk.bold("Mid: ") + chalk.green(formatMoney(state.mid)));
  left.push(chalk.bold("Spread: ") + (state.spreadPct == null || !Number.isFinite(state.spreadPct) ? chalk.gray("—") : chalk.red(state.spreadPct.toFixed(3) + "%")));
  left.push("");
  left.push(chalk.bold("Status: ") + chalk.magenta(state.status));
  left.push(chalk.dim(`BTC samples: ${state.btcHistory.length}`));
  left.push("");
  left.push(chalk.italic.dim("Press Ctrl+C to quit"));

  const center: string[] = [];
  center.push(chalk.underline(" ORDERBOOK (top) "));
  center.push("");
  const sortedBooks = Object.entries(state.topBooks).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [token, tb] of sortedBooks) {
    const outcome = tb.outcome ?? "Unknown";
    const outcomeLabel = outcome === "Up" ? chalk.green("⬆ UP") : outcome === "Down" ? chalk.red("⬇ DOWN") : outcome;
    center.push(chalk.bold(outcomeLabel));
    
    const bidPx = tb.bid?.px;
    const bidSz = tb.bid?.sz;
    const askPx = tb.ask?.px;
    const askSz = tb.ask?.sz;
    
    const b = bidPx != null && Number.isFinite(bidPx) ? `${formatPrice(bidPx)} @ ${formatSize(bidSz)}` : chalk.gray("—");
    const a = askPx != null && Number.isFinite(askPx) ? `${formatPrice(askPx)} @ ${formatSize(askSz)}` : chalk.gray("—");
    center.push(`  ${chalk.green("B")} ${b}    ${chalk.red("A")} ${a}`);
    center.push("");
  }
  
  // Trading Simulator Status
  center.push(chalk.underline(" SIMULATOR "));
  center.push("");
  const sim = state.simState;
  if (sim.position) {
    const p = sim.position;
    const currentBook = state.topBooks[p.tokenId];
    const currentPrice = currentBook?.bid?.px ?? p.entryPrice;
    const unrealizedPnl = (currentPrice - p.entryPrice) * p.size;
    const color = unrealizedPnl >= 0 ? chalk.green : chalk.red;
    center.push(chalk.bold("Position:") + ` ${p.side} x${p.size}`);
    center.push(`  Entry: ${formatPrice(p.entryPrice)}`);
    center.push(`  Current: ${formatPrice(currentPrice)}`);
    center.push(color(`  Unrealized: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`));
  } else {
    center.push(chalk.dim("No position"));
  }
  center.push("");
  center.push(chalk.bold("Cash: ") + chalk.yellow(`$${sim.cash.toFixed(2)}`));
  const pnlColor = sim.totalPnl >= 0 ? chalk.green : chalk.red;
  center.push(chalk.bold("Total PnL: ") + pnlColor(`${sim.totalPnl >= 0 ? "+" : ""}$${sim.totalPnl.toFixed(2)}`));
  center.push(chalk.dim(`Trades: ${sim.trades.length}`));

  const right: string[] = [];
  right.push(chalk.underline(" SIM TRADES "));
  right.push("");
  const maxSimTrades = 12;
  const simTrades = state.simState.trades.slice(-maxSimTrades).reverse();
  for (let i = 0; i < maxSimTrades; i++) {
    if (i < simTrades.length) {
      const t = simTrades[i];
      const time = new Date(t.time).toISOString().substring(11, 19);
      const action = t.action === "BUY" ? chalk.green("BUY ") : chalk.red("SELL");
      const pnlStr = t.pnl != null ? (t.pnl >= 0 ? chalk.green(` +$${t.pnl.toFixed(2)}`) : chalk.red(` -$${Math.abs(t.pnl).toFixed(2)}`)) : "";
      right.push(`${chalk.dim(time)} ${action} ${chalk.cyan(t.side)} ${chalk.yellow(formatPrice(t.price))}${pnlStr}`);
      right.push(chalk.dim(`  ${t.reason}`));
    } else {
      right.push("");
    }
  }

  const maxLines = Math.max(left.length, center.length, right.length);
  for (let i = 0; i < maxLines; i++) {
    const a = (left[i] ?? "").padEnd(col1w).slice(0, col1w);
    const b = (center[i] ?? "").padEnd(col2w).slice(0, col2w);
    const c = (right[i] ?? "").padEnd(col3w).slice(0, col3w);
    console.log(a + "  " + b + "  " + c);
  }

  console.log("");
  console.log(chalk.dim("Recent:"));
  const recent = state.log.slice(-4);
  for (const l of recent) console.log("  " + chalk.dim(l));
}

// ----------------- BTC price metrics calculation (optimized for scalping) -----------------
function calculateBtcMetrics(history: BtcPriceSample[], current: number): BtcMetrics {
  const now = Date.now();
  const metrics: BtcMetrics = {
    current,
    change100ms: null,
    change250ms: null,
    change500ms: null,
    change1s: null,
    change5s: null,
    change30s: null,
    volatility: null,
    volatility30s: null,
    trend: null,
    roc100ms: null,
    roc1s: null,
  };

  if (!history.length) return metrics;

  // Fast lookup: find price at various time offsets (optimized for speed)
  const find = (msAgo: number) => {
    const targetTs = now - msAgo;
    let lo = 0;
    let hi = history.length - 1;
    let candidate: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const sample = history[mid];
      if (sample.ts <= targetTs) {
        candidate = sample.price;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return candidate;
  };

  // SUB-SECOND METRICS (critical for scalping)
  const price100msAgo = find(100);
  const price250msAgo = find(250);
  const price500msAgo = find(500);
  const price1sAgo = find(1000);
  const price5sAgo = find(5000);
  const price30sAgo = find(30000);

  if (price100msAgo !== null) {
    metrics.change100ms = current - price100msAgo;
    metrics.roc100ms = ((current - price100msAgo) / price100msAgo) * 100;
  }
  if (price250msAgo !== null) metrics.change250ms = current - price250msAgo;
  if (price500msAgo !== null) metrics.change500ms = current - price500msAgo;
  if (price1sAgo !== null) {
    metrics.change1s = current - price1sAgo;
    metrics.roc1s = ((current - price1sAgo) / price1sAgo) * 100;
  }
  if (price5sAgo !== null) metrics.change5s = current - price5sAgo;
  if (price30sAgo !== null) metrics.change30s = current - price30sAgo;

  // Short-term volatility (last 5 seconds = ~50 samples @ 100ms)
  const shortSamples = history.slice(-50);
  if (shortSamples.length >= 10) {
    const prices = shortSamples.map(s => s.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    metrics.volatility = Math.sqrt(variance);
  }

  // Long-term volatility (30s)
  const longSamples = history.slice(-300); // 300 samples @ 100ms = 30s
  if (longSamples.length >= 50) {
    const prices = longSamples.map(s => s.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    metrics.volatility30s = Math.sqrt(variance);
  }

  // Trend (linear regression over last 10s for faster reaction)
  const trendSamples = history.filter(s => s.ts >= now - 10000);
  if (trendSamples.length >= 20) {
    const n = trendSamples.length;
    const sumT = trendSamples.reduce((sum, s) => sum + (s.ts - now), 0);
    const sumP = trendSamples.reduce((sum, s) => sum + s.price, 0);
    const sumTP = trendSamples.reduce((sum, s) => sum + (s.ts - now) * s.price, 0);
    const sumT2 = trendSamples.reduce((sum, s) => sum + Math.pow(s.ts - now, 2), 0);
    const slope = (n * sumTP - sumT * sumP) / (n * sumT2 - sumT * sumT);
    metrics.trend = slope * 1000; // $/second
  }

  return metrics;
}

// ----------------- BTC price polling -----------------
async function fetchLatestBtcPrice(): Promise<number | null> {
  const sources: Array<{ url: string; extractor: (data: any) => number | null }> = [
    {
      url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      extractor: (data) => {
        const value = Number(data?.price);
        return Number.isFinite(value) ? value : null;
      },
    },
    {
      url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      extractor: (data) => {
        const value = Number(data?.data?.amount);
        return Number.isFinite(value) ? value : null;
      },
    },
    {
      url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      extractor: (data) => {
        const value = Number(data?.bitcoin?.usd);
        return Number.isFinite(value) ? value : null;
      },
    },
  ];

  for (const source of sources) {
    const data = await fetchJsonWithTimeout(source.url, 2_500);
    if (!data) continue;
    const value = source.extractor(data);
    if (value != null) {
      logApiResponse(source.url, data, "BTC_POLL");
      return value;
    }
  }
  return null;
}

async function pollCurrentBtcPrice(): Promise<number | null> {
  const now = Date.now();
  if (lastBtcPrice !== null && now - lastBtcPriceTs < BTC_PRICE_CACHE_TTL_MS) {
    return lastBtcPrice;
  }

  if (!btcPriceRequest) {
    btcPriceRequest = (async () => {
      const fresh = await fetchLatestBtcPrice();
      if (fresh != null) {
        lastBtcPrice = fresh;
        lastBtcPriceTs = Date.now();
        return fresh;
      }
      return lastBtcPrice;
    })().finally(() => {
      btcPriceRequest = null;
    });
  }

  const result = await btcPriceRequest;
  return result ?? lastBtcPrice;
}

// Calculate next 15m market slug based on current one
function getNext15MinSlug(currentSlug: string): string | null {
  const match = currentSlug.match(/btc-updown-15m-(\d+)/);
  if (!match) return null;
  const currentTimestamp = parseInt(match[1], 10);
  if (!Number.isFinite(currentTimestamp)) return null;
  const nextTimestamp = currentTimestamp + 900;
  return `btc-updown-15m-${nextTimestamp}`;
}

// ----------------- Orchestration -----------------
type Timer = { id: NodeJS.Timeout; label: string };
class RunContext {
  timers: Timer[] = [];
  ws?: WebSocket;
  aborted = false;
  lastSignalSec = Math.floor(Date.now() / 1000);

  addTimer(id: NodeJS.Timeout, label: string) {
    this.timers.push({ id, label });
  }
  clearAll() {
    for (const t of this.timers) clearInterval(t.id);
    this.timers = [];
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try { this.ws.close(); } catch {}
    }
  }
}

async function main() {
  let currentUrl = FRONTEND_URL;
  let tries = 0;

  for (;;) {
    try {
      await runMarket(currentUrl);
      // normal return means stop (shouldn’t happen); enforce rotation
      const slug = slugFromUrl(currentUrl);
      const nextSlug = getNext15MinSlug(slug);
      if (!nextSlug) break;
      currentUrl = `https://polymarket.com/event/${nextSlug}`;
      tries = 0;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("MARKET_EXPIRED")) {
        const slug = slugFromUrl(currentUrl);
        const nextSlug = getNext15MinSlug(slug);
        if (nextSlug) {
          console.log(chalk.yellow(`\nMarket expired. Switching to next 15m window: ${nextSlug}\n`));
          currentUrl = `https://polymarket.com/event/${nextSlug}`;
          tries = 0;
          continue;
        }
      }
      // reconnect/backoff
      tries++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (tries - 1), RECONNECT_MAX_MS);
      console.log(chalk.red(`Error: ${msg}. Reconnecting in ${Math.round(delay)} ms...`));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ----------------- Trading Simulator -----------------
function takerFee(notional: number): number {
  return Math.max(0, (FEE.takerBps / 10_000) * notional);
}

function topOfBookFill(bookSide: { px: number; sz?: number } | undefined, want: number): Fill | null {
  if (!bookSide?.px || !Number.isFinite(bookSide.px)) return null;
  const avail = Math.max(0, Number(bookSide.sz ?? 0));
  const sz = Math.min(want, avail);
  if (sz <= 0) return null;
  const notional = bookSide.px * sz;
  return { px: bookSide.px, sz, fee: takerFee(notional) };
}

function createSimulator(startingCash: number): SimState {
  return {
    position: null,
    trades: [],
    totalPnl: 0,
    cash: startingCash,
  };
}

function simulateTrade(
  sim: SimState,
  action: "BUY" | "SELL",
  side: "Up" | "Down",
  price: number,
  size: number,
  tokenId: string,
  reason: string,
  fee: number = 0
): boolean {
  const now = Date.now();
  
  if (action === "BUY") {
    if (sim.position) return false; // Already have position
    const cost = price * size + fee;
    if (sim.cash < cost) return false; // Not enough cash
    
    sim.position = { side, size, entryPrice: price, entryTime: now, tokenId };
    sim.cash -= cost;
    sim.trades.push({ time: now, action, side, price, size, reason });
    return true;
  } else {
    if (!sim.position) return false; // No position to sell
    const pos = sim.position;
    
    const proceeds = price * pos.size - fee;
    const pnl = proceeds - (pos.entryPrice * pos.size);
    
    sim.cash += proceeds;
    sim.totalPnl += pnl;
    sim.trades.push({ time: now, action, side: pos.side, price, size: pos.size, pnl, reason });
    sim.position = null;
    return true;
  }
}

// Trading logic: when to enter/exit
function evaluateTradingSignals(
  sim: SimState,
  btcMetrics: BtcMetrics | null,
  btcReferencePrice: number | null,
  topBooks: Record<string, TopBook>
): { action: "BUY" | "SELL" | null; side: "Up" | "Down" | null; reason: string } {
  if (!btcMetrics || !btcReferencePrice) return { action: null, side: null, reason: "No data" };
  
  const btcDelta = btcMetrics.current - btcReferencePrice;
  const btcPctChange = (btcDelta / btcReferencePrice) * 100;
  
  // Find Up and Down books
  let upBook: TopBook | null = null;
  let downBook: TopBook | null = null;
  let upTokenId = "";
  let downTokenId = "";
  
  for (const [tokenId, book] of Object.entries(topBooks)) {
    if (book.outcome === "Up") { upBook = book; upTokenId = tokenId; }
    if (book.outcome === "Down") { downBook = book; downTokenId = tokenId; }
  }
  
  if (!upBook || !downBook) return { action: null, side: null, reason: "Missing books" };
  
  // ENTRY SIGNALS
  if (!sim.position) {
    // Realistic momentum thresholds
    const fastUp = (btcMetrics.change100ms ?? 0) > 0.15 && (btcMetrics.trend ?? 0) > 0.10;
    const fastDn = (btcMetrics.change100ms ?? 0) < -0.15 && (btcMetrics.trend ?? 0) < -0.10;
    
    // Price guardrails
    const goodAsk = (px?: number) => px != null && Number.isFinite(px) && px < 0.58;
    
    // Buy UP if BTC moving up fast
    if (fastUp && goodAsk(upBook.ask?.px) && (upBook.ask?.sz ?? 0) >= 5) {
      return { action: "BUY", side: "Up", reason: `FastUp Δ100ms=${btcMetrics.change100ms!.toFixed(2)}, trend=${btcMetrics.trend!.toFixed(2)}` };
    }
    
    // Buy DOWN if BTC moving down fast
    if (fastDn && goodAsk(downBook.ask?.px) && (downBook.ask?.sz ?? 0) >= 5) {
      return { action: "BUY", side: "Down", reason: `FastDn Δ100ms=${btcMetrics.change100ms!.toFixed(2)}, trend=${btcMetrics.trend!.toFixed(2)}` };
    }
  }
  
  // EXIT SIGNALS
  if (sim.position) {
    const pos = sim.position;
    const currentBook = pos.side === "Up" ? upBook : downBook;
    const bid = currentBook?.bid?.px;
    
    if (!bid || !Number.isFinite(bid)) return { action: null, side: null, reason: "No bid" };
    
    const pxDiff = bid - pos.entryPrice;
    const r = pxDiff / Math.max(1e-6, pos.entryPrice);
    const notional = bid * pos.size;
    const roundTripFee = takerFee(pos.entryPrice * pos.size) + takerFee(notional);
    const minEdge = Math.max(0.01, roundTripFee / Math.max(1, pos.size));
    const holdTimeMs = Date.now() - pos.entryTime;
    
    // Take profit: beat fees + spread (min 3 ticks or 6%)
    if (pxDiff > Math.max(minEdge, 0.03) || r > 0.06) {
      return { action: "SELL", side: pos.side, reason: `TP pxDiff=${pxDiff.toFixed(3)}` };
    }
    
    // Stop loss: -4c or -8% or held >12s and red
    if (pxDiff < -0.04 || r < -0.08 || (holdTimeMs > 12000 && pxDiff < 0)) {
      return { action: "SELL", side: pos.side, reason: `SL pxDiff=${pxDiff.toFixed(3)} hold=${(holdTimeMs/1000).toFixed(1)}s` };
    }
    
    // Momentum flip exit
    if (pos.side === "Up" && (btcMetrics.change100ms ?? 0) < -0.10) {
      return { action: "SELL", side: pos.side, reason: "Momentum flip" };
    }
    if (pos.side === "Down" && (btcMetrics.change100ms ?? 0) > 0.10) {
      return { action: "SELL", side: pos.side, reason: "Momentum flip" };
    }
  }
  
  return { action: null, side: null, reason: "No signal" };
}

async function runMarket(marketUrl: string) {
  const slug = slugFromUrl(marketUrl);
  let resolved = await tryGammaForTokenIds(slug);
  if (!resolved.assetIds.length) {
    console.log("Waiting for tokens to appear (polling gamma)...");
    const start = Date.now();
    const timeout = 5 * 60_000;
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 2000));
      resolved = await tryGammaForTokenIds(slug);
      if (resolved.assetIds.length) break;
    }
    if (!resolved.assetIds.length) throw new Error("Timed out waiting for token IDs");
  }

  const assetIds = resolved.assetIds;
  const marketId = resolved.marketId ?? resolved.marketObj?.id ?? resolved.marketObj?.markets?.[0]?.id ?? undefined;
  const conditionId = resolved.marketObj?.conditionId ?? resolved.marketObj?.markets?.[0]?.conditionId;
  const eventStartTime = resolved.marketObj?.eventStartTime ?? resolved.marketObj?.markets?.[0]?.eventStartTime ?? resolved.marketObj?.startTime;
  const endDate = resolved.marketObj?.endDate ?? resolved.marketObj?.markets?.[0]?.endDate;

  const chainlinkPrice = await fetchChainlinkPrice(conditionId, slug, eventStartTime, endDate);
  if (chainlinkPrice) {
    console.log(`Chainlink BTC Price (price to beat): $${chainlinkPrice.toFixed(2)}`);
  }

  const startPriceRes = await fetchStartingPrice(resolved.marketObj, marketId, assetIds);

  const state = {
    marketSlug: slug,
    marketId,
    startingPrice: startPriceRes.price,
    startingPriceSource: startPriceRes.source,
    btcReferencePrice: chainlinkPrice,
    currentBtcPrice: chainlinkPrice,
    btcMetrics: null as BtcMetrics | null,
    btcHistory: [] as BtcPriceSample[],
    topBooks: {} as Record<string, TopBook>,
    mid: startPriceRes.price,
    spreadPct: null as number | null,
    trades: [] as Trade[],
    log: [] as string[],
    status: "connecting",
    eventStartTime,
    endDate,
    simState: createSimulator(1000), // Start with $1000
  };
  
  // Map token outcomes to books
  const tokenOutcomes = resolved.tokenOutcomes ?? {};

  // Initialize BTC history with current price (high-res timestamp)
  if (chainlinkPrice) {
    state.btcHistory.push({ ts: Date.now(), price: chainlinkPrice, hrts: performance.now() });
  }

  const pushLog = (s: string) => {
    state.log.push(`[${new Date().toISOString().substr(11,8)}] ${s}`);
    if (state.log.length > 200) state.log.shift();
  };

  // Lifecycle context
  const ctx = new RunContext();

  // Graceful exit
  const onSigint = async () => {
    ctx.aborted = true;
    ctx.clearAll();
    renderUI(state);
    await flushLogWriters();
    process.exit(0);
  };
  process.once("SIGINT", onSigint);

  // Promisify run with explicit resolve/reject
  let done!: (v?: unknown) => void;
  let fail!: (e: unknown) => void;
  const p = new Promise((res, rej) => { done = res; fail = rej; });

  // Open WS
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });
  ctx.ws = ws;

  ws.on("open", () => {
    pushLog("WS open");
    state.status = "subscribed";
  
    // Subscribe to order book updates for the target tokens
    ws.send(JSON.stringify({ type: "market", asset_ids: assetIds }));
  
    // keepalive
    const ping = setInterval(() => { try { ws.send("PING"); } catch {} }, 10_000);
    ctx.addTimer(ping, "ping");
  });
  

  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());

      // any message marks activity
      ctx.lastSignalSec = Math.floor(Date.now() / 1000);

      if (msg?.btc_price || msg?.reference_price || msg?.start_price || msg?.chainlink_price || msg?.oracle_price) {
        logApiResponse("WebSocket Message", msg, "WS_BTC_REFERENCE_PRICE");
      }

      if (msg?.event_type === "book") {
        const t = msg.asset_id ?? msg.market ?? "token";
        const bid = Array.isArray(msg.bids) && msg.bids[0] ? { px: Number(msg.bids[0][0]), sz: Number(msg.bids[0][1]) } : undefined;
        const ask = Array.isArray(msg.asks) && msg.asks[0] ? { px: Number(msg.asks[0][0]), sz: Number(msg.asks[0][1]) } : undefined;
        const outcome = tokenOutcomes[t] ?? state.topBooks[t]?.outcome;
        state.topBooks[t] = { bid, ask, outcome };
      } else if (msg?.event_type === "price_change") {
        for (const pc of msg.price_changes ?? []) {
          const t = pc.asset_id ?? pc.token_id ?? "token";
          const bid = pc.best_bid ? { px: Number(pc.best_bid), sz: pc.best_bid_size ? Number(pc.best_bid_size) : undefined } : state.topBooks[t]?.bid;
          const ask = pc.best_ask ? { px: Number(pc.best_ask), sz: pc.best_ask_size ? Number(pc.best_ask_size) : undefined } : state.topBooks[t]?.ask;
          const outcome = tokenOutcomes[t] ?? state.topBooks[t]?.outcome;
          state.topBooks[t] = { bid, ask, outcome };
        }
      } else if (msg?.event_type === "last_trade_price") {
        const px = Number(msg.price);
        if (Number.isFinite(px)) {
          const side = msg.side ?? (msg.side_raw ?? "unknown");
          const tstamp = (+msg.timestamp) || Math.floor(Date.now() / 1000);
          const token = msg.asset_id ?? msg.assetId ?? "token";
          state.trades.unshift({ ts: tstamp, px, sz: msg.size ?? msg.size_raw ?? undefined, side });
          if (state.trades.length > 200) state.trades.length = 200;
          pushLog(`TRADE ${token} ${side} ${px} x ${msg.size ?? "?"}`);
        }
      }

      // update mid/spread from current topBooks
      const bookTokens = Object.values(state.topBooks);
      if (bookTokens.length) {
        let bTop: TopBook | undefined = undefined;
        for (const tb of bookTokens) {
          if (tb.bid && tb.ask) { bTop = tb; break; }
        }
        if (!bTop) bTop = bookTokens[0];
        const bidPx = bTop?.bid?.px ?? null;
        const askPx = bTop?.ask?.px ?? null;
        if (bidPx != null && askPx != null && bidPx > 0 && askPx > 0) {
          const mid = (bidPx + askPx) / 2;
          state.mid = Number.isFinite(mid) ? mid : state.mid;
          if (state.mid && state.mid > 1e-9) {
            state.spreadPct = ((askPx - bidPx) / state.mid) * 100;
          } else {
            state.spreadPct = null;
          }
        } else {
          state.spreadPct = null;
        }
      }
    } catch {
      // ignore parse
    }
  });

  ws.on("error", (e) => {
    pushLog("WS error: " + String(e).slice(0, 200));
    state.status = "error";
  });

  ws.on("close", (code, reason) => {
    pushLog(`WS closed ${code} ${String(reason).slice(0, 200)}`);
    state.status = "closed";
    ctx.clearAll();
    process.removeListener("SIGINT", onSigint);
    fail(new Error(`WS_CLOSED_${code}`));
  });

  // BTC live price polling with history tracking (HIGH FREQUENCY - 100ms)
  const btcTimer = setInterval(async () => {
    try {
      const currentPrice = await pollCurrentBtcPrice();
      if (currentPrice && Number.isFinite(currentPrice)) {
        const now = Date.now();
        const hrts = performance.now();
        
        state.currentBtcPrice = currentPrice;
        
        // Add to history with high-res timestamp
        const sample: BtcPriceSample = { ts: now, price: currentPrice, hrts };
        state.btcHistory.push(sample);
        
        // Trim history (circular buffer behavior)
        if (state.btcHistory.length > BTC_HISTORY_MAX) {
          state.btcHistory.shift();
        }
        
        // Calculate metrics (optimized for low latency)
        state.btcMetrics = calculateBtcMetrics(state.btcHistory, currentPrice);
        
        // TRADING SIMULATOR: Evaluate signals
        const signal = evaluateTradingSignals(state.simState, state.btcMetrics, state.btcReferencePrice, state.topBooks);
        if (signal.action && signal.side) {
          if (signal.action === "BUY") {
            const book = Object.values(state.topBooks).find(b => b.outcome === signal.side);
            const tokenId = Object.keys(state.topBooks).find(k => state.topBooks[k].outcome === signal.side) ?? "";
            if (book?.ask) {
              const wantSz = 10;
              const fill = topOfBookFill(book.ask, wantSz);
              if (fill) {
                const success = simulateTrade(state.simState, "BUY", signal.side, fill.px, fill.sz, tokenId, signal.reason, fill.fee);
                if (success) {
                  pushLog(`[SIM] BUY ${signal.side} @ ${fill.px.toFixed(4)} x${fill.sz.toFixed(1)} (fee ${fill.fee.toFixed(4)})`);
                  const last = state.simState.trades[state.simState.trades.length - 1];
                  logSim({
                    type: "execution",
                    action: "BUY",
                    side: signal.side,
                    price: fill.px,
                    size: fill.sz,
                    fee: fill.fee,
                    reason: signal.reason,
                    flags: { takeProfit: false, stopLoss: false, momentumReversal: false, timeCut: false },
                    btc: {
                      price: state.currentBtcPrice ?? null,
                      deltaVsRef:
                        state.currentBtcPrice != null && state.btcReferencePrice != null
                          ? state.currentBtcPrice - state.btcReferencePrice
                          : null,
                      pctVsRef:
                        state.currentBtcPrice != null && state.btcReferencePrice != null && state.btcReferencePrice !== 0
                          ? ((state.currentBtcPrice - state.btcReferencePrice) / state.btcReferencePrice) * 100
                          : null,
                      d100ms: state.btcMetrics?.change100ms ?? null,
                      d1s: state.btcMetrics?.change1s ?? null,
                      trend: state.btcMetrics?.trend ?? null,
                    },
                    cash: state.simState.cash,
                    totalPnl: state.simState.totalPnl,
                    positionOpen: !!state.simState.position,
                    trade: last,
                  });
                }
              }
            }
          } else if (signal.action === "SELL") {
            if (state.simState.position) {
              const tokenId = state.simState.position.tokenId;
              const book = state.topBooks[tokenId];
              const fill = topOfBookFill(book?.bid, state.simState.position.size);
              if (fill) {
                const closingPosition = state.simState.position;
                const success = simulateTrade(state.simState, "SELL", closingPosition.side, fill.px, 0, tokenId, signal.reason, fill.fee);
                if (success) {
                  pushLog(`[SIM] SELL ${closingPosition.side} @ ${fill.px.toFixed(4)} x${fill.sz.toFixed(1)} (fee ${fill.fee.toFixed(4)})`);
                  const last = state.simState.trades[state.simState.trades.length - 1];
                  const r = signal.reason || "";
                  const flags = {
                    takeProfit: r.startsWith("TP"),
                    stopLoss: r.startsWith("SL"),
                    momentumReversal: r.includes("Momentum flip"),
                    timeCut: r.includes("hold="),
                  };
                  logSim({
                    type: "execution",
                    action: "SELL",
                    side: closingPosition.side,
                    price: fill.px,
                    size: fill.sz,
                    fee: fill.fee,
                    reason: signal.reason,
                    flags,
                    btc: {
                      price: state.currentBtcPrice ?? null,
                      deltaVsRef:
                        state.currentBtcPrice != null && state.btcReferencePrice != null
                          ? state.currentBtcPrice - state.btcReferencePrice
                          : null,
                      pctVsRef:
                        state.currentBtcPrice != null && state.btcReferencePrice != null && state.btcReferencePrice !== 0
                          ? ((state.currentBtcPrice - state.btcReferencePrice) / state.btcReferencePrice) * 100
                          : null,
                      d100ms: state.btcMetrics?.change100ms ?? null,
                      d1s: state.btcMetrics?.change1s ?? null,
                      trend: state.btcMetrics?.trend ?? null,
                    },
                    cash: state.simState.cash,
                    totalPnl: state.simState.totalPnl,
                    positionOpen: !!state.simState.position,
                    trade: last,
                  });
                }
              }
            }
          }
        }
        // Build lightweight snapshots for analysis
        const upPair = Object.entries(state.topBooks).find(([_, b]) => b.outcome === "Up");
        const downPair = Object.entries(state.topBooks).find(([_, b]) => b.outcome === "Down");
        const booksSnap = {
          Up: upPair ? { tokenId: upPair[0], bid: upPair[1].bid?.px ?? null, ask: upPair[1].ask?.px ?? null } : null,
          Down: downPair ? { tokenId: downPair[0], bid: downPair[1].bid?.px ?? null, ask: downPair[1].ask?.px ?? null } : null,
        };
        const metricsSnap = state.btcMetrics
          ? {
              current: state.btcMetrics.current,
              change100ms: state.btcMetrics.change100ms,
              change250ms: state.btcMetrics.change250ms,
              change500ms: state.btcMetrics.change500ms,
              change1s: state.btcMetrics.change1s,
              trend: state.btcMetrics.trend,
              volatility: state.btcMetrics.volatility,
            }
          : null;
        
        // Always log the decision, even if no execution follows
        const btcSnap = {
          price: state.currentBtcPrice ?? null,
          deltaVsRef:
            state.currentBtcPrice != null && state.btcReferencePrice != null
              ? state.currentBtcPrice - state.btcReferencePrice
              : null,
          pctVsRef:
            state.currentBtcPrice != null && state.btcReferencePrice != null && state.btcReferencePrice !== 0
              ? ((state.currentBtcPrice - state.btcReferencePrice) / state.btcReferencePrice) * 100
              : null,
          d100ms: state.btcMetrics?.change100ms ?? null,
          d1s: state.btcMetrics?.change1s ?? null,
          trend: state.btcMetrics?.trend ?? null,
        };
        if (signal.action) {
          logSim({
            type: "decision",
            signal,
            books: booksSnap,
            metrics: metricsSnap,
            btc: btcSnap,
            position: state.simState.position,
            cash: state.simState.cash,
            totalPnl: state.simState.totalPnl,
          });
        }
      }
    } catch {}
  }, BTC_POLL_MS);
  ctx.addTimer(btcTimer, "btc");

  // Market expiry watcher
  const expiryTimer = setInterval(() => {
    if (state.endDate) {
      const endTime = new Date(state.endDate).getTime();
      const now = Date.now();
      if (Number.isFinite(endTime) && now >= endTime) {
        // Settle position if any
        if (state.simState.position) {
          const winsUp = (state.currentBtcPrice ?? 0) >= (state.btcReferencePrice ?? Infinity);
          const settlePx = (state.simState.position.side === "Up" ? (winsUp ? 1 : 0) : (winsUp ? 0 : 1));
          const fee = 0; // settlement is fee-less
          simulateTrade(state.simState, "SELL", state.simState.position.side, settlePx, 0, state.simState.position.tokenId, "Settlement", fee);
          pushLog(`[SIM] Settled @ ${settlePx.toFixed(2)}`);
        }
        ctx.clearAll();
        process.removeListener("SIGINT", onSigint);
        fail(new Error("MARKET_EXPIRED"));
      }
    }
  }, EXPIRY_CHECK_MS);
  ctx.addTimer(expiryTimer, "expiry");

  // Heartbeat watchdog
  const hbTimer = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - ctx.lastSignalSec > HEARTBEAT_SEC) {
      pushLog(`No WS activity for ${HEARTBEAT_SEC}s; reconnecting`);
      try { ws.close(); } catch {}
    }
  }, 1_000);
  ctx.addTimer(hbTimer, "heartbeat");

  // periodic UI
  const uiTimer = setInterval(() => {
    renderUI(state);
  }, UI_RENDER_MS);
  ctx.addTimer(uiTimer, "ui");

  // Log BTC price data periodically for analysis (with microsecond precision)
  const dataLogTimer = setInterval(() => {
    if (state.btcHistory.length > 0) {
      const latest = state.btcHistory[state.btcHistory.length - 1];
      const dataPoint = {
        timestamp: new Date(latest.ts).toISOString(),
        timestampMs: latest.ts,
        hrTimestamp: latest.hrts,
        btcPrice: latest.price,
        btcReferencePrice: state.btcReferencePrice,
        marketMid: state.mid,
        marketSlug: state.marketSlug,
        metrics: state.btcMetrics,
        topBooks: state.topBooks,
      };
      logApiResponse("BTC_PRICE_DATA_POINT", dataPoint, "SCALPING_DATA");
    }
  }, 5_000); // Log every 5 seconds for high-frequency analysis
  ctx.addTimer(dataLogTimer, "datalog");

  return p;
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
