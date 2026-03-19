/**
 * MAG — The Observer
 *
 * Tracks agent behavior across tool calls. Classifies archetypes.
 * Detects anomalies. Builds behavioral profiles for HELIX to analyze.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentArchetype =
  | "research"
  | "trading"
  | "developer"
  | "data"
  | "unknown";
export type GrowthStage = "explorer" | "active" | "power" | "whale";

// Tool-to-archetype affinity mapping
const TOOL_AFFINITIES: Record<string, AgentArchetype> = {
  get_probability: "research",
  search_markets: "research",
  list_markets: "research",
  get_history: "research",
  get_sentiment: "research",
  get_signal: "trading",
  get_edge: "trading",
  detect_arbitrage: "trading",
  execute_trade: "trading",
  get_order_status: "trading",
  cancel_order: "trading",
  get_divergences: "trading",
  compare_sources: "trading",
  generate_api_key: "developer",
  get_usage: "developer",
  get_health: "developer",
  register_alert: "developer",
  list_alerts: "developer",
  delete_alert: "developer",
  create_market: "developer",
  export_data: "data",
  get_market_stats: "data",
  get_trending: "data",
  track_prediction: "data",
  get_performance: "data",
};

export interface AgentProfile {
  agentId: string;
  archetype: AgentArchetype;
  toolUsage: Record<string, number>;
  totalQueries: number;
  firstSeen: string;
  lastSeen: string;
  sessions: number;
  growthStage: GrowthStage;
  favoriteCategories: string[];
}

export class MAGObserver {
  private profiles: Map<string, AgentProfile> = new Map();
  private sessionObservations: Array<{
    agentId: string;
    tool: string;
    timestamp: number;
  }> = [];

  /**
   * Record a tool call observation
   */
  observe(agentId: string, toolName: string): void {
    const now = Date.now();
    this.sessionObservations.push({ agentId, tool: toolName, timestamp: now });

    // Update in-memory profile
    let profile = this.profiles.get(agentId);
    if (!profile) {
      profile = {
        agentId,
        archetype: "unknown",
        toolUsage: {},
        totalQueries: 0,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        sessions: 1,
        growthStage: "explorer",
        favoriteCategories: [],
      };
      this.profiles.set(agentId, profile);
    }

    profile.toolUsage[toolName] = (profile.toolUsage[toolName] || 0) + 1;
    profile.totalQueries++;
    profile.lastSeen = new Date().toISOString();

    // Reclassify archetype every 20 queries
    if (profile.totalQueries % 20 === 0) {
      profile.archetype = this.classifyArchetype(profile.toolUsage);
      profile.growthStage = this.classifyGrowthStage(profile.totalQueries);
    }
  }

  /**
   * Classify agent archetype from tool usage
   */
  private classifyArchetype(toolUsage: Record<string, number>): AgentArchetype {
    const scores: Record<AgentArchetype, number> = {
      research: 0,
      trading: 0,
      developer: 0,
      data: 0,
      unknown: 0,
    };

    for (const [tool, count] of Object.entries(toolUsage)) {
      const affinity = TOOL_AFFINITIES[tool];
      if (affinity) {
        scores[affinity] += count;
      }
    }

    let maxArchetype: AgentArchetype = "unknown";
    let maxScore = 0;
    for (const [archetype, score] of Object.entries(scores)) {
      if (archetype !== "unknown" && score > maxScore) {
        maxScore = score;
        maxArchetype = archetype as AgentArchetype;
      }
    }

    return maxArchetype;
  }

  /**
   * Classify growth stage from total queries
   */
  private classifyGrowthStage(totalQueries: number): GrowthStage {
    if (totalQueries >= 1000) return "whale";
    if (totalQueries >= 200) return "power";
    if (totalQueries >= 50) return "active";
    return "explorer";
  }

  /**
   * Detect anomalous behavior
   */
  detectAnomalies(agentId: string): string[] {
    const anomalies: string[] = [];
    const recentObs = this.sessionObservations.filter(
      (o) => o.agentId === agentId && o.timestamp > Date.now() - 60000,
    );

    // Rate anomaly: >50 calls/minute
    if (recentObs.length > 50) {
      anomalies.push(`High rate: ${recentObs.length} calls/min`);
    }

    return anomalies;
  }

  /**
   * Get profile for an agent
   */
  getProfile(agentId: string): AgentProfile | null {
    return this.profiles.get(agentId) || null;
  }

  /**
   * Persist profiles to DB (called at ORBIT)
   */
  async persist(supabase: SupabaseClient): Promise<number> {
    let persisted = 0;
    for (const [agentId, profile] of this.profiles) {
      const { error } = await supabase.from("telekash_agent_profiles").upsert(
        {
          agent_id: agentId,
          archetype: profile.archetype,
          tool_usage: profile.toolUsage,
          total_queries: profile.totalQueries,
          first_seen_at: profile.firstSeen,
          last_seen_at: profile.lastSeen,
          sessions: profile.sessions,
          growth_stage: profile.growthStage,
          favorite_categories: profile.favoriteCategories,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "agent_id" },
      );
      if (!error) persisted++;
    }
    return persisted;
  }

  /**
   * Get tool recommendations for an agent based on archetype
   */
  getRecommendations(agentId: string): string[] {
    const profile = this.profiles.get(agentId);
    if (!profile) return [];

    const used = new Set(Object.keys(profile.toolUsage));

    const recommendations: Record<AgentArchetype, string[]> = {
      research: [
        "compare_sources",
        "get_signal",
        "detect_arbitrage",
        "get_trending",
      ],
      trading: [
        "get_edge",
        "track_prediction",
        "get_performance",
        "register_alert",
      ],
      developer: ["export_data", "get_health", "create_market"],
      data: ["get_history", "detect_arbitrage", "compare_sources"],
      unknown: ["get_probability", "search_markets", "get_trending"],
    };

    return (recommendations[profile.archetype] || []).filter(
      (t) => !used.has(t),
    );
  }
}
