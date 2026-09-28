// MarketPulse demo dataset — single deterministic source of truth for the seed.
//
// Requirements (§3): dependency-free ESM (only `node:*` importable at release
// time), pure functions of a fixed-seed PRNG (no Math.random(), no Date.now()),
// and every timestamp derived from the explicit `now` the seeder passes in.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + helpers
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function uuidFromRng(rng) {
  const bytes = [];
  for (let i = 0; i < 16; i += 1) {
    bytes.push(Math.floor(rng() * 256));
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0"));
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-` +
    `${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Mirrors lib/market/rvol.ts (kept inline: this module must stay
// dependency-free for the release-time seed).
const VOLUME_PROFILE_ANCHORS = [
  [0, 0],
  [5, 0.03],
  [15, 0.08],
  [30, 0.13],
  [60, 0.2],
  [120, 0.32],
  [180, 0.43],
  [240, 0.53],
  [300, 0.63],
  [330, 0.7],
  [360, 0.8],
  [390, 0.95],
  [9999, 1],
];

function volumeProfileFraction(elapsedMinutes) {
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) {
    return 0;
  }
  const points = VOLUME_PROFILE_ANCHORS;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (elapsedMinutes <= x1) {
      const t = (elapsedMinutes - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 1;
}

function avgDailyVolume(ticker) {
  return 6_000_000 + (hashString(`adv:${ticker}`) % 60_000_000);
}

// ---------------------------------------------------------------------------
// Fixed reference data
// ---------------------------------------------------------------------------

const SEED = 20240901;

export const BENCHMARK_TICKERS = ["SPY", "QQQ", "SOXX", "XLK", "XLC", "XLY"];

export const SECTORS = [
  {
    slug: "semiconductors",
    name: "Semiconductors",
    etfSymbol: "SOXX",
    description: "Semiconductor design, manufacturing and equipment.",
  },
  {
    slug: "technology",
    name: "Technology",
    etfSymbol: "XLK",
    description: "Software, hardware and enterprise technology.",
  },
  {
    slug: "communication-services",
    name: "Communication Services",
    etfSymbol: "XLC",
    description: "Media, social platforms and communication services.",
  },
  {
    slug: "consumer-discretionary",
    name: "Consumer Discretionary",
    etfSymbol: "XLY",
    description: "Automotive and consumer discretionary goods.",
  },
];

export const COMPANIES = [
  {
    ticker: "NVDA",
    name: "NVIDIA",
    sectorSlug: "semiconductors",
    exchange: "NASDAQ",
    country: "US",
    cik: "0001045810",
    website: "https://www.nvidia.com",
    description: "Designer of graphics processing units and accelerated computing platforms.",
    marketCapUsd: 3200000000000,
    employees: 29600,
  },
  {
    ticker: "AMD",
    name: "Advanced Micro Devices",
    sectorSlug: "semiconductors",
    exchange: "NASDAQ",
    country: "US",
    cik: "0000002488",
    website: "https://www.amd.com",
    description: "Designer of CPUs and GPUs for compute and graphics.",
    marketCapUsd: 190000000000,
    employees: 26000,
  },
  {
    ticker: "TSM",
    name: "Taiwan Semiconductor",
    sectorSlug: "semiconductors",
    exchange: "NYSE",
    country: "TW",
    cik: "0001046179",
    website: "https://www.tsmc.com",
    description: "Semiconductor foundry manufacturing advanced-node chips.",
    marketCapUsd: 1000000000000,
    employees: 73000,
  },
  {
    ticker: "AVGO",
    name: "Broadcom",
    sectorSlug: "semiconductors",
    exchange: "NASDAQ",
    country: "US",
    cik: "0001730168",
    website: "https://www.broadcom.com",
    description: "Designer of semiconductor and infrastructure software products.",
    marketCapUsd: 1000000000000,
    employees: 40000,
  },
  {
    ticker: "META",
    name: "Meta Platforms",
    sectorSlug: "communication-services",
    exchange: "NASDAQ",
    country: "US",
    cik: "0001326801",
    website: "https://www.meta.com",
    description: "Social media and advertising platform operator.",
    marketCapUsd: 1500000000000,
    employees: 74000,
  },
  {
    ticker: "MSFT",
    name: "Microsoft",
    sectorSlug: "technology",
    exchange: "NASDAQ",
    country: "US",
    cik: "0000789019",
    website: "https://www.microsoft.com",
    description: "Software, cloud and productivity platform provider.",
    marketCapUsd: 3100000000000,
    employees: 228000,
  },
  {
    ticker: "AAPL",
    name: "Apple",
    sectorSlug: "technology",
    exchange: "NASDAQ",
    country: "US",
    cik: "0000320193",
    website: "https://www.apple.com",
    description: "Consumer electronics, software and services company.",
    marketCapUsd: 3600000000000,
    employees: 164000,
  },
  {
    ticker: "TSLA",
    name: "Tesla",
    sectorSlug: "consumer-discretionary",
    exchange: "NASDAQ",
    country: "US",
    cik: "0001318605",
    website: "https://www.tesla.com",
    description: "Electric vehicle and clean energy company.",
    marketCapUsd: 750000000000,
    employees: 140000,
  },
];

export const NEWS_SOURCES = [
  { slug: "reuters", name: "Reuters", url: "https://www.reuters.com", tier: 1, qualityScore: 0.92, kind: "wire" },
  { slug: "bloomberg", name: "Bloomberg", url: "https://www.bloomberg.com", tier: 1, qualityScore: 0.95, kind: "wire" },
  { slug: "wsj", name: "The Wall Street Journal", url: "https://www.wsj.com", tier: 1, qualityScore: 0.9, kind: "newspaper" },
  { slug: "cnbc", name: "CNBC", url: "https://www.cnbc.com", tier: 2, qualityScore: 0.75, kind: "newspaper" },
  { slug: "marketwatch", name: "MarketWatch", url: "https://www.marketwatch.com", tier: 2, qualityScore: 0.72, kind: "newspaper" },
  { slug: "barrons", name: "Barron's", url: "https://www.barrons.com", tier: 2, qualityScore: 0.7, kind: "newspaper" },
  { slug: "businesswire", name: "Business Wire", url: "https://www.businesswire.com", tier: 2, qualityScore: 0.68, kind: "press_release" },
  { slug: "prnewswire", name: "PR Newswire", url: "https://www.prnewswire.com", tier: 2, qualityScore: 0.66, kind: "press_release" },
  { slug: "sec-edgar", name: "SEC EDGAR", url: "https://www.sec.gov", tier: 1, qualityScore: 0.98, kind: "sec_filing" },
  { slug: "seeking-alpha", name: "Seeking Alpha", url: "https://seekingalpha.com", tier: 3, qualityScore: 0.55, kind: "analyst" },
  { slug: "benzinga", name: "Benzinga", url: "https://www.benzinga.com", tier: 3, qualityScore: 0.5, kind: "analyst" },
  { slug: "stocktwits", name: "StockTwits", url: "https://stocktwits.com", tier: 3, qualityScore: 0.35, kind: "social" },
];

const SECTOR_ETF_BY_SLUG = {
  semiconductors: "SOXX",
  technology: "XLK",
  "communication-services": "XLC",
  "consumer-discretionary": "XLY",
};

const PEER_GROUP_BY_SECTOR = {
  semiconductors: ["NVDA", "AMD", "TSM", "AVGO"],
  technology: ["MSFT", "AAPL"],
  "communication-services": ["META"],
  "consumer-discretionary": ["TSLA"],
};

export const ANCHOR_PRICES = {
  NVDA: 178.4,
  AMD: 172.1,
  TSM: 268.3,
  AVGO: 342.6,
  META: 612.8,
  MSFT: 489.2,
  AAPL: 254.7,
  TSLA: 402.3,
  SPY: 592.1,
  QQQ: 524.6,
  SOXX: 254.8,
  XLK: 268.1,
  XLC: 104.2,
  XLY: 218.4,
};

const MACRO_SERIES = [
  { series: "FED_FUNDS_RATE", base: 5.25, unit: "%", digits: 2, kind: "rate" },
  { series: "CPI_YOY", base: 3.1, unit: "%", digits: 1, kind: "rate" },
  { series: "PCE_YOY", base: 2.6, unit: "%", digits: 1, kind: "rate" },
  { series: "NFP_CHANGE", base: 210, unit: "k", digits: 0, kind: "rate" },
  { series: "UNEMPLOYMENT", base: 3.9, unit: "%", digits: 1, kind: "rate" },
  { series: "GDP_QOQ", base: 2.8, unit: "%", digits: 1, kind: "rate" },
  { series: "US10Y", base: 4.2, unit: "%", digits: 2, kind: "rate" },
  { series: "DXY", base: 103.4, unit: "%", digits: 1, kind: "level" },
  { series: "VIX", base: 14.2, unit: "%", digits: 1, kind: "level" },
  { series: "SP500", base: 5921, unit: "%", digits: 1, kind: "level" },
  { series: "NASDAQ", base: 21008, unit: "%", digits: 1, kind: "level" },
  { series: "SOXX", base: 254.8, unit: "%", digits: 1, kind: "level" },
];

// ---------------------------------------------------------------------------
// Trading-day helpers (UTC-based; timestamps are deterministic offsets)
// ---------------------------------------------------------------------------

function nthPriorWeekday(now, n) {
  const base = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0),
  );
  let cursor = new Date(base.getTime());
  let found = 0;
  while (found < n) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      found += 1;
    }
  }
  return cursor;
}

function tradingDays(now, count) {
  const days = [];
  for (let i = 1; i <= count; i += 1) {
    days.push(nthPriorWeekday(now, i));
  }
  return days.reverse(); // oldest first
}

// ---------------------------------------------------------------------------
// Scenario bank
// ---------------------------------------------------------------------------

const DIRECTION_WORD = {
  positive: "Positive",
  negative: "Negative",
  neutral: "Neutral",
  mixed: "Mixed",
};

function formatPct(value) {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)}%`;
}

function buildInterpretation(evt) {
  const dirWord = DIRECTION_WORD[evt.catalystDirection] ?? "Neutral";
  const parts = [];
  if (evt.surprisePct != null) {
    parts.push(`${dirWord} ${evt.surpriseLabel} surprise (${formatPct(evt.surprisePct)} vs consensus)`);
  } else {
    parts.push(`${dirWord} ${evt.eventTypeLabel.toLowerCase()}`);
  }
  if (evt.rvol != null) {
    const prefix = evt.rvol >= 1.5 ? "elevated " : "";
    parts.push(`${prefix}relative volume (${evt.rvol.toFixed(1)}x)`);
  }
  if (evt.relativeStrengthPp != null) {
    const bench = evt.benchmark ? ` versus ${evt.benchmark}` : "";
    const rel = evt.relativeStrengthPp >= 0 ? "outperformance" : "underperformance";
    parts.push(`${rel} of ${Math.abs(evt.relativeStrengthPp).toFixed(1)}pp${bench}`);
  }
  const opening = parts.shift() ?? `${dirWord} event`;
  let sentence = opening;
  if (parts.length === 1) {
    sentence += ` accompanied by ${parts[0]}`;
  } else if (parts.length >= 2) {
    sentence += ` accompanied by ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  }
  return `${sentence}.`;
}

// Each scenario returns the canonical event fields (without id/timestamps).
const SCENARIOS = {
  EARNINGS_BEAT: (c, rng) => {
    const epsConsensus = round(0.55 + rng() * 1.2, 2);
    const epsActual = round(epsConsensus * (1 + 0.08 + rng() * 0.12), 2);
    const revenueConsensus = round((8000 + rng() * 30000) / 1000, 2); // billions
    const revenueActual = round(revenueConsensus * (1 + 0.03 + rng() * 0.05), 2);
    const surprise = round(((epsActual - epsConsensus) / epsConsensus) * 100, 1);
    return {
      eventType: "EARNINGS",
      catalystDirection: "positive",
      sentiment: round(0.55 + rng() * 0.3, 2),
      importance: round(0.85 + rng() * 0.15, 2),
      relevance: 1,
      surpriseLabel: "EPS",
      surprisePct: surprise,
      rvol: round(2 + rng() * 1.6, 1),
      relativeStrengthPp: round(0.4 + rng() * 1.2, 1),
      headline: `${c.name} reports quarterly results above analyst estimates`,
      summary: `${c.name} reported quarterly earnings and revenue ahead of consensus, citing strong demand across its core business segments.`,
      reasoning: `Earnings beat the consensus estimate by ${formatPct(surprise)}, a positive surprise judged against expectations rather than absolute growth.`,
      expectations: [
        { metric: "eps", consensus: epsConsensus, unit: "USD" },
        { metric: "revenue", consensus: revenueConsensus, unit: "B" },
      ],
      earnings: {
        epsActual,
        epsConsensus,
        revenueActual,
        revenueConsensus,
        yoyRevenueGrowthPct: round(8 + rng() * 18, 1),
      },
    };
  },
  EARNINGS_MISS: (c, rng) => {
    const epsConsensus = round(0.4 + rng() * 1.1, 2);
    const epsActual = round(epsConsensus * (1 - 0.06 - rng() * 0.1), 2);
    const revenueConsensus = round((12000 + rng() * 25000) / 1000, 2);
    const revenueActual = round(revenueConsensus * (1 - 0.02 - rng() * 0.04), 2);
    const surprise = round(((epsActual - epsConsensus) / epsConsensus) * 100, 1);
    return {
      eventType: "EARNINGS",
      catalystDirection: "negative",
      sentiment: round(-0.4 - rng() * 0.35, 2),
      importance: round(0.85 + rng() * 0.15, 2),
      relevance: 1,
      surpriseLabel: "EPS",
      surprisePct: surprise,
      rvol: round(1.8 + rng() * 1.4, 1),
      relativeStrengthPp: round(-0.3 - rng() * 1.0, 1),
      headline: `${c.name} earnings fall short of analyst estimates`,
      summary: `${c.name} reported quarterly results below consensus on softer-than-expected demand and narrowing margins.`,
      reasoning: `Earnings missed consensus by ${formatPct(surprise)}, a negative surprise relative to expectations.`,
      expectations: [
        { metric: "eps", consensus: epsConsensus, unit: "USD" },
        { metric: "revenue", consensus: revenueConsensus, unit: "B" },
      ],
      earnings: {
        epsActual,
        epsConsensus,
        revenueActual,
        revenueConsensus,
        yoyRevenueGrowthPct: round(-2 - rng() * 8, 1),
      },
    };
  },
  GUIDANCE_RAISE: (c, rng) => {
    const consensus = round(2 + rng() * 3, 2);
    const actual = round(consensus * (1 + 0.12 + rng() * 0.1), 2);
    const surprise = round(((actual - consensus) / consensus) * 100, 1);
    return {
      eventType: "GUIDANCE",
      catalystDirection: "positive",
      sentiment: round(0.5 + rng() * 0.3, 2),
      importance: round(0.9 + rng() * 0.1, 2),
      relevance: 1,
      surpriseLabel: "guidance",
      surprisePct: surprise,
      rvol: round(1.8 + rng() * 1.5, 1),
      relativeStrengthPp: round(0.3 + rng() * 1.1, 1),
      headline: `${c.name} raises full-year guidance`,
      summary: `${c.name} raised its full-year outlook above consensus, pointing to accelerating demand and improving efficiency.`,
      reasoning: `Forward guidance was raised ${formatPct(surprise)} above consensus, a positive surprise versus expectations.`,
      expectations: [{ metric: "guidance", consensus, unit: "USD" }],
      earnings: { guidanceActual: actual, guidanceConsensus: consensus },
    };
  },
  GUIDANCE_CUT: (c, rng) => {
    const consensus = round(2 + rng() * 3, 2);
    const actual = round(consensus * (1 - 0.1 - rng() * 0.08), 2);
    const surprise = round(((actual - consensus) / consensus) * 100, 1);
    return {
      eventType: "GUIDANCE",
      catalystDirection: "negative",
      sentiment: round(-0.45 - rng() * 0.3, 2),
      importance: round(0.9 + rng() * 0.1, 2),
      relevance: 1,
      surpriseLabel: "guidance",
      surprisePct: surprise,
      rvol: round(1.6 + rng() * 1.3, 1),
      relativeStrengthPp: round(-0.3 - rng() * 0.9, 1),
      headline: `${c.name} cuts full-year guidance`,
      summary: `${c.name} lowered its full-year outlook below consensus, citing weaker end-market demand.`,
      reasoning: `Forward guidance was reduced ${formatPct(surprise)} below consensus, a negative surprise versus expectations.`,
      expectations: [{ metric: "guidance", consensus, unit: "USD" }],
      earnings: { guidanceActual: actual, guidanceConsensus: consensus },
    };
  },
  ANALYST_UPGRADE: (c, rng) => {
    return {
      eventType: "ANALYST_UPGRADE",
      catalystDirection: "positive",
      sentiment: round(0.35 + rng() * 0.3, 2),
      importance: round(0.4 + rng() * 0.2, 2),
      relevance: round(0.8 + rng() * 0.2, 2),
      surpriseLabel: "analyst",
      surprisePct: null,
      rvol: round(1.4 + rng() * 0.8, 1),
      relativeStrengthPp: round(0.2 + rng() * 0.6, 1),
      headline: `${c.name} upgraded by a major research desk`,
      summary: `A large institutional research desk raised its rating on ${c.name}, citing improving fundamentals.`,
      reasoning: `The rating change is treated as a directional signal; its weight is bounded by the source tier and event importance.`,
      expectations: [],
      earnings: null,
    };
  },
  ANALYST_DOWNGRADE: (c, rng) => {
    return {
      eventType: "ANALYST_DOWNGRADE",
      catalystDirection: "negative",
      sentiment: round(-0.35 - rng() * 0.3, 2),
      importance: round(0.45 + rng() * 0.2, 2),
      relevance: round(0.8 + rng() * 0.2, 2),
      surpriseLabel: "analyst",
      surprisePct: null,
      rvol: round(1.4 + rng() * 0.8, 1),
      relativeStrengthPp: round(-0.2 - rng() * 0.6, 1),
      headline: `${c.name} downgraded by a major research desk`,
      summary: `A large institutional research desk lowered its rating on ${c.name}, citing valuation and competitive pressure.`,
      reasoning: `The rating change is treated as a directional signal; its weight is bounded by the source tier and event importance.`,
      expectations: [],
      earnings: null,
    };
  },
  PRODUCT: (c, rng) => {
    return {
      eventType: "PRODUCT",
      catalystDirection: "positive",
      sentiment: round(0.4 + rng() * 0.3, 2),
      importance: round(0.5 + rng() * 0.25, 2),
      relevance: round(0.9 + rng() * 0.1, 2),
      surpriseLabel: "product",
      surprisePct: null,
      rvol: round(1.5 + rng() * 1.2, 1),
      relativeStrengthPp: round(0.2 + rng() * 0.8, 1),
      headline: `${c.name} unveils a new product line`,
      summary: `${c.name} announced a new product line aimed at expanding its addressable market.`,
      reasoning: `A new product launch is weighted by event importance and measured market reaction rather than sentiment alone.`,
      expectations: [],
      earnings: null,
    };
  },
  CONTRACT: (c, rng) => {
    return {
      eventType: "CONTRACT",
      catalystDirection: "positive",
      sentiment: round(0.35 + rng() * 0.25, 2),
      importance: round(0.45 + rng() * 0.25, 2),
      relevance: round(0.85 + rng() * 0.15, 2),
      surpriseLabel: "contract",
      surprisePct: null,
      rvol: round(1.2 + rng() * 0.9, 1),
      relativeStrengthPp: round(0.1 + rng() * 0.6, 1),
      headline: `${c.name} signs a large supply agreement`,
      summary: `${c.name} announced a multi-year supply agreement with a major customer.`,
      reasoning: `A new contract is scored against event importance and measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  PARTNERSHIP: (c, rng) => {
    return {
      eventType: "PARTNERSHIP",
      catalystDirection: "positive",
      sentiment: round(0.3 + rng() * 0.25, 2),
      importance: round(0.4 + rng() * 0.2, 2),
      relevance: round(0.85 + rng() * 0.15, 2),
      surpriseLabel: "partnership",
      surprisePct: null,
      rvol: round(1.1 + rng() * 0.8, 1),
      relativeStrengthPp: round(0.1 + rng() * 0.5, 1),
      headline: `${c.name} announces a strategic partnership`,
      summary: `${c.name} announced a strategic partnership to co-develop new capabilities.`,
      reasoning: `Partnerships carry moderate base importance and are scored on measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  M_A: (c, rng) => {
    return {
      eventType: "M&A",
      catalystDirection: "positive",
      sentiment: round(0.45 + rng() * 0.3, 2),
      importance: round(0.8 + rng() * 0.2, 2),
      relevance: 1,
      surpriseLabel: "acquisition",
      surprisePct: null,
      rvol: round(2.2 + rng() * 1.5, 1),
      relativeStrengthPp: round(0.5 + rng() * 1.2, 1),
      headline: `${c.name} agrees to acquire a competitor`,
      summary: `${c.name} agreed to acquire a smaller competitor, expanding its product portfolio.`,
      reasoning: `M&A events carry high base importance and are judged by measured market reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  REGULATION: (c, rng) => {
    return {
      eventType: "REGULATION",
      catalystDirection: "negative",
      sentiment: round(-0.4 - rng() * 0.3, 2),
      importance: round(0.6 + rng() * 0.25, 2),
      relevance: round(0.9 + rng() * 0.1, 2),
      surpriseLabel: "regulatory",
      surprisePct: null,
      rvol: round(1.3 + rng() * 0.9, 1),
      relativeStrengthPp: round(-0.2 - rng() * 0.7, 1),
      headline: `${c.name} faces a new regulatory probe`,
      summary: `Regulators opened a review into certain ${c.name} business practices.`,
      reasoning: `Regulatory events are weighted by event importance and measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  LAWSUIT: (c, rng) => {
    return {
      eventType: "LAWSUIT",
      catalystDirection: "negative",
      sentiment: round(-0.35 - rng() * 0.3, 2),
      importance: round(0.5 + rng() * 0.2, 2),
      relevance: round(0.8 + rng() * 0.2, 2),
      surpriseLabel: "litigation",
      surprisePct: null,
      rvol: round(1.2 + rng() * 0.8, 1),
      relativeStrengthPp: round(-0.1 - rng() * 0.6, 1),
      headline: `${c.name} named in a new lawsuit`,
      summary: `A lawsuit was filed against ${c.name} alleging anticompetitive conduct.`,
      reasoning: `Litigation events are scored on measured market reaction and event importance.`,
      expectations: [],
      earnings: null,
    };
  },
  MANAGEMENT: (c, rng) => {
    return {
      eventType: "MANAGEMENT",
      catalystDirection: "mixed",
      sentiment: round(-0.1 + rng() * 0.2, 2),
      importance: round(0.4 + rng() * 0.2, 2),
      relevance: round(0.7 + rng() * 0.2, 2),
      surpriseLabel: "management",
      surprisePct: null,
      rvol: round(1 + rng() * 0.6, 1),
      relativeStrengthPp: round(-0.2 + rng() * 0.4, 1),
      headline: `${c.name} announces a leadership change`,
      summary: `${c.name} announced a change in a senior leadership role.`,
      reasoning: `Management changes carry moderate base importance and are judged by measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  BUYBACK: (c, rng) => {
    return {
      eventType: "BUYBACK",
      catalystDirection: "positive",
      sentiment: round(0.3 + rng() * 0.25, 2),
      importance: round(0.4 + rng() * 0.2, 2),
      relevance: round(0.9 + rng() * 0.1, 2),
      surpriseLabel: "repurchase",
      surprisePct: null,
      rvol: round(1.2 + rng() * 0.7, 1),
      relativeStrengthPp: round(0.1 + rng() * 0.5, 1),
      headline: `${c.name} authorizes a share repurchase program`,
      summary: `${c.name} authorized an expanded share repurchase program.`,
      reasoning: `A repurchase program is scored on measured market reaction and event importance.`,
      expectations: [],
      earnings: null,
    };
  },
  DIVIDEND: (c, rng) => {
    return {
      eventType: "DIVIDEND",
      catalystDirection: "positive",
      sentiment: round(0.2 + rng() * 0.2, 2),
      importance: round(0.3 + rng() * 0.15, 2),
      relevance: round(0.9 + rng() * 0.1, 2),
      surpriseLabel: "dividend",
      surprisePct: null,
      rvol: round(1 + rng() * 0.4, 1),
      relativeStrengthPp: round(0.1 + rng() * 0.3, 1),
      headline: `${c.name} raises its quarterly dividend`,
      summary: `${c.name} announced an increase to its quarterly dividend.`,
      reasoning: `Dividend changes carry low base importance and are scored on measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  OFFERING: (c, rng) => {
    return {
      eventType: "OFFERING",
      catalystDirection: "negative",
      sentiment: round(-0.3 - rng() * 0.25, 2),
      importance: round(0.5 + rng() * 0.2, 2),
      relevance: 1,
      surpriseLabel: "offering",
      surprisePct: null,
      rvol: round(1.3 + rng() * 0.8, 1),
      relativeStrengthPp: round(-0.2 - rng() * 0.6, 1),
      headline: `${c.name} announces a secondary offering`,
      summary: `${c.name} announced a secondary offering of additional shares.`,
      reasoning: `A share offering is scored on measured market reaction and event importance.`,
      expectations: [],
      earnings: null,
    };
  },
  INSIDER_TRANSACTION: (c, rng) => {
    return {
      eventType: "INSIDER_TRANSACTION",
      catalystDirection: "negative",
      sentiment: round(-0.25 - rng() * 0.2, 2),
      importance: round(0.3 + rng() * 0.15, 2),
      relevance: round(0.8 + rng() * 0.2, 2),
      surpriseLabel: "insider",
      surprisePct: null,
      rvol: round(1 + rng() * 0.5, 1),
      relativeStrengthPp: round(-0.1 - rng() * 0.4, 1),
      headline: `${c.name} insider discloses a share sale`,
      summary: `A ${c.name} executive disclosed the sale of shares under a pre-arranged plan.`,
      reasoning: `Insider transactions carry low base importance and are judged by measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
  MACRO: (c, rng) => {
    const positive = rng() > 0.5;
    const value = positive ? round(0.2 + rng() * 0.3, 2) : round(-0.2 - rng() * 0.3, 2);
    return {
      eventType: "MACRO",
      catalystDirection: positive ? "positive" : "negative",
      sentiment: round(value, 2),
      importance: round(0.6 + rng() * 0.25, 2),
      relevance: round(0.6 + rng() * 0.3, 2),
      surpriseLabel: "macro",
      surprisePct: null,
      rvol: round(1.2 + rng() * 0.8, 1),
      relativeStrengthPp: round(value * 2, 1),
      headline: `Key economic data print moves broad markets`,
      summary: `A widely watched economic release shifted broad-market sentiment, touching ${c.name} alongside its sector.`,
      reasoning: `Macro releases are judged by measured market reaction and event importance, not sentiment alone.`,
      expectations: [],
      earnings: null,
    };
  },
  OTHER: (c, rng) => {
    return {
      eventType: "OTHER",
      catalystDirection: "neutral",
      sentiment: round(-0.1 + rng() * 0.2, 2),
      importance: round(0.2 + rng() * 0.2, 2),
      relevance: round(0.5 + rng() * 0.4, 2),
      surpriseLabel: "update",
      surprisePct: null,
      rvol: round(0.8 + rng() * 0.6, 1),
      relativeStrengthPp: round(-0.2 + rng() * 0.4, 1),
      headline: `${c.name} issues an operational update`,
      summary: `${c.name} issued a routine operational update with no material change to its outlook.`,
      reasoning: `Routine updates carry low base importance and are scored on measured reaction.`,
      expectations: [],
      earnings: null,
    };
  },
};

const EVENT_TYPE_LABELS = {
  EARNINGS: "Earnings",
  GUIDANCE: "Guidance",
  PRODUCT: "Product",
  CONTRACT: "Contract",
  PARTNERSHIP: "Partnership",
  "M&A": "M&A",
  ANALYST_UPGRADE: "Analyst Upgrade",
  ANALYST_DOWNGRADE: "Analyst Downgrade",
  REGULATION: "Regulation",
  LAWSUIT: "Lawsuit",
  MANAGEMENT: "Management",
  BUYBACK: "Buyback",
  DIVIDEND: "Dividend",
  OFFERING: "Offering",
  INSIDER_TRANSACTION: "Insider Transaction",
  MACRO: "Macro",
  OTHER: "Other",
};

// Fixed schedule: [ticker, scenarioKey, dayIndex (0..4)] guaranteeing coverage.
const PLAN = [
  ["NVDA", "EARNINGS_BEAT", 0],
  ["AMD", "GUIDANCE_CUT", 0],
  ["META", "PRODUCT", 0],
  ["MSFT", "ANALYST_UPGRADE", 0],
  ["TSLA", "MACRO", 0],
  ["AAPL", "DIVIDEND", 1],
  ["TSM", "CONTRACT", 1],
  ["AVGO", "ANALYST_UPGRADE", 1],
  ["TSLA", "EARNINGS_MISS", 1],
  ["NVDA", "PRODUCT", 1],
  ["MSFT", "GUIDANCE_RAISE", 2],
  ["AAPL", "ANALYST_DOWNGRADE", 2],
  ["AMD", "PARTNERSHIP", 2],
  ["META", "INSIDER_TRANSACTION", 2],
  ["AVGO", "M_A", 3],
  ["TSM", "REGULATION", 3],
  ["TSLA", "OFFERING", 3],
  ["NVDA", "CONTRACT", 3],
  ["MSFT", "BUYBACK", 4],
  ["AAPL", "PRODUCT", 4],
  ["AMD", "LAWSUIT", 4],
  ["META", "ANALYST_UPGRADE", 4],
  ["TSM", "MANAGEMENT", 4],
  ["AVGO", "EARNINGS_BEAT", 2],
  ["NVDA", "ANALYST_UPGRADE", 2],
  ["TSLA", "REGULATION", 2],
  ["MSFT", "PARTNERSHIP", 3],
  ["AAPL", "GUIDANCE_RAISE", 3],
  ["AMD", "EARNINGS_MISS", 3],
  ["META", "GUIDANCE_CUT", 3],
  ["AVGO", "DIVIDEND", 0],
  ["TSM", "INSIDER_TRANSACTION", 1],
  ["NVDA", "BUYBACK", 4],
  ["TSLA", "PRODUCT", 4],
  ["MSFT", "CONTRACT", 1],
  ["AAPL", "MANAGEMENT", 1],
  ["META", "MACRO", 1],
  ["AVGO", "OTHER", 4],
  ["TSM", "OTHER", 2],
  ["AMD", "ANALYST_DOWNGRADE", 4],
];

// Recent events injected into the last 3 hours of the default feed. The large
// dayIndex values keep their `dedupe_key` distinct from the historical PLAN
// while remaining valid for the fiscal-period derivation.
const RECENT_PLAN = [
  ["NVDA", "EARNINGS_BEAT", 8, 100],
  ["AMD", "GUIDANCE_RAISE", 25, 101],
  ["TSM", "ANALYST_UPGRADE", 47, 102],
  ["AVGO", "ANALYST_DOWNGRADE", 70, 103],
  ["META", "PRODUCT", 95, 104],
  ["MSFT", "REGULATION", 130, 105],
  ["AAPL", "CONTRACT", 160, 106],
  ["TSLA", "EARNINGS_MISS", 160, 107],
];

// ---------------------------------------------------------------------------
// Dataset builder
// ---------------------------------------------------------------------------

export function buildDataset({ now }) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const rng = mulberry32(SEED);
  const days = tradingDays(nowDate, 5);

  // --- reference data ---
  const users = [
    {
      id: uuidFromRng(rng),
      email: "demo@marketpulse.dev",
      displayName: "Demo Trader",
      isDemo: true,
      riskProfile: "active",
      prefs: {},
    },
  ];

  const sectors = SECTORS.map((s) => ({
    id: uuidFromRng(rng),
    slug: s.slug,
    name: s.name,
    etfSymbol: s.etfSymbol,
    description: s.description,
  }));
  const sectorBySlug = new Map(sectors.map((s) => [s.slug, s.id]));

  const companies = COMPANIES.map((c) => ({
    id: uuidFromRng(rng),
    name: c.name,
    ticker: c.ticker,
    sectorId: sectorBySlug.get(c.sectorSlug) ?? null,
    exchange: c.exchange,
    country: c.country,
    cik: c.cik,
    website: c.website,
    description: c.description,
    marketCapUsd: c.marketCapUsd,
    employees: c.employees,
  }));
  const companyByTicker = new Map(companies.map((c) => [c.ticker, c]));

  const stocks = companies.map((c) => ({
    id: uuidFromRng(rng),
    companyId: c.id,
    ticker: c.ticker,
    isActive: true,
    universe: true,
    addedAt: new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  }));

  const newsSources = NEWS_SOURCES.map((s) => ({
    id: uuidFromRng(rng),
    slug: s.slug,
    name: s.name,
    url: s.url,
    tier: s.tier,
    qualityScore: s.qualityScore,
    kind: s.kind,
  }));
  const sourceBySlug = new Map(newsSources.map((s) => [s.slug, s]));

  // --- events + articles ---
  const marketEvents = [];
  const newsArticles = [];
  const eventArticles = [];
  const eventTickers = [];
  const fundamentalExpectations = [];
  const earningsResults = [];

  // Emits one canonical event (plus its article cluster, tickers, expectations
  // and earnings). Shared by the historical PLAN and the recent-window plan.
  const emitEvent = (ticker, scenarioKey, dayIndex, publishedAt) => {
    const company = companyByTicker.get(ticker);
    if (!company) {
      return;
    }
    const scenario = SCENARIOS[scenarioKey](company, rng);
    const sectorSlug = COMPANIES.find((c) => c.ticker === ticker)?.sectorSlug;
    const benchmark = SECTOR_ETF_BY_SLUG[sectorSlug] ?? "SPY";
    const hourBucket = Math.floor(publishedAt.getUTCHours());

    const eventId = uuidFromRng(rng);
    const dedupeKey = `${ticker}:${scenario.eventType}:${dayIndex}:${hourBucket}`;

    // cluster: 1–3 articles
    const articleCount = randInt(rng, 1, 3);
    const session = scenario.eventType === "EARNINGS" ? "after_hours" : "regular";

    const peers = (PEER_GROUP_BY_SECTOR[sectorSlug] ?? []).filter((t) => t !== ticker);
    const affected = peers.slice(0, Math.min(peers.length, 2));

    for (let a = 0; a < articleCount; a += 1) {
      const articleId = uuidFromRng(rng);
      const source = pick(rng, newsSources);
      const provider = source.slug;
      const articlePublishedAt = new Date(publishedAt.getTime() + a * randInt(rng, 3, 25) * 60 * 1000);
      const hash = sha256(
        `${ticker}|${provider}|${scenario.headline}|${dayIndex}-${hourBucket}-${a}`,
      );
      newsArticles.push({
        id: articleId,
        sourceId: source.id,
        provider,
        providerArticleId: `mp-${dayIndex}-${ticker}-${scenarioKey}-${a}`,
        url: `${source.url}/articles/${hash.slice(0, 12)}`,
        headline: scenario.headline,
        body: `${scenario.summary} Reported by ${source.name}.`,
        publishedAt: articlePublishedAt.toISOString(),
        fetchedAt: new Date(articlePublishedAt.getTime() + 2 * 60 * 1000).toISOString(),
        author: a === 0 ? `${source.name} Staff` : "Editorial",
        tickersRaw: [ticker, ...affected],
        hash,
        isPrimary: a === 0,
        eventId,
      });
      eventArticles.push({
        id: uuidFromRng(rng),
        eventId,
        articleId,
        similarity: a === 0 ? 1 : round(0.65 + rng() * 0.3, 2),
        isPrimary: a === 0,
      });
    }

    const canonicalArticleId = newsArticles[newsArticles.length - articleCount].id;

    // event_tickers: primary + classifier-affected + sector peers
    const primaryChange = scenario.catalystDirection === "negative"
      ? -round(0.5 + rng() * 3, 2)
      : scenario.catalystDirection === "positive"
        ? round(0.5 + rng() * 3, 2)
        : round(-0.4 + rng() * 0.8, 2);

    eventTickers.push({
      id: uuidFromRng(rng),
      eventId,
      ticker,
      relation: "primary",
      changePctSincePublication: primaryChange,
      isDirect: true,
    });
    for (const peer of affected) {
      eventTickers.push({
        id: uuidFromRng(rng),
        eventId,
        ticker: peer,
        relation: "affected",
        changePctSincePublication: round(primaryChange * (0.3 + rng() * 0.5), 2),
        isDirect: true,
      });
    }

    marketEvents.push({
      id: eventId,
      canonicalArticleId,
      ticker,
      companyId: company.id,
      sectorId: company.sectorId,
      headline: scenario.headline,
      summary: scenario.summary,
      eventType: scenario.eventType,
      eventTypeLabel: EVENT_TYPE_LABELS[scenario.eventType],
      sentiment: scenario.sentiment,
      catalystDirection: scenario.catalystDirection,
      companyRelevance: scenario.relevance,
      eventImportance: scenario.importance,
      affectedTickers: [ticker, ...affected],
      affectedSectors: [sectorSlug],
      reasoning: scenario.reasoning,
      publishedAt: publishedAt.toISOString(),
      dedupeKey,
      articleCount,
      analysisSource: "hybrid",
      llmAnalysis: null,
      session,
      latestUpdateAt: publishedAt.toISOString(),
      benchmark,
      surpriseLabel: scenario.surpriseLabel,
      surprisePct: scenario.surprisePct,
      rvol: scenario.rvol,
      relativeStrengthPp: scenario.relativeStrengthPp,
      interpretation: buildInterpretation({
        catalystDirection: scenario.catalystDirection,
        eventTypeLabel: EVENT_TYPE_LABELS[scenario.eventType],
        surpriseLabel: scenario.surpriseLabel,
        surprisePct: scenario.surprisePct,
        rvol: scenario.rvol,
        relativeStrengthPp: scenario.relativeStrengthPp,
        benchmark,
      }),
    });

    for (const exp of scenario.expectations ?? []) {
      fundamentalExpectations.push({
        id: uuidFromRng(rng),
        ticker,
        fiscalPeriod: `FY${nowDate.getUTCFullYear()}Q${1 + (dayIndex % 4)}`,
        metric: exp.metric,
        consensus: exp.consensus,
        unit: exp.unit,
        asOf: new Date(publishedAt.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        source: "analyst-consensus",
      });
    }

    if (scenario.earnings) {
      const e = scenario.earnings;
      const epsSurprise = e.epsActual != null && e.epsConsensus
        ? round(((e.epsActual - e.epsConsensus) / Math.abs(e.epsConsensus)) * 100, 1)
        : null;
      const revenueSurprise = e.revenueActual != null && e.revenueConsensus
        ? round(((e.revenueActual - e.revenueConsensus) / Math.abs(e.revenueConsensus)) * 100, 1)
        : null;
      const guidanceSurprise = e.guidanceActual != null && e.guidanceConsensus
        ? round(((e.guidanceActual - e.guidanceConsensus) / Math.abs(e.guidanceConsensus)) * 100, 1)
        : null;
      earningsResults.push({
        id: uuidFromRng(rng),
        ticker,
        eventId,
        fiscalPeriod: `FY${nowDate.getUTCFullYear()}Q${1 + (dayIndex % 4)}`,
        reportedAt: publishedAt.toISOString(),
        epsActual: e.epsActual ?? null,
        epsConsensus: e.epsConsensus ?? null,
        epsSurprisePct: epsSurprise,
        revenueActual: e.revenueActual ?? null,
        revenueConsensus: e.revenueConsensus ?? null,
        revenueSurprisePct: revenueSurprise,
        guidanceActual: e.guidanceActual ?? null,
        guidanceConsensus: e.guidanceConsensus ?? null,
        guidanceSurprisePct: guidanceSurprise,
        yoyRevenueGrowthPct: e.yoyRevenueGrowthPct ?? null,
      });
    }
  };

  for (const [ticker, scenarioKey, dayIndex] of PLAN) {
    const day = days[dayIndex];
    // event timestamp: within the day (13:00–20:00 UTC window)
    const minutesOffset = 13 * 60 + randInt(rng, 0, 7 * 60);
    emitEvent(ticker, scenarioKey, dayIndex, new Date(day.getTime() + minutesOffset * 60 * 1000));
  }

  // Fresh events inside the last 3 hours (so the default feed is not stale) and
  // at least one event per demo ticker inside the last 24 hours.
  for (const [ticker, scenarioKey, minutesAgo, dayIndex] of RECENT_PLAN) {
    emitEvent(ticker, scenarioKey, dayIndex, new Date(nowDate.getTime() - minutesAgo * 60 * 1000));
  }

  // --- macro snapshots ---
  const macroSnapshots = [];
  for (const series of MACRO_SERIES) {
    let previous = series.base;
    for (let d = 0; d < 5; d += 1) {
      const ts = new Date(days[d].getTime() + 15 * 60 * 60 * 1000);
      const drift = (rng() - 0.5) * series.base * 0.02;
      const value = round(series.base + drift * (d + 1), series.digits);
      const change =
        series.kind === "level"
          ? previous === 0
            ? 0
            : round(((value - previous) / previous) * 100, 2)
          : round(value - previous, series.digits);
      macroSnapshots.push({
        id: uuidFromRng(rng),
        series: series.series,
        ts: ts.toISOString(),
        value,
        previousValue: previous,
        change,
        unit: series.unit,
      });
      previous = value;
    }
  }

  // --- market data snapshots (price / volume / technical) ---
  const priceSnapshots = [];
  const volumeSnapshots = [];
  const technicalSnapshots = [];
  const allTickers = [...COMPANIES.map((c) => c.ticker), ...BENCHMARK_TICKERS];

  for (const ticker of allTickers) {
    const anchor = ANCHOR_PRICES[ticker] ?? 100;
    const seedForTicker = hashString(`bars:${ticker}`);
    const adv = avgDailyVolume(ticker);
    let price = anchor * (1 + (rng() - 0.5) * 0.02);

    for (let d = 0; d < 5; d += 1) {
      const day = days[d];
      const dayRng = mulberry32(seedForTicker + d);
      const prevClose = price;
      const open = round(prevClose * (1 + (dayRng() - 0.5) * 0.01), 2);
      let cursor = open;
      let cumulative = 0;
      let prevCumulative = 0;
      let dayHigh = open;
      let dayLow = open;
      const barTimes = [];

      // intraday: 09:30 → 16:00 ET approximated as 13:30 → 20:00 UTC, 30m bars
      const startMin = 13 * 60 + 30;
      const barCount = 13;
      for (let b = 0; b < barCount; b += 1) {
        const ts = new Date(day.getTime() + (startMin + b * 30) * 60 * 1000);
        const marketMove = (dayRng() - 0.5) * anchor * 0.002;
        const idioMove = (dayRng() - 0.5) * anchor * 0.004;
        const next = round(Math.max(0.01, cursor + marketMove + idioMove), 2);
        const high = round(Math.max(cursor, next) * (1 + dayRng() * 0.0008), 2);
        const low = round(Math.min(cursor, next) * (1 - dayRng() * 0.0008), 2);
        const elapsed = (b + 1) * 30;
        const expectedVolumeToDate = Math.max(
          1,
          Math.floor(adv * volumeProfileFraction(elapsed)),
        );
        const rvolFactor = round(0.4 + dayRng() * 2.4, 2);
        cumulative = Math.round(expectedVolumeToDate * rvolFactor);
        const intervalVolume = Math.max(1, cumulative - prevCumulative);
        prevCumulative = cumulative;

        barTimes.push(ts.toISOString());
        priceSnapshots.push({
          id: uuidFromRng(rng),
          ticker,
          ts: ts.toISOString(),
          price: next,
          session: "regular",
          changePctDaily: round(((next - prevClose) / prevClose) * 100, 2),
          gapPct: round(((open - prevClose) / prevClose) * 100, 2),
          vwap: round((cursor + next) / 2, 2),
          high,
          low,
          open: b === 0 ? open : cursor,
          prevClose,
        });
        volumeSnapshots.push({
          id: uuidFromRng(rng),
          ticker,
          ts: ts.toISOString(),
          cumulativeVolume: cumulative,
          intervalVolume,
          expectedVolumeToDate,
          rvol: round(cumulative / Math.max(1, expectedVolumeToDate), 2),
        });
        technicalSnapshots.push({
          id: uuidFromRng(rng),
          ticker,
          ts: ts.toISOString(),
          vwap: round((cursor + next) / 2, 2),
          sma20: round(anchor * (0.98 + dayRng() * 0.04), 2),
          sma50: round(anchor * (0.96 + dayRng() * 0.06), 2),
          ema9: round(next * (0.995 + dayRng() * 0.01), 2),
          atr14: round(anchor * 0.012, 2),
          rsi14: round(40 + dayRng() * 30, 1),
          prevDayHigh: round(anchor * 1.03, 2),
          prevDayLow: round(anchor * 0.97, 2),
          dayHigh,
          dayLow,
          distFrom52wHighPct: round(-2 - dayRng() * 10, 2),
          gapPct: round(((open - prevClose) / prevClose) * 100, 2),
          conditions: [],
        });
        cursor = next;
        dayHigh = Math.max(dayHigh, high);
        dayLow = Math.min(dayLow, low);
      }
      price = cursor;
      void barTimes;
    }
  }

  // --- watchlists + alert rules ---
  const watchlistId = uuidFromRng(rng);
  const watchlists = [
    {
      id: watchlistId,
      userId: users[0].id,
      name: "AI & Semiconductors",
      description: "Default watchlist of high-attention names.",
      isDefault: true,
    },
  ];
  const watchlistStocks = ["NVDA", "AMD", "TSM", "AVGO", "MSFT"].map((ticker, idx) => ({
    id: uuidFromRng(rng),
    watchlistId,
    ticker,
    note: idx === 0 ? "Core position" : null,
    addedAt: new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  }));

  const alertRules = [
    {
      id: uuidFromRng(rng),
      userId: users[0].id,
      name: "High-impact events",
      description: "Flags events scoring 70 or higher.",
      conditions: { impact_score_gte: 70 },
      channels: ["log", "webhook"],
      enabled: true,
      cooldownMinutes: 30,
      matchCount: 0,
      lastTriggeredAt: null,
    },
    {
      id: uuidFromRng(rng),
      userId: users[0].id,
      name: "Earnings surprises",
      description: "Flags earnings and guidance events.",
      conditions: { event_types: ["EARNINGS", "GUIDANCE"] },
      channels: ["log"],
      enabled: true,
      cooldownMinutes: 15,
      matchCount: 0,
      lastTriggeredAt: null,
    },
    {
      id: uuidFromRng(rng),
      userId: users[0].id,
      name: "Semiconductor movers",
      description: "Flags semiconductor sector events with elevated volume.",
      conditions: { sectors: ["semiconductors"], rvol_gte: 1.5 },
      channels: ["log"],
      enabled: true,
      cooldownMinutes: 30,
      matchCount: 0,
      lastTriggeredAt: null,
    },
  ];

  // Recent-window events can share a fiscal period with a historical event;
  // keep a single row per unique key (later entries — the fresher events — win)
  // so the seed's unique constraints hold.
  const dedupeBy = (rows, keyFn) => {
    const map = new Map();
    for (const row of rows) {
      map.set(keyFn(row), row);
    }
    return [...map.values()];
  };

  return {
    users,
    sectors,
    companies,
    stocks,
    newsSources,
    newsArticles,
    marketEvents,
    eventArticles,
    eventTickers,
    fundamentalExpectations: dedupeBy(
      fundamentalExpectations,
      (r) => `${r.ticker}|${r.fiscalPeriod}|${r.metric}`,
    ),
    earningsResults: dedupeBy(earningsResults, (r) => `${r.ticker}|${r.fiscalPeriod}`),
    macroSnapshots,
    priceSnapshots,
    volumeSnapshots,
    technicalSnapshots,
    watchlists,
    watchlistStocks,
    alertRules,
  };
}

/** Articles for the MockNewsProvider historical backfill (same as the seed). */
export function backfillArticles({ now }) {
  const dataset = buildDataset({ now });
  return dataset.newsArticles;
}
