/**
 * KILO — Source Freshness Monitor + Intelligence
 *
 * Monitors data source health, detects stale sources,
 * tracks accuracy by source for HELIX pattern detection.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SourceHealth {
  source: string;
  latestUpdate: string;
  marketCount: number;
  isFresh: boolean;
  staleSinceMinutes: number;
}

export class KiloMonitor {
  /**
   * Check freshness of all data sources
   */
  async checkSourceFreshness(
    supabase: SupabaseClient,
  ): Promise<SourceHealth[]> {
    const { data, error } = await supabase
      .from("telekash_markets")
      .select("source, updated_at")
      .eq("status", "active")
      .order("updated_at", { ascending: false });

    if (error || !data) return [];

    const sourceMap = new Map<string, { latest: string; count: number }>();

    for (const row of data) {
      const existing = sourceMap.get(row.source);
      if (!existing || row.updated_at > existing.latest) {
        sourceMap.set(row.source, {
          latest: row.updated_at,
          count: (existing?.count || 0) + 1,
        });
      } else {
        sourceMap.set(row.source, {
          ...existing,
          count: existing.count + 1,
        });
      }
    }

    const now = Date.now();
    const STALE_THRESHOLD_MIN = 30;

    return [...sourceMap.entries()].map(([source, info]) => {
      const ageMin = (now - new Date(info.latest).getTime()) / (1000 * 60);
      return {
        source,
        latestUpdate: info.latest,
        marketCount: info.count,
        isFresh: ageMin <= STALE_THRESHOLD_MIN,
        staleSinceMinutes: Math.round(ageMin),
      };
    });
  }

  /**
   * Track tool revenue efficiency
   */
  async getRevenuePerTool(
    supabase: SupabaseClient,
  ): Promise<Record<string, { calls: number; revenue: number }>> {
    const { data } = await supabase
      .from("telekash_usage_logs")
      .select("tool_name, query_cost_usd")
      .gte(
        "created_at",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      );

    if (!data) return {};

    const result: Record<string, { calls: number; revenue: number }> = {};
    for (const row of data) {
      const tool = row.tool_name || "unknown";
      if (!result[tool]) result[tool] = { calls: 0, revenue: 0 };
      result[tool].calls++;
      result[tool].revenue += Number(row.query_cost_usd) || 0;
    }

    return result;
  }
}
