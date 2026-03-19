/**
 * Tool Definitions & Tier Configuration — Shared between stdio and HTTP transports
 *
 * Extracted from the main MCP server for use in the Cloudflare Worker.
 * Keep in sync with packages/mcp-server/src/index.ts TOOLS array.
 */

export type Tier = "free" | "calibration" | "edge";

export interface TierConfig {
  calls_per_day: number;
  sources: string[];
  tools: string[];
}

export const TIER_CONFIGS: Record<Tier, TierConfig> = {
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
    ],
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
      "generate_api_key",
      "get_usage",
      "get_resolution_status",
    ],
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
      "generate_api_key",
      "get_usage",
      "register_alert",
      "list_alerts",
      "delete_alert",
      "execute_trade",
      "get_order_status",
      "cancel_order",
      "get_pool_status",
      "get_agent_balance",
      "get_resolution_status",
    ],
  },
};

export const TIER_REQUIRED: Record<string, Tier> = {
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
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_probability",
    description: `Get real-time probability for any prediction market outcome. Returns YES/NO probabilities (0-100%), volume, liquidity, and market metadata from Kalshi and Polymarket.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
        query: {
          type: "string",
          description:
            "Natural language search query (alternative to market_id)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_markets",
    description: `Browse prediction markets across 7 categories with filtering and sorting. 500+ markets from Kalshi, Polymarket, and Metaculus.`,
    inputSchema: {
      type: "object",
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
          description: "Sort order",
        },
        limit: {
          type: "number",
          description: "Max markets (default: 10, max: 50)",
        },
        source: {
          type: "string",
          enum: ["all", "kalshi", "polymarket", "metaculus"],
          description: "Filter by source",
        },
        jurisdiction: {
          type: "string",
          enum: ["all", "US-regulated", "international", "forecasting"],
          description: "Filter by jurisdiction",
        },
      },
      required: [],
    },
  },
  {
    name: "search_markets",
    description: `Search 500+ prediction markets by keyword or natural language query.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_history",
    description: `Get historical probability changes and trend data for a market over 1h/24h/7d/30d.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
        timeframe: {
          type: "string",
          enum: ["1h", "24h", "7d", "30d"],
          description: "Time range (default: 24h)",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "get_sentiment",
    description: `Get AI-powered sentiment analysis (-1 to 1), recommendation, and confidence for a market.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
      },
      required: ["market_id"],
    },
  },
  {
    name: "get_market_stats",
    description: `Get aggregate statistics — total markets, categories, sources, and volume.`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_trending",
    description: `Markets with biggest probability swings — momentum detection for trending events.`,
    inputSchema: {
      type: "object",
      properties: {
        timeframe: {
          type: "string",
          enum: ["1h", "24h", "7d", "30d"],
          description: "Lookback window (default: 24h)",
        },
        limit: {
          type: "number",
          description: "Max markets (default: 10, max: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "compare_sources",
    description: `Compare prediction odds across Kalshi and Polymarket for the same event. Find pricing discrepancies.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find matching markets across sources",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "detect_arbitrage",
    description: `Detect cross-source arbitrage between Kalshi and Polymarket. Returns opportunities ranked by spread.`,
    inputSchema: {
      type: "object",
      properties: {
        min_spread: {
          type: "number",
          description: "Min spread % (default: 5)",
        },
        category: { type: "string", description: "Filter by category" },
        limit: {
          type: "number",
          description: "Max opportunities (default: 10, max: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_signal",
    description: `Structured TPF signal — probability + confidence + sentiment + noise + verdict. Single call replaces multiple tools.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
        query: {
          type: "string",
          description: "Natural language query (alternative)",
        },
      },
      required: [],
    },
  },
  {
    name: "track_prediction",
    description: `Record a prediction for performance tracking. Log your call and check accuracy later via get_performance.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
        agent_id: { type: "string", description: "Your agent identifier" },
        predicted_outcome: {
          type: "string",
          enum: ["YES", "NO"],
          description: "Your predicted outcome",
        },
        predicted_probability: {
          type: "number",
          description: "Your estimated probability (0.0-1.0)",
        },
        reasoning: {
          type: "string",
          description: "Brief reasoning (optional)",
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
    description: `Agent prediction performance — accuracy, Brier score, calibration, and prediction history.`,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent identifier" },
        limit: {
          type: "number",
          description: "Recent predictions (default: 20, max: 100)",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "get_divergences",
    description: `Find markets where prediction sources disagree — highest-value signal in forecasting.`,
    inputSchema: {
      type: "object",
      properties: {
        min_spread: { type: "number", description: "Min spread (default: 5%)" },
        category: { type: "string", description: "Filter by category" },
        limit: {
          type: "number",
          description: "Max divergences (default: 10, max: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_edge",
    description: `Capital efficiency — Kelly Criterion optimal position sizing. Markets ranked by edge (expected profit per dollar).`,
    inputSchema: {
      type: "object",
      properties: {
        bankroll: {
          type: "number",
          description: "Total capital in USD (default: 1000)",
        },
        agent_id: {
          type: "string",
          description: "Agent ID for edge estimation",
        },
        category: { type: "string", description: "Filter by category" },
        min_confidence: {
          type: "string",
          description: "Min confidence (HIGH/MEDIUM/LOW)",
        },
        limit: {
          type: "number",
          description: "Max opportunities (default: 10, max: 30)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_market",
    description: `Create a custom prediction market. Binary YES/NO question, tagged as "agent-created."`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "YES/NO question" },
        description: { type: "string", description: "Context and details" },
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
        },
        closes_at: { type: "string", description: "Trading close (ISO 8601)" },
        resolves_at: {
          type: "string",
          description: "Resolution date (ISO 8601)",
        },
        resolution_criteria: {
          type: "string",
          description: "How outcome is determined",
        },
        creator_id: { type: "string", description: "Agent identifier" },
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
  {
    name: "generate_api_key",
    description: `Generate a free TeleKash API key. Free tier: 100 calls/day. Save the key — shown once.`,
    inputSchema: {
      type: "object",
      properties: {
        owner_id: { type: "string", description: "Agent or user identifier" },
        owner_email: {
          type: "string",
          description: "Contact email (optional)",
        },
      },
      required: ["owner_id"],
    },
  },
  {
    name: "get_usage",
    description: `Check API usage, rate limits, and tier status.`,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "register_alert",
    description: `Register a webhook alert for market events. Event-driven, not polling.`,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Your agent identifier" },
        market_id: {
          type: "string",
          description: "Market UUID (optional for cross-market alerts)",
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
        },
        threshold: { type: "number", description: "Trigger threshold" },
        callback_url: {
          type: "string",
          description: "HTTPS URL to POST alerts to",
        },
        cooldown_minutes: {
          type: "number",
          description: "Min minutes between triggers (default: 60)",
        },
      },
      required: ["agent_id", "condition", "callback_url"],
    },
  },
  {
    name: "list_alerts",
    description: `List active webhook alerts for your agent.`,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent identifier" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "delete_alert",
    description: `Delete a webhook alert by ID.`,
    inputSchema: {
      type: "object",
      properties: { alert_id: { type: "string", description: "Alert UUID" } },
      required: ["alert_id"],
    },
  },
  {
    name: "execute_trade",
    description: `Execute a prediction market trade through TeleKash Broker. Routes to best exchange or native parimutuel pool.`,
    inputSchema: {
      type: "object",
      properties: {
        market_id: {
          type: "string",
          description: "Market UUID or external_id",
        },
        side: {
          type: "string",
          enum: ["yes", "no"],
          description: "Outcome to buy",
        },
        amount_usd: {
          type: "number",
          description: "Trade amount in USD ($1-$10,000)",
        },
        order_type: { type: "string", enum: ["market", "limit"] },
        limit_price: {
          type: "number",
          description: "Limit price (0-1 probability)",
        },
        routing_preference: {
          type: "string",
          enum: ["kalshi", "polymarket", "best_price", "native_pool"],
        },
      },
      required: ["market_id", "side", "amount_usd"],
    },
  },
  {
    name: "get_order_status",
    description: `Check broker order fill status.`,
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Broker order UUID" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "cancel_order",
    description: `Cancel a pending broker order.`,
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order UUID to cancel" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "get_pool_status",
    description: `Get parimutuel pool status — composition, participants, implied odds.`,
    inputSchema: {
      type: "object",
      properties: { market_id: { type: "string", description: "Market UUID" } },
      required: ["market_id"],
    },
  },
  {
    name: "get_agent_balance",
    description: `Check agent pool balance — USD balance, total deposited, won/lost, win rate.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_resolution_status",
    description: `Resolution status and multi-source verification confidence (0.30-0.99).`,
    inputSchema: {
      type: "object",
      properties: { market_id: { type: "string", description: "Market ID" } },
      required: ["market_id"],
    },
  },
];
