/**
 * COMPASS — The Clock
 *
 * Time cycles that drive the learning system.
 * PULSE: every 15 min (snapshot + health check)
 * ORBIT: daily 3am UTC (calibration cycle, model weight update, pattern promotion)
 * EPOCH: weekly Sunday 3am UTC (full retrain, decay audit, intelligence compound)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalibrationManager } from "./calibration.js";
import { HelixEngine } from "./helix.js";
import { MAGObserver } from "./mag.js";

export type CycleType = "pulse" | "orbit" | "epoch";

export interface CycleResult {
  cycleType: CycleType;
  startedAt: string;
  completedAt: string;
  metrics: Record<string, unknown>;
  status: "completed" | "failed";
  error?: string;
}

export class CompassManager {
  constructor(
    private calibration: CalibrationManager,
    private helix: HelixEngine,
    private mag: MAGObserver,
  ) {}

  /**
   * ORBIT cycle — daily calibration + learning
   * Called by pg_cron at 3am UTC or manually
   */
  async runOrbit(supabase: SupabaseClient): Promise<CycleResult> {
    const startedAt = new Date().toISOString();
    const metrics: Record<string, unknown> = {};

    try {
      // 1. Run calibration for each domain
      const domains = ["general", "sports", "politics", "crypto", "science"];
      const calibrationResults = [];
      for (const domain of domains) {
        const result = await this.calibration.runCalibrationCycle(
          supabase,
          domain,
        );
        calibrationResults.push(result);
      }
      metrics.calibration = calibrationResults;
      metrics.calibrations_updated = calibrationResults.filter(
        (r) => r.success,
      ).length;
      metrics.calibrations_rolled_back = calibrationResults.filter(
        (r) => r.rolledBack,
      ).length;

      // 2. Update model weights via DB function
      const { error: weightError } = await supabase.rpc(
        "oracle_update_model_weights",
        { p_domain: "general" },
      );
      metrics.model_weights_updated = !weightError;

      // 3. Measure actual noise reversal rate (replaces assumed 58%)
      const noiseRate = await this.helix.measureNoiseReversalRate(supabase, 24);
      metrics.noise_reversal_rate = noiseRate.reversal_rate;
      metrics.noise_sample_size = noiseRate.sample_size;

      // 4. Persist agent profiles
      const profilesPersisted = await this.mag.persist(supabase);
      metrics.profiles_persisted = profilesPersisted;

      // 5. Reload calibration cache
      await this.calibration.load(supabase);
      metrics.calibration_cache_refreshed = true;

      // 6. Log cycle completion
      await this.logCycle(supabase, "orbit", startedAt, metrics, "completed");

      return {
        cycleType: "orbit",
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        status: "completed",
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown ORBIT error";
      await this.logCycle(
        supabase,
        "orbit",
        startedAt,
        metrics,
        "failed",
        error,
      );
      return {
        cycleType: "orbit",
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        status: "failed",
        error,
      };
    }
  }

  /**
   * EPOCH cycle — weekly deep learning
   * Called by pg_cron at 3am UTC Sunday or manually
   */
  async runEpoch(supabase: SupabaseClient): Promise<CycleResult> {
    const startedAt = new Date().toISOString();
    const metrics: Record<string, unknown> = {};

    try {
      // 1. Run ORBIT first (EPOCH includes ORBIT)
      const orbitResult = await this.runOrbit(supabase);
      metrics.orbit_included = orbitResult.status;

      // 2. Decay model weights by 5% (prevents stale model accumulation)
      const { error: decayError } = await supabase.rpc("oracle_decay_weights", {
        p_decay_factor: 0.95,
      });
      // If RPC doesn't exist, do it manually
      if (decayError) {
        await supabase
          .from("telekash_oracle_model_weights")
          .update({
            weight: supabase.rpc("oracle_ema", {
              old_value: 1.0,
              new_observation: 0.95,
              alpha: 0.05,
            }),
          })
          .neq("weight", 0);
        metrics.weight_decay = "manual_fallback";
      } else {
        metrics.weight_decay = "rpc_success";
      }

      // 3. Cross-market correlation sweep
      const correlations = await this.helix.detectCorrelations(supabase);
      metrics.correlations_found = correlations.length;

      // 4. Arbitrage pattern analysis
      const arbPatterns =
        await this.helix.measureArbitrageClosureRate(supabase);
      metrics.arbitrage_closure_rate = arbPatterns.closure_rate_48h;
      metrics.arbitrage_sample_size = arbPatterns.sample_size;

      // 5. Update compound intelligence
      const { error: intelError } = await supabase.rpc(
        "oracle_compound_intelligence",
        {
          initial_intelligence: 1000,
          learning_rate: 0.01,
          periods: 1,
          resonance_bonus: correlations.length > 5 ? 0.05 : 0,
        },
      );
      metrics.intelligence_compounded = !intelError;

      // 6. Cleanup old data
      const { data: cleanupResult } = await supabase.rpc(
        "telekash_cleanup_old_snapshots",
      );
      metrics.snapshots_cleaned = cleanupResult;

      await this.logCycle(supabase, "epoch", startedAt, metrics, "completed");

      return {
        cycleType: "epoch",
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        status: "completed",
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown EPOCH error";
      await this.logCycle(
        supabase,
        "epoch",
        startedAt,
        metrics,
        "failed",
        error,
      );
      return {
        cycleType: "epoch",
        startedAt,
        completedAt: new Date().toISOString(),
        metrics,
        status: "failed",
        error,
      };
    }
  }

  /**
   * Log cycle to DB
   */
  private async logCycle(
    supabase: SupabaseClient,
    cycleType: CycleType,
    startedAt: string,
    metrics: Record<string, unknown>,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void> {
    await supabase.from("telekash_compass_cycles").insert({
      cycle_type: cycleType,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      metrics,
      status,
      error: error || null,
    });
  }

  /**
   * Get next ORBIT time (3am UTC)
   */
  getNextOrbitTime(): string {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
}
