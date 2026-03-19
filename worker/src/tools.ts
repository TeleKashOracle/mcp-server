/**
 * Tool Handlers — Cloudflare Worker Edition
 *
 * Each tool maps to Supabase queries. No SQLite cache (Workers use Cache API).
 * No broker (no exchange credentials in Worker env — broker tools return guidance).
 *
 * Mirrors packages/mcp-server/src/index.ts tool handlers.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { Tier } from "./schema.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// ─── Jurisdiction Mapping ──────────────────────────────────

const SOURCE_JURISDICTION: Record<
  string,
  { jurisdiction: string; regulatory_status: string }
> = {
  kalshi: {
    jurisdiction: "US-regulated",
    regulatory_status: "CFTC-regulated designated contract market (DCM)",
  },
  polymarket: {
    jurisdiction: "international",
    regulatory_status: "Offshore, unregulated in most jurisdictions",
  },
  metaculus: {
    jurisdiction: "forecasting",
    regulatory_status: "Forecasting platform — not gambling",
  },
  agent: {
    jurisdiction: "unregulated",
    regulatory_status: "Agent-created market",
  },
  user: {
    jurisdiction: "unregulated",
    regulatory_status: "User-created market",
  },
  demo: { jurisdiction: "demo", regulatory_status: "Demo data" },
};

const JURISDICTION_SOURCES: Record<string, string[]> = {
  "US-regulated": ["kalshi"],
  international: ["polymarket"],
  forecasting: ["metaculus"],
};

// ─── Helpers ──────────────────────────────────────────────

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

function computeConfidence(market: {
  volume: number;
  liquidity: number;
  yesProbability: number;
  closesAt: string;
}) {
  const vol = Math.max(0, market.volume);
  const volumeConviction = Math.min(1, Math.log10(Math.max(1, vol)) / 6);
  const liq = Math.max(0, market.liquidity);
  const liquidityDepth = Math.min(1, Math.log10(Math.max(1, liq)) / 5);
  const prob = market.yesProbability / 100;
  const probConviction = Math.abs(prob - 0.5) * 2;
  const now = Date.now();
  const closes = new Date(market.closesAt).getTime();
  const hoursLeft = Math.max(0, (closes - now) / (1000 * 60 * 60));
  const timeDecay =
    hoursLeft <= 0 ? 1 : hoursLeft <= 24 ? 0.9 : hoursLeft <= 168 ? 0.7 : 0.5;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findMarket(
  supabase: SupabaseClient,
  market_id?: string,
  query?: string,
): Promise<any | null> {
  if (market_id) {
    const { data } = await supabase
      .from("telekash_markets")
      .select("*")
      .or(`id.eq.${market_id},external_id.eq.${market_id}`)
      .single();
    return data;
  }
  if (query) {
    const { data } = await supabase
      .from("telekash_markets")
      .select("*")
      .eq("status", "active")
      .ilike("title", `%${query}%`)
      .order("raw_data->volume", { ascending: false })
      .limit(1)
      .single();
    return data;
  }
  return null;
}

// ─── Tool Dispatcher ──────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  supabase: SupabaseClient,
  tier: Tier,
): Promise<ToolResult> {
  switch (name) {
    case "get_probability":
      return getProbability(
        supabase,
        args as { market_id?: string; query?: string },
      );
    case "list_markets":
      return listMarkets(
        supabase,
        args as {
          category?: string;
          sort_by?: string;
          limit?: number;
          source?: string;
          jurisdiction?: string;
        },
      );
    case "search_markets":
      return searchMarkets(supabase, args as { query: string; limit?: number });
    case "get_history":
      return getHistory(
        supabase,
        args as { market_id: string; timeframe?: string },
      );
    case "get_sentiment":
      return getSentiment(supabase, args as { market_id: string });
    case "get_market_stats":
      return getMarketStats(supabase);
    case "get_trending":
      return getTrending(
        supabase,
        args as { timeframe?: string; limit?: number },
      );
    case "compare_sources":
      return compareSources(supabase, args as { query: string });
    case "detect_arbitrage":
      return detectArbitrage(
        supabase,
        args as { min_spread?: number; category?: string; limit?: number },
      );
    case "get_divergences":
      return detectArbitrage(
        supabase,
        args as { min_spread?: number; category?: string; limit?: number },
      ); // Same logic
    case "get_signal":
      return getSignal(
        supabase,
        args as { market_id?: string; query?: string },
      );
    case "track_prediction":
      return trackPrediction(
        supabase,
        args as {
          market_id: string;
          agent_id: string;
          predicted_outcome: string;
          predicted_probability: number;
          reasoning?: string;
        },
      );
    case "get_performance":
      return getPerformance(
        supabase,
        args as { agent_id: string; limit?: number },
      );
    case "get_edge":
      return getEdge(
        supabase,
        args as {
          bankroll?: number;
          agent_id?: string;
          category?: string;
          min_confidence?: string;
          limit?: number;
        },
      );
    case "create_market":
      return createMarket(
        supabase,
        args as {
          title: string;
          description?: string;
          category: string;
          closes_at: string;
          resolves_at: string;
          resolution_criteria: string;
          creator_id: string;
        },
      );
    case "generate_api_key":
      return generateApiKey(
        supabase,
        args as { owner_id: string; owner_email?: string },
      );
    case "get_usage":
      return getUsage(supabase, tier);
    case "register_alert":
      return registerAlert(
        supabase,
        args as {
          agent_id: string;
          market_id?: string;
          condition: string;
          threshold?: number;
          callback_url: string;
          cooldown_minutes?: number;
        },
      );
    case "list_alerts":
      return listAlerts(supabase, args as { agent_id: string });
    case "delete_alert":
      return deleteAlert(supabase, args as { alert_id: string });
    case "execute_trade":
      return json({
        error:
          "execute_trade requires exchange credentials. Use the local MCP server (npx telekash-mcp-server) with KALSHI_API_KEY/POLYMARKET_PRIVATE_KEY configured for broker trading.",
        hint: "For native_pool routing, this will be available in a future update.",
      });
    case "get_order_status":
      return getOrderStatus(supabase, args as { order_id: string });
    case "cancel_order":
      return json({
        error:
          "cancel_order requires exchange credentials. Use the local MCP server for broker operations.",
      });
    case "get_pool_status":
      return getPoolStatus(supabase, args as { market_id: string });
    case "get_agent_balance":
      return json({
        error:
          "get_agent_balance requires authenticated agent context. Use the local MCP server with TELEKASH_API_KEY.",
      });
    case "get_resolution_status":
      return getResolutionStatus(supabase, args as { market_id: string });
    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ─── Tool Implementations ────────────────────────────────

async function getProbability(
  supabase: SupabaseClient,
  args: { market_id?: string; query?: string },
): Promise<ToolResult> {
  if (!args.market_id && !args.query) return err("Provide market_id or query");
  const market = await findMarket(supabase, args.market_id, args.query);
  if (!market) return err("Market not found");

  const yesProb = Math.round((market.external_odds?.yes || 0.5) * 100);
  const volume = market.raw_data?.volume_24h || market.raw_data?.volume || 0;
  const liquidity = market.raw_data?.liquidity || 0;
  const confidence = computeConfidence({
    volume,
    liquidity,
    yesProbability: yesProb,
    closesAt: market.closes_at,
  });
  const jurisdictionInfo =
    SOURCE_JURISDICTION[market.source] || SOURCE_JURISDICTION.demo;

  return json({
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
    confidence,
    jurisdiction: jurisdictionInfo,
  });
}

async function listMarkets(
  supabase: SupabaseClient,
  args: {
    category?: string;
    sort_by?: string;
    limit?: number;
    source?: string;
    jurisdiction?: string;
  },
): Promise<ToolResult> {
  const {
    category = "all",
    sort_by = "volume",
    limit = 10,
    source = "all",
    jurisdiction = "all",
  } = args;
  let effectiveSource = source;
  if (jurisdiction !== "all" && source === "all") {
    const jSources = JURISDICTION_SOURCES[jurisdiction];
    if (jSources?.length === 1) effectiveSource = jSources[0];
  }
  const effectiveLimit = Math.min(Math.max(1, limit), 50);

  let query = supabase
    .from("telekash_markets")
    .select(
      "id, external_id, title, category, source, external_odds, raw_data, status, closes_at",
    )
    .eq("status", "active")
    .limit(effectiveLimit);
  if (category !== "all") query = query.eq("category", category);
  if (effectiveSource !== "all") query = query.eq("source", effectiveSource);

  switch (sort_by) {
    case "probability":
      query = query.order("external_odds->yes", { ascending: false });
      break;
    case "closing_date":
      query = query.order("closes_at", { ascending: true });
      break;
    default:
      query = query.order("raw_data->volume", {
        ascending: false,
        nullsFirst: false,
      });
  }

  const { data, error } = await query;
  if (error) throw new Error(`Database error: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markets = (data || []).map((m: any) => {
    const ji = SOURCE_JURISDICTION[m.source] || SOURCE_JURISDICTION.demo;
    return {
      id: m.id,
      title: m.title,
      category: m.category,
      source: m.source,
      jurisdiction: ji.jurisdiction,
      yes_probability: Math.round((m.external_odds?.yes || 0.5) * 100),
      volume_24h: m.raw_data?.volume_24h || m.raw_data?.volume || 0,
      closes_at: m.closes_at,
      status: m.status,
    };
  });

  return json({
    markets,
    total: markets.length,
    filters: { category, sort_by, source: effectiveSource, jurisdiction },
  });
}

async function searchMarkets(
  supabase: SupabaseClient,
  args: { query: string; limit?: number },
): Promise<ToolResult> {
  const { query, limit = 10 } = args;
  if (!query?.trim()) return err("Search query is required");
  const effectiveLimit = Math.min(Math.max(1, limit), 50);

  const { data, error } = await supabase
    .from("telekash_markets")
    .select(
      "id, external_id, title, category, source, external_odds, raw_data, status, closes_at",
    )
    .eq("status", "active")
    .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
    .order("raw_data->volume", { ascending: false, nullsFirst: false })
    .limit(effectiveLimit);

  if (error) throw new Error(`Search error: ${error.message}`);

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

  return json({ query, markets, total: markets.length });
}

async function getHistory(
  supabase: SupabaseClient,
  args: { market_id: string; timeframe?: string },
): Promise<ToolResult> {
  const { market_id, timeframe = "24h" } = args;
  const market = await findMarket(supabase, market_id);
  if (!market) return err("Market not found");

  const timeframeMs: Record<string, number> = {
    "1h": 3600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
  };
  const startTime = new Date(
    Date.now() - (timeframeMs[timeframe] || timeframeMs["24h"]),
  ).toISOString();

  const { data: historyData } = await supabase
    .from("telekash_probability_history")
    .select("probability, volume, recorded_at")
    .eq("market_id", market.id)
    .gte("recorded_at", startTime)
    .order("recorded_at", { ascending: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history = (historyData || []).map((h: any) => ({
    probability: Math.round(h.probability * 100),
    volume: h.volume || 0,
    timestamp: h.recorded_at,
  }));

  let trend = "stable";
  if (history.length >= 2) {
    const change =
      history[history.length - 1].probability - history[0].probability;
    trend = change > 1 ? "up" : change < -1 ? "down" : "stable";
  }

  return json({
    market_id: market.id,
    title: market.title,
    timeframe,
    data_points: history.length,
    trend,
    history,
    current: {
      yes_probability: Math.round((market.external_odds?.yes || 0.5) * 100),
      no_probability: Math.round((market.external_odds?.no || 0.5) * 100),
      volume: market.raw_data?.volume || 0,
      timestamp: market.updated_at,
    },
  });
}

async function getSentiment(
  supabase: SupabaseClient,
  args: { market_id: string },
): Promise<ToolResult> {
  const market = await findMarket(supabase, args.market_id);
  if (!market) return err("Market not found");

  // Check stored sentiment
  const { data: sentiment } = await supabase
    .from("telekash_market_sentiment")
    .select("*")
    .eq("market_id", market.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (sentiment) {
    return json({
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
    });
  }

  // Compute on-the-fly
  const yesProb = (market.external_odds?.yes || 0.5) as number;
  const volume = (market.raw_data?.volume as number) || 0;
  const daysToClose = Math.max(
    0,
    (new Date(market.closes_at).getTime() - Date.now()) / 86400000,
  );

  const sentimentScore = (yesProb - 0.5) * 2;
  const probScore = Math.abs(yesProb - 0.5) * 2;
  const volScore = Math.min(1, Math.log10(Math.max(1, volume)) / 7);
  const recency =
    daysToClose <= 1
      ? 1.0
      : daysToClose <= 7
        ? 0.8
        : daysToClose <= 30
          ? 0.5
          : 0.3;
  const confidence = probScore * 0.3 + volScore * 0.3 + recency * 0.2;
  const recommendation =
    sentimentScore > 0.3 && confidence > 0.4
      ? "bullish"
      : sentimentScore < -0.3 && confidence > 0.4
        ? "bearish"
        : "neutral";

  return json({
    market_id: market.id,
    title: market.title,
    sentiment: {
      score: parseFloat(sentimentScore.toFixed(3)),
      confidence: parseFloat(confidence.toFixed(3)),
      recommendation,
      analyzed_at: new Date().toISOString(),
      version: "live-v2",
    },
  });
}

async function getMarketStats(supabase: SupabaseClient): Promise<ToolResult> {
  const { data: markets, error } = await supabase
    .from("telekash_markets")
    .select("id, status, category, source");
  if (error) throw new Error(`Stats error: ${error.message}`);

  const all = markets || [];
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const m of all) {
    byCategory[m.category || "other"] =
      (byCategory[m.category || "other"] || 0) + 1;
    bySource[m.source || "unknown"] =
      (bySource[m.source || "unknown"] || 0) + 1;
  }

  return json({
    summary: {
      total_markets: all.length,
      active_markets: all.filter((m) => m.status === "active").length,
      resolved_markets: all.filter((m) => m.status === "resolved").length,
      closed_markets: all.filter((m) => m.status === "closed").length,
    },
    by_category: byCategory,
    by_source: bySource,
  });
}

async function getTrending(
  supabase: SupabaseClient,
  args: { timeframe?: string; limit?: number },
): Promise<ToolResult> {
  const { timeframe = "24h", limit = 10 } = args;
  const effectiveLimit = Math.min(Math.max(1, limit), 25);
  const timeframeMs: Record<string, number> = {
    "1h": 3600000,
    "24h": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
  };
  const startTime = new Date(
    Date.now() - (timeframeMs[timeframe] || timeframeMs["24h"]),
  ).toISOString();

  const { data: historyData } = await supabase
    .from("telekash_probability_history")
    .select("market_id, probability, recorded_at")
    .gte("recorded_at", startTime)
    .order("recorded_at", { ascending: true });

  if (!historyData?.length) {
    // Fallback: recently updated markets
    const { data: recent } = await supabase
      .from("telekash_markets")
      .select("id, title, category, source, external_odds, updated_at")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(effectiveLimit);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return json({
      timeframe,
      trending: (recent || []).map((m: any) => ({
        market_id: m.id,
        title: m.title,
        category: m.category,
        source: m.source,
        current_probability: Math.round((m.external_odds?.yes || 0.5) * 100),
        last_updated: m.updated_at,
      })),
      total: (recent || []).length,
      _note: "Showing recently updated. Historical tracking building up.",
    });
  }

  // Group by market and compute swings with noise filter
  const snapshots: Record<string, number[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const h of historyData as any[]) {
    if (!snapshots[h.market_id]) snapshots[h.market_id] = [];
    snapshots[h.market_id].push(h.probability);
  }

  const swings = Object.entries(snapshots)
    .map(([mid, probs]) => {
      const change = probs[probs.length - 1] - probs[0];
      let reversals = 0,
        sustained = 0;
      for (let i = 2; i < probs.length; i++) {
        const prev = probs[i - 1] - probs[i - 2],
          curr = probs[i] - probs[i - 1];
        if (prev * curr < 0) reversals++;
        else if (Math.abs(curr) > 0.001) sustained++;
      }
      const total = Math.max(1, reversals + sustained);
      const ratio = sustained / total;
      const quality =
        probs.length < 3
          ? "insufficient_data"
          : ratio >= 0.6
            ? "signal"
            : ratio >= 0.4
              ? "weak"
              : "noise";
      return {
        market_id: mid,
        change: Math.round(change * 100),
        abs_change: Math.abs(Math.round(change * 100)),
        direction:
          change > 0 ? "up" : change < 0 ? "down" : ("stable" as string),
        from_probability: Math.round(probs[0] * 100),
        to_probability: Math.round(probs[probs.length - 1] * 100),
        signal_quality: quality,
      };
    })
    .filter((s) => s.abs_change > 0)
    .sort((a, b) => {
      const order: Record<string, number> = {
        signal: 0,
        weak: 1,
        noise: 2,
        insufficient_data: 3,
      };
      const qd =
        (order[a.signal_quality] || 3) - (order[b.signal_quality] || 3);
      return qd !== 0 ? qd : b.abs_change - a.abs_change;
    })
    .slice(0, effectiveLimit);

  // Enrich with market details
  const ids = swings.map((s) => s.market_id);
  const { data: mkts } = await supabase
    .from("telekash_markets")
    .select("id, title, category, source")
    .in("id", ids);
  const mktMap: Record<
    string,
    { title: string; category: string; source: string }
  > = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (mkts || []) as any[]) mktMap[m.id] = m;

  return json({
    timeframe,
    trending: swings.map((s) => ({ ...s, ...(mktMap[s.market_id] || {}) })),
    total: swings.length,
  });
}

async function compareSources(
  supabase: SupabaseClient,
  args: { query: string },
): Promise<ToolResult> {
  const { query } = args;
  if (!query?.trim()) return err("Search query required");

  // Get matching markets across sources
  const { data } = await supabase
    .from("telekash_markets")
    .select("id, title, source, external_odds, raw_data, closes_at, status")
    .eq("status", "active")
    .ilike("title", `%${query}%`)
    .order("raw_data->volume", { ascending: false })
    .limit(50);

  if (!data?.length)
    return json({
      query,
      comparisons: [],
      total: 0,
      _note: "No markets found matching query",
    });

  // Group by similar title (word overlap)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups: Record<string, any[]> = {};
  for (const m of data) {
    const words = m.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w: string) => w.length >= 4);
    const key = words.sort().join("|");
    let matched = false;
    for (const [gk, gv] of Object.entries(groups)) {
      const gWords = gk.split("|");
      const overlap = words.filter((w: string) => gWords.includes(w)).length;
      if (overlap >= 2) {
        gv.push(m);
        matched = true;
        break;
      }
    }
    if (!matched) groups[key] = [m];
  }

  const comparisons = Object.values(groups)
    .filter(
      (g) =>
        g.length >= 2 &&
        new Set(g.map((m: { source: string }) => m.source)).size >= 2,
    )
    .map((g) => {
      const sources: Record<string, { probability: number; volume: number }> =
        {};
      for (const m of g) {
        sources[m.source] = {
          probability: Math.round((m.external_odds?.yes || 0.5) * 100),
          volume: m.raw_data?.volume || 0,
        };
      }
      const probs = Object.values(sources).map((s) => s.probability);
      const spread = Math.max(...probs) - Math.min(...probs);
      return {
        title: g[0].title,
        sources,
        spread_pct: spread,
        market_ids: g.map((m: { id: string }) => m.id),
      };
    })
    .sort((a, b) => b.spread_pct - a.spread_pct);

  return json({ query, comparisons, total: comparisons.length });
}

async function detectArbitrage(
  supabase: SupabaseClient,
  args: { min_spread?: number; category?: string; limit?: number },
): Promise<ToolResult> {
  const { min_spread = 5, category, limit = 10 } = args;
  const effectiveLimit = Math.min(Math.max(1, limit), 25);

  let query = supabase
    .from("telekash_markets")
    .select("id, title, source, category, external_odds, raw_data, closes_at")
    .eq("status", "active");
  if (category && category !== "all") query = query.eq("category", category);
  const { data } = await query;
  if (!data?.length) return json({ opportunities: [], total: 0 });

  // Group similar markets across sources
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byTitle: Record<string, any[]> = {};
  for (const m of data) {
    const words = m.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w: string) => w.length >= 4);
    let placed = false;
    for (const [k, v] of Object.entries(byTitle)) {
      const kWords = k.split("|");
      if (
        words.filter((w: string) => kWords.includes(w)).length >= 2 &&
        m.source !== v[0].source
      ) {
        v.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) byTitle[words.sort().join("|")] = [m];
  }

  const opportunities = Object.values(byTitle)
    .filter(
      (g) => new Set(g.map((m: { source: string }) => m.source)).size >= 2,
    )
    .map((g) => {
      const probs = g.map(
        (m: { external_odds?: { yes?: number }; source: string }) => ({
          source: m.source,
          prob: Math.round((m.external_odds?.yes || 0.5) * 100),
        }),
      );
      probs.sort((a: { prob: number }, b: { prob: number }) => b.prob - a.prob);
      const spread = probs[0].prob - probs[probs.length - 1].prob;
      return {
        title: g[0].title,
        category: g[0].category,
        spread_pct: spread,
        buy_source: probs[probs.length - 1].source,
        buy_prob: probs[probs.length - 1].prob,
        sell_source: probs[0].source,
        sell_prob: probs[0].prob,
        classification:
          spread >= 15 ? "STRONG" : spread >= 8 ? "MODERATE" : "WEAK",
      };
    })
    .filter((o) => o.spread_pct >= min_spread)
    .sort((a, b) => b.spread_pct - a.spread_pct)
    .slice(0, effectiveLimit);

  return json({
    opportunities,
    total: opportunities.length,
    min_spread_filter: min_spread,
  });
}

async function getSignal(
  supabase: SupabaseClient,
  args: { market_id?: string; query?: string },
): Promise<ToolResult> {
  if (!args.market_id && !args.query) return err("Provide market_id or query");
  const market = await findMarket(supabase, args.market_id, args.query);
  if (!market) return err("Market not found");

  const yesProb = (market.external_odds?.yes || 0.5) as number;
  const volume = (market.raw_data?.volume as number) || 0;
  const liquidity = (market.raw_data?.liquidity as number) || 0;
  const confidence = computeConfidence({
    volume,
    liquidity,
    yesProbability: yesProb * 100,
    closesAt: market.closes_at,
  });

  // Get recent history for momentum
  const startTime = new Date(Date.now() - 86400000).toISOString();
  const { data: hist } = await supabase
    .from("telekash_probability_history")
    .select("probability")
    .eq("market_id", market.id)
    .gte("recorded_at", startTime)
    .order("recorded_at", { ascending: true });

  let momentum = 0;
  let signalQuality = "insufficient_data";
  if (hist && hist.length >= 2) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probs = hist.map((h: any) => h.probability);
    momentum = probs[probs.length - 1] - probs[0];
    let rev = 0,
      sus = 0;
    for (let i = 2; i < probs.length; i++) {
      const p = probs[i - 1] - probs[i - 2],
        c = probs[i] - probs[i - 1];
      if (p * c < 0) rev++;
      else if (Math.abs(c) > 0.001) sus++;
    }
    const ratio = sus / Math.max(1, rev + sus);
    signalQuality =
      probs.length < 3
        ? "insufficient_data"
        : ratio >= 0.6
          ? "signal"
          : ratio >= 0.4
            ? "weak"
            : "noise";
  }

  // Get cross-source data
  const sentimentScore = (yesProb - 0.5) * 2;
  const sentiment =
    sentimentScore > 0.3
      ? "bullish"
      : sentimentScore < -0.3
        ? "bearish"
        : "neutral";

  let verdict: string;
  if (confidence.grade === "VERY_LOW" || signalQuality === "insufficient_data")
    verdict = "NO_SIGNAL";
  else if (
    sentimentScore > 0.4 &&
    confidence.score > 0.6 &&
    signalQuality === "signal"
  )
    verdict = "STRONG_BUY";
  else if (sentimentScore > 0.2 && confidence.score > 0.4) verdict = "BUY";
  else if (
    sentimentScore < -0.4 &&
    confidence.score > 0.6 &&
    signalQuality === "signal"
  )
    verdict = "STRONG_SELL";
  else if (sentimentScore < -0.2 && confidence.score > 0.4) verdict = "SELL";
  else verdict = "HOLD";

  return json({
    market_id: market.id,
    title: market.title,
    source: market.source,
    signal: {
      probability: Math.round(yesProb * 100),
      confidence,
      sentiment,
      momentum: parseFloat(momentum.toFixed(4)),
      signal_quality: signalQuality,
      verdict,
    },
    generated_at: new Date().toISOString(),
  });
}

async function trackPrediction(
  supabase: SupabaseClient,
  args: {
    market_id: string;
    agent_id: string;
    predicted_outcome: string;
    predicted_probability: number;
    reasoning?: string;
  },
): Promise<ToolResult> {
  const market = await findMarket(supabase, args.market_id);
  if (!market) return err("Market not found");

  const { error } = await supabase.from("telekash_agent_predictions").insert({
    market_id: market.id,
    agent_id: args.agent_id,
    predicted_outcome: args.predicted_outcome,
    predicted_probability: args.predicted_probability,
    reasoning: args.reasoning,
    market_probability_at_prediction: market.external_odds?.yes || 0.5,
  });

  if (error) throw new Error(`Failed to record prediction: ${error.message}`);
  return json({
    status: "recorded",
    market_id: market.id,
    title: market.title,
    prediction: args.predicted_outcome,
    probability: args.predicted_probability,
  });
}

async function getPerformance(
  supabase: SupabaseClient,
  args: { agent_id: string; limit?: number },
): Promise<ToolResult> {
  const { agent_id, limit = 20 } = args;
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  const { data: predictions, error } = await supabase
    .from("telekash_agent_predictions")
    .select("*, telekash_markets(title, status, resolved_outcome)")
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: false })
    .limit(effectiveLimit);

  if (error) throw new Error(`Performance error: ${error.message}`);
  if (!predictions?.length)
    return json({
      agent_id,
      total_predictions: 0,
      _note:
        "No predictions recorded. Use track_prediction to start building your track record.",
    });

  let correct = 0,
    resolved = 0;
  let brierSum = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of predictions as any[]) {
    const mkt = p.telekash_markets;
    if (mkt?.status === "resolved" && mkt.resolved_outcome) {
      resolved++;
      const actual = mkt.resolved_outcome === "yes" ? 1 : 0;
      const predicted = p.predicted_probability;
      brierSum += Math.pow(predicted - actual, 2);
      if (
        (p.predicted_outcome === "YES" && mkt.resolved_outcome === "yes") ||
        (p.predicted_outcome === "NO" && mkt.resolved_outcome === "no")
      )
        correct++;
    }
  }

  return json({
    agent_id,
    total_predictions: predictions.length,
    resolved_predictions: resolved,
    accuracy: resolved > 0 ? Math.round((correct / resolved) * 100) : null,
    brier_score:
      resolved > 0 ? parseFloat((brierSum / resolved).toFixed(4)) : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recent: predictions.slice(0, 10).map((p: any) => ({
      market: p.telekash_markets?.title,
      prediction: p.predicted_outcome,
      probability: p.predicted_probability,
      created_at: p.created_at,
      resolved: p.telekash_markets?.status === "resolved",
      outcome: p.telekash_markets?.resolved_outcome,
    })),
  });
}

async function getEdge(
  supabase: SupabaseClient,
  args: {
    bankroll?: number;
    agent_id?: string;
    category?: string;
    min_confidence?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const { bankroll = 1000, category, limit = 10 } = args;
  const effectiveLimit = Math.min(Math.max(1, limit), 30);

  let query = supabase
    .from("telekash_markets")
    .select("id, title, category, source, external_odds, raw_data, closes_at")
    .eq("status", "active")
    .limit(100);
  if (category && category !== "all") query = query.eq("category", category);
  const { data } = await query;
  if (!data?.length) return json({ opportunities: [], total: 0 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opportunities = data
    .map((m: any) => {
      const yesProb = (m.external_odds?.yes || 0.5) as number;
      const vol = m.raw_data?.volume || 0;
      const liq = m.raw_data?.liquidity || 0;
      const conf = computeConfidence({
        volume: vol,
        liquidity: liq,
        yesProbability: yesProb * 100,
        closesAt: m.closes_at,
      });

      // Kelly: edge = p - q/b, where p = true prob, q = 1-p, b = payout odds
      // Since we don't have agent's estimated prob, we use confidence-adjusted market prob
      const adjustedProb = yesProb + (yesProb - 0.5) * conf.score * 0.1;
      const edge = Math.abs(adjustedProb - yesProb);
      const kelly =
        edge > 0 ? Math.min(0.25, edge / Math.max(0.01, 1 - yesProb)) : 0;
      const ev = edge * bankroll * kelly;

      return {
        market_id: m.id,
        title: m.title,
        category: m.category,
        source: m.source,
        market_probability: Math.round(yesProb * 100),
        confidence: conf,
        edge_pct: Math.round(edge * 10000) / 100,
        kelly_fraction: Math.round(kelly * 10000) / 100,
        optimal_bet: Math.round(bankroll * kelly * 100) / 100,
        expected_value: Math.round(ev * 100) / 100,
        risk:
          kelly > 0.15
            ? "aggressive"
            : kelly > 0.05
              ? "moderate"
              : "conservative",
      };
    })
    .filter((o: { edge_pct: number }) => o.edge_pct > 0)
    .sort(
      (a: { expected_value: number }, b: { expected_value: number }) =>
        b.expected_value - a.expected_value,
    )
    .slice(0, effectiveLimit);

  return json({ bankroll, opportunities, total: opportunities.length });
}

async function createMarket(
  supabase: SupabaseClient,
  args: {
    title: string;
    description?: string;
    category: string;
    closes_at: string;
    resolves_at: string;
    resolution_criteria: string;
    creator_id: string;
  },
): Promise<ToolResult> {
  const {
    title,
    description,
    category,
    closes_at,
    resolves_at,
    resolution_criteria,
    creator_id,
  } = args;

  const { data, error } = await supabase
    .from("telekash_markets")
    .insert({
      title,
      description,
      category,
      closes_at,
      resolves_at,
      source: "agent",
      resolution_source: "agent",
      external_id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      outcomes: ["yes", "no"],
      external_odds: { yes: 0.5, no: 0.5 },
      status: "active",
      raw_data: {
        resolution_criteria,
        creator_id,
        creator_fee_share: 0.01,
        created_via: "remote-mcp",
      },
    })
    .select("id, title")
    .single();

  if (error) throw new Error(`Create market error: ${error.message}`);

  // Create pool
  await supabase.from("telekash_pools").insert({
    market_id: data.id,
    yes_total: 0,
    no_total: 0,
    total_volume: 0,
    participant_count: 0,
  });

  return json({
    status: "created",
    market_id: data.id,
    title: data.title,
    odds: "50/50",
    resolution_criteria,
    creator_id,
  });
}

async function generateApiKey(
  supabase: SupabaseClient,
  args: { owner_id: string; owner_email?: string },
): Promise<ToolResult> {
  const key = `tk_${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { error } = await supabase.from("telekash_api_keys").insert({
    key_hash: keyHash,
    owner_id: args.owner_id,
    owner_email: args.owner_email,
    tier: "free",
    daily_limit: 100,
    status: "active",
  });

  if (error) throw new Error(`API key generation failed: ${error.message}`);

  return json({
    api_key: key,
    tier: "free",
    daily_limit: 100,
    _warning: "Save this key now — it cannot be retrieved later.",
    usage: "Set header: Authorization: Bearer <key>",
  });
}

async function getUsage(
  supabase: SupabaseClient,
  tier: Tier,
): Promise<ToolResult> {
  return json({
    tier,
    transport: "streamable-http",
    limits: {
      free: "100 calls/day",
      calibration: "1,000 calls/day",
      edge: "unlimited",
    },
    upgrade: "Contact @TeleKashBot for tier upgrades",
  });
}

async function registerAlert(
  supabase: SupabaseClient,
  args: {
    agent_id: string;
    market_id?: string;
    condition: string;
    threshold?: number;
    callback_url: string;
    cooldown_minutes?: number;
  },
): Promise<ToolResult> {
  const {
    agent_id,
    market_id,
    condition,
    threshold,
    callback_url,
    cooldown_minutes = 60,
  } = args;

  const { data, error } = await supabase
    .from("telekash_alerts")
    .insert({
      agent_id,
      market_id: market_id || null,
      condition,
      threshold,
      callback_url,
      cooldown_minutes,
      status: "active",
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    })
    .select("id")
    .single();

  if (error) throw new Error(`Alert registration failed: ${error.message}`);
  return json({
    status: "registered",
    alert_id: data.id,
    condition,
    threshold,
    callback_url,
    cooldown_minutes,
    expires_in: "30 days",
  });
}

async function listAlerts(
  supabase: SupabaseClient,
  args: { agent_id: string },
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("telekash_alerts")
    .select("*")
    .eq("agent_id", args.agent_id)
    .eq("status", "active");
  if (error) throw new Error(`List alerts error: ${error.message}`);
  return json({
    agent_id: args.agent_id,
    alerts: data || [],
    total: (data || []).length,
  });
}

async function deleteAlert(
  supabase: SupabaseClient,
  args: { alert_id: string },
): Promise<ToolResult> {
  const { error } = await supabase
    .from("telekash_alerts")
    .update({ status: "deleted" })
    .eq("id", args.alert_id);
  if (error) throw new Error(`Delete alert error: ${error.message}`);
  return json({ status: "deleted", alert_id: args.alert_id });
}

async function getOrderStatus(
  supabase: SupabaseClient,
  args: { order_id: string },
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("telekash_broker_orders")
    .select("*")
    .eq("id", args.order_id)
    .single();
  if (error || !data) return err("Order not found");
  return json(data);
}

async function getPoolStatus(
  supabase: SupabaseClient,
  args: { market_id: string },
): Promise<ToolResult> {
  const { data: pool, error } = await supabase
    .from("telekash_pools")
    .select("*")
    .eq("market_id", args.market_id)
    .single();
  if (error || !pool) return err("Pool not found for this market");

  const total = (pool.yes_total || 0) + (pool.no_total || 0);
  return json({
    market_id: args.market_id,
    pool: {
      yes_volume: pool.yes_total,
      no_volume: pool.no_total,
      total_volume: total,
      participant_count: pool.participant_count,
      implied_odds:
        total > 0
          ? {
              yes: Math.round((pool.yes_total / total) * 100),
              no: Math.round((pool.no_total / total) * 100),
            }
          : { yes: 50, no: 50 },
      two_sided: pool.yes_total > 0 && pool.no_total > 0,
    },
  });
}

async function getResolutionStatus(
  supabase: SupabaseClient,
  args: { market_id: string },
): Promise<ToolResult> {
  const market = await findMarket(supabase, args.market_id);
  if (!market) return err("Market not found");

  // Check for verification records
  const { data: verification } = await supabase
    .from("telekash_resolution_verifications")
    .select("*")
    .eq("market_id", market.id)
    .order("verified_at", { ascending: false })
    .limit(1)
    .single();

  // Check cross-source links
  const { data: links } = await supabase
    .from("telekash_market_links")
    .select("*")
    .or(`market_id_a.eq.${market.id},market_id_b.eq.${market.id}`);

  if (market.status === "resolved") {
    return json({
      market_id: market.id,
      title: market.title,
      status: "resolved",
      resolved_outcome: market.resolved_outcome,
      resolution_confidence: market.resolution_confidence || 0.7,
      resolution_sources: market.resolution_sources || [market.source],
      requires_manual_review: market.requires_manual_review || false,
      manual_review_reason: market.manual_review_reason,
      verification: verification || null,
      cross_source_links: (links || []).length,
    });
  }

  // Pre-resolution: show what sources are available for verification
  const { data: similar } = await supabase.rpc("find_similar_markets", {
    p_market_id: market.id,
  });

  return json({
    market_id: market.id,
    title: market.title,
    status: market.status,
    resolution_method:
      market.source === "kalshi" || market.source === "polymarket"
        ? "source-exchange"
        : market.source === "coingecko"
          ? "price-oracle"
          : "manual",
    similar_markets: similar || [],
    cross_source_links: (links || []).length,
    _note:
      "Market not yet resolved. Similar markets shown for potential cross-source verification.",
  });
}
