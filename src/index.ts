#!/usr/bin/env node
/**
 * TeleKash Prediction Oracle — MCP Server
 *
 * The probability oracle for the agent economy.
 * Aggregates prediction markets from Kalshi (CFTC-regulated) and Polymarket into one API.
 *
 * "Chainlink is the price oracle. TeleKash is the probability oracle."
 *
 * Oracle Tools (live):
 * - get_probability: Real-time probability for any prediction market
 * - list_markets: Browse markets by category with filtering/sorting
 * - search_markets: Full-text search across all markets
 * - get_history: Historical probability changes with trend detection
 * - get_sentiment: AI sentiment analysis with recommendation
 * - get_market_stats: Aggregate statistics across all markets
 * - get_trending: Markets with biggest probability swings (momentum detection)
 * - compare_sources: Cross-source odds comparison (Kalshi vs Polymarket)
 * - detect_arbitrage: Cross-source arbitrage detection with buy/sell signals
 *
 * @version 0.5.0
 * @author TeleKash <themagician@0xlaboratory.xyz>
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

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
- "Who will win the Super Bowl?" → sports odds`,
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
- "What economic forecasts are available?" → GDP, inflation, interest rates`,
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
      },
      required: [],
    },
  },
  {
    name: "get_history",
    description: `Get historical probability changes and trend data for a prediction market over time.

Returns probability snapshots showing how odds, sentiment, and market consensus have shifted over 1h, 24h, 7d, or 30d.
Use for trend analysis, momentum detection, volatility assessment, and understanding how predictions evolve.
Essential for backtesting strategies, identifying probability swings, and spotting market-moving events.`,
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
- "Fed interest rate" → monetary policy forecasts`,
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
Use for trade signals, contrarian analysis, or augmenting your own prediction models with market sentiment data.`,
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
Use for market overview, portfolio allocation decisions, or understanding the prediction market landscape.`,
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
Returns markets ranked by absolute probability change with direction (up/down) and current odds.`,
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
Returns matched pairs with probability delta and which source is more bullish/bearish.`,
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
  // ===========================================
  // AGENT TRADING TOOLS — Coming soon (pool infrastructure built, awaiting liquidity)
  // Uncomment when agent pools are funded and active
  // Tools: get_pool_status, execute_trade, get_agent_positions, get_recommended_position_size
  // ===========================================
];

// Confidence score computation — volume-weighted probability conviction
// "Prices on thin markets are lies" — Magician's Playbook #5
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

  // Weighted composite (volume matters most — Magician's Playbook #5)
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

  constructor() {
    this.server = new Server(
      {
        name: "telekash-oracle",
        version: "0.5.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.initializeSupabase();
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
    } else {
      console.error(
        "[TeleKash MCP] Warning: No Supabase credentials. Using mock data.",
      );
    }
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "get_probability":
            return await this.getProbability(
              args as { market_id?: string; query?: string },
            );
          case "list_markets":
            return await this.listMarkets(
              args as {
                category?: string;
                sort_by?: string;
                limit?: number;
                source?: string;
              },
            );
          case "get_history":
            return await this.getHistory(
              args as { market_id: string; timeframe?: string },
            );
          case "search_markets":
            return await this.searchMarkets(
              args as { query: string; limit?: number },
            );
          case "get_sentiment":
            return await this.getSentiment(args as { market_id: string });
          case "get_market_stats":
            return await this.getMarketStats();
          case "get_trending":
            return await this.getTrending(
              args as { timeframe?: string; limit?: number },
            );
          case "compare_sources":
            return await this.compareSources(args as { query: string });
          case "detect_arbitrage":
            return await this.detectArbitrage(
              args as {
                min_spread?: number;
                category?: string;
                limit?: number;
              },
            );
          case "get_signal":
            return await this.getSignal(
              args as { market_id?: string; query?: string },
            );
          // Agent Trading Tools — gated until pools are funded
          // case "get_pool_status":
          // case "execute_trade":
          // case "get_agent_positions":
          // case "get_recommended_position_size":
          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, confidence }, null, 2),
        },
      ],
    };
  }

  private async listMarkets(args: {
    category?: string;
    sort_by?: string;
    limit?: number;
    source?: string;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const {
      category = "all",
      sort_by = "volume",
      limit = 10,
      source = "all",
    } = args;

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

    if (source !== "all") {
      query = query.eq("source", source);
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

    const { data, error } = await query;

    if (error) {
      throw new Error(`Database error: ${error.message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets: MarketListItem[] = (data || []).map((m: any) => ({
      id: m.id,
      title: m.title,
      category: m.category,
      source: m.source,
      yes_probability: Math.round((m.external_odds?.yes || 0.5) * 100),
      volume_24h:
        (m.raw_data?.volume_24h as number) ||
        (m.raw_data?.volume as number) ||
        0,
      closes_at: m.closes_at,
      status: m.status,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              markets,
              total: markets.length,
              filters: { category, sort_by, source },
            },
            null,
            2,
          ),
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
    if (history.length >= 2) {
      const first = history[0].probability;
      const last = history[history.length - 1].probability;
      const change = last - first;
      trend = change > 1 ? "up" : change < -1 ? "down" : "stable";
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
    const markets = (data || []).map((m: any) => ({
      id: m.id,
      title: m.title,
      category: m.category,
      source: m.source,
      yes_probability: Math.round((m.external_odds?.yes || 0.5) * 100),
      volume_24h: m.raw_data?.volume || 0,
      closes_at: m.closes_at,
      status: m.status,
    }));

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

    // Get all markets for counting
    const { data, error } = await this.supabase
      .from("telekash_markets")
      .select("id, status, category, source");

    if (error) {
      throw new Error(`Stats error: ${error.message}`);
    }

    const markets = data || [];

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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              summary: stats,
              by_category: byCategory,
              by_source: bySource,
            },
            null,
            2,
          ),
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
          "id, title, category, source, external_odds, updated_at, closes_at",
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
                  (m: Record<string, unknown>) => ({
                    market_id: m.id,
                    title: m.title,
                    category: m.category,
                    source: m.source,
                    current_probability: Math.round(
                      ((m.external_odds as Record<string, number>)?.yes ||
                        0.5) * 100,
                    ),
                    last_updated: m.updated_at,
                  }),
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

    // Noise filter: "58% of price moves are noise" — Magician's Playbook #3
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
      .select("id, title, category, source, closes_at")
      .in("id", marketIds);

    const marketMap: Record<string, Record<string, unknown>> = {};
    for (const m of markets || []) {
      marketMap[(m as { id: string }).id] = m as Record<string, unknown>;
    }

    const trending = swings.map((s) => ({
      ...s,
      title: marketMap[s.market_id]?.title || "Unknown",
      category: marketMap[s.market_id]?.category || "other",
      source: marketMap[s.market_id]?.source || "unknown",
      closes_at: marketMap[s.market_id]?.closes_at,
    }));

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
              _note:
                "Spread = absolute difference in YES probability between Kalshi and Polymarket. Signal shows which side to buy/sell for convergence profit. Academic research: $40M+ extracted from prediction market mispricings annually.",
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

    // === BUILD TPF RESPONSE ===
    const tpf = {
      format: "TPF",
      version: "1.0",
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
            ? "Momentum is likely noise — 58% of price moves are random walk (Magician's Playbook #3)"
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
      metadata: {
        generated_at: new Date().toISOString(),
        oracle: "TeleKash Probability Oracle",
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

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[TeleKash MCP] Prediction Oracle running on stdio");
  }
}

// Main entry point
const server = new TeleKashMCPServer();
server.run().catch((error) => {
  console.error("[TeleKash MCP] Fatal error:", error);
  process.exit(1);
});
