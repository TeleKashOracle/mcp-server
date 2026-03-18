/**
 * TeleKash MCP Server - Database Connection
 *
 * Connects to Supabase for prediction market data.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Types for database tables
export interface Market {
  id: string;
  external_id: string;
  source: string;
  source_url: string | null;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  outcomes: string[];
  external_odds: { yes?: number; no?: number };
  status: "active" | "closed" | "resolved" | "cancelled";
  closes_at: string | null;
  resolves_at: string | null;
  resolved_outcome: string | null;
  raw_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProbabilityHistory {
  id: string;
  market_id: string;
  probability: number;
  volume: number | null;
  recorded_at: string;
}

export interface MarketSentiment {
  id: string;
  market_id: string;
  sentiment_score: number;
  confidence: number;
  recommendation: "bullish" | "bearish" | "neutral";
  keyword_score: number | null;
  pattern_score: number | null;
  volume_score: number | null;
  recency_score: number | null;
  signals: unknown[];
  analyzed_text: string | null;
  analysis_version: string;
  created_at: string;
}

export interface AgentPool {
  id: string;
  name: string;
  description: string | null;
  strategy_type: string;
  status: string;
  available_balance: number;
  total_deposits: number;
  total_withdrawals: number;
  total_pnl: number;
  winning_trades: number;
  losing_trades: number;
  created_at: string;
  updated_at: string;
}

let supabase: SupabaseClient | null = null;

/**
 * Initialize Supabase connection
 */
export function initDatabase(): SupabaseClient {
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables",
    );
  }

  supabase = createClient(supabaseUrl, supabaseKey);
  return supabase;
}

/**
 * Get Supabase client
 */
export function getDatabase(): SupabaseClient {
  if (!supabase) {
    return initDatabase();
  }
  return supabase;
}

/**
 * Get active markets with optional filters
 */
export async function getMarkets(options: {
  category?: string;
  source?: string;
  status?: string;
  limit?: number;
  sortBy?: "closes_at" | "created_at" | "probability";
  sortOrder?: "asc" | "desc";
}): Promise<Market[]> {
  const db = getDatabase();

  let query = db.from("telekash_markets").select("*");

  if (options.category && options.category !== "all") {
    query = query.eq("category", options.category);
  }

  if (options.source && options.source !== "all") {
    query = query.eq("source", options.source);
  }

  if (options.status) {
    query = query.eq("status", options.status);
  } else {
    query = query.eq("status", "active");
  }

  // Sort
  const sortColumn = options.sortBy || "created_at";
  const sortOrder = options.sortOrder || "desc";

  if (sortColumn === "probability") {
    // Sort by yes probability from external_odds JSON
    query = query.order("external_odds->yes", {
      ascending: sortOrder === "asc",
    });
  } else {
    query = query.order(sortColumn, { ascending: sortOrder === "asc" });
  }

  // Limit
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch markets: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a single market by ID or external ID
 */
export async function getMarket(
  idOrExternalId: string,
): Promise<Market | null> {
  const db = getDatabase();

  // Try by UUID first
  let { data, error } = await db
    .from("telekash_markets")
    .select("*")
    .eq("id", idOrExternalId)
    .single();

  // If not found, try by external_id
  if (!data) {
    const result = await db
      .from("telekash_markets")
      .select("*")
      .eq("external_id", idOrExternalId)
      .single();

    data = result.data;
    error = result.error;
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch market: ${error.message}`);
  }

  return data;
}

/**
 * Search markets by title/description
 */
export async function searchMarkets(
  query: string,
  limit: number = 10,
): Promise<Market[]> {
  const db = getDatabase();

  const { data, error } = await db
    .from("telekash_markets")
    .select("*")
    .eq("status", "active")
    .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
    .limit(limit);

  if (error) {
    throw new Error(`Failed to search markets: ${error.message}`);
  }

  return data || [];
}

/**
 * Get probability history for a market
 */
export async function getProbabilityHistory(
  marketId: string,
  timeframe: "1h" | "24h" | "7d" | "30d" = "24h",
): Promise<ProbabilityHistory[]> {
  const db = getDatabase();

  // Calculate start time based on timeframe
  const now = new Date();
  let startTime: Date;

  switch (timeframe) {
    case "1h":
      startTime = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case "24h":
      startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "7d":
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "30d":
      startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }

  const { data, error } = await db
    .from("telekash_probability_history")
    .select("*")
    .eq("market_id", marketId)
    .gte("recorded_at", startTime.toISOString())
    .order("recorded_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch probability history: ${error.message}`);
  }

  return data || [];
}

/**
 * Get latest sentiment for a market
 */
export async function getMarketSentiment(
  marketId: string,
): Promise<MarketSentiment | null> {
  const db = getDatabase();

  const { data, error } = await db
    .from("telekash_market_sentiment")
    .select("*")
    .eq("market_id", marketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch sentiment: ${error.message}`);
  }

  return data;
}

/**
 * Get all sentiment for active markets
 */
export async function getAllSentiment(): Promise<MarketSentiment[]> {
  const db = getDatabase();

  const { data, error } = await db
    .from("telekash_market_sentiment")
    .select(
      `
      *,
      market:telekash_markets!inner(status)
    `,
    )
    .eq("market.status", "active")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch sentiment: ${error.message}`);
  }

  return data || [];
}

/**
 * Get agent pools
 */
export async function getAgentPools(): Promise<AgentPool[]> {
  const db = getDatabase();

  const { data, error } = await db
    .from("telekash_agent_pools")
    .select("*")
    .eq("status", "active");

  if (error) {
    throw new Error(`Failed to fetch agent pools: ${error.message}`);
  }

  return data || [];
}

/**
 * Get market statistics
 */
export async function getMarketStats(): Promise<{
  totalMarkets: number;
  activeMarkets: number;
  resolvedMarkets: number;
  categoryCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
}> {
  const db = getDatabase();

  // Get all markets for counting
  const { data, error } = await db
    .from("telekash_markets")
    .select("id, status, category, source");

  if (error) {
    throw new Error(`Failed to fetch market stats: ${error.message}`);
  }

  const markets = data || [];

  const stats = {
    totalMarkets: markets.length,
    activeMarkets: markets.filter((m) => m.status === "active").length,
    resolvedMarkets: markets.filter((m) => m.status === "resolved").length,
    categoryCounts: {} as Record<string, number>,
    sourceCounts: {} as Record<string, number>,
  };

  // Count by category
  for (const market of markets) {
    const category = market.category || "other";
    stats.categoryCounts[category] = (stats.categoryCounts[category] || 0) + 1;

    const source = market.source || "unknown";
    stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + 1;
  }

  return stats;
}
