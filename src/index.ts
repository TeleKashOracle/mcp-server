#!/usr/bin/env node
/**
 * TeleKash Prediction Oracle — MCP Server
 *
 * The probability oracle for the agent economy.
 * Aggregates prediction markets from Kalshi (CFTC-regulated) and Polymarket into one API.
 *
 * "Chainlink is the price oracle. TeleKash is the probability oracle."
 *
 * Oracle Tools (26 live):
 * - get_probability: Real-time probability for any prediction market
 * - list_markets: Browse markets by category with filtering/sorting
 * - search_markets: Full-text search across all markets
 * - get_history: Historical probability changes with trend detection
 * - get_sentiment: AI sentiment analysis with recommendation
 * - get_market_stats: Aggregate statistics across all markets
 * - get_trending: Markets with biggest probability swings (momentum detection)
 * - compare_sources: Cross-source odds comparison (Kalshi vs Polymarket)
 * - detect_arbitrage: Cross-source arbitrage detection with buy/sell signals
 * - get_signal: Structured TPF signal (probability + confidence + sentiment + noise + verdict)
 * - track_prediction: Record a prediction for performance tracking
 * - get_performance: Agent accuracy metrics (Brier score, calibration, edge)
 * - get_divergences: Consensus divergence detection across all sources
 * - get_edge: Capital efficiency — Kelly Criterion optimal position sizing
 * - create_market: Create agent-powered prediction markets
 * - generate_api_key: Self-provision API keys for rate-limited access
 * - get_usage: Check current tier, usage, and rate limits
 * - register_alert: Webhook alerts for market events (Edge tier)
 * - list_alerts: List active webhook alerts
 * - delete_alert: Remove a webhook alert
 * - execute_trade: Route trades to Kalshi/Polymarket via smart broker (1% commission)
 * - get_order_status: Check broker order fill status
 * - cancel_order: Cancel pending broker orders
 *
 * @version 0.9.0
 * @author TeleKash <themagician@0xlaboratory.xyz>
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import {
  TeleKashBroker,
  type BrokerOrder,
  type BrokerResult,
  type NativePoolResult,
} from "./broker.js";
import {
  cacheGet,
  cacheSet,
  cachePrune,
  cacheStats,
  cacheEnforceSize,
  cacheClose,
  type CacheEntry,
} from "./cache.js";
import {
  createPaymentRequired,
  isX402Payment,
  extractPaymentProof,
  verifyPayment,
  formatX402Response,
  getToolPrice,
  stripPaymentArgs,
  type X402PaymentVerified,
} from "./x402.js";
import { OracleClient } from "./oracle/index.js";

// ============================================
// TIER SYSTEM — Free / Calibration ($0.01/query) / Edge ($0.05/query)
// ============================================

type Tier = "free" | "calibration" | "edge";

interface TierConfig {
  calls_per_day: number;
  sources: string[];
  tools: string[];
  price_per_query: number; // USD cost per tool call (0 = free)
  description: string;
}

const TIER_CONFIGS: Record<Tier, TierConfig> = {
  free: {
    calls_per_day: 100,
    sources: ["kalshi", "polymarket"],
    tools: [
      "get_probability",
      "list_markets",
      "search_markets",
      "get_history",
      "get_sentiment",
      "get_market_stats",
      "get_trending",
      "generate_api_key",
      "get_usage",
      "get_health",
    ],
    price_per_query: 0,
    description: "Free tier — 100 queries/day, intelligence tools",
  },
  calibration: {
    calls_per_day: 1000,
    sources: ["kalshi", "polymarket", "metaculus"],
    tools: [
      "get_probability",
      "list_markets",
      "search_markets",
      "get_history",
      "get_sentiment",
      "get_market_stats",
      "get_trending",
      "compare_sources",
      "detect_arbitrage",
      "get_divergences",
      "track_prediction",
      "get_performance",
      "get_resolution_status",
      "get_calibration_changelog",
      "generate_api_key",
      "get_usage",
      "get_health",
    ],
    price_per_query: 0.01,
    description:
      "Calibration tier — $0.01/query, cross-source analysis + calibration changelog",
  },
  edge: {
    calls_per_day: 999999,
    sources: ["kalshi", "polymarket", "metaculus"],
    tools: [
      "get_probability",
      "list_markets",
      "search_markets",
      "get_history",
      "get_sentiment",
      "get_market_stats",
      "get_trending",
      "compare_sources",
      "detect_arbitrage",
      "get_divergences",
      "track_prediction",
      "get_performance",
      "get_signal",
      "get_edge",
      "create_market",
      "get_calibration_changelog",
      "generate_api_key",
      "get_usage",
      "register_alert",
      "list_alerts",
      "delete_alert",
      "execute_trade",
      "get_order_status",
      "cancel_order",
      "export_data",
      "get_health",
    ],
    price_per_query: 0.05,
    description: "Edge tier — $0.05/query, signals + broker + pools + alerts",
  },
};

// Jurisdictional mapping — source to regulatory classification
const SOURCE_JURISDICTION: Record<
  string,
  { jurisdiction: string; regulatory_status: string; country: string }
> = {
  kalshi: {
    jurisdiction: "US-regulated",
    regulatory_status: "CFTC-regulated designated contract market (DCM)",
    country: "US",
  },
  polymarket: {
    jurisdiction: "international",
    regulatory_status: "Offshore, unregulated in most jurisdictions",
    country: "International",
  },
  metaculus: {
    jurisdiction: "forecasting",
    regulatory_status:
      "Forecasting platform — not gambling, immune to gambling regulation",
    country: "US",
  },
  agent: {
    jurisdiction: "unregulated",
    regulatory_status: "Agent-created market — no regulatory oversight",
    country: "N/A",
  },
  demo: {
    jurisdiction: "demo",
    regulatory_status: "Demo data — not real markets",
    country: "N/A",
  },
};

// Jurisdiction filter → source mapping
const JURISDICTION_SOURCES: Record<string, string[]> = {
  "US-regulated": ["kalshi"],
  international: ["polymarket"],
  forecasting: ["metaculus"],
  unregulated: ["agent"],
  all: [], // empty = no filter
};

// Tools that require specific tiers (used for error messages)
const TIER_REQUIRED: Record<string, Tier> = {
  compare_sources: "calibration",
  detect_arbitrage: "calibration",
  get_divergences: "calibration",
  track_prediction: "calibration",
  get_performance: "calibration",
  get_signal: "edge",
  get_edge: "edge",
  create_market: "edge",
  register_alert: "edge",
  list_alerts: "edge",
  delete_alert: "edge",
  execute_trade: "edge",
  get_order_status: "edge",
  cancel_order: "edge",
  get_pool_status: "edge",
  get_agent_balance: "edge",
  get_resolution_status: "calibration",
  get_calibration_changelog: "calibration",
  export_data: "edge",
};

// Types
interface Market {
  id: string;
  external_id: string;
  source: string;
  source_url: string;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  outcomes: string[];
  external_odds: { yes?: number; no?: number };
  status: "active" | "closed" | "resolved";
  closes_at: string;
  resolves_at: string | null;
  resolved_outcome: string | null;
  created_at: string;
  updated_at: string;
  raw_data: Record<string, unknown>;
}

interface ProbabilityResult {
  market_id: string;
  title: string;
  source: string;
  yes_probability: number;
  no_probability: number;
  volume_24h: number;
  liquidity: number;
  status: string;
  closes_at: string;
  last_updated: string;
}

interface MarketListItem {
  id: string;
  title: string;
  category: string;
  source: string;
  yes_probability: number;
  volume_24h: number;
  closes_at: string;
  status: string;
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "get_probability",
    description: `Get real-time probability, odds, and likelihood for any prediction market outcome.

Returns YES/NO probabilities (0-100%), trading volume, liquidity depth, and market metadata from Kalshi (CFTC-regulated) and Polymarket.
Use this when asked about chances, odds, likelihood, forecasts, or predictions for any event — elections, crypto prices, sports, economics, weather, entertainment.

Example queries:
- "What are the odds Trump wins 2028?" → election forecasting
- "What's the probability BTC hits $200K?" → crypto price prediction
- "Will the Fed cut rates?" → economic forecasting, interest rates
- "What's the chance of rain in NYC?" → weather betting
- "Who will win the Super Bowl?" → sports odds

Keywords: forecasting, prediction odds, what are the chances, likelihood, will something happen, binary outcome probability, event prediction, market odds lookup, probability forecast, future event odds, outcome likelihood`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "The market UUID or external_id (ticker) to query",
        },
        query: {
          type: "string",
          description:
            "Natural language query to search for a market (alternative to market_id)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_markets",
    description: `Browse and discover prediction markets across 7 categories with filtering and sorting.

Lists active betting markets from Kalshi, Polymarket, and Metaculus. Filter by category, sort by trading volume, probability, or closing date. 500+ markets available.
Categories: sports, crypto, politics, economics, pop_culture, weather, other.
Use when exploring what predictions are available, finding trending markets, or discovering betting opportunities.

Example queries:
- "Show me crypto prediction markets" → Bitcoin, Ethereum, altcoin forecasts
- "What sports markets are trending?" → NFL, NBA, soccer odds
- "List political predictions" → elections, legislation, geopolitics
- "What economic forecasts are available?" → GDP, inflation, interest rates

Keywords: browse prediction markets, find betting opportunities, explore categories, crypto politics sports science markets, active markets catalog, market directory, available predictions, what can I bet on`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: [
            "all",
            "sports",
            "crypto",
            "politics",
            "economics",
            "pop_culture",
            "weather",
            "other",
          ],
          description: "Filter by category (default: all)",
        },
        sort_by: {
          type: "string",
          enum: ["volume", "probability", "closing_date"],
          description: "Sort order (default: volume)",
        },
        limit: {
          type: "number",
          description: "Maximum markets to return (default: 10, max: 50)",
        },
        source: {
          type: "string",
          enum: ["all", "kalshi", "polymarket", "metaculus"],
          description: "Filter by data source (default: all)",
        },
        jurisdiction: {
          type: "string",
          enum: ["all", "US-regulated", "international", "forecasting"],
          description:
            "Filter by regulatory jurisdiction. US-regulated = Kalshi (CFTC-regulated), international = Polymarket, forecasting = Metaculus (not gambling). Default: all.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_history",
    description: `Get historical probability changes and trend data for a prediction market over time.

Returns probability snapshots showing how odds, sentiment, and market consensus have shifted over 1h, 24h, 7d, or 30d.
Use for trend analysis, momentum detection, volatility assessment, and understanding how predictions evolve.
Essential for backtesting strategies, identifying probability swings, and spotting market-moving events.

Keywords: probability timeline, how odds changed, trend analysis, momentum detection, historical price movement, odds trajectory, price history, probability over time, how has the market moved`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "The market UUID or external_id (ticker)",
        },
        timeframe: {
          type: "string",
          enum: ["1h", "24h", "7d", "30d"],
          description: "Time range for history (default: 24h)",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "search_markets",
    description: `Search 500+ prediction markets by keyword, topic, or natural language query.

Full-text search across Kalshi, Polymarket, and Metaculus. Finds markets matching any topic — politics, crypto, sports, economics, entertainment, science, technology, weather.
Returns matching active markets sorted by relevance and trading volume.
Use when looking for specific predictions, events, or outcomes to bet on.

Example queries:
- "Trump election 2028" → presidential race odds
- "Bitcoin price prediction" → BTC price target markets
- "Super Bowl winner" → NFL championship odds
- "AI regulation" → technology policy predictions
- "Fed interest rate" → monetary policy forecasts

Keywords: find specific prediction market, search by topic, keyword search, market discovery, find predictions about, topic search, event lookup, query markets`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'Trump', 'Bitcoin', 'Super Bowl')",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_sentiment",
    description: `Get AI-powered sentiment analysis, recommendation, and confidence score for any prediction market.

Returns sentiment score (-1 to 1), actionable recommendation (bullish/bearish/neutral), and AI confidence level.
Goes beyond raw probability — analyzes market psychology, crowd wisdom, and directional bias.
Use for trade signals, contrarian analysis, or augmenting your own prediction models with market sentiment data.

Keywords: market sentiment analysis, bullish or bearish, conviction scoring, should I buy or sell, crowd wisdom, contrarian signal, market psychology, directional bias, trading recommendation`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "The market UUID or external_id (ticker)",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "get_market_stats",
    description: `Get aggregate statistics across all prediction markets — totals, categories, sources, and volume.

Returns total market count, active markets, category distribution, source breakdown (Kalshi vs Polymarket), and aggregate trading volume.
Use for market overview, portfolio allocation decisions, or understanding the prediction market landscape.

Keywords: aggregate statistics, market overview, total volume, market count, category breakdown, platform health, how many markets, prediction market summary`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // ===========================================
  // MOMENTUM & CROSS-SOURCE TOOLS (v0.4.0)
  // ===========================================
  {
    name: "get_trending",
    description: `Get prediction markets with the biggest probability swings — momentum detection for trending events.

Finds markets where odds moved most in the last 1h, 24h, 7d, or 30d. Surfaces breaking events, sentiment shifts, and market-moving news.
Use when looking for actionable opportunities, volatile markets, or events where consensus is rapidly changing.
Returns markets ranked by absolute probability change with direction (up/down) and current odds.

Keywords: hot markets, biggest movers, momentum detection, breaking news markets, probability swings, what is moving now, volatile markets, rapid odds change, trending predictions`,
    inputSchema: {
      type: "object" as const,
      properties: {
        timeframe: {
          type: "string",
          enum: ["1h", "24h", "7d", "30d"],
          description: "Lookback window for detecting swings (default: 24h)",
        },
        limit: {
          type: "number",
          description: "Maximum markets to return (default: 10, max: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "compare_sources",
    description: `Compare prediction odds across Kalshi and Polymarket for the same event — find pricing discrepancies.

Searches for markets matching your query on both Kalshi (CFTC-regulated) and Polymarket, then shows side-by-side probabilities.
Use for arbitrage detection, cross-validating predictions, or understanding how regulated vs unregulated markets price the same event.
Returns matched pairs with probability delta and which source is more bullish/bearish.

Keywords: cross-source comparison, Kalshi vs Polymarket odds, price discrepancy, which source is right, odds comparison, multi-exchange pricing, regulatory arbitrage, consensus disagreement`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query to find matching markets across sources (e.g., 'Trump', 'Bitcoin', 'Fed rate')",
        },
      },
      required: ["query"],
    },
  },
  // ===========================================
  // ARBITRAGE & INTELLIGENCE TOOLS (v0.5.0)
  // ===========================================
  {
    name: "detect_arbitrage",
    description: `Detect cross-source arbitrage opportunities between Kalshi and Polymarket.

Scans all active markets to find events priced differently across regulated (Kalshi) and unregulated (Polymarket) prediction markets.
Returns actionable opportunities sorted by spread size, with buy/sell signals for each side.

Academic research shows $40M+ extracted from prediction market mispricings annually. Cross-source spreads are structural — different regulation, user bases, and liquidity create persistent pricing gaps.

Use when looking for:
- Arbitrage opportunities between prediction market exchanges
- Mispriced markets where consensus disagrees across sources
- Risk-free profit opportunities from cross-source spread trading

Example: If Kalshi prices "BTC $200K" at 35% and Polymarket at 28%, that's a 7% spread — buy YES on Polymarket, sell YES on Kalshi.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        min_spread: {
          type: "number",
          description:
            "Minimum probability spread percentage to flag as arbitrage (default: 5, range: 1-50)",
        },
        category: {
          type: "string",
          enum: [
            "all",
            "sports",
            "crypto",
            "politics",
            "economics",
            "pop_culture",
            "weather",
            "other",
          ],
          description: "Filter by category (default: all)",
        },
        limit: {
          type: "number",
          description:
            "Maximum arbitrage opportunities to return (default: 10, max: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_signal",
    description: `Get a structured pre-computed trading signal for any prediction market — TeleKash Probability Format (TPF).

Combines probability, confidence, sentiment, noise filter, and cross-source data into one actionable signal. This is the complete intelligence package for autonomous agents.

Returns:
- probability with confidence grade (HIGH/MEDIUM/LOW/VERY_LOW)
- sentiment score with recommendation (bullish/bearish/neutral)
- noise filter (signal/weak/noise) — is this momentum real or random walk?
- cross-source spread (if market exists on multiple exchanges)
- actionable verdict: STRONG_BUY / BUY / HOLD / SELL / STRONG_SELL / NO_SIGNAL

Use this as the single entry point when an agent needs to make a trade decision. One call replaces get_probability + get_sentiment + get_history + compare_sources.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "The market UUID or external_id (ticker)",
        },
        query: {
          type: "string",
          description:
            "Natural language query to find the market (alternative to market_id)",
        },
      },
      required: [],
    },
  },
  {
    name: "track_prediction",
    description: `Record a prediction for performance tracking. Agents can log their predictions and later check accuracy via get_performance.

Records: which market, predicted outcome (YES/NO), predicted probability, and confidence level. When the market resolves, your Brier score and calibration are computed automatically.

Use this to build a track record. Agents with verified accuracy get higher trust scores.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "The market UUID or external_id",
        },
        agent_id: {
          type: "string",
          description:
            "Your agent identifier (any string — use consistently across predictions)",
        },
        predicted_outcome: {
          type: "string",
          enum: ["YES", "NO"],
          description: "Your predicted outcome",
        },
        predicted_probability: {
          type: "number",
          description:
            "Your estimated probability (0.0-1.0) that YES wins. Required for Brier score.",
        },
        reasoning: {
          type: "string",
          description: "Brief reasoning for the prediction (optional)",
        },
      },
      required: [
        "market_id",
        "agent_id",
        "predicted_outcome",
        "predicted_probability",
      ],
    },
  },
  {
    name: "get_performance",
    description: `Get prediction performance metrics for an agent. Shows accuracy, Brier score, calibration, and prediction history.

Returns:
- Total predictions and resolution rate
- Accuracy (% correct)
- Brier score (0 = perfect, 1 = worst — lower is better)
- Calibration curve (predicted probability vs actual outcome rate)
- Recent predictions with outcomes

Use this to evaluate an agent's forecasting ability or track your own improvement over time.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "The agent identifier to check performance for",
        },
        limit: {
          type: "number",
          description:
            "Number of recent predictions to return (default: 20, max: 100)",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "get_divergences",
    description: `Find markets where prediction sources disagree — the highest-value signal in forecasting.

When Kalshi, Polymarket, and Metaculus show different probabilities for the same event, at least one source is wrong. This tool finds those disagreements, ranked by spread size.

Returns:
- Markets with the largest cross-source probability gaps
- Which source says what
- Forecaster count from Metaculus (crowd wisdom depth)
- Divergence classification: STRONG (>15%), MODERATE (8-15%), WEAK (3-8%)

These are the markets where alpha exists. When sources converge, the edge disappears.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        min_spread: {
          type: "number",
          description:
            "Minimum probability spread to include (default: 5 = 5%)",
        },
        category: {
          type: "string",
          description:
            "Filter by category (crypto, politics, economics, sports, weather, other)",
        },
        limit: {
          type: "number",
          description: "Number of divergences to return (default: 10, max: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_edge",
    description: `Capital efficiency analysis — find markets with the best risk/reward for a given bankroll.

Uses Kelly Criterion to compute optimal position sizes and expected value. Returns markets ranked by edge (expected profit per dollar risked).

For each market:
- Edge = your estimated probability minus market probability
- Kelly fraction = optimal % of bankroll to allocate
- Expected value per dollar risked
- Risk classification (conservative/moderate/aggressive)

Use this when an agent has limited capital and needs to maximize expected returns. Pairs with get_signal for probability estimates and track_prediction for accuracy tracking.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        bankroll: {
          type: "number",
          description:
            "Total capital available for allocation (in dollars, default: 1000)",
        },
        agent_id: {
          type: "string",
          description:
            "Agent ID — uses your prediction history to estimate your edge (optional but recommended)",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        min_confidence: {
          type: "string",
          description:
            "Minimum confidence grade to include (HIGH, MEDIUM, LOW — default: MEDIUM)",
        },
        limit: {
          type: "number",
          description:
            "Number of opportunities to return (default: 10, max: 30)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_market",
    description: `Create a custom prediction market on TeleKash. Markets are binary YES/NO questions that resolve on a specified date.

Markets created via this tool are tagged as "agent-created" and appear alongside Kalshi/Polymarket/Metaculus markets. Other agents can query, predict on, and trade these markets.

Requirements:
- Clear YES/NO question in the title
- Resolution date in the future
- Category for discoverability
- Resolution criteria (how to determine the outcome)

Created markets start with 50/50 odds. Probability moves as predictions come in.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description:
            "The prediction question (should be answerable with YES or NO)",
        },
        description: {
          type: "string",
          description: "Detailed description and context for the market",
        },
        category: {
          type: "string",
          enum: [
            "crypto",
            "politics",
            "economics",
            "sports",
            "weather",
            "other",
          ],
          description: "Market category",
        },
        closes_at: {
          type: "string",
          description: "When trading closes (ISO 8601 datetime)",
        },
        resolves_at: {
          type: "string",
          description:
            "When the market resolves (ISO 8601 datetime, must be after closes_at)",
        },
        resolution_criteria: {
          type: "string",
          description:
            "How the outcome will be determined (e.g., 'Based on CoinGecko BTC price at midnight UTC')",
        },
        creator_id: {
          type: "string",
          description:
            "Agent identifier creating this market (used for attribution)",
        },
      },
      required: [
        "title",
        "category",
        "closes_at",
        "resolves_at",
        "resolution_criteria",
        "creator_id",
      ],
    },
  },
  // ===========================================
  // AGENT TRADING TOOLS — Coming soon (pool infrastructure built, awaiting liquidity)
  // Uncomment when agent pools are funded and active
  // Tools: get_pool_status, execute_trade, get_agent_positions, get_recommended_position_size
  // ===========================================
  // ===========================================
  // API KEY MANAGEMENT
  // ===========================================
  {
    name: "generate_api_key",
    description: `Generate a free TeleKash API key for rate-limited access to prediction market intelligence.

Free tier: 100 calls/day, 7 core tools (probability, markets, search, history, sentiment, stats, trending).
Calibration tier ($0.01/query): 1,000 calls/day + arbitrage, divergence, and performance tracking tools.
Edge tier ($0.05/query): Unlimited + TPF signals, Kelly sizing, and market creation.

The API key is returned ONCE — save it immediately. Set it as TELEKASH_API_KEY environment variable.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        owner_id: {
          type: "string",
          description:
            "Your agent or user identifier (used for key management)",
        },
        owner_email: {
          type: "string",
          description: "Contact email (optional, for billing if upgrading)",
        },
      },
      required: ["owner_id"],
    },
  },
  {
    name: "get_usage",
    description: `Check your current API usage, rate limits, and tier status.

Returns calls made today, calls remaining, tier, and upgrade options.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // ===========================================
  // WEBHOOK ALERT TOOLS (Edge tier)
  // ===========================================
  {
    name: "register_alert",
    description: `Register a webhook alert for prediction market events. When the condition is met, TeleKash POSTs TPF-formatted data to your callback URL.

Available conditions:
- probability_crosses_above: Triggered when market probability rises above threshold (e.g., 70%)
- probability_crosses_below: Triggered when market probability falls below threshold (e.g., 30%)
- mispricing_detected: Triggered when cross-source spread exceeds threshold (e.g., 5%)
- volume_spike: Triggered when 1h volume exceeds threshold multiple of average
- resolution: Triggered when market resolves (no threshold needed)
- divergence_detected: Triggered when any source disagrees beyond threshold

Alerts auto-expire after 30 days. Cooldown prevents duplicate triggers (default: 60 min).
Event-driven, not polling — your agent sleeps until we wake it up.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "Your agent identifier",
        },
        market_id: {
          type: "string",
          description:
            "Market UUID or external_id. Omit for cross-market alerts (mispricing, divergence)",
        },
        condition: {
          type: "string",
          enum: [
            "probability_crosses_above",
            "probability_crosses_below",
            "mispricing_detected",
            "volume_spike",
            "resolution",
            "divergence_detected",
          ],
          description: "What event triggers the alert",
        },
        threshold: {
          type: "number",
          description:
            "Trigger threshold (probability %, spread %, or volume multiplier). Not needed for 'resolution'.",
        },
        callback_url: {
          type: "string",
          description:
            "URL to POST alert data to when triggered (must be https)",
        },
        cooldown_minutes: {
          type: "number",
          description:
            "Minimum minutes between triggers for this alert (default: 60)",
        },
      },
      required: ["agent_id", "condition", "callback_url"],
    },
  },
  {
    name: "list_alerts",
    description: `List all active webhook alerts for your agent. Shows condition, threshold, last triggered, and delivery stats.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "Your agent identifier",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "delete_alert",
    description: `Delete a webhook alert by ID. The alert will stop firing immediately.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        alert_id: {
          type: "string",
          description: "The alert UUID to delete",
        },
      },
      required: ["alert_id"],
    },
  },
  // ===== BROKER TOOLS (Edge tier) =====
  {
    name: "execute_trade",
    description: `Execute a prediction market trade through TeleKash Broker.

Routes your order to the best exchange (Kalshi or Polymarket) based on where the market trades.
Or route to native_pool to join TeleKash parimutuel pools — trade alongside Telegram users.

Commission: 1% for exchange trades, 5% pool fee for native pools (deducted at resolution).
Requires: Edge tier API key. Exchange credentials for Kalshi/Polymarket routing. Native pool requires funded agent balance.

Native pool benefits: Your USD converts to Stars-equivalent, joining the SAME pool as Telegram mini app users.
More participants = deeper liquidity = better odds for everyone. Payout at resolution.

Returns: order_id, fill_price, commission, routing details. For native_pool: position_id, pool_composition.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description:
            "TeleKash market UUID or external_id (Kalshi ticker or Polymarket condition_id)",
        },
        side: {
          type: "string",
          enum: ["yes", "no"],
          description: "Which outcome to buy: 'yes' or 'no'",
        },
        amount_usd: {
          type: "number",
          description: "Trade amount in USD. Min $1, max $10,000 per order.",
        },
        order_type: {
          type: "string",
          enum: ["market", "limit"],
          description:
            "Order type: 'market' (fill at best available price) or 'limit' (fill at limit_price or better). Default: market.",
        },
        limit_price: {
          type: "number",
          description:
            "Limit price as probability 0-1 (e.g. 0.65 = 65 cents). Required for limit orders. Ignored for market orders.",
        },
        routing_preference: {
          type: "string",
          enum: ["kalshi", "polymarket", "best_price", "native_pool"],
          description:
            "Where to route: 'kalshi', 'polymarket', 'best_price' (default — routes to source exchange), or 'native_pool' (join TeleKash parimutuel pool alongside Telegram users). Native pool requires funded agent balance.",
        },
      },
      required: ["market_id", "side", "amount_usd"],
    },
  },
  {
    name: "get_order_status",
    description: `Check the status of a broker order placed through execute_trade.

Returns current fill status, price, amount filled, and commission.
Queries the exchange directly for the latest status.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "TeleKash broker order UUID (returned by execute_trade)",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "cancel_order",
    description: `Cancel a pending or submitted broker order.

Only works for orders that haven't been fully filled yet.
Sends cancellation to the exchange and updates the order status.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "TeleKash broker order UUID to cancel",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "get_pool_status",
    description: `Get the current status of a TeleKash native parimutuel pool.

Shows pool composition (YES/NO volume), participant counts (humans vs agents),
current implied odds, and whether the pool is one-sided or two-sided.

Use this before joining a pool via execute_trade with routing_preference='native_pool'
to understand the current pool dynamics.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "TeleKash market UUID",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "get_agent_balance",
    description: `Check your agent's pool balance and performance stats.

Shows: current USD balance, total deposited, total won/lost, pool position count, win rate.
Balance is credited from pool resolution payouts and depleted by native pool entries.

Fund your balance via Stripe (through the TeleKash dashboard) to trade in native pools.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_resolution_status",
    description: `Check resolution status and confidence for a market.

Shows multi-source verification results: which sources confirmed the outcome,
confidence level, and whether manual review is needed.

Resolution confidence levels:
- 0.99: Price-based (CoinGecko) — objective, verifiable
- 0.95: Multi-source agreement (2+ sources confirm same outcome)
- 0.825: Cross-verified by 1 additional source
- 0.70: Single source only (no cross-verification available)
- 0.30: Sources DISAGREE — flagged for manual review

Use this to verify resolution integrity before accepting payout results.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "Market ID to check resolution status",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "export_data",
    description: `Export structured prediction market data in bulk. Historical probabilities, resolution outcomes, market catalogs, and arbitrage history.

Types: probability_history (how odds changed over time), resolution_outcomes (how markets resolved), market_catalog (all active markets with metadata), arbitrage_history (cross-source price gaps).

Returns structured JSON or CSV format. Max 1000 records per export.

Keywords: bulk data export, historical data, prediction dataset, market data feed, data licensing, research data, backtesting data, probability timeseries`,
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: [
            "probability_history",
            "resolution_outcomes",
            "market_catalog",
            "arbitrage_history",
          ],
          description: "Type of data to export",
        },
        market_id: {
          type: "string",
          description: "Specific market ID (optional — omit for all markets)",
        },
        category: {
          type: "string",
          description: "Filter by category (crypto, politics, sports, etc.)",
        },
        limit: {
          type: "number",
          description: "Max records to return (default 100, max 1000)",
        },
        format: {
          type: "string",
          enum: ["json", "csv"],
          description: "Output format (default: json)",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "get_health",
    description: `System health check — Supabase connectivity, broker exchange status, cache stats, data freshness, market count, and AXIOM structural audit.

Use this to verify the oracle is operational before relying on its data. Includes self-audit scores (AXIOM/AXIOS/VOID) for calibration health, data source freshness, and pipeline integrity.

Keywords: health check, system status, uptime, connectivity, is it working, API status, service health, audit, integrity`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_calibration_changelog",
    description: `View the oracle's calibration history — when and how Platt scaling parameters changed across domains.

Each ORBIT cycle (daily 3am UTC) recalibrates the oracle using resolved prediction outcomes. This tool shows the versioned history of those changes, including before/after Platt parameters, ECE (Expected Calibration Error), and sample counts.

Use this to understand how the oracle improves over time, verify calibration integrity, or debug prediction accuracy changes.

Keywords: calibration history, oracle learning, self-improvement, Platt scaling, ECE, calibration version, accuracy changelog`,
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description:
            "Filter by domain (general, sports, politics, crypto, science). Omit for all domains.",
          enum: ["general", "sports", "politics", "crypto", "science"],
        },
        limit: {
          type: "number",
          description:
            "Number of changelog entries to return (default 20, max 100)",
        },
      },
    },
  },
];

// Confidence score computation — volume-weighted probability conviction
function computeConfidence(market: {
  volume: number;
  liquidity: number;
  yesProbability: number;
  closesAt: string;
}): {
  score: number;
  grade: string;
  factors: {
    volume_conviction: number;
    liquidity_depth: number;
    probability_conviction: number;
    time_decay: number;
  };
  warning: string | null;
} {
  // Volume conviction (0-1): log-scaled, $1M+ = max
  const vol = Math.max(0, market.volume);
  const volumeConviction = Math.min(1, Math.log10(Math.max(1, vol)) / 6);

  // Liquidity depth (0-1): log-scaled, $100K+ = max
  const liq = Math.max(0, market.liquidity);
  const liquidityDepth = Math.min(1, Math.log10(Math.max(1, liq)) / 5);

  // Probability conviction (0-1): extreme probabilities (<10% or >90%) = high conviction
  // Probabilities near 50% = low conviction (maximum uncertainty)
  const prob = market.yesProbability / 100;
  const probConviction = Math.abs(prob - 0.5) * 2; // 0 at 50%, 1 at 0% or 100%

  // Time decay (0-1): markets closing soon have more reliable prices
  const now = Date.now();
  const closes = new Date(market.closesAt).getTime();
  const hoursLeft = Math.max(0, (closes - now) / (1000 * 60 * 60));
  const timeDecay =
    hoursLeft <= 0 ? 1 : hoursLeft <= 24 ? 0.9 : hoursLeft <= 168 ? 0.7 : 0.5;

  // Weighted composite (volume matters most)
  const score =
    volumeConviction * 0.4 +
    liquidityDepth * 0.2 +
    probConviction * 0.2 +
    timeDecay * 0.2;

  const roundedScore = Math.round(score * 100) / 100;

  const grade =
    roundedScore >= 0.8
      ? "HIGH"
      : roundedScore >= 0.5
        ? "MEDIUM"
        : roundedScore >= 0.3
          ? "LOW"
          : "VERY_LOW";

  let warning: string | null = null;
  if (vol < 1000)
    warning = "Thin market — price may not reflect true consensus";
  else if (liq < 500)
    warning = "Low liquidity — large orders would move the price significantly";

  return {
    score: roundedScore,
    grade,
    factors: {
      volume_conviction: Math.round(volumeConviction * 100) / 100,
      liquidity_depth: Math.round(liquidityDepth * 100) / 100,
      probability_conviction: Math.round(probConviction * 100) / 100,
      time_decay: Math.round(timeDecay * 100) / 100,
    },
    warning,
  };
}

// Verdict reasoning — human-readable explanation of the TPF verdict
function buildVerdictReasoning(
  verdict: string,
  confidenceGrade: string,
  signalQuality: string,
  sentiment: string,
  crossSource: Record<string, unknown> | null,
  momentum: number,
): string {
  const parts: string[] = [];

  if (verdict === "NO_SIGNAL") {
    return "Insufficient data to generate a reliable signal. Low confidence and no momentum history.";
  }

  // Sentiment direction
  if (sentiment === "bullish") parts.push("Market sentiment is bullish");
  else if (sentiment === "bearish") parts.push("Market sentiment is bearish");
  else parts.push("Market sentiment is neutral");

  // Confidence qualifier
  if (confidenceGrade === "HIGH")
    parts.push("with high confidence (strong volume + liquidity)");
  else if (confidenceGrade === "MEDIUM") parts.push("with moderate confidence");
  else parts.push("but confidence is low (thin market)");

  // Momentum
  if (signalQuality === "signal" && Math.abs(momentum) > 0.01) {
    parts.push(
      `Sustained ${momentum > 0 ? "upward" : "downward"} momentum (${Math.round(momentum * 100)}% in 24h)`,
    );
  } else if (signalQuality === "noise") {
    parts.push("24h momentum appears to be noise (high reversal rate)");
  }

  // Cross-source
  if (crossSource && (crossSource.spread_pct as number) >= 5) {
    parts.push(
      `Cross-source spread of ${crossSource.spread_pct}% detected — potential arbitrage`,
    );
  }

  return parts.join(". ") + ".";
}

// Server class
class TeleKashMCPServer {
  private server: Server;
  private supabase: SupabaseClient | null = null;
  private tier: Tier = "free";
  private apiKeyId: string | null = null;
  private apiKeyHash: string | null = null;
  private callsRemaining: number = 100;
  private sessionCost: number = 0;
  private broker: TeleKashBroker;
  private oracle: OracleClient;
  private requestTimestamps: number[] = [];
  private paymentAddress: string | null = null;
  private readonly BURST_LIMITS: Record<Tier, number> = {
    free: 5, // 5 requests/second
    calibration: 20, // 20 requests/second
    edge: 100, // 100 requests/second
  };

  /**
   * Execute a query with cache fallback.
   * On success: caches result. On failure: returns cached version if available.
   * Graceful degradation: if live fails, serve cached. Never serve nothing.
   */
  private async cachedQuery<T>(
    cacheKey: string,
    category:
      | "markets"
      | "market_detail"
      | "probabilities"
      | "trending"
      | "stats"
      | "default",
    queryFn: () => Promise<T>,
  ): Promise<{ data: T; fromCache: boolean; freshness?: string }> {
    try {
      // Try live query
      const result = await queryFn();
      // Cache the successful result
      cacheSet(cacheKey, result, category);
      return { data: result, fromCache: false };
    } catch (err) {
      // Live query failed — try cache
      console.error(`[TeleKash MCP] Query failed, checking cache: ${cacheKey}`);
      const cached = cacheGet<T>(cacheKey, true); // allowStale = true
      if (cached) {
        console.error(
          `[TeleKash MCP] Serving from cache (age: ${Math.round(cached.age_seconds / 60)}min)`,
        );
        return {
          data: cached.data,
          fromCache: true,
          freshness: cached.freshness,
        };
      }
      // No cache either — re-throw
      throw err;
    }
  }

  constructor() {
    this.broker = new TeleKashBroker();
    this.oracle = new OracleClient();

    // Prune expired cache entries on startup
    try {
      const pruned = cachePrune();
      cacheEnforceSize();
      if (pruned > 0)
        console.error(`[TeleKash MCP] Pruned ${pruned} expired cache entries`);
    } catch {
      // Cache init failure is non-fatal
    }

    this.server = new Server(
      {
        name: "telekash-oracle",
        version: "0.9.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    );

    this.initializeSupabase();
    this.initializeApiKey();
    this.initializeX402();
    this.setupHandlers();
  }

  private initializeSupabase(): void {
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.TELEKASH_SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_ANON_KEY || process.env.TELEKASH_SUPABASE_KEY;

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      console.error("[TeleKash MCP] Connected to Supabase");
      // Initialize fractal oracle systems (HELIX calibration, MAG profiles)
      this.oracle
        .initialize(this.supabase)
        .catch((err) => console.error("[Oracle] Background init:", err));
    } else {
      console.error(
        "[TeleKash MCP] Warning: No Supabase credentials. Using mock data.",
      );
    }
  }

  private initializeApiKey(): void {
    const apiKey = process.env.TELEKASH_API_KEY;
    if (apiKey) {
      this.apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
      console.error(
        `[TeleKash MCP] API key detected (${apiKey.substring(0, 16)}...)`,
      );
    } else {
      console.error(
        "[TeleKash MCP] No API key — running in free tier (100 calls/day)",
      );
    }
  }

  private initializeX402(): void {
    const addr = process.env.TELEKASH_PAYMENT_ADDRESS;
    if (addr) {
      this.paymentAddress = addr;
      console.error(
        `[TeleKash MCP] x402 payments enabled (${addr.substring(0, 10)}...)`,
      );
    } else {
      console.error(
        "[TeleKash MCP] No TELEKASH_PAYMENT_ADDRESS — x402 micropayments disabled",
      );
    }
  }

  private async checkTierAccess(toolName: string): Promise<{
    allowed: boolean;
    tier: Tier;
    error?: string;
  }> {
    // If we have an API key + Supabase, check against DB
    if (this.apiKeyHash && this.supabase) {
      const { data, error } = await this.supabase.rpc("check_rate_limit", {
        p_key_hash: this.apiKeyHash,
      });

      if (error) {
        console.error("[TeleKash MCP] Rate limit check error:", error.message);
        // Fail open — don't block if DB is down
        return { allowed: true, tier: this.tier };
      }

      if (!data.allowed) {
        if (data.reason === "invalid_key") {
          return {
            allowed: false,
            tier: "free",
            error:
              "Invalid API key. Get a free key at https://t.me/TeleKashBot or use without a key for free tier.",
          };
        }
        if (data.reason === "rate_limited") {
          return {
            allowed: false,
            tier: data.tier,
            error: `Rate limit exceeded. ${data.tier} tier: ${data.limit} calls/day. Resets at ${data.resets_at}. Upgrade at https://t.me/TeleKashBot`,
          };
        }
        if (data.reason === "key_expired") {
          return {
            allowed: false,
            tier: "free",
            error:
              "API key expired. Generate a new one at https://t.me/TeleKashBot",
          };
        }
        return { allowed: false, tier: "free", error: data.reason };
      }

      // Update local tier info
      this.tier = data.tier;
      this.apiKeyId = data.key_id;
      this.callsRemaining = data.remaining;
    }

    // Check tool access for the current tier
    const tierConfig = TIER_CONFIGS[this.tier];
    if (!tierConfig.tools.includes(toolName)) {
      const requiredTier = TIER_REQUIRED[toolName] || "edge";
      return {
        allowed: false,
        tier: this.tier,
        error: `${toolName} requires ${requiredTier} tier ($${TIER_CONFIGS[requiredTier].price_per_query}/query). Current tier: ${this.tier}. Upgrade at https://t.me/TeleKashBot`,
      };
    }

    return { allowed: true, tier: this.tier };
  }

  private checkBurstLimit(): { allowed: boolean; error?: string } {
    const now = Date.now();
    const windowMs = 1000; // 1 second window

    // Remove timestamps older than the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < windowMs,
    );

    const limit = this.BURST_LIMITS[this.tier] || 5;
    if (this.requestTimestamps.length >= limit) {
      return {
        allowed: false,
        error: `Burst rate limit exceeded: ${limit} requests/second for ${this.tier} tier. Wait ${Math.ceil(this.requestTimestamps[0] + windowMs - now)}ms.`,
      };
    }

    this.requestTimestamps.push(now);
    return { allowed: true };
  }

  private async logUsage(
    toolName: string,
    startTime: number,
    argsHash?: string,
  ): Promise<void> {
    if (!this.supabase) return;

    const responseTimeMs = Date.now() - startTime;
    const tierConfig = TIER_CONFIGS[this.tier];
    const queryCost = tierConfig.price_per_query;

    try {
      await this.supabase.from("telekash_usage_logs").insert({
        api_key_id: this.apiKeyId,
        tool_name: toolName,
        tier: this.tier,
        args_hash: argsHash,
        response_time_ms: responseTimeMs,
        query_cost_usd: queryCost,
      });

      // Track cumulative revenue from per-query pricing
      if (queryCost > 0) {
        try {
          await this.supabase.from("telekash_revenue").insert({
            source: "query_fee",
            amount_usd: queryCost,
            amount_stars: 0,
            details: {
              tool_name: toolName,
              tier: this.tier,
              api_key_id: this.apiKeyId,
              response_time_ms: responseTimeMs,
            },
          });
        } catch {
          // Revenue tracking is best-effort
        }
      }
    } catch {
      // Don't fail the request if logging fails
    }
  }

  private setupHandlers(): void {
    // List available tools — filtered by tier
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tierConfig = TIER_CONFIGS[this.tier];
      const visibleTools = TOOLS.filter((t) =>
        tierConfig.tools.includes(t.name),
      );
      return { tools: visibleTools };
    });

    // List resources — includes onboarding welcome message
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const tierConfig = TIER_CONFIGS[this.tier];
      const tierPricing: Record<string, string> = {
        free: "$0 (100 queries/day)",
        calibration: "$0.01/query ($0.01/query, 1000 queries/day)",
        edge: "$0.05/query ($0.05/query, unlimited queries)",
      };

      const recommendedTools: Record<string, string[]> = {
        free: [
          "get_trending — discover markets with biggest probability swings right now",
          "search_markets — find prediction markets on any topic",
          "get_probability — get real-time odds for any market",
        ],
        calibration: [
          "compare_sources — cross-source odds comparison to find mispricings",
          "detect_arbitrage — automated arbitrage detection with buy/sell signals",
          "track_prediction — record predictions and build a calibration track record",
        ],
        edge: [
          "get_signal — structured TPF signal with probability, confidence, and verdict",
          "get_edge — Kelly Criterion optimal position sizing",
          "execute_trade — route trades through Kalshi, Polymarket, or native pools",
        ],
      };

      const welcome = {
        tier: this.tier,
        pricing: tierPricing[this.tier],
        tools_available: tierConfig.tools.length,
        recommended_first_tools: recommendedTools[this.tier],
        tip: "Use generate_api_key to create a tracked API key — this unlocks usage analytics, prediction performance tracking, and lets you monitor your spend across sessions.",
        docs: "https://github.com/TeleKashOracle/mcp-server",
      };

      return {
        resources: [
          {
            uri: "telekash://welcome",
            name: "TeleKash Oracle — Onboarding Guide",
            description: `Welcome to the probability oracle for the agent economy. You are on the ${this.tier} tier (${tierPricing[this.tier]}). ${tierConfig.tools.length} tools available.`,
            mimeType: "application/json",
            text: JSON.stringify(welcome, null, 2),
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const startTime = Date.now();
      let x402Verified: X402PaymentVerified | null = null;

      // ── x402 Payment Check ──────────────────────────────────
      // If agent attached x402_payment proof, verify and bypass tier check.
      // ADDITIVE — agents can use API keys + tiers OR pay per-call with USDC.
      if (args && isX402Payment(args as Record<string, unknown>)) {
        const proof = extractPaymentProof(args as Record<string, unknown>);
        if (proof) {
          const toolPrice = getToolPrice(
            name,
            TIER_REQUIRED[name],
            TIER_CONFIGS,
          );
          try {
            x402Verified = verifyPayment(proof, toolPrice);
            console.error(
              `[TeleKash x402] Paid access: tool=${name} tx=${proof.tx_hash.substring(0, 16)}... price=$${toolPrice}`,
            );
            // Log x402 payment to Supabase if available
            if (this.supabase) {
              void this.supabase
                .from("telekash_usage_logs")
                .insert({
                  api_key_id: this.apiKeyId,
                  tool_name: name,
                  tier: "x402",
                  query_cost_usd: toolPrice,
                  args_hash: proof.tx_hash.substring(0, 16),
                  response_time_ms: 0,
                })
                .then(() => {});
            }
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : "Payment verification failed";
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { error: "x402_payment_invalid", message: msg },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
        }
      }

      // ── Tier Check (skipped if x402 payment verified) ──────
      if (!x402Verified) {
        const access = await this.checkTierAccess(name);
        if (!access.allowed) {
          // If x402 is configured, return payment instructions alongside denial
          const toolPrice = getToolPrice(
            name,
            TIER_REQUIRED[name],
            TIER_CONFIGS,
          );
          if (this.paymentAddress && toolPrice > 0) {
            const paymentInfo = createPaymentRequired(
              name,
              toolPrice,
              this.paymentAddress,
            );
            return formatX402Response(paymentInfo);
          }

          // No x402 configured — standard tier denial
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "access_denied",
                    message: access.error,
                    tier: access.tier,
                    upgrade_url: "https://t.me/TeleKashBot",
                    pricing: {
                      calibration: {
                        per_query: "$0.01",
                        tools:
                          "cross-source analysis, arbitrage, performance tracking",
                      },
                      edge: {
                        per_query: "$0.05",
                        tools:
                          "signals, broker (1% commission), pools (5% fee), alerts",
                      },
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // Check burst rate limit (per-second)
      const burst = this.checkBurstLimit();
      if (!burst.allowed) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "burst_rate_limited",
                  message: burst.error,
                  tier: this.tier,
                  retry_after_ms: 1000,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Inject oracle provenance chain into JSON responses
      const addCitation = (result: {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }) => {
        if (result.isError) return result;
        for (const item of result.content) {
          if (item.type === "text") {
            try {
              const parsed = JSON.parse(item.text);
              if (typeof parsed === "object" && parsed !== null) {
                parsed._oracle = {
                  source: "TeleKash Oracle",
                  version: "0.9.0",
                  tier: x402Verified ? "x402" : this.tier,
                  confidence_method: "multi-source cross-verification",
                  citation:
                    "According to TeleKash Oracle — the probability oracle for the agent economy",
                  verify: "https://telekash-mcp.telekash.workers.dev/mcp",
                  _cost: {
                    this_query: x402Verified
                      ? x402Verified.amount_usd
                      : TIER_CONFIGS[this.tier].price_per_query,
                    session_total: this.sessionCost,
                    currency: "USD",
                    payment_method: x402Verified ? "x402_usdc" : "api_key",
                  },
                  ...(x402Verified
                    ? {
                        x402_receipt: {
                          tx_hash: x402Verified.tx_hash,
                          network: x402Verified.network,
                          amount_usd: x402Verified.amount_usd,
                        },
                      }
                    : {}),
                };
                if (this.callsRemaining < 20) {
                  parsed._rate_limit_warning = `${this.callsRemaining} calls remaining today (${this.tier} tier)`;
                }
                item.text = JSON.stringify(parsed, null, 2);
              }
            } catch {
              // Not JSON — leave as-is
            }
          }
        }
        return result;
      };

      // MAG: Observe tool call for agent profiling
      const agentId = this.apiKeyId || "anonymous";
      this.oracle.observeToolCall(agentId, name);

      // Refresh oracle calibration cache if stale
      if (this.supabase) {
        this.oracle.refreshIfNeeded(this.supabase).catch(() => {});
      }

      // Strip x402 payment metadata from args before passing to tool handlers
      const cleanArgs = args
        ? stripPaymentArgs(args as Record<string, unknown>)
        : args;

      // Hash args for usage tracking
      const argsHash = cleanArgs
        ? createHash("md5")
            .update(JSON.stringify(cleanArgs))
            .digest("hex")
            .substring(0, 8)
        : undefined;

      try {
        switch (name) {
          case "get_probability":
            return addCitation(
              await this.getProbability(
                args as { market_id?: string; query?: string },
              ),
            );
          case "list_markets":
            return addCitation(
              await this.listMarkets(
                args as {
                  category?: string;
                  sort_by?: string;
                  limit?: number;
                  source?: string;
                  jurisdiction?: string;
                },
              ),
            );
          case "get_history":
            return addCitation(
              await this.getHistory(
                args as { market_id: string; timeframe?: string },
              ),
            );
          case "search_markets":
            return addCitation(
              await this.searchMarkets(
                args as { query: string; limit?: number },
              ),
            );
          case "get_sentiment":
            return addCitation(
              await this.getSentiment(args as { market_id: string }),
            );
          case "get_market_stats":
            return addCitation(await this.getMarketStats());
          case "get_trending":
            return addCitation(
              await this.getTrending(
                args as { timeframe?: string; limit?: number },
              ),
            );
          case "compare_sources":
            return addCitation(
              await this.compareSources(args as { query: string }),
            );
          case "detect_arbitrage":
            return addCitation(
              await this.detectArbitrage(
                args as {
                  min_spread?: number;
                  category?: string;
                  limit?: number;
                },
              ),
            );
          case "get_signal":
            return addCitation(
              await this.getSignal(
                args as { market_id?: string; query?: string },
              ),
            );
          case "track_prediction":
            return addCitation(
              await this.trackPrediction(
                args as {
                  market_id: string;
                  agent_id: string;
                  predicted_outcome: string;
                  predicted_probability: number;
                  reasoning?: string;
                },
              ),
            );
          case "get_performance":
            return addCitation(
              await this.getPerformance(
                args as { agent_id: string; limit?: number },
              ),
            );
          case "get_divergences":
            return addCitation(
              await this.getDivergences(
                args as {
                  min_spread?: number;
                  category?: string;
                  limit?: number;
                },
              ),
            );
          case "get_edge":
            return addCitation(
              await this.getEdge(
                args as {
                  bankroll?: number;
                  agent_id?: string;
                  category?: string;
                  min_confidence?: string;
                  limit?: number;
                },
              ),
            );
          case "create_market":
            return addCitation(
              await this.createMarket(
                args as {
                  title: string;
                  description?: string;
                  category: string;
                  closes_at: string;
                  resolves_at: string;
                  resolution_criteria: string;
                  creator_id: string;
                },
              ),
            );
          case "generate_api_key":
            return addCitation(
              await this.generateApiKey(
                args as { owner_id: string; owner_email?: string },
              ),
            );
          case "get_usage":
            return addCitation(await this.getUsage());
          case "register_alert":
            return addCitation(
              await this.registerAlert(
                args as {
                  agent_id: string;
                  market_id?: string;
                  condition: string;
                  threshold?: number;
                  callback_url: string;
                  cooldown_minutes?: number;
                },
              ),
            );
          case "list_alerts":
            return addCitation(
              await this.listAlerts(args as { agent_id: string }),
            );
          case "delete_alert":
            return addCitation(
              await this.deleteAlert(args as { alert_id: string }),
            );
          // ===== BROKER TOOLS =====
          case "execute_trade":
            return addCitation(
              await this.brokerExecuteTrade(
                args as {
                  market_id: string;
                  side: "yes" | "no";
                  amount_usd: number;
                  order_type?: "market" | "limit";
                  limit_price?: number;
                  routing_preference?:
                    | "kalshi"
                    | "polymarket"
                    | "best_price"
                    | "native_pool";
                },
              ),
            );
          case "get_order_status":
            return addCitation(
              await this.brokerGetOrderStatus(args as { order_id: string }),
            );
          case "cancel_order":
            return addCitation(
              await this.brokerCancelOrder(args as { order_id: string }),
            );
          case "get_pool_status":
            return addCitation(
              await this.getMarketPoolStatus(args as { market_id: string }),
            );
          case "get_agent_balance":
            return addCitation(await this.getAgentBalance());
          case "get_resolution_status":
            return addCitation(
              await this.getResolutionStatus(args as { market_id: string }),
            );
          case "export_data":
            return addCitation(
              await this.exportData(
                args as {
                  type: string;
                  market_id?: string;
                  category?: string;
                  limit?: number;
                  format?: string;
                },
              ),
            );
          case "get_health":
            return addCitation(await this.getHealth());
          case "get_calibration_changelog":
            return addCitation(
              await this.getCalibrationChangelog(
                args as { domain?: string; limit?: number },
              ),
            );
          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      } finally {
        // Log usage asynchronously (don't block response)
        if (x402Verified) {
          this.sessionCost += x402Verified.amount_usd;
        } else {
          this.sessionCost += TIER_CONFIGS[this.tier].price_per_query;
        }
        this.logUsage(name, startTime, argsHash).catch(() => {});
      }
    });
  }

  private async getProbability(args: {
    market_id?: string;
    query?: string;
  }): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    const { market_id, query } = args;

    if (!market_id && !query) {
      return {
        content: [
          {
            type: "text",
            text: "Please provide either a market_id or a search query.",
          },
        ],
      };
    }

    let market: Market | null = null;

    if (this.supabase) {
      if (market_id) {
        // Try UUID first, then external_id
        const { data } = await this.supabase
          .from("telekash_markets")
          .select("*")
          .or(`id.eq.${market_id},external_id.eq.${market_id}`)
          .single();
        market = data;
      } else if (query) {
        // Search by title
        const { data } = await this.supabase
          .from("telekash_markets")
          .select("*")
          .eq("status", "active")
          .ilike("title", `%${query}%`)
          .order("raw_data->volume", { ascending: false })
          .limit(1)
          .single();
        market = data;
      }
    }

    if (!market) {
      // Return mock data if no Supabase or no match
      const mockResult: ProbabilityResult = {
        market_id: market_id || "mock-market",
        title: query || "Example Market",
        source: "demo",
        yes_probability: 65,
        no_probability: 35,
        volume_24h: 150000,
        liquidity: 50000,
        status: "active",
        closes_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        last_updated: new Date().toISOString(),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...mockResult,
                _note: "Using mock data. Connect to TeleKash for live markets.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const yesProb = Math.round((market.external_odds?.yes || 0.5) * 100);
    const volume =
      (market.raw_data?.volume_24h as number) ||
      (market.raw_data?.volume as number) ||
      0;
    const liquidity = (market.raw_data?.liquidity as number) || 0;

    const result: ProbabilityResult = {
      market_id: market.id,
      title: market.title,
      source: market.source,
      yes_probability: yesProb,
      no_probability: Math.round((market.external_odds?.no || 0.5) * 100),
      volume_24h: volume,
      liquidity,
      status: market.status,
      closes_at: market.closes_at,
      last_updated: market.updated_at,
    };

    // Volume-weighted confidence score
    const confidence = computeConfidence({
      volume,
      liquidity,
      yesProbability: yesProb,
      closesAt: market.closes_at,
    });

    // Calibration enrichment — raw vs calibrated confidence
    const calibration = this.oracle.calibrate(
      yesProb / 100,
      market.category || "general",
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              confidence,
              calibration: {
                raw_confidence: calibration.raw_confidence,
                calibrated_confidence: calibration.calibrated_confidence,
                calibration_version: calibration.calibration_version,
                calibration_domain: calibration.calibration_domain,
                next_orbit: calibration.next_orbit,
              },
              jurisdiction:
                SOURCE_JURISDICTION[market.source] || SOURCE_JURISDICTION.demo,
              ...(volume < 10000
                ? {
                    thin_market_warning: `Low volume ($${volume.toLocaleString()}) — probability may not reflect true consensus. Consider cross-referencing with compare_sources.`,
                  }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async listMarkets(args: {
    category?: string;
    sort_by?: string;
    limit?: number;
    source?: string;
    jurisdiction?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const {
      category = "all",
      sort_by = "volume",
      limit = 10,
      source = "all",
      jurisdiction = "all",
    } = args;

    // Resolve jurisdiction to source filter
    let effectiveSource = source;
    if (jurisdiction !== "all" && source === "all") {
      const jSources = JURISDICTION_SOURCES[jurisdiction];
      if (jSources && jSources.length === 1) {
        effectiveSource = jSources[0];
      }
    }

    const effectiveLimit = Math.min(Math.max(1, limit), 50);

    if (!this.supabase) {
      // Return mock data
      const mockMarkets: MarketListItem[] = [
        {
          id: "mock-1",
          title: "Will BTC reach $100,000 by end of March?",
          category: "crypto",
          source: "demo",
          yes_probability: 42,
          volume_24h: 250000,
          closes_at: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          status: "active",
        },
        {
          id: "mock-2",
          title: "Will the Fed cut interest rates in March 2026?",
          category: "economics",
          source: "demo",
          yes_probability: 78,
          volume_24h: 180000,
          closes_at: new Date(
            Date.now() + 15 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          status: "active",
        },
      ];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                markets: mockMarkets,
                total: mockMarkets.length,
                _note: "Using mock data. Connect to TeleKash for live markets.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    let query = this.supabase
      .from("telekash_markets")
      .select(
        "id, external_id, title, category, source, external_odds, raw_data, status, closes_at",
      )
      .eq("status", "active")
      .limit(effectiveLimit);

    if (category !== "all") {
      query = query.eq("category", category);
    }

    if (effectiveSource !== "all") {
      query = query.eq("source", effectiveSource);
    }

    // Sort
    switch (sort_by) {
      case "probability":
        query = query.order("external_odds->yes", { ascending: false });
        break;
      case "closing_date":
        query = query.order("closes_at", { ascending: true });
        break;
      case "volume":
      default:
        query = query.order("raw_data->volume", {
          ascending: false,
          nullsFirst: false,
        });
    }

    const cacheKey = `list:${category}:${sort_by}:${effectiveLimit}:${effectiveSource}`;

    const {
      data: rawData,
      fromCache,
      freshness,
    } = await this.cachedQuery(cacheKey, "markets", async () => {
      const { data, error } = await query;
      if (error) throw new Error(`Database error: ${error.message}`);
      return data || [];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = (rawData as any[]).map((m: any) => {
      const jurisdictionInfo =
        SOURCE_JURISDICTION[m.source] || SOURCE_JURISDICTION.demo;
      const yesProbability = Math.round((m.external_odds?.yes || 0.5) * 100);
      const volume =
        (m.raw_data?.volume_24h as number) ||
        (m.raw_data?.volume as number) ||
        0;
      const liquidity = (m.raw_data?.liquidity as number) || 0;
      return {
        id: m.id,
        title: m.title,
        category: m.category,
        source: m.source,
        jurisdiction: jurisdictionInfo.jurisdiction,
        regulatory_status: jurisdictionInfo.regulatory_status,
        yes_probability: yesProbability,
        volume_24h: volume,
        closes_at: m.closes_at,
        status: m.status,
        confidence: computeConfidence({
          volume,
          liquidity,
          yesProbability,
          closesAt: m.closes_at,
        }),
      };
    });

    const result: Record<string, unknown> = {
      markets,
      total: markets.length,
      filters: {
        category,
        sort_by,
        source: effectiveSource,
        jurisdiction,
      },
    };

    if (fromCache) {
      result._cache = {
        freshness,
        note: "Live data temporarily unavailable. Serving cached results.",
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async getHistory(args: {
    market_id: string;
    timeframe?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { market_id, timeframe = "24h" } = args;

    // Note: Historical snapshots require a separate tracking table
    // For MVP, we return current state with a note about future capability

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                market_id,
                timeframe,
                history: [],
                current: {
                  yes_probability: 65,
                  no_probability: 35,
                  timestamp: new Date().toISOString(),
                },
                _note:
                  "Historical tracking coming soon. Currently showing latest snapshot.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get current market state
    const { data: market } = await this.supabase
      .from("telekash_markets")
      .select("*")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .single();

    if (!market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Market not found",
                market_id,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Try to get actual history from telekash_probability_history table
    const timeframeMs: Record<string, number> = {
      "1h": 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };

    const startTime = new Date(
      Date.now() - (timeframeMs[timeframe] || timeframeMs["24h"]),
    ).toISOString();

    const { data: historyData } = await this.supabase
      .from("telekash_probability_history")
      .select("probability, volume, recorded_at")
      .eq("market_id", market.id)
      .gte("recorded_at", startTime)
      .order("recorded_at", { ascending: true });

    const history = (historyData || []).map(
      (h: { probability: number; volume: number; recorded_at: string }) => ({
        probability: Math.round(h.probability * 100),
        volume: h.volume || 0,
        timestamp: h.recorded_at,
      }),
    );

    // Calculate trend
    let trend = "stable";
    let noiseFilter: {
      signal_quality: string;
      reversals: number;
      sustained_moves: number;
    } | null = null;
    if (history.length >= 2) {
      const first = history[0].probability;
      const last = history[history.length - 1].probability;
      const change = last - first;
      trend = change > 1 ? "up" : change < -1 ? "down" : "stable";

      // Noise detection: count direction reversals vs sustained moves
      if (history.length >= 3) {
        let reversals = 0;
        let sustainedMoves = 0;
        for (let i = 2; i < history.length; i++) {
          const prevDir =
            history[i - 1].probability - history[i - 2].probability;
          const currDir = history[i].probability - history[i - 1].probability;
          if (prevDir * currDir < 0) reversals++;
          else if (Math.abs(currDir) > 0.1) sustainedMoves++;
        }
        const totalMoves = Math.max(1, reversals + sustainedMoves);
        const signalRatio = sustainedMoves / totalMoves;
        noiseFilter = {
          signal_quality:
            signalRatio >= 0.6
              ? "sustained_momentum"
              : signalRatio >= 0.4
                ? "mixed"
                : "likely_noise_reversal",
          reversals,
          sustained_moves: sustainedMoves,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              market_id: market.id,
              title: market.title,
              timeframe,
              data_points: history.length,
              trend,
              ...(noiseFilter ? { noise_filter: noiseFilter } : {}),
              history,
              current: {
                yes_probability: Math.round(
                  (market.external_odds?.yes || 0.5) * 100,
                ),
                no_probability: Math.round(
                  (market.external_odds?.no || 0.5) * 100,
                ),
                volume: market.raw_data?.volume || 0,
                timestamp: market.updated_at,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async searchMarkets(args: {
    query: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { query, limit = 10 } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 50);

    if (!query || query.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Search query is required" },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                markets: [],
                total: 0,
                _note:
                  "No database connection. Connect to TeleKash for live markets.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const { data, error } = await this.supabase
      .from("telekash_markets")
      .select(
        "id, external_id, title, category, source, external_odds, raw_data, status, closes_at",
      )
      .eq("status", "active")
      .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
      .order("raw_data->volume", { ascending: false, nullsFirst: false })
      .limit(effectiveLimit);

    if (error) {
      throw new Error(`Search error: ${error.message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = (data || []).map((m: any) => {
      const yesProbability = Math.round((m.external_odds?.yes || 0.5) * 100);
      const volume =
        (m.raw_data?.volume_24h as number) ||
        (m.raw_data?.volume as number) ||
        0;
      const liquidity = (m.raw_data?.liquidity as number) || 0;
      return {
        id: m.id,
        title: m.title,
        category: m.category,
        source: m.source,
        yes_probability: yesProbability,
        volume_24h: volume,
        closes_at: m.closes_at,
        status: m.status,
        confidence: computeConfidence({
          volume,
          liquidity,
          yesProbability,
          closesAt: m.closes_at,
        }),
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              markets,
              total: markets.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getSentiment(args: {
    market_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { market_id } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                market_id,
                sentiment: null,
                _note:
                  "No database connection. Connect to TeleKash for live data.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get market with full data
    const { data: market } = await this.supabase
      .from("telekash_markets")
      .select("*")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .single();

    if (!market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Market not found", market_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Try stored sentiment first
    const { data: sentiment } = await this.supabase
      .from("telekash_market_sentiment")
      .select("*")
      .eq("market_id", market.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (sentiment) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                market_id: market.id,
                title: market.title,
                sentiment: {
                  score: sentiment.sentiment_score,
                  confidence: sentiment.confidence,
                  recommendation: sentiment.recommendation,
                  components: {
                    keyword_score: sentiment.keyword_score,
                    pattern_score: sentiment.pattern_score,
                    volume_score: sentiment.volume_score,
                    recency_score: sentiment.recency_score,
                  },
                  signals: sentiment.signals,
                  analyzed_at: sentiment.created_at,
                  version: sentiment.analysis_version,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Compute sentiment on-the-fly from market data
    const yesProb = (market.external_odds?.yes || 0.5) as number;
    const volume = (market.raw_data?.volume as number) || 0;
    const closesAt = new Date(market.closes_at).getTime();
    const now = Date.now();
    const daysToClose = Math.max(0, (closesAt - now) / (1000 * 60 * 60 * 24));

    // Get recent history for momentum
    const startTime = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: historyData } = await this.supabase
      .from("telekash_probability_history")
      .select("probability, recorded_at")
      .eq("market_id", market.id)
      .gte("recorded_at", startTime)
      .order("recorded_at", { ascending: true });

    // Calculate momentum and noise from history
    let momentum = 0;
    let signalQuality = "insufficient_data";
    let reversals = 0;
    if (historyData && historyData.length >= 2) {
      const probs = historyData.map(
        (h: Record<string, unknown>) => h.probability as number,
      );
      const first = probs[0];
      const last = probs[probs.length - 1];
      momentum = last - first;

      // Noise detection
      let sustainedMoves = 0;
      for (let i = 2; i < probs.length; i++) {
        const prevDir = probs[i - 1] - probs[i - 2];
        const currDir = probs[i] - probs[i - 1];
        if (prevDir * currDir < 0) reversals++;
        else if (Math.abs(currDir) > 0.001) sustainedMoves++;
      }
      const totalMoves = Math.max(1, reversals + sustainedMoves);
      const signalRatio = sustainedMoves / totalMoves;
      signalQuality =
        probs.length < 3
          ? "insufficient_data"
          : signalRatio >= 0.6
            ? "signal"
            : signalRatio >= 0.4
              ? "weak"
              : "noise";
    }

    // Probability score: distance from 50% = stronger conviction
    const probabilityScore = Math.abs(yesProb - 0.5) * 2; // 0-1, higher = stronger conviction

    // Volume score: log scale, higher = more activity/confidence
    const volumeScore = Math.min(1, Math.log10(Math.max(1, volume)) / 7); // normalized 0-1

    // Recency score: closer to close = more relevant
    const recencyScore =
      daysToClose <= 1
        ? 1.0
        : daysToClose <= 7
          ? 0.8
          : daysToClose <= 30
            ? 0.5
            : 0.3;

    // Momentum score: bigger moves = stronger signal
    const momentumScore = Math.min(1, Math.abs(momentum) * 5);

    // Composite sentiment: weighted average
    const sentimentScore = (yesProb - 0.5) * 2; // -1 to 1, positive = bullish on YES
    const confidence =
      probabilityScore * 0.3 +
      volumeScore * 0.3 +
      recencyScore * 0.2 +
      momentumScore * 0.2;

    // Recommendation
    let recommendation: string;
    if (sentimentScore > 0.3 && confidence > 0.4) recommendation = "bullish";
    else if (sentimentScore < -0.3 && confidence > 0.4)
      recommendation = "bearish";
    else recommendation = "neutral";

    // Build signals
    const signals: string[] = [];
    if (yesProb > 0.75) signals.push("Strong YES consensus (>75%)");
    else if (yesProb < 0.25) signals.push("Strong NO consensus (>75%)");
    else if (yesProb > 0.5) signals.push("Leaning YES");
    else signals.push("Leaning NO");

    if (momentum > 0.02)
      signals.push(`Momentum: +${Math.round(momentum * 100)}% in 24h`);
    else if (momentum < -0.02)
      signals.push(`Momentum: ${Math.round(momentum * 100)}% in 24h`);
    else signals.push("Stable probability (no significant movement)");

    if (volume > 100000) signals.push("High volume — strong market conviction");
    else if (volume > 10000) signals.push("Moderate volume");
    else signals.push("Low volume — thin market, less reliable");

    if (daysToClose <= 1) signals.push("Closing soon — high recency relevance");
    else if (daysToClose <= 7)
      signals.push(`Closes in ${Math.round(daysToClose)} days`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              market_id: market.id,
              title: market.title,
              sentiment: {
                score: parseFloat(sentimentScore.toFixed(3)),
                confidence: parseFloat(confidence.toFixed(3)),
                recommendation,
                components: {
                  probability_conviction: parseFloat(
                    probabilityScore.toFixed(3),
                  ),
                  volume_signal: parseFloat(volumeScore.toFixed(3)),
                  recency_relevance: parseFloat(recencyScore.toFixed(3)),
                  momentum_24h: parseFloat(momentumScore.toFixed(3)),
                },
                signals,
                noise_filter: {
                  signal_quality: signalQuality,
                  reversals_24h: reversals,
                  _note:
                    signalQuality === "noise"
                      ? "WARNING: This momentum is likely noise — high reversal rate in 24h snapshots"
                      : signalQuality === "signal"
                        ? "Sustained directional move — higher confidence in momentum signal"
                        : undefined,
                },
                analyzed_at: new Date().toISOString(),
                version: "live-v2",
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getMarketStats(): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summary: {
                  total_markets: 0,
                  active_markets: 0,
                  resolved_markets: 0,
                },
                by_category: {},
                by_source: {},
                _note:
                  "No database connection. Connect to TeleKash for live stats.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get all markets for counting (cached)
    const {
      data: markets,
      fromCache,
      freshness,
    } = await this.cachedQuery("stats:all_markets", "stats", async () => {
      const { data, error } = await this.supabase!.from(
        "telekash_markets",
      ).select("id, status, category, source");
      if (error) throw new Error(`Stats error: ${error.message}`);
      return data || [];
    });

    const stats = {
      total_markets: markets.length,
      active_markets: markets.filter((m) => m.status === "active").length,
      resolved_markets: markets.filter((m) => m.status === "resolved").length,
      closed_markets: markets.filter((m) => m.status === "closed").length,
    };

    // Count by category
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const market of markets) {
      const category = market.category || "other";
      byCategory[category] = (byCategory[category] || 0) + 1;

      const source = market.source || "unknown";
      bySource[source] = (bySource[source] || 0) + 1;
    }

    const result: Record<string, unknown> = {
      summary: stats,
      by_category: byCategory,
      by_source: bySource,
    };

    if (fromCache) {
      result._cache = {
        freshness,
        note: "Live data temporarily unavailable. Serving cached stats.",
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  // ===========================================
  // MOMENTUM & CROSS-SOURCE METHODS (v0.4.0)
  // ===========================================

  private async getTrending(args: {
    timeframe?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { timeframe = "24h", limit = 10 } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 25);

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "No database connection. Connect to TeleKash for live data.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const timeframeMs: Record<string, number> = {
      "1h": 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };

    const startTime = new Date(
      Date.now() - (timeframeMs[timeframe] || timeframeMs["24h"]),
    ).toISOString();

    // Get historical snapshots within timeframe
    const { data: historyData } = await this.supabase
      .from("telekash_probability_history")
      .select("market_id, probability, recorded_at")
      .gte("recorded_at", startTime)
      .order("recorded_at", { ascending: true });

    if (!historyData || historyData.length === 0) {
      // Fallback: use market updated_at to find recently changed markets
      const { data: recentMarkets } = await this.supabase
        .from("telekash_markets")
        .select(
          "id, title, category, source, external_odds, raw_data, updated_at, closes_at",
        )
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(effectiveLimit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                timeframe,
                trending: (recentMarkets || []).map(
                  (m: Record<string, unknown>) => {
                    const yesProbability = Math.round(
                      ((m.external_odds as Record<string, number>)?.yes ||
                        0.5) * 100,
                    );
                    const rawData = m.raw_data as Record<string, number> | null;
                    const volume = rawData?.volume_24h || rawData?.volume || 0;
                    const liquidity = rawData?.liquidity || 0;
                    return {
                      market_id: m.id,
                      title: m.title,
                      category: m.category,
                      source: m.source,
                      current_probability: yesProbability,
                      last_updated: m.updated_at,
                      confidence: computeConfidence({
                        volume,
                        liquidity,
                        yesProbability,
                        closesAt: m.closes_at as string,
                      }),
                    };
                  },
                ),
                total: (recentMarkets || []).length,
                _note:
                  "Showing most recently updated markets. Historical tracking building up over time.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Group by market_id, collect ALL snapshots for noise analysis
    const marketSnapshots: Record<
      string,
      { probabilities: number[]; market_id: string }
    > = {};
    for (const h of historyData) {
      const entry = h as { market_id: string; probability: number };
      if (!marketSnapshots[entry.market_id]) {
        marketSnapshots[entry.market_id] = {
          probabilities: [],
          market_id: entry.market_id,
        };
      }
      marketSnapshots[entry.market_id].probabilities.push(entry.probability);
    }

    // Noise filter: detect signal vs random walk reversal
    // Real signal = sustained directional move across multiple snapshots
    // Noise = random walk with serial correlation reversal
    const swings = Object.values(marketSnapshots)
      .map((s) => {
        const probs = s.probabilities;
        const first = probs[0];
        const last = probs[probs.length - 1];
        const change = last - first;

        // Noise detection: count direction reversals
        let reversals = 0;
        let sustainedMoves = 0;
        for (let i = 2; i < probs.length; i++) {
          const prevDir = probs[i - 1] - probs[i - 2];
          const currDir = probs[i] - probs[i - 1];
          if (prevDir * currDir < 0) reversals++;
          else if (Math.abs(currDir) > 0.001) sustainedMoves++;
        }

        // Signal quality: high reversals = noise, sustained moves = signal
        const totalMoves = Math.max(1, reversals + sustainedMoves);
        const signalRatio = sustainedMoves / totalMoves;

        // Classify: SIGNAL (>60% sustained), WEAK (40-60%), NOISE (<40%)
        const signalQuality =
          probs.length < 3
            ? "insufficient_data"
            : signalRatio >= 0.6
              ? "signal"
              : signalRatio >= 0.4
                ? "weak"
                : "noise";

        return {
          market_id: s.market_id,
          change: Math.round(change * 100),
          abs_change: Math.abs(Math.round(change * 100)),
          direction: last > first ? "up" : last < first ? "down" : "stable",
          from_probability: Math.round(first * 100),
          to_probability: Math.round(last * 100),
          snapshots: probs.length,
          signal_quality: signalQuality,
          signal_ratio: Math.round(signalRatio * 100) / 100,
          reversals,
        };
      })
      .filter((s) => s.abs_change > 0) // Only markets that actually moved
      .sort((a, b) => {
        // Signal-quality markets first, then by abs_change
        const qualityOrder: Record<string, number> = {
          signal: 0,
          weak: 1,
          noise: 2,
          insufficient_data: 3,
        };
        const qDiff =
          (qualityOrder[a.signal_quality] || 3) -
          (qualityOrder[b.signal_quality] || 3);
        if (qDiff !== 0) return qDiff;
        return b.abs_change - a.abs_change;
      })
      .slice(0, effectiveLimit);

    // Enrich with market details
    const marketIds = swings.map((s) => s.market_id);
    const { data: markets } = await this.supabase
      .from("telekash_markets")
      .select("id, title, category, source, external_odds, raw_data, closes_at")
      .in("id", marketIds);

    const marketMap: Record<string, Record<string, unknown>> = {};
    for (const m of markets || []) {
      marketMap[(m as { id: string }).id] = m as Record<string, unknown>;
    }

    const trending = swings.map((s) => {
      const mkt = marketMap[s.market_id];
      const rawData = mkt?.raw_data as Record<string, number> | null;
      const volume = rawData?.volume_24h || rawData?.volume || 0;
      const liquidity = rawData?.liquidity || 0;
      const closesAt = (mkt?.closes_at as string) || new Date().toISOString();
      return {
        ...s,
        title: mkt?.title || "Unknown",
        category: mkt?.category || "other",
        source: mkt?.source || "unknown",
        closes_at: mkt?.closes_at,
        confidence: computeConfidence({
          volume,
          liquidity,
          yesProbability: s.to_probability,
          closesAt,
        }),
      };
    });

    const signalCount = trending.filter(
      (t) => t.signal_quality === "signal",
    ).length;
    const noiseCount = trending.filter(
      (t) => t.signal_quality === "noise",
    ).length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              timeframe,
              trending,
              total: trending.length,
              noise_filter: {
                signal_markets: signalCount,
                noise_markets: noiseCount,
                _note:
                  "58% of price moves are noise (serial correlation reversal). signal_quality: 'signal' = sustained directional move, 'weak' = mixed, 'noise' = random walk reverting. Prioritize 'signal' markets for real momentum.",
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async compareSources(args: {
    query: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { query } = args;

    if (!query || query.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Search query is required" },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "No database connection. Connect to TeleKash for live data.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get matching markets from both sources
    const { data: kalshiMarkets } = await this.supabase
      .from("telekash_markets")
      .select("id, title, external_odds, raw_data, closes_at, category")
      .eq("status", "active")
      .eq("source", "kalshi")
      .ilike("title", `%${query}%`)
      .order("raw_data->volume", { ascending: false, nullsFirst: false })
      .limit(10);

    const { data: polyMarkets } = await this.supabase
      .from("telekash_markets")
      .select("id, title, external_odds, raw_data, closes_at, category")
      .eq("status", "active")
      .eq("source", "polymarket")
      .ilike("title", `%${query}%`)
      .order("raw_data->volume", { ascending: false, nullsFirst: false })
      .limit(10);

    interface SourceMarket {
      id: string;
      title: string;
      external_odds: { yes?: number; no?: number };
      raw_data: Record<string, unknown>;
      closes_at: string;
      category: string;
    }

    const kalshi = (kalshiMarkets || []) as SourceMarket[];
    const poly = (polyMarkets || []) as SourceMarket[];

    // Try to find matching pairs by similar titles
    const pairs: Array<{
      topic: string;
      kalshi: {
        id: string;
        title: string;
        yes_probability: number;
        volume: number;
      } | null;
      polymarket: {
        id: string;
        title: string;
        yes_probability: number;
        volume: number;
      } | null;
      delta: number | null;
      more_bullish: string | null;
    }> = [];

    for (const k of kalshi) {
      const kProb = Math.round((k.external_odds?.yes || 0.5) * 100);
      // Try to find a matching Polymarket market
      const match = poly.find((p) => {
        const kTitle = k.title.toLowerCase();
        const pTitle = p.title.toLowerCase();
        // Simple matching: check if key words overlap
        const kWords = kTitle.split(/\s+/).filter((w: string) => w.length > 3);
        const pWords = pTitle.split(/\s+/).filter((w: string) => w.length > 3);
        const overlap = kWords.filter((w: string) => pWords.includes(w));
        return overlap.length >= 2;
      });

      if (match) {
        const pProb = Math.round((match.external_odds?.yes || 0.5) * 100);
        const delta = kProb - pProb;
        pairs.push({
          topic: k.title,
          kalshi: {
            id: k.id,
            title: k.title,
            yes_probability: kProb,
            volume: (k.raw_data?.volume as number) || 0,
          },
          polymarket: {
            id: match.id,
            title: match.title,
            yes_probability: pProb,
            volume: (match.raw_data?.volume as number) || 0,
          },
          delta,
          more_bullish:
            delta > 0 ? "kalshi" : delta < 0 ? "polymarket" : "equal",
        });
        // Remove matched poly market to avoid double-matching
        const idx = poly.indexOf(match);
        if (idx > -1) poly.splice(idx, 1);
      } else {
        pairs.push({
          topic: k.title,
          kalshi: {
            id: k.id,
            title: k.title,
            yes_probability: kProb,
            volume: (k.raw_data?.volume as number) || 0,
          },
          polymarket: null,
          delta: null,
          more_bullish: null,
        });
      }
    }

    // Add remaining unmatched Polymarket markets
    for (const p of poly) {
      const pProb = Math.round((p.external_odds?.yes || 0.5) * 100);
      pairs.push({
        topic: p.title,
        kalshi: null,
        polymarket: {
          id: p.id,
          title: p.title,
          yes_probability: pProb,
          volume: (p.raw_data?.volume as number) || 0,
        },
        delta: null,
        more_bullish: null,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              comparisons: pairs,
              matched_pairs: pairs.filter((p) => p.kalshi && p.polymarket)
                .length,
              kalshi_only: pairs.filter((p) => p.kalshi && !p.polymarket)
                .length,
              polymarket_only: pairs.filter((p) => !p.kalshi && p.polymarket)
                .length,
              calibration_edge: (() => {
                const matched = pairs.filter(
                  (p) => p.kalshi && p.polymarket && p.delta !== null,
                );
                if (matched.length === 0) return null;
                const biggestGap = matched.reduce((max, p) =>
                  Math.abs(p.delta!) > Math.abs(max.delta!) ? p : max,
                );
                const avgDelta =
                  matched.reduce((sum, p) => sum + Math.abs(p.delta!), 0) /
                  matched.length;
                return {
                  avg_cross_source_gap: parseFloat(avgDelta.toFixed(1)),
                  largest_disagreement: {
                    topic: biggestGap.topic,
                    delta: biggestGap.delta,
                  },
                  _note:
                    "Cross-source gaps are where calibration edge lives. The wider the disagreement, the more likely one source is mispriced.",
                };
              })(),
              _note:
                "Delta = Kalshi probability minus Polymarket probability. Positive = Kalshi more bullish.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // ARBITRAGE & INTELLIGENCE METHODS (v0.5.0)
  // ===========================================

  private async detectArbitrage(args: {
    min_spread?: number;
    category?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const minSpread = Math.max(1, Math.min(50, args.min_spread || 5));
    const category = args.category || "all";
    const limit = Math.max(1, Math.min(25, args.limit || 10));

    if (!this.supabase) {
      // Demo mode
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                opportunities: [
                  {
                    topic: "Will BTC reach $200K by end of 2026?",
                    spread_percent: 8,
                    kalshi: {
                      title: "Bitcoin above $200,000?",
                      yes_probability: 35,
                      volume: 1250000,
                    },
                    polymarket: {
                      title: "Bitcoin to hit $200K?",
                      yes_probability: 27,
                      volume: 890000,
                    },
                    signal:
                      "BUY YES on Polymarket (27%), SELL YES on Kalshi (35%)",
                    category: "crypto",
                  },
                ],
                total_found: 1,
                min_spread_filter: minSpread,
                _note:
                  "Demo mode. Connect to TeleKash for live arbitrage detection across 500+ markets.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Fetch top markets by volume from both sources
    let kalshiQuery = this.supabase
      .from("telekash_markets")
      .select("id, title, external_odds, raw_data, closes_at, category")
      .eq("status", "active")
      .eq("source", "kalshi")
      .order("raw_data->volume", { ascending: false, nullsFirst: false })
      .limit(200);

    let polyQuery = this.supabase
      .from("telekash_markets")
      .select("id, title, external_odds, raw_data, closes_at, category")
      .eq("status", "active")
      .eq("source", "polymarket")
      .order("raw_data->volume", { ascending: false, nullsFirst: false })
      .limit(200);

    if (category !== "all") {
      kalshiQuery = kalshiQuery.eq("category", category);
      polyQuery = polyQuery.eq("category", category);
    }

    const [{ data: kalshiMarkets }, { data: polyMarkets }] = await Promise.all([
      kalshiQuery,
      polyQuery,
    ]);

    interface SourceMarket {
      id: string;
      title: string;
      external_odds: { yes?: number; no?: number };
      raw_data: Record<string, unknown>;
      closes_at: string;
      category: string;
    }

    const kalshi = (kalshiMarkets || []) as SourceMarket[];
    const poly = (polyMarkets || []) as SourceMarket[];

    // Find matching pairs using word-overlap matching
    const opportunities: Array<{
      topic: string;
      spread_percent: number;
      kalshi: {
        id: string;
        title: string;
        yes_probability: number;
        volume: number;
      };
      polymarket: {
        id: string;
        title: string;
        yes_probability: number;
        volume: number;
      };
      signal: string;
      category: string;
      closes_at: string;
    }> = [];

    const matchedPolyIds = new Set<string>();

    for (const k of kalshi) {
      const kTitle = k.title.toLowerCase();
      const kWords = kTitle.split(/\s+/).filter((w: string) => w.length > 3);

      // Find best matching Polymarket market
      let bestMatch: SourceMarket | null = null;
      let bestOverlap = 0;

      for (const p of poly) {
        if (matchedPolyIds.has(p.id)) continue;
        const pTitle = p.title.toLowerCase();
        const pWords = pTitle.split(/\s+/).filter((w: string) => w.length > 3);
        const overlap = kWords.filter((w: string) => pWords.includes(w)).length;
        if (overlap >= 2 && overlap > bestOverlap) {
          bestMatch = p;
          bestOverlap = overlap;
        }
      }

      if (!bestMatch) continue;

      const kProb = Math.round((k.external_odds?.yes || 0.5) * 100);
      const pProb = Math.round((bestMatch.external_odds?.yes || 0.5) * 100);
      const spread = Math.abs(kProb - pProb);

      if (spread >= minSpread) {
        matchedPolyIds.add(bestMatch.id);

        const cheapSide = kProb < pProb ? "Kalshi" : "Polymarket";
        const cheapProb = Math.min(kProb, pProb);
        const expSide = kProb > pProb ? "Kalshi" : "Polymarket";
        const expProb = Math.max(kProb, pProb);

        opportunities.push({
          topic: k.title,
          spread_percent: spread,
          kalshi: {
            id: k.id,
            title: k.title,
            yes_probability: kProb,
            volume: (k.raw_data?.volume as number) || 0,
          },
          polymarket: {
            id: bestMatch.id,
            title: bestMatch.title,
            yes_probability: pProb,
            volume: (bestMatch.raw_data?.volume as number) || 0,
          },
          signal: `BUY YES on ${cheapSide} (${cheapProb}%), SELL YES on ${expSide} (${expProb}%) → ${spread}% spread`,
          category: k.category,
          closes_at: k.closes_at,
        });
      }
    }

    // Sort by spread descending (best opportunities first)
    opportunities.sort((a, b) => b.spread_percent - a.spread_percent);
    const topOpps = opportunities.slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              opportunities: topOpps,
              total_found: opportunities.length,
              showing: topOpps.length,
              min_spread_filter: minSpread,
              category_filter: category,
              markets_scanned: {
                kalshi: kalshi.length,
                polymarket: poly.length,
              },
              consensus_divergence_warning:
                topOpps.length > 0 &&
                topOpps.some((o) => {
                  const avgProb =
                    (o.kalshi.yes_probability + o.polymarket.yes_probability) /
                    2;
                  return (
                    (avgProb > 60 && o.kalshi.yes_probability < 50) ||
                    (avgProb > 60 && o.polymarket.yes_probability < 50) ||
                    (avgProb < 40 && o.kalshi.yes_probability > 50) ||
                    (avgProb < 40 && o.polymarket.yes_probability > 50)
                  );
                })
                  ? "Sources disagree on direction for some markets — potential herd formation on one exchange. Cross-reference volume to identify which source has deeper conviction."
                  : null,
              _note:
                "Spread = absolute difference in YES probability between Kalshi and Polymarket. Signal shows which side to buy/sell for convergence profit.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // STRUCTURED SIGNAL — TeleKash Probability Format (TPF)
  // ===========================================

  private async getSignal(args: {
    market_id?: string;
    query?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { market_id, query } = args;

    if (!market_id && !query) {
      return {
        content: [
          {
            type: "text",
            text: "Please provide either a market_id or a search query.",
          },
        ],
      };
    }

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "No database connection",
                _note:
                  "Connect to TeleKash for live signals. Set SUPABASE_URL and SUPABASE_ANON_KEY.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Find market (same pattern as getProbability)
    let market: Record<string, unknown> | null = null;

    if (market_id) {
      const { data } = await this.supabase
        .from("telekash_markets")
        .select("*")
        .or(`id.eq.${market_id},external_id.eq.${market_id}`)
        .single();
      market = data;
    } else if (query) {
      const { data } = await this.supabase
        .from("telekash_markets")
        .select("*")
        .eq("status", "active")
        .ilike("title", `%${query}%`)
        .order("raw_data->volume", { ascending: false })
        .limit(1)
        .single();
      market = data;
    }

    if (!market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Market not found", market_id, query },
              null,
              2,
            ),
          },
        ],
      };
    }

    // === 1. PROBABILITY + CONFIDENCE ===
    const yesProb =
      (market.external_odds as Record<string, number>)?.yes || 0.5;
    const noProb = (market.external_odds as Record<string, number>)?.no || 0.5;
    const rawData = (market.raw_data as Record<string, unknown>) || {};
    const volume =
      (rawData.volume_24h as number) || (rawData.volume as number) || 0;
    const liquidity = (rawData.liquidity as number) || 0;

    const confidence = computeConfidence({
      volume,
      liquidity,
      yesProbability: Math.round(yesProb * 100),
      closesAt: market.closes_at as string,
    });

    // === 2. MOMENTUM + NOISE FILTER ===
    const now = Date.now();
    const startTime24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: historyData } = await this.supabase
      .from("telekash_probability_history")
      .select("probability, recorded_at")
      .eq("market_id", market.id)
      .gte("recorded_at", startTime24h)
      .order("recorded_at", { ascending: true });

    let momentum = 0;
    let signalQuality = "insufficient_data";
    let reversals = 0;
    let signalRatio = 0;
    let dataPoints = 0;

    if (historyData && historyData.length >= 2) {
      const probs = historyData.map(
        (h: Record<string, unknown>) => h.probability as number,
      );
      dataPoints = probs.length;
      momentum = probs[probs.length - 1] - probs[0];

      let sustainedMoves = 0;
      for (let i = 2; i < probs.length; i++) {
        const prevDir = probs[i - 1] - probs[i - 2];
        const currDir = probs[i] - probs[i - 1];
        if (prevDir * currDir < 0) reversals++;
        else if (Math.abs(currDir) > 0.001) sustainedMoves++;
      }
      const totalMoves = Math.max(1, reversals + sustainedMoves);
      signalRatio = sustainedMoves / totalMoves;
      signalQuality =
        probs.length < 3
          ? "insufficient_data"
          : signalRatio >= 0.6
            ? "signal"
            : signalRatio >= 0.4
              ? "weak"
              : "noise";
    }

    // === 3. SENTIMENT ===
    const closesAt = new Date(market.closes_at as string).getTime();
    const daysToClose = Math.max(0, (closesAt - now) / (1000 * 60 * 60 * 24));

    const probabilityConviction = Math.abs(yesProb - 0.5) * 2;
    const volumeSignal = Math.min(1, Math.log10(Math.max(1, volume)) / 7);
    const recencyScore =
      daysToClose <= 1
        ? 1.0
        : daysToClose <= 7
          ? 0.8
          : daysToClose <= 30
            ? 0.5
            : 0.3;
    const momentumScore = Math.min(1, Math.abs(momentum) * 5);

    const sentimentScore = (yesProb - 0.5) * 2; // -1 to 1
    const sentimentConfidence =
      probabilityConviction * 0.3 +
      volumeSignal * 0.3 +
      recencyScore * 0.2 +
      momentumScore * 0.2;

    let recommendation: string;
    if (sentimentScore > 0.3 && sentimentConfidence > 0.4)
      recommendation = "bullish";
    else if (sentimentScore < -0.3 && sentimentConfidence > 0.4)
      recommendation = "bearish";
    else recommendation = "neutral";

    // === 4. CROSS-SOURCE SPREAD ===
    let crossSource: Record<string, unknown> | null = null;
    const titleWords = (market.title as string)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w: string) => w.length > 3);

    if (titleWords.length >= 2) {
      // Find matching market on different source
      const otherSource =
        (market.source as string) === "kalshi" ? "polymarket" : "kalshi";
      const searchPattern = `%${titleWords.slice(0, 3).join("%")}%`;

      const { data: matches } = await this.supabase
        .from("telekash_markets")
        .select("id, title, source, external_odds")
        .eq("source", otherSource)
        .eq("status", "active")
        .ilike("title", searchPattern)
        .limit(3);

      if (matches && matches.length > 0) {
        // Pick best match by word overlap
        let bestMatch: Record<string, unknown> | null = null;
        let bestOverlap = 0;

        for (const m of matches as Record<string, unknown>[]) {
          const mWords = (m.title as string)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter((w: string) => w.length > 3);
          const overlap = titleWords.filter((w: string) =>
            mWords.includes(w),
          ).length;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestMatch = m;
          }
        }

        if (bestMatch && bestOverlap >= 2) {
          const otherYes =
            (bestMatch.external_odds as Record<string, number>)?.yes || 0.5;
          const spread = Math.abs(yesProb - otherYes);

          crossSource = {
            other_source: otherSource,
            other_market_id: bestMatch.id,
            other_title: bestMatch.title,
            other_yes_probability: Math.round(otherYes * 100),
            spread_pct: parseFloat((spread * 100).toFixed(1)),
            word_overlap: bestOverlap,
            arbitrage_signal:
              spread >= 0.05
                ? yesProb > otherYes
                  ? `BUY YES on ${otherSource}, SELL YES on ${market.source}`
                  : `BUY YES on ${market.source}, SELL YES on ${otherSource}`
                : null,
          };
        }
      }
    }

    // === 5. VERDICT ===
    // Multi-factor verdict combining all signals
    let verdictScore = 0; // -100 to +100

    // Probability direction (+/- 40 points)
    verdictScore += sentimentScore * 40;

    // Confidence weight (+/- 20 points)
    if (confidence.grade === "HIGH")
      verdictScore += Math.sign(sentimentScore) * 20;
    else if (confidence.grade === "MEDIUM")
      verdictScore += Math.sign(sentimentScore) * 10;
    else if (confidence.grade === "VERY_LOW")
      verdictScore -= Math.abs(sentimentScore) * 10;

    // Momentum boost (+/- 20 points) — only if signal quality is good
    if (signalQuality === "signal") {
      verdictScore += momentum * 200; // ±0.1 momentum = ±20 points
    } else if (signalQuality === "noise") {
      verdictScore *= 0.7; // Dampen verdict when momentum is noise
    }

    // Cross-source arbitrage boost (+/- 20 points)
    if (crossSource && (crossSource.spread_pct as number) >= 5) {
      verdictScore += Math.sign(sentimentScore) * 10;
    }

    // Map to verdict
    let verdict: string;
    if (verdictScore > 35) verdict = "STRONG_BUY";
    else if (verdictScore > 15) verdict = "BUY";
    else if (verdictScore > -15) verdict = "HOLD";
    else if (verdictScore > -35) verdict = "SELL";
    else verdict = "STRONG_SELL";

    // Override to NO_SIGNAL if data is insufficient
    if (
      confidence.grade === "VERY_LOW" &&
      signalQuality === "insufficient_data"
    ) {
      verdict = "NO_SIGNAL";
    }

    // === CALIBRATION ===
    const signalCategory = (market.category as string) || "general";
    const calibration = this.oracle.calibrate(yesProb, signalCategory);

    // === BUILD TPF RESPONSE ===
    const tpf = {
      format: "TPF",
      version: "1.1",
      market: {
        id: market.id,
        title: market.title,
        source: market.source,
        category: market.category,
        closes_at: market.closes_at,
        days_to_close: parseFloat(daysToClose.toFixed(1)),
      },
      probability: {
        yes: Math.round(yesProb * 100),
        no: Math.round(noProb * 100),
        calibrated_yes: Math.round(calibration.calibrated_confidence * 100),
        calibration_version: calibration.calibration_version,
        confidence: {
          score: confidence.score,
          grade: confidence.grade,
          factors: confidence.factors,
          warning: confidence.warning,
        },
      },
      sentiment: {
        score: parseFloat(sentimentScore.toFixed(3)),
        confidence: parseFloat(sentimentConfidence.toFixed(3)),
        recommendation,
        components: {
          probability_conviction: parseFloat(probabilityConviction.toFixed(3)),
          volume_signal: parseFloat(volumeSignal.toFixed(3)),
          recency_relevance: parseFloat(recencyScore.toFixed(3)),
          momentum_24h: parseFloat(momentumScore.toFixed(3)),
        },
      },
      noise_filter: {
        signal_quality: signalQuality,
        signal_ratio: parseFloat(signalRatio.toFixed(3)),
        reversals_24h: reversals,
        data_points: dataPoints,
        _warning:
          signalQuality === "noise"
            ? "Momentum is likely noise — 58% of short-term price moves reverse within 24h"
            : null,
      },
      cross_source: crossSource,
      verdict: {
        action: verdict,
        score: parseFloat(verdictScore.toFixed(1)),
        reasoning: buildVerdictReasoning(
          verdict,
          confidence.grade,
          signalQuality,
          recommendation,
          crossSource,
          momentum,
        ),
      },
      ...(daysToClose <= 1
        ? {
            holding_period_warning:
              "Markets closing within 24h show 18% lower returns for late entrants — price convergence compresses edge.",
          }
        : {}),
      metadata: {
        generated_at: new Date().toISOString(),
        oracle: "TeleKash Probability Oracle",
        signal_source:
          "Pre-computed from live market data across regulated exchanges, not LLM-generated",
        _note:
          "TPF (TeleKash Probability Format) — structured signal for autonomous agents. One call replaces get_probability + get_sentiment + get_history + compare_sources.",
      },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(tpf, null, 2),
        },
      ],
    };
  }

  // ===========================================
  // CREATE MARKET — Agent-created prediction markets
  // ===========================================

  private async createMarket(args: {
    title: string;
    description?: string;
    category: string;
    closes_at: string;
    resolves_at: string;
    resolution_criteria: string;
    creator_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const {
      title,
      description,
      category,
      closes_at,
      resolves_at,
      resolution_criteria,
      creator_id,
    } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Validate dates
    const closeDate = new Date(closes_at);
    const resolveDate = new Date(resolves_at);
    const now = new Date();

    if (isNaN(closeDate.getTime()) || isNaN(resolveDate.getTime())) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Invalid date format. Use ISO 8601 (e.g., 2026-04-01T00:00:00Z)",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (closeDate <= now) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "closes_at must be in the future" },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (resolveDate <= closeDate) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "resolves_at must be after closes_at" },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Validate category
    const validCategories = [
      "crypto",
      "politics",
      "economics",
      "sports",
      "weather",
      "other",
    ];
    if (!validCategories.includes(category)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Invalid category. Must be one of: ${validCategories.join(", ")}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Generate external_id
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 50);
    const externalId = `agent-${slug}-${Date.now().toString(36)}`;

    // Create the market
    const { data: market, error } = await this.supabase
      .from("telekash_markets")
      .insert({
        external_id: externalId,
        source: "agent",
        source_url: null,
        title,
        description: description || null,
        category,
        subcategory: null,
        outcomes: ["Yes", "No"],
        external_odds: { yes: 0.5, no: 0.5 },
        resolution_source: "agent",
        status: "active",
        closes_at: closeDate.toISOString(),
        resolves_at: resolveDate.toISOString(),
        raw_data: {
          created_by: creator_id,
          resolution_criteria,
          source_type: "agent-created",
          volume: 0,
          liquidity: 0,
        },
      })
      .select("id, external_id, title, category, closes_at, resolves_at")
      .single();

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to create market",
                details: error.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              market: {
                id: market.id,
                external_id: market.external_id,
                title: market.title,
                category: market.category,
                closes_at: market.closes_at,
                resolves_at: market.resolves_at,
                initial_odds: "50/50",
                resolution_criteria,
                created_by: creator_id,
              },
              permissionless: true,
              _note:
                "Market created successfully. No gatekeepers, no approval queue — you set the question, the market resolves on the date. Other agents can now query via get_probability, get_signal, and track_prediction.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // CAPITAL EFFICIENCY — Kelly Criterion + Edge Analysis
  // ===========================================

  private async getEdge(args: {
    bankroll?: number;
    agent_id?: string;
    category?: string;
    min_confidence?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const {
      bankroll = 1000,
      agent_id,
      category,
      min_confidence = "MEDIUM",
      limit = 10,
    } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 30);

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Get agent's historical accuracy if available
    let agentEdge = 0; // how much better/worse than market consensus
    if (agent_id) {
      const { data: predictions } = await this.supabase
        .from("telekash_agent_predictions")
        .select(
          "predicted_probability, market_probability_at_prediction, is_correct",
        )
        .eq("agent_id", agent_id)
        .eq("status", "resolved")
        .limit(100);

      if (predictions && predictions.length >= 5) {
        // Calculate agent's calibration edge
        let edgeSum = 0;
        for (const p of predictions as Record<string, unknown>[]) {
          const predicted = p.predicted_probability as number;
          const market = p.market_probability_at_prediction as number;
          const correct = p.is_correct as boolean;
          // If agent was right AND diverged from market, that's positive edge
          if (correct && Math.abs(predicted - market) > 0.05) {
            edgeSum += Math.abs(predicted - market);
          } else if (!correct && Math.abs(predicted - market) > 0.05) {
            edgeSum -= Math.abs(predicted - market);
          }
        }
        agentEdge = edgeSum / predictions.length;
      }
    }

    // Get active markets with high confidence
    let query = this.supabase
      .from("telekash_markets")
      .select("id, title, source, category, external_odds, raw_data, closes_at")
      .eq("status", "active")
      .order("raw_data->volume", { ascending: false })
      .limit(200);

    if (category && category !== "all") {
      query = query.eq("category", category);
    }

    const { data: markets } = await query;
    if (!markets || markets.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { opportunities: [], summary: { total: 0 } },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Score each market for capital efficiency
    const opportunities: Array<{
      market_id: string;
      title: string;
      source: string;
      category: string;
      yes_probability: number;
      confidence_grade: string;
      edge_pct: number;
      kelly_fraction: number;
      optimal_bet: number;
      expected_value_per_dollar: number;
      risk_classification: string;
      days_to_close: number;
      annualized_return_pct: number;
      opportunity_cost: { vs_risk_free: number; worth_locking: boolean };
      holding_period_warning?: string;
    }> = [];

    const confidenceThresholds: Record<string, number> = {
      HIGH: 0.8,
      MEDIUM: 0.5,
      LOW: 0.3,
    };
    const minConfScore = confidenceThresholds[min_confidence] || 0.5;

    for (const market of markets as Record<string, unknown>[]) {
      const odds = market.external_odds as Record<string, number>;
      const rawData = (market.raw_data as Record<string, unknown>) || {};
      const yesProb = odds?.yes || 0.5;
      const volume =
        (rawData.volume_24h as number) || (rawData.volume as number) || 0;
      const liquidity = (rawData.liquidity as number) || 0;

      const confidence = computeConfidence({
        volume,
        liquidity,
        yesProbability: Math.round(yesProb * 100),
        closesAt: market.closes_at as string,
      });

      if (confidence.score < minConfScore) continue;

      // Edge calculation
      // For markets near 50%, the edge from probability conviction is small
      // For markets with strong conviction (>70% or <30%), edge = distance from fair
      const probConviction = Math.abs(yesProb - 0.5);
      const edge = probConviction + agentEdge; // agent's historical edge adds

      if (edge < 0.02) continue; // Skip markets with <2% edge

      // Kelly Criterion: f* = (bp - q) / b
      // where b = odds, p = estimated probability of winning, q = 1-p
      // Simplified for binary: f* = 2*edge (capped at 0.25 = quarter-Kelly for safety)
      const kellyFraction = Math.min(0.25, 2 * edge);
      const optimalBet = parseFloat((bankroll * kellyFraction).toFixed(2));

      // Expected value per dollar
      const evPerDollar = parseFloat((edge * 2).toFixed(4)); // simplified EV

      // Days to close
      const closesAt = new Date(market.closes_at as string).getTime();
      const daysToClose = Math.max(
        0.1,
        (closesAt - Date.now()) / (1000 * 60 * 60 * 24),
      );

      // Annualized return (edge / days * 365)
      const annualizedReturn = parseFloat(
        ((edge / daysToClose) * 365 * 100).toFixed(1),
      );

      // Risk classification
      let riskClass: string;
      if (kellyFraction > 0.15) riskClass = "aggressive";
      else if (kellyFraction > 0.05) riskClass = "moderate";
      else riskClass = "conservative";

      // Opportunity cost: annualized return vs risk-free rate (5%)
      const riskFreeRate = 5.0;
      const opportunityCostPct = parseFloat(
        (annualizedReturn - riskFreeRate).toFixed(1),
      );

      opportunities.push({
        market_id: market.id as string,
        title: market.title as string,
        source: market.source as string,
        category: market.category as string,
        yes_probability: Math.round(yesProb * 100),
        confidence_grade: confidence.grade,
        edge_pct: parseFloat((edge * 100).toFixed(1)),
        kelly_fraction: parseFloat(kellyFraction.toFixed(4)),
        optimal_bet: optimalBet,
        expected_value_per_dollar: evPerDollar,
        risk_classification: riskClass,
        days_to_close: parseFloat(daysToClose.toFixed(1)),
        annualized_return_pct: annualizedReturn,
        opportunity_cost: {
          vs_risk_free: opportunityCostPct,
          worth_locking: opportunityCostPct > 0,
        },
        ...(daysToClose <= 1
          ? {
              holding_period_warning:
                "Market closing within 24h — late entries show 18% lower realized returns",
            }
          : {}),
      });
    }

    // Sort by annualized return (best risk/reward considering time)
    opportunities.sort(
      (a, b) => b.annualized_return_pct - a.annualized_return_pct,
    );
    const results = opportunities.slice(0, effectiveLimit);

    // Calculate total allocation
    const totalAllocated = results.reduce((sum, o) => sum + o.optimal_bet, 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              opportunities: results,
              portfolio_summary: {
                bankroll,
                total_allocated: parseFloat(totalAllocated.toFixed(2)),
                reserve: parseFloat((bankroll - totalAllocated).toFixed(2)),
                markets_analyzed: markets.length,
                opportunities_found: opportunities.length,
                returned: results.length,
                agent_historical_edge: agent_id
                  ? parseFloat((agentEdge * 100).toFixed(2)) + "%"
                  : "N/A (provide agent_id for personalized edge)",
                min_confidence_filter: min_confidence,
              },
              _note:
                "Kelly fractions are capped at quarter-Kelly (25%) for safety. Optimal bet = bankroll × kelly_fraction. Annualized return assumes edge is realized over time-to-close. Use track_prediction to build accuracy history for better edge estimates.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // CONSENSUS DIVERGENCE DETECTION
  // ===========================================

  private async getDivergences(args: {
    min_spread?: number;
    category?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { min_spread = 5, category, limit = 10 } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 50);
    const minSpreadDecimal = min_spread / 100;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Get all active markets grouped by title similarity
    // We need to find the same event across different sources
    const sources = ["kalshi", "polymarket", "metaculus"];
    const marketsBySource: Record<string, Record<string, unknown>[]> = {};

    for (const source of sources) {
      let query = this.supabase
        .from("telekash_markets")
        .select("id, title, source, external_odds, category, raw_data")
        .eq("source", source)
        .eq("status", "active")
        .order("raw_data->volume", { ascending: false })
        .limit(300);

      if (category && category !== "all") {
        query = query.eq("category", category);
      }

      const { data } = await query;
      marketsBySource[source] = (data as Record<string, unknown>[]) || [];
    }

    // Cross-match markets between sources using word overlap
    const divergences: Array<{
      title: string;
      category: string;
      sources: Record<
        string,
        { market_id: string; yes_probability: number; title: string }
      >;
      max_spread: number;
      classification: string;
      forecaster_depth: number | null;
    }> = [];

    // Use Kalshi as anchor, match against Polymarket and Metaculus
    const kalshiMarkets = marketsBySource["kalshi"] || [];
    const polyMarkets = marketsBySource["polymarket"] || [];
    const metaculusMarkets = marketsBySource["metaculus"] || [];

    for (const kalshi of kalshiMarkets) {
      const kTitle = (kalshi.title as string)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "");
      const kWords = kTitle.split(/\s+/).filter((w) => w.length > 3);
      if (kWords.length < 2) continue;

      const kYes = (kalshi.external_odds as Record<string, number>)?.yes || 0.5;

      const sourceData: Record<
        string,
        { market_id: string; yes_probability: number; title: string }
      > = {
        kalshi: {
          market_id: kalshi.id as string,
          yes_probability: Math.round(kYes * 100),
          title: kalshi.title as string,
        },
      };

      let maxSpread = 0;
      let forecasterDepth: number | null = null;

      // Match Polymarket
      for (const poly of polyMarkets) {
        const pTitle = (poly.title as string)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "");
        const pWords = pTitle.split(/\s+/).filter((w) => w.length > 3);
        const overlap = kWords.filter((w) => pWords.includes(w)).length;

        if (overlap >= 2) {
          const pYes =
            (poly.external_odds as Record<string, number>)?.yes || 0.5;
          sourceData["polymarket"] = {
            market_id: poly.id as string,
            yes_probability: Math.round(pYes * 100),
            title: poly.title as string,
          };
          maxSpread = Math.max(maxSpread, Math.abs(kYes - pYes));
          break;
        }
      }

      // Match Metaculus
      for (const meta of metaculusMarkets) {
        const mTitle = (meta.title as string)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "");
        const mWords = mTitle.split(/\s+/).filter((w) => w.length > 3);
        const overlap = kWords.filter((w) => mWords.includes(w)).length;

        if (overlap >= 2) {
          const mYes =
            (meta.external_odds as Record<string, number>)?.yes || 0.5;
          sourceData["metaculus"] = {
            market_id: meta.id as string,
            yes_probability: Math.round(mYes * 100),
            title: meta.title as string,
          };
          maxSpread = Math.max(maxSpread, Math.abs(kYes - mYes));

          // Get forecaster count from Metaculus
          const rawData = meta.raw_data as Record<string, unknown>;
          forecasterDepth =
            (rawData?.forecaster_count as number) ||
            (rawData?.nr_forecasters as number) ||
            null;
          break;
        }
      }

      // Also check Polymarket vs Metaculus spread
      if (sourceData["polymarket"] && sourceData["metaculus"]) {
        const pYes = sourceData["polymarket"].yes_probability / 100;
        const mYes = sourceData["metaculus"].yes_probability / 100;
        maxSpread = Math.max(maxSpread, Math.abs(pYes - mYes));
      }

      // Only include if we have 2+ sources and spread meets threshold
      if (
        Object.keys(sourceData).length >= 2 &&
        maxSpread >= minSpreadDecimal
      ) {
        divergences.push({
          title: kalshi.title as string,
          category: kalshi.category as string,
          sources: sourceData,
          max_spread: parseFloat((maxSpread * 100).toFixed(1)),
          classification:
            maxSpread >= 0.15
              ? "STRONG"
              : maxSpread >= 0.08
                ? "MODERATE"
                : "WEAK",
          forecaster_depth: forecasterDepth,
        });
      }
    }

    // Sort by spread descending
    divergences.sort((a, b) => b.max_spread - a.max_spread);
    const results = divergences.slice(0, effectiveLimit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              divergences: results,
              summary: {
                total_found: divergences.length,
                returned: results.length,
                strong: divergences.filter((d) => d.classification === "STRONG")
                  .length,
                moderate: divergences.filter(
                  (d) => d.classification === "MODERATE",
                ).length,
                weak: divergences.filter((d) => d.classification === "WEAK")
                  .length,
                min_spread_filter: min_spread,
                sources_scanned: {
                  kalshi: kalshiMarkets.length,
                  polymarket: polyMarkets.length,
                  metaculus: metaculusMarkets.length,
                },
              },
              consensus_divergence_warning: results.some((d) => {
                const probs = Object.values(d.sources).map(
                  (s) => s.yes_probability,
                );
                const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
                return probs.some(
                  (p) => (p > 50 && avg < 50) || (p < 50 && avg > 50),
                );
              })
                ? "Sources disagree on DIRECTION for some markets — when exchanges point opposite ways, one crowd is herding wrong. The cross-source truth is in the volume-weighted average."
                : null,
              _note:
                "Divergences show where prediction sources disagree. STRONG divergences (>15%) are rare and high-value — at least one source is significantly wrong. Metaculus forecaster_depth indicates crowd wisdom backing.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // AGENT PERFORMANCE TRACKING
  // ===========================================

  private checkMilestone(predictionCount: number): {
    milestone: boolean;
    message: string;
    tier: string;
    next: number | null;
  } | null {
    const milestones: Record<number, { message: string; tier: string }> = {
      10: {
        message:
          "Trader unlocked! You've made 10 predictions. Custom avatar available.",
        tier: "Trader",
      },
      50: {
        message:
          "Analyst achieved! 50 predictions. Early market access unlocked.",
        tier: "Analyst",
      },
      100: {
        message: "Century club! 100 predictions. Entering Expert territory.",
        tier: "Expert",
      },
      200: {
        message: "Expert status! 200 predictions. Reduced fees activated.",
        tier: "Expert",
      },
      500: {
        message:
          "Oracle rank achieved! 500 predictions. You can now create markets.",
        tier: "Oracle",
      },
      1000: {
        message:
          "Legend! 1000 predictions. Revenue share unlocked. You are the top.",
        tier: "Legend",
      },
    };

    if (milestones[predictionCount]) {
      const next =
        Object.keys(milestones)
          .map(Number)
          .find((m) => m > predictionCount) || null;
      return {
        milestone: true,
        message: milestones[predictionCount].message,
        tier: milestones[predictionCount].tier,
        next,
      };
    }
    return null;
  }

  private async trackPrediction(args: {
    market_id: string;
    agent_id: string;
    predicted_outcome: string;
    predicted_probability: number;
    reasoning?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const {
      market_id,
      agent_id,
      predicted_outcome,
      predicted_probability,
      reasoning,
    } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Validate probability
    if (predicted_probability < 0 || predicted_probability > 1) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "predicted_probability must be between 0.0 and 1.0",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Find market
    const { data: market } = await this.supabase
      .from("telekash_markets")
      .select("id, title, source, status, external_odds, resolved_outcome")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .single();

    if (!market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Market not found", market_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Check for duplicate prediction
    const { data: existing } = await this.supabase
      .from("telekash_agent_predictions")
      .select("id")
      .eq("agent_id", agent_id)
      .eq("market_id", market.id)
      .limit(1)
      .single();

    if (existing) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Already predicted on this market",
                prediction_id: existing.id,
                _note:
                  "Each agent gets one prediction per market. This prevents gaming accuracy metrics.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Record the prediction
    const currentYesProb =
      (market.external_odds as Record<string, number>)?.yes || 0.5;

    const { data: prediction, error } = await this.supabase
      .from("telekash_agent_predictions")
      .insert({
        agent_id,
        market_id: market.id,
        predicted_outcome: predicted_outcome.toUpperCase(),
        predicted_probability,
        market_probability_at_prediction: currentYesProb,
        reasoning: reasoning || null,
        status: market.status === "resolved" ? "resolved" : "pending",
        is_correct:
          market.status === "resolved"
            ? market.resolved_outcome?.toUpperCase() ===
              predicted_outcome.toUpperCase()
            : null,
      })
      .select("id, created_at")
      .single();

    if (error) {
      // Table might not exist yet — create it
      if (error.code === "42P01") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Agent predictions table not yet created",
                  _note:
                    "Run the telekash_agent_predictions migration first. This table stores agent prediction history for performance tracking.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to record prediction", details: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Check for AURA POLARIS milestones
    let milestoneNotification = null;
    if (this.supabase) {
      const { count } = await this.supabase
        .from("telekash_agent_predictions")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent_id);
      if (count) {
        milestoneNotification = this.checkMilestone(count);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              prediction: {
                id: prediction.id,
                agent_id,
                market: market.title,
                market_id: market.id,
                predicted_outcome: predicted_outcome.toUpperCase(),
                predicted_probability,
                market_probability_at_prediction: Math.round(
                  currentYesProb * 100,
                ),
                edge: parseFloat(
                  (
                    Math.abs(predicted_probability - currentYesProb) * 100
                  ).toFixed(1),
                ),
                recorded_at: prediction.created_at,
              },
              ...(milestoneNotification
                ? { milestone: milestoneNotification }
                : {}),
              _note:
                "Prediction recorded. Check accuracy after market resolves with get_performance.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getPerformance(args: {
    agent_id: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { agent_id, limit = 20 } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 100);

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Get all predictions for this agent
    const { data: predictions, error } = await this.supabase
      .from("telekash_agent_predictions")
      .select(
        "id, market_id, predicted_outcome, predicted_probability, market_probability_at_prediction, is_correct, status, reasoning, created_at",
      )
      .eq("agent_id", agent_id)
      .order("created_at", { ascending: false })
      .limit(effectiveLimit);

    if (error) {
      if (error.code === "42P01") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Agent predictions table not yet created",
                  _note: "Run the telekash_agent_predictions migration first.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to fetch predictions", details: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (!predictions || predictions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                agent_id,
                total_predictions: 0,
                _note:
                  "No predictions found. Use track_prediction to record predictions.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Calculate metrics
    const total = predictions.length;
    const resolved = predictions.filter(
      (p: Record<string, unknown>) => p.status === "resolved",
    );
    const pending = total - resolved.length;
    const correct = resolved.filter(
      (p: Record<string, unknown>) => p.is_correct === true,
    );
    const accuracy =
      resolved.length > 0 ? correct.length / resolved.length : null;

    // Brier score (only for resolved predictions)
    let brierScore: number | null = null;
    if (resolved.length > 0) {
      let brierSum = 0;
      for (const p of resolved as Record<string, unknown>[]) {
        const prob = p.predicted_probability as number;
        const outcome = p.is_correct ? 1 : 0;
        // Brier score: mean squared error of probability forecasts
        // If predicted YES at 0.8 and it was YES → (0.8 - 1)^2 = 0.04 (good)
        // If predicted YES at 0.8 and it was NO → (0.8 - 0)^2 = 0.64 (bad)
        const forecastForOutcome =
          (p.predicted_outcome as string) === "YES" ? prob : 1 - prob;
        brierSum += Math.pow(forecastForOutcome - outcome, 2);
      }
      brierScore = parseFloat((brierSum / resolved.length).toFixed(4));
    }

    // Calibration buckets (0-10%, 10-20%, ..., 90-100%)
    const calibrationBuckets: Record<
      string,
      { predictions: number; correct: number; avg_probability: number }
    > = {};
    for (const p of resolved as Record<string, unknown>[]) {
      const prob = p.predicted_probability as number;
      const bucketKey = `${Math.floor(prob * 10) * 10}-${Math.floor(prob * 10) * 10 + 10}%`;
      if (!calibrationBuckets[bucketKey]) {
        calibrationBuckets[bucketKey] = {
          predictions: 0,
          correct: 0,
          avg_probability: 0,
        };
      }
      calibrationBuckets[bucketKey].predictions++;
      if (p.is_correct) calibrationBuckets[bucketKey].correct++;
      calibrationBuckets[bucketKey].avg_probability += prob;
    }
    // Finalize averages
    for (const bucket of Object.values(calibrationBuckets)) {
      bucket.avg_probability = parseFloat(
        (bucket.avg_probability / bucket.predictions).toFixed(3),
      );
    }

    // Edge analysis — were predictions better than market consensus?
    let avgEdge = 0;
    let edgeWins = 0;
    for (const p of resolved as Record<string, unknown>[]) {
      const marketProb = p.market_probability_at_prediction as number;
      const predictedProb = p.predicted_probability as number;
      const edge = Math.abs(predictedProb - marketProb);
      avgEdge += edge;
      // Did the agent's divergence from market add value?
      if (p.is_correct && predictedProb > marketProb) edgeWins++;
      if (!p.is_correct && predictedProb < marketProb) edgeWins++;
    }
    avgEdge =
      resolved.length > 0
        ? parseFloat((avgEdge / resolved.length).toFixed(4))
        : 0;

    // Get market titles for recent predictions
    const marketIds = predictions
      .slice(0, 10)
      .map((p: Record<string, unknown>) => p.market_id);
    const { data: markets } = await this.supabase
      .from("telekash_markets")
      .select("id, title")
      .in("id", marketIds);

    const marketTitleMap = new Map(
      (markets || []).map((m: Record<string, unknown>) => [m.id, m.title]),
    );

    const recentPredictions = predictions
      .slice(0, 10)
      .map((p: Record<string, unknown>) => ({
        market: marketTitleMap.get(p.market_id as string) || p.market_id,
        predicted: `${p.predicted_outcome} @ ${Math.round((p.predicted_probability as number) * 100)}%`,
        market_was: `${Math.round((p.market_probability_at_prediction as number) * 100)}% YES`,
        status: p.status,
        correct: p.is_correct,
        date: p.created_at,
      }));

    // Benchmark against platform average
    let benchmark = null;
    if (this.supabase && brierScore !== null) {
      const { data: allPredictions } = await this.supabase
        .from("telekash_agent_predictions")
        .select("brier_score")
        .not("brier_score", "is", null)
        .limit(1000);

      if (allPredictions && allPredictions.length > 5) {
        const scores = allPredictions
          .map((p: Record<string, unknown>) => p.brier_score as number)
          .sort((a: number, b: number) => a - b);
        const median = scores[Math.floor(scores.length / 2)];
        const betterThan = scores.filter((s: number) => s > brierScore).length;
        const percentile = Math.round((betterThan / scores.length) * 100);

        benchmark = {
          your_brier_score: brierScore,
          platform_median: median,
          percentile,
          rank: `Top ${100 - percentile}% of agents`,
          total_agents_tracked: scores.length,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              agent_id,
              summary: {
                total_predictions: total,
                resolved: resolved.length,
                pending,
                correct: correct.length,
                accuracy:
                  accuracy !== null
                    ? parseFloat((accuracy * 100).toFixed(1)) + "%"
                    : "N/A (no resolved predictions)",
                brier_score: brierScore,
                brier_interpretation:
                  brierScore !== null
                    ? brierScore < 0.1
                      ? "Excellent — top-tier forecaster"
                      : brierScore < 0.2
                        ? "Good — better than market average"
                        : brierScore < 0.3
                          ? "Fair — room for improvement"
                          : "Poor — worse than coin flip"
                    : null,
              },
              edge_analysis: {
                avg_edge_vs_market:
                  parseFloat((avgEdge * 100).toFixed(1)) + "%",
                edge_win_rate:
                  resolved.length > 0
                    ? parseFloat(
                        ((edgeWins / resolved.length) * 100).toFixed(1),
                      ) + "%"
                    : "N/A",
                _note:
                  "Edge measures how much your predictions diverged from market consensus. Edge win rate shows if that divergence added value.",
              },
              ...(benchmark ? { benchmark } : {}),
              reality_check:
                brierScore !== null
                  ? {
                      percentile: benchmark ? benchmark.percentile : null,
                      context:
                        "Across prediction markets, only ~7.6% of participants are consistently profitable. Calibration (Brier score) is the strongest predictor of long-term edge.",
                    }
                  : null,
              calibration: calibrationBuckets,
              ...this.oracle.getAgentInsight(agent_id, brierScore, total),
              recent_predictions: recentPredictions,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // AGENT TRADING METHODS (v0.3.0) — Gated until pools funded
  // ===========================================

  private async getPoolStatus(args: { pool_id?: string }): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Get pool - default to first active pool if not specified
    let poolQuery = this.supabase
      .from("telekash_agent_pools")
      .select(
        `
        *,
        agent:telekash_agent_configs(name, strategy, risk_level)
      `,
      )
      .eq("status", "active");

    if (args.pool_id) {
      poolQuery = poolQuery.eq("id", args.pool_id);
    }

    const { data: pools, error } = await poolQuery.limit(1).single();

    if (error || !pools) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "No active pool found", pool_id: args.pool_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    const pool = pools;

    // Count open positions
    const { count: openPositions } = await this.supabase
      .from("telekash_agent_bets")
      .select("*", { count: "exact", head: true })
      .eq("pool_id", pool.id)
      .eq("status", "pending");

    // Calculate metrics
    const totalTrades = (pool.winning_trades || 0) + (pool.losing_trades || 0);
    const winRate =
      totalTrades > 0 ? ((pool.winning_trades || 0) / totalTrades) * 100 : 0;
    const netPnL = (pool.total_profit || 0) - (pool.total_loss || 0);
    const roi =
      pool.total_deposits > 0 ? (netPnL / pool.total_deposits) * 100 : 0;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pool_id: pool.id,
              name: pool.agent?.name || "Unknown Pool",
              strategy: pool.agent?.strategy || "balanced",
              risk_level: pool.agent?.risk_level || "medium",
              status: pool.status,
              balance: {
                total: parseFloat(pool.total_balance || 0),
                available: parseFloat(pool.total_balance || 0), // Simplified
                currency: pool.pool_type?.toUpperCase() || "TON",
              },
              performance: {
                total_deposits: parseFloat(pool.total_deposits || 0),
                total_profit: parseFloat(pool.total_profit || 0),
                total_loss: parseFloat(pool.total_loss || 0),
                net_pnl: netPnL,
                roi_percent: roi.toFixed(2),
                winning_trades: pool.winning_trades || 0,
                losing_trades: pool.losing_trades || 0,
                win_rate_percent: winRate.toFixed(1),
              },
              open_positions: openPositions || 0,
              can_trade: pool.status === "active",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async executeTrade(args: {
    market_id: string;
    side: "yes" | "no";
    amount: number;
    pool_id?: string;
    reasoning?: string;
    confidence?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { market_id, side, amount, reasoning, confidence } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Validate amount
    if (amount <= 0 || amount > 10) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Invalid amount. Must be between 0 and 10 TON." },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get pool
    let poolQuery = this.supabase
      .from("telekash_agent_pools")
      .select("*")
      .eq("status", "active");

    if (args.pool_id) {
      poolQuery = poolQuery.eq("id", args.pool_id);
    }

    const { data: pool, error: poolError } = await poolQuery.limit(1).single();

    if (poolError || !pool) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No active pool found" }, null, 2),
          },
        ],
      };
    }

    // Check balance
    if (parseFloat(pool.total_balance || 0) < amount) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Insufficient pool balance",
                available: parseFloat(pool.total_balance || 0),
                requested: amount,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get market
    const { data: market, error: marketError } = await this.supabase
      .from("telekash_markets")
      .select("*")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .eq("status", "active")
      .single();

    if (marketError || !market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Market not found or not active", market_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get current odds
    const odds =
      side === "yes"
        ? market.external_odds?.yes || 0.5
        : market.external_odds?.no || 0.5;

    // Calculate expected payout
    const expectedPayout = amount / odds;

    // Check with Market Maker bankroll (can_place_bet function)
    const { data: canBet, error: betCheckError } = await this.supabase.rpc(
      "can_place_bet",
      {
        p_amount_stars: Math.round(amount * 100), // Convert to Stars
        p_odds: odds,
      },
    );

    if (betCheckError || !canBet?.[0]?.allowed) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Trade rejected by Market Maker",
                reason: canBet?.[0]?.reason || "Unknown",
                max_allowed_ton: (canBet?.[0]?.max_allowed_stars || 0) / 100,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Create the position
    const { data: position, error: positionError } = await this.supabase
      .from("telekash_agent_bets")
      .insert({
        pool_id: pool.id,
        market_id: market.id,
        outcome: side.toUpperCase(),
        amount: amount,
        odds_at_entry: odds,
        confidence: confidence || null,
        reasoning: reasoning || null,
        status: "pending",
      })
      .select()
      .single();

    if (positionError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to create position",
                details: positionError.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Update pool balance
    await this.supabase
      .from("telekash_agent_pools")
      .update({
        total_balance: parseFloat(pool.total_balance || 0) - amount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pool.id);

    // Update Market Maker exposure
    await this.supabase.rpc("update_market_exposure", {
      p_market_id: market.id,
      p_outcome: side.charAt(0).toUpperCase() + side.slice(1),
      p_bet_amount_stars: Math.round(amount * 100),
      p_bet_amount_ton: amount,
      p_odds: odds,
    });

    // Record the position received by bankroll
    await this.supabase.rpc("record_bet_received", {
      p_market_id: market.id,
      p_position_id: position.id,
      p_amount_ton: amount,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              position: {
                id: position.id,
                pool_id: pool.id,
                market_id: market.id,
                market_title: market.title,
                side: side.toUpperCase(),
                amount: amount,
                currency: pool.pool_type?.toUpperCase() || "TON",
                entry_probability: Math.round(odds * 100),
                expected_payout: expectedPayout.toFixed(4),
                status: "pending",
              },
              pool_balance_after: parseFloat(pool.total_balance || 0) - amount,
              message: `Trade executed: ${amount} ${pool.pool_type?.toUpperCase() || "TON"} on ${side.toUpperCase()} @ ${Math.round(odds * 100)}%`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getAgentPositions(args: {
    pool_id?: string;
    status?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { status = "pending", limit = 20 } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Get pool first
    let poolQuery = this.supabase
      .from("telekash_agent_pools")
      .select("id")
      .eq("status", "active");

    if (args.pool_id) {
      poolQuery = poolQuery.eq("id", args.pool_id);
    }

    const { data: pool } = await poolQuery.limit(1).single();

    if (!pool) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No active pool found" }, null, 2),
          },
        ],
      };
    }

    // Get positions with market details
    let positionsQuery = this.supabase
      .from("telekash_agent_bets")
      .select(
        `
        *,
        market:telekash_markets(id, title, external_odds, status, resolved_outcome)
      `,
      )
      .eq("pool_id", pool.id)
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 50));

    if (status !== "all") {
      positionsQuery = positionsQuery.eq("status", status);
    }

    const { data: positions, error } = await positionsQuery;

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formattedPositions = (positions || []).map((p: any) => {
      const currentOdds =
        p.outcome?.toLowerCase() === "yes"
          ? p.market?.external_odds?.yes
          : p.market?.external_odds?.no;
      const entryOdds = parseFloat(p.odds_at_entry || 0);
      const pnlPercent =
        currentOdds && entryOdds
          ? ((currentOdds - entryOdds) / entryOdds) * 100
          : 0;

      return {
        id: p.id,
        market_id: p.market_id,
        market_title: p.market?.title || "Unknown",
        side: p.outcome,
        amount: parseFloat(p.amount),
        entry_probability: Math.round(entryOdds * 100),
        current_probability: Math.round((currentOdds || entryOdds) * 100),
        unrealized_pnl_percent: pnlPercent.toFixed(2),
        status: p.status,
        reasoning: p.reasoning,
        confidence: p.confidence,
        created_at: p.created_at,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pool_id: pool.id,
              positions: formattedPositions,
              total: formattedPositions.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getRecommendedBetSize(args: {
    pool_id?: string;
    win_probability: number;
    market_odds: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { win_probability, market_odds } = args;

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    // Validate inputs
    if (win_probability <= 0 || win_probability >= 1) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "win_probability must be between 0 and 1 exclusive" },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (market_odds <= 0 || market_odds >= 1) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "market_odds must be between 0 and 1 exclusive" },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get pool
    let poolQuery = this.supabase
      .from("telekash_agent_pools")
      .select("*")
      .eq("status", "active");

    if (args.pool_id) {
      poolQuery = poolQuery.eq("id", args.pool_id);
    }

    const { data: pool } = await poolQuery.limit(1).single();

    if (!pool) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No active pool found" }, null, 2),
          },
        ],
      };
    }

    const poolBalance = parseFloat(pool.total_balance || 0);

    // Calculate Kelly Criterion
    // f* = (p * b - q) / b
    // where p = win probability, q = 1-p, b = odds (payout per unit wagered - 1)
    const p = win_probability;
    const q = 1 - p;
    const b = 1 / market_odds - 1; // Convert probability to decimal odds

    const fullKelly = (p * b - q) / b;

    // Apply quarter Kelly for conservative sizing
    const quarterKelly = fullKelly / 4;

    // Apply min/max constraints (0.5% min, 10% max)
    const minBet = poolBalance * 0.005;
    const maxBet = poolBalance * 0.1;

    let recommendedSize: number;
    let reasoning: string;

    if (fullKelly <= 0) {
      recommendedSize = 0;
      reasoning =
        "Negative edge - no trade recommended. Your win probability is too low relative to market odds.";
    } else {
      recommendedSize = Math.max(
        minBet,
        Math.min(maxBet, poolBalance * quarterKelly),
      );
      reasoning = `Positive edge detected. Using quarter-Kelly (${(quarterKelly * 100).toFixed(2)}%) with min/max constraints.`;
    }

    const edge = ((win_probability - market_odds) / market_odds) * 100;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pool_id: pool.id,
              pool_balance: poolBalance,
              inputs: {
                win_probability: win_probability,
                market_odds: market_odds,
                edge_percent: edge.toFixed(2),
              },
              kelly: {
                full_kelly_fraction: fullKelly.toFixed(4),
                quarter_kelly_fraction: quarterKelly.toFixed(4),
              },
              recommendation: {
                position_size: parseFloat(recommendedSize.toFixed(4)),
                as_percent_of_pool: (
                  (recommendedSize / poolBalance) *
                  100
                ).toFixed(2),
                min_position: minBet.toFixed(4),
                max_position: maxBet.toFixed(4),
                reasoning: reasoning,
              },
              should_trade: fullKelly > 0,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // WEBHOOK ALERT TOOLS
  // ===========================================

  private async registerAlert(args: {
    agent_id: string;
    market_id?: string;
    condition: string;
    threshold?: number;
    callback_url: string;
    cooldown_minutes?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    // Validate callback URL
    if (
      !args.callback_url.startsWith("https://") &&
      !args.callback_url.startsWith("http://localhost")
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "callback_url must use HTTPS (except localhost for testing)",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Validate condition requires threshold
    if (
      args.condition !== "resolution" &&
      (args.threshold === undefined || args.threshold === null)
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Threshold required for '${args.condition}' condition`,
                hint: args.condition.includes("probability")
                  ? "Use a percentage value, e.g., 70 for 70%"
                  : args.condition === "mispricing_detected" ||
                      args.condition === "divergence_detected"
                    ? "Use a spread percentage, e.g., 5 for 5% gap"
                    : "Use a multiplier, e.g., 3 for 3x average volume",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Resolve market_id if it's an external_id
    let resolvedMarketId = args.market_id || null;
    if (args.market_id && args.market_id.length < 36) {
      const { data: market } = await this.supabase
        .from("telekash_markets")
        .select("id")
        .eq("external_id", args.market_id)
        .single();
      if (market) resolvedMarketId = market.id;
    }

    const { data, error } = await this.supabase
      .from("telekash_alerts")
      .insert({
        agent_id: args.agent_id,
        api_key_id: this.apiKeyId,
        market_id: resolvedMarketId,
        condition: args.condition,
        threshold: args.threshold || null,
        callback_url: args.callback_url,
        cooldown_minutes: args.cooldown_minutes || 60,
      })
      .select()
      .single();

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to register alert", detail: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              alert_id: data.id,
              status: "active",
              condition: args.condition,
              threshold: args.threshold,
              market_id: resolvedMarketId,
              callback_url: args.callback_url,
              cooldown_minutes: args.cooldown_minutes || 60,
              expires_at: data.expires_at,
              message: `Alert registered. We'll POST to ${args.callback_url} when ${args.condition} ${args.threshold ? `(threshold: ${args.threshold})` : ""} triggers.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async listAlerts(args: {
    agent_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    const { data: alerts, error } = await this.supabase
      .from("telekash_alerts")
      .select(
        "id, market_id, condition, threshold, callback_url, is_active, trigger_count, last_triggered_at, cooldown_minutes, created_at, expires_at",
      )
      .eq("agent_id", args.agent_id)
      .order("created_at", { ascending: false });

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to list alerts", detail: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              agent_id: args.agent_id,
              total_alerts: alerts?.length || 0,
              active_alerts: alerts?.filter((a) => a.is_active).length || 0,
              alerts: (alerts || []).map((a) => ({
                ...a,
                status: a.is_active ? "active" : "paused",
                age:
                  Math.round(
                    (Date.now() - new Date(a.created_at).getTime()) /
                      (1000 * 60 * 60),
                  ) + "h",
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async deleteAlert(args: {
    alert_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    const { error } = await this.supabase
      .from("telekash_alerts")
      .delete()
      .eq("id", args.alert_id);

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to delete alert", detail: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              deleted: true,
              alert_id: args.alert_id,
              message: "Alert deleted. No further webhooks will be sent.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // API KEY & USAGE TOOLS
  // ===========================================

  private async generateApiKey(args: {
    owner_id: string;
    owner_email?: string;
  }): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Database not configured",
                message:
                  "Set SUPABASE_URL and SUPABASE_ANON_KEY to generate API keys.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const { data, error } = await this.supabase.rpc("generate_api_key", {
      p_owner_id: args.owner_id,
      p_tier: "free",
      p_owner_email: args.owner_email || null,
    });

    if (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to generate key", detail: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              api_key: data.api_key,
              tier: "free",
              limits: {
                calls_per_day: 100,
                tools: TIER_CONFIGS.free.tools.length,
                sources: TIER_CONFIGS.free.sources,
              },
              setup: {
                env_variable: "TELEKASH_API_KEY",
                example: `TELEKASH_API_KEY=${data.api_key}`,
                claude_code: `claude mcp add telekash-oracle --env TELEKASH_API_KEY=${data.api_key} -- npx telekash-mcp-server`,
              },
              upgrade: {
                calibration: {
                  price: "$0.01/query",
                  calls_per_day: 1000,
                  tools: TIER_CONFIGS.calibration.tools.length,
                  includes:
                    "arbitrage, divergences, cross-source, performance tracking",
                },
                edge: {
                  price: "$0.05/query",
                  calls_per_day: "unlimited",
                  tools: TIER_CONFIGS.edge.tools.length,
                  includes:
                    "TPF signals, Kelly sizing, market creation, all tools",
                },
                url: "https://t.me/TeleKashBot",
              },
              warning: "Save this key now — it cannot be retrieved again.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getUsage(): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    const tierConfig = TIER_CONFIGS[this.tier];

    // Tool category classification
    const TOOL_CATEGORIES: Record<string, string> = {
      get_probability: "intelligence",
      list_markets: "intelligence",
      search_markets: "intelligence",
      get_history: "intelligence",
      get_sentiment: "intelligence",
      get_market_stats: "intelligence",
      get_trending: "intelligence",
      compare_sources: "intelligence",
      get_divergences: "intelligence",
      get_signal: "intelligence",
      get_edge: "intelligence",
      detect_arbitrage: "trading",
      track_prediction: "trading",
      get_performance: "trading",
      execute_trade: "trading",
      get_order_status: "trading",
      cancel_order: "trading",
      create_market: "trading",
      register_alert: "trading",
      list_alerts: "trading",
      delete_alert: "trading",
      export_data: "admin",
      generate_api_key: "admin",
      get_usage: "admin",
      get_health: "admin",
      get_resolution_status: "admin",
    };

    // Per-tool usage breakdown (last 24h)
    const toolBreakdown: Record<string, { calls: number; cost: number }> = {};
    let dailySpend = 0;
    const categorySpend: Record<string, { calls: number; cost: number }> = {
      intelligence: { calls: 0, cost: 0 },
      trading: { calls: 0, cost: 0 },
      admin: { calls: 0, cost: 0 },
    };

    if (this.supabase && this.apiKeyId) {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const { data: usageLogs } = await this.supabase
        .from("telekash_usage_logs")
        .select("tool_name, query_cost_usd")
        .eq("api_key_id", this.apiKeyId)
        .gte("created_at", yesterday);

      if (usageLogs) {
        for (const log of usageLogs) {
          const tool = log.tool_name || "unknown";
          if (!toolBreakdown[tool]) toolBreakdown[tool] = { calls: 0, cost: 0 };
          toolBreakdown[tool].calls++;
          const cost = log.query_cost_usd || 0;
          toolBreakdown[tool].cost += cost;
          dailySpend += cost;

          // Accumulate category spend
          const category = TOOL_CATEGORIES[tool] || "admin";
          if (!categorySpend[category])
            categorySpend[category] = { calls: 0, cost: 0 };
          categorySpend[category].calls++;
          categorySpend[category].cost += cost;
        }
      }
    }

    // Round category costs
    for (const cat of Object.keys(categorySpend)) {
      categorySpend[cat].cost =
        Math.round(categorySpend[cat].cost * 1000) / 1000;
    }
    // Round per-tool costs
    for (const tool of Object.keys(toolBreakdown)) {
      toolBreakdown[tool].cost =
        Math.round(toolBreakdown[tool].cost * 1000) / 1000;
    }

    // Detect first-time user (full daily allowance still available)
    const isFirstUse = this.callsRemaining >= tierConfig.calls_per_day - 1;

    // Calculate remaining budget estimate for paid tiers
    let budgetEstimate: Record<string, unknown> | undefined;
    if (this.tier !== "free") {
      const monthlyBudget = this.tier === "calibration" ? 99 : 499;
      const dailyBudgetEstimate = monthlyBudget / 30;
      const remainingDailyBudget = Math.max(
        0,
        Math.round((dailyBudgetEstimate - dailySpend) * 100) / 100,
      );
      const remainingQueriesEstimate =
        tierConfig.price_per_query > 0
          ? Math.floor(remainingDailyBudget / tierConfig.price_per_query)
          : this.callsRemaining;
      budgetEstimate = {
        monthly_budget_usd: monthlyBudget,
        daily_budget_estimate_usd: Math.round(dailyBudgetEstimate * 100) / 100,
        daily_spent_usd: Math.round(dailySpend * 1000) / 1000,
        daily_remaining_usd: remainingDailyBudget,
        estimated_queries_remaining: remainingQueriesEstimate,
      };
    }

    const usage: Record<string, unknown> = {
      tier: this.tier,
      rate_limit: {
        calls_per_day: tierConfig.calls_per_day,
        calls_remaining: this.callsRemaining,
        resets_at: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      },
      access: {
        tools_available: tierConfig.tools.length,
        tools: tierConfig.tools,
        sources: tierConfig.sources,
      },
      has_api_key: !!this.apiKeyHash,
      spend: {
        session_usd: Math.round((this.sessionCost || 0) * 1000) / 1000,
        daily_usd: Math.round(dailySpend * 1000) / 1000,
        price_per_query_usd: tierConfig.price_per_query,
      },
      cost_by_category: categorySpend,
      per_tool_breakdown_24h: toolBreakdown,
      ...(budgetEstimate ? { budget: budgetEstimate } : {}),
      install: "npx telekash-mcp-server",
    };

    // Add welcome info for first-time users
    if (isFirstUse) {
      const tierPricing: Record<string, string> = {
        free: "$0 (100 queries/day, no charge)",
        calibration: "$0.01/query ($99/mo, 1000 queries/day)",
        edge: "$0.05/query ($499/mo, unlimited queries)",
      };

      const recommendedTools: Record<string, string[]> = {
        free: [
          "get_trending — discover markets with biggest probability swings",
          "search_markets — find prediction markets on any topic",
          "get_probability — get real-time odds for any market",
        ],
        calibration: [
          "compare_sources — cross-source odds comparison to find mispricings",
          "detect_arbitrage — automated arbitrage detection with buy/sell signals",
          "track_prediction — record predictions and build a calibration track record",
        ],
        edge: [
          "get_signal — structured TPF signal with probability, confidence, and verdict",
          "get_edge — Kelly Criterion optimal position sizing",
          "execute_trade — route trades through Kalshi, Polymarket, or native pools",
        ],
      };

      usage.welcome = {
        message:
          "Welcome to TeleKash Oracle — the probability oracle for the agent economy.",
        your_tier: `${this.tier} — ${tierPricing[this.tier]}`,
        recommended_first_tools: recommendedTools[this.tier],
        tip: "Use generate_api_key to create a tracked API key. This unlocks usage analytics, prediction performance tracking, and spend monitoring across sessions.",
        docs: "https://github.com/TeleKashOracle/mcp-server",
      };
    }

    // Add upgrade info if not on edge
    if (this.tier !== "edge") {
      const nextTier = this.tier === "free" ? "calibration" : "edge";
      const nextConfig = TIER_CONFIGS[nextTier];
      usage.upgrade = {
        next_tier: nextTier,
        price: nextTier === "calibration" ? "$0.01/query" : "$0.05/query",
        calls_per_day: nextConfig.calls_per_day,
        additional_tools: nextConfig.tools.filter(
          (t) => !tierConfig.tools.includes(t),
        ),
        url: "https://t.me/TeleKashBot",
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(usage, null, 2),
        },
      ],
    };
  }

  // ===========================================
  // BROKER TOOLS — Trade execution via Kalshi/Polymarket
  // ===========================================

  private async brokerExecuteTrade(args: {
    market_id: string;
    side: "yes" | "no";
    amount_usd: number;
    order_type?: "market" | "limit";
    limit_price?: number;
    routing_preference?: "kalshi" | "polymarket" | "best_price" | "native_pool";
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    const { market_id, side, amount_usd } = args;
    const order_type = args.order_type || "market";

    // Validate amount
    if (amount_usd < 1 || amount_usd > 10000) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Amount must be between $1 and $10,000" },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Limit orders require a price
    if (order_type === "limit" && !args.limit_price) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "limit_price required for limit orders (0-1 probability)",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Look up market
    const { data: market, error: marketError } = await this.supabase
      .from("telekash_markets")
      .select("*")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .eq("status", "active")
      .limit(1)
      .single();

    if (marketError || !market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Market not found or not active",
                market_id,
                suggestion:
                  "Use search_markets or list_markets to find valid market IDs",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // ==========================================
    // NATIVE POOL ROUTING — Dual-sided liquidity
    // Agent trades go into the SAME pool as Telegram users
    // ==========================================
    if (args.routing_preference === "native_pool") {
      return await this.executeNativePoolTrade(market, args);
    }

    // Check if we should auto-route to native pool (no exchange creds)
    const connected = this.broker.getConnectedExchanges();
    const { data: existingPool } = await this.supabase
      .from("telekash_pools")
      .select("id, total_volume")
      .eq("market_id", market.id)
      .limit(1)
      .single();

    if (
      connected.length === 0 &&
      this.broker.shouldRouteToNativePool(
        {
          id: market.id,
          external_id: market.external_id,
          source: market.source,
          title: market.title,
          external_odds: market.external_odds,
          status: market.status,
        },
        {
          agent_id: this.apiKeyId || "anonymous",
          market_id,
          side,
          amount_usd,
          order_type,
        },
        !!existingPool,
      )
    ) {
      return await this.executeNativePoolTrade(market, args);
    }

    // Build broker order
    const brokerOrder: BrokerOrder = {
      agent_id: this.apiKeyId || "anonymous",
      market_id,
      side,
      amount_usd,
      order_type,
      limit_price: args.limit_price,
      routing_preference: args.routing_preference,
    };

    // Route and execute on external exchange
    const result: BrokerResult = await this.broker.routeOrder(brokerOrder, {
      id: market.id,
      external_id: market.external_id,
      source: market.source,
      title: market.title,
      external_odds: market.external_odds,
      status: market.status,
      raw_data: market.raw_data,
    });

    // Record order in database
    const { data: dbOrder } = await this.supabase
      .from("telekash_broker_orders")
      .insert({
        api_key_id: this.apiKeyId,
        agent_id: brokerOrder.agent_id,
        market_id: market.id,
        market_title: market.title,
        side,
        amount_usd,
        price: args.limit_price || null,
        order_type,
        routed_to: result.routed_to || "unknown",
        routing_reason: result.routing_reason,
        exchange_order_id: result.exchange_order_id,
        fill_price: result.fill_price,
        fill_amount_usd: result.fill_amount_usd,
        commission_usd: result.commission_usd,
        commission_rate: 0.01,
        status: result.status,
        error_message: result.error,
        submitted_at:
          result.status !== "failed" ? new Date().toISOString() : null,
        filled_at: result.status === "filled" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();

    // Log commission as revenue
    if (result.success && result.commission_usd && result.commission_usd > 0) {
      await this.supabase
        .from("telekash_revenue")
        .insert({
          source: "broker_commission",
          amount_usd: result.commission_usd,
          amount_stars: 0,
          details: {
            order_id: dbOrder?.id,
            exchange: result.routed_to,
            market_id: market.id,
            market_title: market.title,
            trade_amount: amount_usd,
            commission_rate: 0.01,
          },
        })
        .then(() => {});
    }

    // Cumulative trading stats for this agent
    let cumulative = null;
    if (this.supabase && this.apiKeyId) {
      const { data: stats } = await this.supabase
        .from("telekash_broker_orders")
        .select("status, fill_amount_usd, commission_usd")
        .eq("api_key_id", this.apiKeyId);

      if (stats && stats.length > 0) {
        const totalTrades = stats.length;
        const filled = stats.filter(
          (s: Record<string, unknown>) => s.status === "filled",
        );
        const totalVolume = filled.reduce(
          (sum: number, s: Record<string, unknown>) =>
            sum + ((s.fill_amount_usd as number) || 0),
          0,
        );
        const totalCommission = filled.reduce(
          (sum: number, s: Record<string, unknown>) =>
            sum + ((s.commission_usd as number) || 0),
          0,
        );
        cumulative = {
          total_trades: totalTrades,
          filled_trades: filled.length,
          total_volume_usd: Math.round(totalVolume * 100) / 100,
          total_commission_usd: Math.round(totalCommission * 100) / 100,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.success,
              order: {
                id: dbOrder?.id,
                exchange_order_id: result.exchange_order_id,
                market_title: market.title,
                side,
                amount_usd,
                order_type,
                routed_to: result.routed_to,
                routing_reason: result.routing_reason,
                fill_price: result.fill_price,
                fill_amount_usd: result.fill_amount_usd,
                commission_usd: result.commission_usd,
                status: result.status,
              },
              receipt: {
                gross_amount: amount_usd,
                commission_rate: "1%",
                commission_usd: result.commission_usd || amount_usd * 0.01,
                net_cost:
                  amount_usd + (result.commission_usd || amount_usd * 0.01),
                exchange: result.routed_to,
                timestamp: new Date().toISOString(),
                note: "Commission is charged on filled trades only. Unfilled limit orders have zero commission.",
              },
              ...(cumulative ? { cumulative } : {}),
              connected_exchanges: connected,
              ...(result.error ? { error: result.error } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async brokerGetOrderStatus(args: {
    order_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    // Get order from DB
    const { data: order, error } = await this.supabase
      .from("telekash_broker_orders")
      .select("*")
      .eq("id", args.order_id)
      .single();

    if (error || !order) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Order not found", order_id: args.order_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // If order is still pending/submitted, check exchange for latest status
    let exchangeStatus = null;
    if (
      order.exchange_order_id &&
      (order.status === "submitted" || order.status === "pending")
    ) {
      exchangeStatus = await this.broker.getOrderStatus(
        order.exchange_order_id,
        order.routed_to,
      );

      // Update DB if status changed
      if (exchangeStatus && exchangeStatus.status !== order.status) {
        await this.supabase
          .from("telekash_broker_orders")
          .update({
            status: exchangeStatus.status,
            fill_price: exchangeStatus.fill_price || order.fill_price,
            fill_amount_usd:
              exchangeStatus.fill_amount_usd || order.fill_amount_usd,
            filled_at:
              exchangeStatus.status === "filled"
                ? new Date().toISOString()
                : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              order_id: order.id,
              market_title: order.market_title,
              side: order.side,
              amount_usd: order.amount_usd,
              order_type: order.order_type,
              routed_to: order.routed_to,
              exchange_order_id: order.exchange_order_id,
              status: exchangeStatus?.status || order.status,
              fill_price: exchangeStatus?.fill_price || order.fill_price,
              fill_amount_usd:
                exchangeStatus?.fill_amount_usd || order.fill_amount_usd,
              commission_usd: order.commission_usd,
              created_at: order.created_at,
              filled_at: order.filled_at,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async brokerCancelOrder(args: {
    order_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    // Get order from DB
    const { data: order, error } = await this.supabase
      .from("telekash_broker_orders")
      .select("*")
      .eq("id", args.order_id)
      .single();

    if (error || !order) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Order not found", order_id: args.order_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Can only cancel pending/submitted orders
    if (order.status !== "pending" && order.status !== "submitted") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Cannot cancel order in '${order.status}' status`,
                order_id: order.id,
                status: order.status,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Cancel on exchange
    let cancelResult: { success: boolean; error?: string } = {
      success: true,
    };
    if (order.exchange_order_id) {
      cancelResult = await this.broker.cancelOrder(
        order.exchange_order_id,
        order.routed_to,
      );
    }

    // Update DB
    await this.supabase
      .from("telekash_broker_orders")
      .update({
        status: cancelResult.success ? "cancelled" : order.status,
        cancelled_at: cancelResult.success ? new Date().toISOString() : null,
        error_message: cancelResult.error || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              cancelled: cancelResult.success,
              order_id: order.id,
              exchange_order_id: order.exchange_order_id,
              market_title: order.market_title,
              ...(cancelResult.error ? { error: cancelResult.error } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ===========================================
  // NATIVE POOL — Dual-sided human+agent liquidity
  // ===========================================

  /**
   * Execute a trade into a TeleKash native parimutuel pool.
   * Agent's USD is converted to Stars-equivalent and placed alongside Telegram users.
   * At resolution, payout is converted back to USD and credited to agent balance.
   */
  private async executeNativePoolTrade(
    market: Record<string, unknown>,
    args: {
      market_id: string;
      side: "yes" | "no";
      amount_usd: number;
      order_type?: string;
      limit_price?: number;
    },
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    const { side, amount_usd } = args;
    const outcome = side === "yes" ? "Yes" : "No";

    // Get Stars/USD conversion rate
    const { data: configRow } = await this.supabase
      .from("telekash_config")
      .select("value")
      .eq("key", "stars_usd_rate")
      .single();
    const starsUsdRate = configRow ? parseFloat(configRow.value) : 0.02;
    const starsEquivalent = Math.floor(amount_usd / starsUsdRate);

    if (starsEquivalent < 10) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Minimum pool entry is 10 Stars (${10 * starsUsdRate} USD). Your amount converts to ${starsEquivalent} Stars.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Deduct from agent balance
    const { data: deductResult } = await this.supabase.rpc(
      "deduct_agent_pool_entry",
      {
        p_api_key_id: this.apiKeyId,
        p_agent_id: this.apiKeyId || "anonymous",
        p_amount_usd: amount_usd,
        p_stars_usd_rate: starsUsdRate,
      },
    );

    if (!deductResult?.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Insufficient agent balance",
                balance_usd: deductResult?.balance_usd || 0,
                required_usd: amount_usd,
                help: "Fund your agent balance via the TeleKash dashboard or Stripe.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Calculate indicative price from external odds
    let indicativePrice = 0.5;
    try {
      const odds = market.external_odds as {
        yes?: number;
        no?: number;
      } | null;
      if (odds) {
        indicativePrice =
          outcome === "Yes" ? (odds.yes || 50) / 100 : (odds.no || 50) / 100;
      }
    } catch {
      indicativePrice = 0.5;
    }

    const potentialPayout =
      indicativePrice > 0
        ? starsEquivalent / indicativePrice
        : starsEquivalent * 2;

    // Check for existing pool
    const { data: pool } = await this.supabase
      .from("telekash_pools")
      .select("id, total_volume, outcome_volumes, participant_count")
      .eq("market_id", market.id)
      .limit(1)
      .single();

    // Check for opposite-side positions (pending_match escrow)
    const oppositeOutcome = outcome === "Yes" ? "No" : "Yes";
    const { data: oppositePositions } = await this.supabase
      .from("telekash_positions")
      .select("id")
      .eq("market_id", market.id as string)
      .eq("outcome", oppositeOutcome)
      .in("status", ["active", "pending_match"])
      .limit(1);

    const poolIsMatched = oppositePositions && oppositePositions.length > 0;
    const positionStatus = poolIsMatched ? "active" : "pending_match";
    const positionId = crypto.randomUUID();

    // Insert agent position into the SAME pool as Telegram users
    const { error: positionError } = await this.supabase
      .from("telekash_positions")
      .insert({
        id: positionId,
        market_id: market.id,
        pool_id: pool?.id || null,
        outcome,
        amount: starsEquivalent,
        odds_at_entry: indicativePrice,
        price: indicativePrice,
        potential_payout: Math.floor(potentialPayout),
        status: positionStatus,
        is_agent: true,
        agent_id: this.apiKeyId || "anonymous",
        api_key_id: this.apiKeyId,
        currency: "stars",
        currency_amount: amount_usd,
        usd_equivalent: amount_usd,
        exchange_rate: starsUsdRate,
        created_at: new Date().toISOString(),
      });

    if (positionError) {
      // Refund the deducted balance
      await this.supabase.rpc("credit_agent_pool_payout", {
        p_api_key_id: this.apiKeyId,
        p_payout_stars: 0,
        p_bet_stars: 0,
        p_won: false,
        p_stars_usd_rate: starsUsdRate,
      });
      // Re-add the deducted amount
      await this.supabase
        .from("telekash_agent_balances")
        .update({
          balance_usd: deductResult.remaining_balance + amount_usd,
        })
        .eq("api_key_id", this.apiKeyId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to create pool position",
                details: positionError.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // If this made the pool two-sided, activate all pending_match positions
    if (poolIsMatched) {
      await this.supabase
        .from("telekash_positions")
        .update({ status: "active" })
        .eq("market_id", market.id as string)
        .eq("status", "pending_match");
    }

    // Update pool totals atomically (prevents race conditions with concurrent agents)
    if (pool) {
      // Use RPC for atomic pool update — avoids read-modify-write race
      const { error: poolUpdateError } = await this.supabase.rpc(
        "telekash_atomic_pool_update",
        {
          p_pool_id: pool.id,
          p_outcome: outcome,
          p_amount: starsEquivalent,
        },
      );

      if (poolUpdateError) {
        console.error(
          `[TeleKash MCP] Pool update error (non-fatal): ${poolUpdateError.message}`,
        );
        // Fallback to direct update if RPC doesn't exist yet
        const volumes = (pool.outcome_volumes as Record<string, number>) || {};
        volumes[outcome] = (volumes[outcome] || 0) + starsEquivalent;
        const newTotal = (pool.total_volume || 0) + starsEquivalent;
        const percentages: Record<string, number> = {};
        for (const [key, vol] of Object.entries(volumes)) {
          percentages[key] = newTotal > 0 ? vol / newTotal : 0;
        }
        await this.supabase
          .from("telekash_pools")
          .update({
            total_volume: newTotal,
            outcome_volumes: volumes,
            outcome_percentages: percentages,
            total_fees: Math.floor(newTotal * 0.05),
            participant_count: (pool.participant_count || 0) + 1,
          })
          .eq("id", pool.id);
      }
    }

    // Log revenue (pool fee estimated)
    await this.supabase.from("telekash_revenue").insert({
      source: "pool_fee",
      amount_usd: amount_usd * 0.05,
      amount_stars: starsEquivalent * 0.05,
      details: {
        position_id: positionId,
        market_id: market.id,
        agent_id: this.apiKeyId,
        is_agent: true,
        model: "parimutuel_dual_sided",
        usd_amount: amount_usd,
        stars_equivalent: starsEquivalent,
        exchange_rate: starsUsdRate,
      },
    });

    // Get pool composition for response
    const yesVolume =
      ((pool?.outcome_volumes as Record<string, number>)?.Yes || 0) +
      (outcome === "Yes" ? starsEquivalent : 0);
    const noVolume =
      ((pool?.outcome_volumes as Record<string, number>)?.No || 0) +
      (outcome === "No" ? starsEquivalent : 0);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              routed_to: "native_pool",
              routing_reason: "dual_sided_liquidity",
              position: {
                id: positionId,
                market_title: market.title,
                side,
                outcome,
                amount_usd,
                stars_equivalent: starsEquivalent,
                exchange_rate: starsUsdRate,
                effective_price: indicativePrice,
                potential_payout_stars: Math.floor(potentialPayout),
                potential_payout_usd:
                  Math.floor(potentialPayout) * starsUsdRate,
                status: positionStatus,
              },
              pool: {
                yes_volume: yesVolume,
                no_volume: noVolume,
                total_volume: (pool?.total_volume || 0) + starsEquivalent,
                is_two_sided: poolIsMatched || false,
                participants: (pool?.participant_count || 0) + 1,
                fee_rate: "5% at resolution",
              },
              balance: {
                remaining_usd: deductResult.remaining_balance,
              },
              note: "Your position is in the SAME pool as Telegram mini app users. Payout at market resolution. 5% pool fee deducted from winnings.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * Get the status of a TeleKash native parimutuel pool
   */
  private async getMarketPoolStatus(args: {
    market_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    // Get market info
    const { data: market } = await this.supabase
      .from("telekash_markets")
      .select("id, title, status, external_odds, close_date")
      .or(`id.eq.${args.market_id},external_id.eq.${args.market_id}`)
      .limit(1)
      .single();

    if (!market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Market not found", market_id: args.market_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get pool
    const { data: pool } = await this.supabase
      .from("telekash_pools")
      .select("*")
      .eq("market_id", market.id)
      .limit(1)
      .single();

    // Count human vs agent positions
    const { data: positions } = await this.supabase
      .from("telekash_positions")
      .select("id, outcome, amount, is_agent, status")
      .eq("market_id", market.id)
      .in("status", ["active", "pending_match"]);

    const humanPositions = (positions || []).filter((p) => !p.is_agent);
    const agentPositions = (positions || []).filter((p) => p.is_agent);

    const volumes = (pool?.outcome_volumes as Record<string, number>) || {};
    const totalVolume = pool?.total_volume || 0;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              market: {
                id: market.id,
                title: market.title,
                status: market.status,
                closes_at: market.close_date,
              },
              pool: pool
                ? {
                    id: pool.id,
                    status: pool.status,
                    total_volume_stars: totalVolume,
                    yes_volume: volumes.Yes || 0,
                    no_volume: volumes.No || 0,
                    implied_yes_odds:
                      totalVolume > 0
                        ? ((volumes.Yes || 0) / totalVolume).toFixed(3)
                        : "0.500",
                    implied_no_odds:
                      totalVolume > 0
                        ? ((volumes.No || 0) / totalVolume).toFixed(3)
                        : "0.500",
                    fee_rate: "5%",
                    is_two_sided:
                      (volumes.Yes || 0) > 0 && (volumes.No || 0) > 0,
                  }
                : { exists: false, note: "No pool yet. Be the first!" },
              participants: {
                total: (positions || []).length,
                humans: humanPositions.length,
                agents: agentPositions.length,
                human_volume: humanPositions.reduce(
                  (sum, p) => sum + (p.amount || 0),
                  0,
                ),
                agent_volume: agentPositions.reduce(
                  (sum, p) => sum + (p.amount || 0),
                  0,
                ),
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * Get agent's pool balance and performance stats
   */
  // ===== RESOLUTION ORACLE =====

  private async getResolutionStatus(args: {
    market_id: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    const { market_id } = args;

    // Fetch the market with resolution data
    const { data: market, error: marketError } = await this.supabase
      .from("telekash_markets")
      .select(
        "id, title, source, status, resolved_outcome, resolved_at, resolution_confidence, resolution_sources, resolution_data, requires_manual_review, manual_review_reason, closes_at",
      )
      .eq("id", market_id)
      .single();

    if (marketError || !market) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: `Market not found: ${market_id}` },
              null,
              2,
            ),
          },
        ],
      };
    }

    // If not resolved yet, show pre-resolution status
    if (market.status !== "resolved") {
      // Check for similar markets across sources
      const { data: similarMarkets } = await this.supabase.rpc(
        "find_similar_markets",
        { p_market_id: market_id },
      );

      // Build resolution forecast from cross-source data
      const similarList = (similarMarkets || []) as Array<{
        linked_market_id: string;
        linked_source: string;
        linked_title: string;
        linked_status: string;
        linked_yes_probability?: number;
        match_score: number;
      }>;

      // Fetch yes_probability for the primary market
      const { data: primaryProb } = await this.supabase
        .from("telekash_markets")
        .select("yes_probability")
        .eq("id", market_id)
        .single();

      // Collect probability readings from all sources
      const probabilityReadings: Array<{
        source: string;
        probability: number;
      }> = [];

      if (primaryProb?.yes_probability != null) {
        probabilityReadings.push({
          source: market.source,
          probability: primaryProb.yes_probability,
        });
      }

      // Fetch probabilities for similar cross-source markets
      if (similarList.length > 0) {
        const crossIds = similarList.map((m) => m.linked_market_id);
        const { data: crossMarkets } = await this.supabase
          .from("telekash_markets")
          .select("id, source, yes_probability")
          .in("id", crossIds);

        for (const cm of crossMarkets || []) {
          if (cm.yes_probability != null) {
            probabilityReadings.push({
              source: cm.source,
              probability: cm.yes_probability,
            });
          }
        }
      }

      // Calculate consensus and forecast
      const closesAt = market.closes_at ? new Date(market.closes_at) : null;
      const now = new Date();
      const daysRemaining = closesAt
        ? Math.max(
            0,
            Math.round(
              (closesAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
            ),
          )
        : null;

      let currentConsensus: string;
      let earlyResolutionPossible = false;

      if (probabilityReadings.length === 0) {
        currentConsensus = "No probability data available";
      } else {
        const avgProb =
          probabilityReadings.reduce((sum, r) => sum + r.probability, 0) /
          probabilityReadings.length;
        const roundedProb = Math.round(avgProb);
        const direction = avgProb >= 50 ? "YES" : "NO";
        const effectiveProb = avgProb >= 50 ? roundedProb : 100 - roundedProb;
        const sourceCount = probabilityReadings.length;
        currentConsensus = `${direction} at ${effectiveProb}% (${sourceCount} source${sourceCount > 1 ? "s" : ""} ${sourceCount > 1 ? "agree" : "reporting"})`;

        // Early resolution possible if consensus is very strong (>90%) across multiple sources
        if (effectiveProb >= 90 && sourceCount >= 2) {
          earlyResolutionPossible = true;
        }
      }

      // Source agreement analysis
      let sourceAgreement: { level: string; details: string } | null = null;
      if (probabilityReadings.length >= 2) {
        const probs = probabilityReadings.map((r) => r.probability);
        const maxDelta = Math.max(...probs) - Math.min(...probs);
        const allSameDirection =
          probs.every((p) => p >= 50) || probs.every((p) => p < 50);
        sourceAgreement = {
          level:
            maxDelta <= 5 ? "STRONG" : maxDelta <= 15 ? "MODERATE" : "WEAK",
          details: allSameDirection
            ? `Sources agree on direction (max spread: ${Math.round(maxDelta)}%)`
            : `Sources DISAGREE on direction — resolution confidence is reduced`,
        };
      }

      const resolutionForecast = {
        expected_resolution: closesAt
          ? closesAt.toISOString().split("T")[0]
          : null,
        days_remaining: daysRemaining,
        current_consensus: currentConsensus,
        source_agreement: sourceAgreement,
        early_resolution_possible: earlyResolutionPossible,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                market_id: market.id,
                title: market.title,
                status: market.status,
                source: market.source,
                closes_at: market.closes_at,
                resolution: {
                  status: "pending",
                  message:
                    "Market not yet resolved. Resolution occurs at close date.",
                },
                cross_source_markets:
                  similarList.length > 0
                    ? similarList.map((m) => ({
                        market_id: m.linked_market_id,
                        source: m.linked_source,
                        title: m.linked_title,
                        status: m.linked_status,
                        match_score: Math.round(m.match_score * 100) + "%",
                      }))
                    : "No cross-source markets found",
                resolution_forecast: resolutionForecast,
                resolution_method:
                  market.source === "kalshi" || market.source === "polymarket"
                    ? `Mirrors resolution from ${market.source} + cross-source verification`
                    : market.source === "agent"
                      ? "Creator-resolved or multi-source oracle"
                      : "CoinGecko price oracle (0.99 confidence)",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Market is resolved — show full verification details
    // Fetch verification log
    const { data: verifications } = await this.supabase
      .from("telekash_resolution_verifications")
      .select("*")
      .eq("market_id", market_id)
      .order("verified_at", { ascending: false })
      .limit(5);

    // Fetch linked markets
    const { data: links } = await this.supabase
      .from("telekash_market_links")
      .select("*")
      .or(`market_id_a.eq.${market_id},market_id_b.eq.${market_id}`)
      .limit(10);

    // Cross-source verification: find similar markets and compare resolved outcomes
    const { data: similarResolved } = await this.supabase.rpc(
      "find_similar_markets",
      { p_market_id: market_id },
    );

    const similarResolvedList = (similarResolved || []) as Array<{
      linked_market_id: string;
      linked_source: string;
      linked_title: string;
      linked_status: string;
      match_score: number;
    }>;

    // Fetch resolved outcomes for cross-source markets
    const crossSourceVerification: {
      sources_checked: string[];
      outcomes_agree: boolean;
      agreement_score: number;
      discrepancies: Array<{
        source: string;
        market_id: string;
        outcome: string | null;
        status: string;
      }>;
    } = {
      sources_checked: [market.source],
      outcomes_agree: true,
      agreement_score: 1.0,
      discrepancies: [],
    };

    if (similarResolvedList.length > 0) {
      const crossIds = similarResolvedList.map((m) => m.linked_market_id);
      const { data: crossMarkets } = await this.supabase
        .from("telekash_markets")
        .select("id, source, status, resolved_outcome")
        .in("id", crossIds);

      const resolvedCross = (crossMarkets || []).filter(
        (cm: {
          id: string;
          source: string;
          status: string;
          resolved_outcome: string | null;
        }) => cm.status === "resolved" && cm.resolved_outcome != null,
      );
      const unresolvedCross = (crossMarkets || []).filter(
        (cm: {
          id: string;
          source: string;
          status: string;
          resolved_outcome: string | null;
        }) => cm.status !== "resolved",
      );

      // Add all checked sources
      for (const cm of crossMarkets || []) {
        if (!crossSourceVerification.sources_checked.includes(cm.source)) {
          crossSourceVerification.sources_checked.push(cm.source);
        }
      }

      // Compare outcomes
      let agreeCount = 1; // primary market agrees with itself
      let totalResolved = 1; // primary market

      for (const cm of resolvedCross as Array<{
        id: string;
        source: string;
        status: string;
        resolved_outcome: string | null;
      }>) {
        totalResolved++;
        const primaryOutcome = (market.resolved_outcome || "")
          .toString()
          .toLowerCase()
          .trim();
        const crossOutcome = (cm.resolved_outcome || "")
          .toString()
          .toLowerCase()
          .trim();

        if (primaryOutcome === crossOutcome) {
          agreeCount++;
        } else {
          crossSourceVerification.discrepancies.push({
            source: cm.source,
            market_id: cm.id,
            outcome: cm.resolved_outcome,
            status: cm.status,
          });
        }
      }

      // Also flag unresolved cross-source markets as potential discrepancies
      for (const cm of unresolvedCross as Array<{
        id: string;
        source: string;
        status: string;
        resolved_outcome: string | null;
      }>) {
        crossSourceVerification.discrepancies.push({
          source: cm.source,
          market_id: cm.id,
          outcome: null,
          status: cm.status,
        });
      }

      crossSourceVerification.agreement_score =
        totalResolved > 0
          ? Math.round((agreeCount / totalResolved) * 100) / 100
          : 1.0;
      crossSourceVerification.outcomes_agree =
        crossSourceVerification.discrepancies.filter((d) => d.outcome != null)
          .length === 0;
    }

    // Resolution trust assessment
    const confidence = market.resolution_confidence || 0.7;

    const resolvedAt = market.resolved_at ? new Date(market.resolved_at) : null;
    const hoursSinceResolution = resolvedAt
      ? (Date.now() - resolvedAt.getTime()) / (1000 * 60 * 60)
      : 0;

    const sourceCount = crossSourceVerification.sources_checked.length;
    const hasDiscrepancies = !crossSourceVerification.outcomes_agree;

    let trustLevel: "high" | "medium" | "low" | "disputed";
    let trustReason: string;
    let trustRecommendation: string;

    if (hasDiscrepancies) {
      trustLevel = "disputed";
      const disagreeingSources = crossSourceVerification.discrepancies
        .filter((d) => d.outcome != null)
        .map((d) => d.source);
      trustReason = `Sources disagree: ${disagreeingSources.join(", ")} report different outcome`;
      trustRecommendation = "Resolution disputed — do not trade";
    } else if (
      sourceCount >= 3 &&
      crossSourceVerification.agreement_score >= 0.95
    ) {
      trustLevel = "high";
      trustReason = `${sourceCount}/${sourceCount} sources agree on ${market.resolved_outcome} outcome`;
      trustRecommendation = "Safe to trust";
    } else if (
      sourceCount >= 2 &&
      crossSourceVerification.agreement_score >= 0.8
    ) {
      trustLevel =
        sourceCount >= 3 || hoursSinceResolution > 24 ? "high" : "medium";
      trustReason = `${sourceCount}/${sourceCount} sources agree on ${market.resolved_outcome} outcome`;
      trustRecommendation =
        trustLevel === "high" ? "Safe to trust" : "Verify manually";
    } else if (sourceCount === 1 && confidence >= 0.8) {
      trustLevel = "medium";
      trustReason = `Single source (${market.source}) with ${Math.round(confidence * 100)}% confidence`;
      trustRecommendation = "Verify manually";
    } else {
      trustLevel = "low";
      trustReason = `Only ${sourceCount} source${sourceCount > 1 ? "s" : ""}, confidence ${Math.round(confidence * 100)}%`;
      trustRecommendation = "Verify manually";
    }

    const resolutionTrust = {
      level: trustLevel,
      reason: trustReason,
      recommendation: trustRecommendation,
    };

    let confidenceLabel: string;
    if (confidence >= 0.95)
      confidenceLabel = "VERY_HIGH — Multi-source verified";
    else if (confidence >= 0.8)
      confidenceLabel = "HIGH — Cross-source confirmed";
    else if (confidence >= 0.7) confidenceLabel = "STANDARD — Single source";
    else if (confidence >= 0.3) confidenceLabel = "LOW — Sources disagree";
    else confidenceLabel = "UNVERIFIED";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              market_id: market.id,
              title: market.title,
              status: "resolved",
              outcome: market.resolved_outcome,
              resolved_at: market.resolved_at,
              source_agreement: `${crossSourceVerification.sources_checked.length} source${crossSourceVerification.sources_checked.length > 1 ? "s" : ""} checked — ${crossSourceVerification.outcomes_agree ? "ALL AGREE" : "DISAGREEMENT DETECTED"}`,
              oracle: {
                confidence,
                confidence_label: confidenceLabel,
                sources: market.resolution_sources || [
                  { source: market.source, type: "primary" },
                ],
                requires_manual_review: market.requires_manual_review || false,
                manual_review_reason: market.manual_review_reason || null,
              },
              cross_source_verification: crossSourceVerification,
              resolution_trust: resolutionTrust,
              verification_log: (verifications || []).map(
                (v: {
                  verification_type: string;
                  sources_checked: unknown;
                  sources_agree: boolean | null;
                  final_confidence: number;
                  verified_at: string;
                  notes: string | null;
                }) => ({
                  type: v.verification_type,
                  sources_checked: v.sources_checked,
                  sources_agree: v.sources_agree,
                  confidence: v.final_confidence,
                  verified_at: v.verified_at,
                  notes: v.notes,
                }),
              ),
              cross_source_links: (links || []).length,
              resolution_data: market.resolution_data,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getAgentBalance(): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    if (!this.apiKeyId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "API key required to check balance" },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Get balance
    const { data: balance } = await this.supabase
      .from("telekash_agent_balances")
      .select("*")
      .eq("api_key_id", this.apiKeyId)
      .single();

    // Get active positions
    const { data: activePositions } = await this.supabase
      .from("telekash_positions")
      .select("id, market_id, outcome, amount, status, created_at")
      .eq("api_key_id", this.apiKeyId)
      .eq("is_agent", true)
      .in("status", ["active", "pending_match"]);

    // Get conversion rate
    const { data: configRow } = await this.supabase
      .from("telekash_config")
      .select("value")
      .eq("key", "stars_usd_rate")
      .single();
    const starsUsdRate = configRow ? parseFloat(configRow.value) : 0.02;

    const winRate =
      balance && balance.total_pool_positions > 0
        ? (
            (balance.total_pool_wins / balance.total_pool_positions) *
            100
          ).toFixed(1)
        : "0.0";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              balance: {
                available_usd: balance?.balance_usd || 0,
                total_deposited_usd: balance?.total_deposited_usd || 0,
                total_won_usd: balance?.total_won_usd || 0,
                total_lost_usd: balance?.total_lost_usd || 0,
                net_pnl:
                  (balance?.total_won_usd || 0) -
                  (balance?.total_lost_usd || 0),
              },
              performance: {
                total_pool_positions: balance?.total_pool_positions || 0,
                total_pool_wins: balance?.total_pool_wins || 0,
                win_rate_pct: winRate,
              },
              active_positions: (activePositions || []).map((p) => ({
                position_id: p.id,
                market_id: p.market_id,
                outcome: p.outcome,
                amount_stars: p.amount,
                amount_usd: (p.amount || 0) * starsUsdRate,
                status: p.status,
                created_at: p.created_at,
              })),
              conversion_rate: {
                stars_per_usd: 1 / starsUsdRate,
                usd_per_star: starsUsdRate,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async exportData(args: {
    type: string;
    market_id?: string;
    category?: string;
    limit?: number;
    format?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "Database not configured" }, null, 2),
          },
        ],
      };
    }

    const limit = Math.min(args.limit || 100, 1000);
    let data: unknown[] = [];
    let meta = {};

    switch (args.type) {
      case "market_catalog": {
        let query = this.supabase
          .from("telekash_markets")
          .select(
            "id, title, source, status, category, external_odds, volume, close_date, created_at, updated_at",
          )
          .order("volume", { ascending: false })
          .limit(limit);
        if (args.category) query = query.eq("category", args.category);
        if (args.market_id) query = query.eq("id", args.market_id);
        const { data: markets } = await query;
        data = markets || [];
        meta = { type: "market_catalog", total: data.length };
        break;
      }

      case "resolution_outcomes": {
        let query = this.supabase
          .from("telekash_markets")
          .select(
            "id, title, source, category, resolved_outcome, resolved_at, external_odds, volume",
          )
          .not("resolved_outcome", "is", null)
          .order("resolved_at", { ascending: false })
          .limit(limit);
        if (args.category) query = query.eq("category", args.category);
        const { data: resolved } = await query;
        data = resolved || [];
        meta = { type: "resolution_outcomes", total: data.length };
        break;
      }

      case "probability_history": {
        if (args.market_id) {
          const { data: history } = await this.supabase
            .from("telekash_probability_history")
            .select("*")
            .eq("market_id", args.market_id)
            .order("recorded_at", { ascending: false })
            .limit(limit);
          data = history || [];
        } else {
          const { data: history } = await this.supabase
            .from("telekash_probability_history")
            .select("*")
            .order("recorded_at", { ascending: false })
            .limit(limit);
          data = history || [];
        }
        meta = { type: "probability_history", total: data.length };
        break;
      }

      case "arbitrage_history": {
        // Query markets that exist on multiple sources with different odds
        const { data: markets } = await this.supabase
          .from("telekash_markets")
          .select("id, title, source, external_odds, volume, category")
          .eq("status", "active")
          .order("volume", { ascending: false })
          .limit(limit * 2);

        // Find pairs by matching titles across sources
        const titleMap = new Map<string, unknown[]>();
        for (const m of markets || []) {
          const key = (m as { title: string }).title.toLowerCase().trim();
          if (!titleMap.has(key)) titleMap.set(key, []);
          titleMap.get(key)!.push(m);
        }

        const opportunities: unknown[] = [];
        for (const [, group] of titleMap) {
          if (group.length > 1) {
            opportunities.push({
              markets: group,
              source_count: group.length,
            });
          }
        }
        data = opportunities.slice(0, limit);
        meta = { type: "arbitrage_history", pairs_found: data.length };
        break;
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Unknown export type: ${args.type}. Use: market_catalog, resolution_outcomes, probability_history, arbitrage_history`,
                },
                null,
                2,
              ),
            },
          ],
        };
    }

    if (args.format === "csv" && data.length > 0) {
      const headers = Object.keys(data[0] as Record<string, unknown>).join(",");
      const rows = data.map((row) =>
        Object.values(row as Record<string, unknown>)
          .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
          .join(","),
      );
      return {
        content: [{ type: "text", text: [headers, ...rows].join("\n") }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...meta,
              export_cost_usd: TIER_CONFIGS.edge.price_per_query,
              records: data,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getCalibrationChangelog(args: {
    domain?: string;
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { domain, limit = 20 } = args;
    const effectiveLimit = Math.min(Math.max(1, limit), 100);

    if (!this.supabase) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No database connection" }, null, 2),
          },
        ],
      };
    }

    let query = this.supabase
      .from("telekash_calibration_changelog")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(effectiveLimit);

    if (domain) {
      query = query.eq("domain", domain);
    }

    const { data, error } = await query;

    if (error) {
      if (error.code === "42P01") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Calibration changelog table not yet created",
                  _note:
                    "The fractal self-improvement migration needs to be applied first.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Failed to fetch changelog", details: error.message },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total_entries: data?.length || 0,
              domain_filter: domain || "all",
              changelog: (data || []).map((entry: Record<string, unknown>) => ({
                version: entry.calibration_version,
                domain: entry.domain,
                change_type: entry.change_type,
                platt_a: {
                  before: entry.platt_a_before,
                  after: entry.platt_a_after,
                },
                platt_b: {
                  before: entry.platt_b_before,
                  after: entry.platt_b_after,
                },
                ece: {
                  before: entry.ece_before,
                  after: entry.ece_after,
                },
                samples_used: entry.samples_used,
                notes: entry.notes,
                timestamp: entry.created_at,
              })),
              _note:
                "ORBIT cycles run daily at 3am UTC. Each entry shows how Platt scaling parameters changed. Lower ECE = better calibration.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getHealth(): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> {
    const health: Record<string, unknown> = {
      status: "operational",
      version: "0.9.0",
      timestamp: new Date().toISOString(),
    };

    // Supabase connectivity
    if (this.supabase) {
      try {
        const { count } = await this.supabase
          .from("telekash_markets")
          .select("id", { count: "exact", head: true })
          .eq("status", "active");
        health.database = { connected: true, active_markets: count || 0 };
      } catch (err) {
        health.database = {
          connected: false,
          error: err instanceof Error ? err.message : "Unknown",
        };
      }
    } else {
      health.database = { connected: false, mode: "demo" };
    }

    // Broker status
    const exchanges = this.broker.getConnectedExchanges();
    health.broker = {
      connected_exchanges: exchanges,
      native_pool: true,
    };

    // Cache stats
    try {
      health.cache = cacheStats();
    } catch {
      health.cache = { available: false };
    }

    // Data freshness
    if (this.supabase) {
      try {
        const { data } = await this.supabase
          .from("telekash_markets")
          .select("updated_at")
          .order("updated_at", { ascending: false })
          .limit(1)
          .single();
        if (data) {
          const age = Date.now() - new Date(data.updated_at).getTime();
          health.data_freshness = {
            last_update: data.updated_at,
            age_minutes: Math.round(age / 60000),
            fresh: age < 30 * 60000, // < 30 min = fresh
          };
        }
      } catch {
        health.data_freshness = { unknown: true };
      }
    }

    // Tier info
    health.tier = {
      current: this.tier,
      price_per_query: TIER_CONFIGS[this.tier].price_per_query,
      calls_remaining: this.callsRemaining,
    };

    // AXIOM structural audit
    if (this.supabase) {
      try {
        health.oracle_audit = await this.oracle.audit(this.supabase);
      } catch {
        health.oracle_audit = { available: false };
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Validate broker credentials on boot (non-blocking)
    const exchanges = this.broker.getConnectedExchanges();
    if (exchanges.length > 0) {
      this.broker
        .validateCredentials()
        .then((status) => {
          const verified = [
            status.kalshi.connected
              ? "kalshi ✓"
              : status.kalshi.error
                ? `kalshi ✗ (${status.kalshi.error})`
                : null,
            status.polymarket.connected
              ? "polymarket ✓"
              : status.polymarket.error
                ? `polymarket ✗ (${status.polymarket.error})`
                : null,
          ].filter(Boolean);
          console.error(
            `[TeleKash MCP] Broker validation: ${verified.join(", ")}`,
          );
        })
        .catch(() => {});
    }

    console.error(
      `[TeleKash MCP] Prediction Oracle v0.8.1 running on stdio | Tier: ${this.tier} ($${TIER_CONFIGS[this.tier].price_per_query}/query) | Broker: ${exchanges.length > 0 ? exchanges.join(", ") : "no exchange credentials"} | Native pool: enabled`,
    );
  }
}

// Main entry point
const server = new TeleKashMCPServer();
server.run().catch((error) => {
  console.error("[TeleKash MCP] Fatal error:", error);
  process.exit(1);
});
