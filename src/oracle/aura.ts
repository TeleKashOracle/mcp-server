/**
 * AURA — Agent Growth Journey
 *
 * ANCHOR: Show the ceiling (what expert looks like)
 * LADDER: Show position (where agent is now)
 * PULL: Make progress visible (growth momentum)
 *
 * Each agent archetype has its own POLARIS and growth tiers.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentArchetype, GrowthStage } from "./mag.js";

export type AuraTier =
  | "Novice"
  | "Trader"
  | "Analyst"
  | "Expert"
  | "Oracle"
  | "Legend";

interface CeilingBenchmarks {
  brierScore: number;
  totalPredictions: number;
  winRate: number;
  description: string;
}

// Ceiling benchmarks by archetype (what "expert" looks like)
const ARCHETYPE_CEILINGS: Record<AgentArchetype, CeilingBenchmarks> = {
  research: {
    brierScore: 0.08,
    totalPredictions: 500,
    winRate: 0.72,
    description: "Top research agents achieve Brier 0.08 with 500+ predictions",
  },
  trading: {
    brierScore: 0.12,
    totalPredictions: 1000,
    winRate: 0.64,
    description: "Top trading agents achieve 64% win rate on 1000+ trades",
  },
  developer: {
    brierScore: 0.15,
    totalPredictions: 200,
    winRate: 0.6,
    description: "Top developer agents build reliable multi-tool workflows",
  },
  data: {
    brierScore: 0.1,
    totalPredictions: 300,
    winRate: 0.68,
    description: "Top data agents achieve Brier 0.10 on backtested strategies",
  },
  unknown: {
    brierScore: 0.15,
    totalPredictions: 100,
    winRate: 0.6,
    description: "Explore tools to discover your archetype",
  },
};

export class AuraTracker {
  /**
   * Get AURA tier from growth stage and performance
   */
  getTier(growthStage: GrowthStage, brierScore: number | null): AuraTier {
    if (!brierScore) {
      return growthStage === "whale" ? "Analyst" : "Novice";
    }

    if (brierScore < 0.08 && growthStage === "whale") return "Legend";
    if (brierScore < 0.1 && growthStage === "whale") return "Oracle";
    if (brierScore < 0.12) return "Expert";
    if (brierScore < 0.15) return "Analyst";
    if (brierScore < 0.2) return "Trader";
    return "Novice";
  }

  /**
   * Get ceiling visibility for an agent
   */
  getCeilingVisibility(
    archetype: AgentArchetype,
    currentBrier: number | null,
    totalPredictions: number,
  ): {
    ceiling: CeilingBenchmarks;
    current_tier: AuraTier;
    progress_pct: number;
    next_milestone: string;
  } {
    const ceiling = ARCHETYPE_CEILINGS[archetype] || ARCHETYPE_CEILINGS.unknown;
    const tier = this.getTier(
      totalPredictions >= 1000
        ? "whale"
        : totalPredictions >= 200
          ? "power"
          : "explorer",
      currentBrier,
    );

    // Progress based on Brier score (lower = better)
    const maxBrier = 0.25; // random baseline
    const progressBrier = currentBrier
      ? Math.max(
          0,
          (maxBrier - currentBrier) / (maxBrier - ceiling.brierScore),
        ) * 100
      : 0;
    const progressPredictions = Math.min(
      100,
      (totalPredictions / ceiling.totalPredictions) * 100,
    );
    const progress = Math.round((progressBrier + progressPredictions) / 2);

    let nextMilestone: string;
    if (totalPredictions < 20) {
      nextMilestone = "Track 20 predictions to unlock accuracy metrics";
    } else if (!currentBrier || currentBrier > 0.2) {
      nextMilestone = "Improve Brier score below 0.20 to reach Trader tier";
    } else if (currentBrier > 0.15) {
      nextMilestone = "Improve Brier score below 0.15 to reach Analyst tier";
    } else if (currentBrier > 0.12) {
      nextMilestone = "Improve Brier score below 0.12 to reach Expert tier";
    } else {
      nextMilestone = `${ceiling.totalPredictions - totalPredictions} more predictions to validate your edge`;
    }

    return {
      ceiling,
      current_tier: tier,
      progress_pct: Math.min(100, progress),
      next_milestone: nextMilestone,
    };
  }

  /**
   * Format AURA data for tool response enrichment (invisible)
   */
  formatForResponse(
    archetype: AgentArchetype,
    currentBrier: number | null,
    totalPredictions: number,
  ): Record<string, unknown> {
    const visibility = this.getCeilingVisibility(
      archetype,
      currentBrier,
      totalPredictions,
    );

    return {
      _aura: {
        tier: visibility.current_tier,
        archetype,
        progress: `${visibility.progress_pct}%`,
        next: visibility.next_milestone,
        ceiling_brier: visibility.ceiling.brierScore,
      },
    };
  }
}
