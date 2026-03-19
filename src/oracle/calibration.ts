/**
 * Calibration Manager — HELIX + AKASH
 *
 * Reads Platt scaling parameters from telekash_oracle_calibration (AKASH),
 * applies calibration to raw probabilities, and runs calibration cycles
 * that fit new parameters from resolved predictions (HELIX learning).
 *
 * Rollback: If ECE worsens by >10%, automatically reverts to previous params.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  plattScale,
  fitPlattScaling,
  expectedCalibrationError,
} from "./math.js";

export interface CalibrationState {
  domain: string;
  version: number;
  plattA: number;
  plattB: number;
  ece: number | null;
  trainingSamples: number;
  calibratedAt: string;
}

export class CalibrationManager {
  private cache: Map<string, CalibrationState> = new Map();
  private lastLoad: number = 0;
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (refreshes at ORBIT)

  /**
   * Load calibration state from DB for all domains
   */
  async load(supabase: SupabaseClient): Promise<void> {
    const { data, error } = await supabase
      .from("telekash_oracle_calibration")
      .select("*");

    if (error) {
      console.error("[CalibrationManager] Failed to load:", error.message);
      return;
    }

    for (const row of data || []) {
      this.cache.set(row.domain, {
        domain: row.domain,
        version: row.training_samples || 1,
        plattA: Number(row.platt_a) || 1.0,
        plattB: Number(row.platt_b) || 0.0,
        ece: row.expected_calibration_error
          ? Number(row.expected_calibration_error)
          : null,
        trainingSamples: row.training_samples || 0,
        calibratedAt: row.updated_at || new Date().toISOString(),
      });
    }

    this.lastLoad = Date.now();
    console.error(
      `[CalibrationManager] Loaded ${this.cache.size} domain calibrations`,
    );
  }

  /**
   * Get calibration for a domain (falls back to 'general')
   */
  getCalibration(domain: string): CalibrationState {
    return (
      this.cache.get(domain) ||
      this.cache.get("general") || {
        domain: "general",
        version: 0,
        plattA: 1.0,
        plattB: 0.0,
        ece: null,
        trainingSamples: 0,
        calibratedAt: new Date().toISOString(),
      }
    );
  }

  /**
   * Apply calibration to a raw probability
   */
  calibrate(
    rawProbability: number,
    domain: string,
  ): {
    raw_confidence: number;
    calibrated_confidence: number;
    calibration_version: number;
    calibration_domain: string;
  } {
    const cal = this.getCalibration(domain);
    const calibrated = plattScale(rawProbability, cal.plattA, cal.plattB);

    return {
      raw_confidence: Math.round(rawProbability * 10000) / 10000,
      calibrated_confidence: Math.round(calibrated * 10000) / 10000,
      calibration_version: cal.version,
      calibration_domain: cal.domain,
    };
  }

  /**
   * Run calibration cycle (called at ORBIT boundary)
   * Fetches resolved predictions, fits new Platt params, checks ECE, writes back.
   */
  async runCalibrationCycle(
    supabase: SupabaseClient,
    domain: string = "general",
  ): Promise<{
    success: boolean;
    domain: string;
    oldECE: number | null;
    newECE: number;
    rolledBack: boolean;
    samplesUsed: number;
  }> {
    // Fetch resolved predictions for this domain
    const { data: predictions, error } = await supabase
      .from("telekash_oracle_brier")
      .select(
        `
        predicted_probability,
        actual_outcome,
        telekash_oracle_ensembles!inner(domain)
      `,
      )
      .not("actual_outcome", "is", null)
      .eq("telekash_oracle_ensembles.domain", domain)
      .order("predicted_at", { ascending: false })
      .limit(1000);

    if (error || !predictions || predictions.length < 20) {
      return {
        success: false,
        domain,
        oldECE: this.getCalibration(domain).ece,
        newECE: 0,
        rolledBack: false,
        samplesUsed: predictions?.length || 0,
      };
    }

    const samples = predictions.map((p) => ({
      predicted: Number(p.predicted_probability),
      actual: Number(p.actual_outcome),
    }));

    const currentCal = this.getCalibration(domain);
    const oldECE = currentCal.ece;

    // Fit new Platt parameters
    const { a, b, ece: newECE } = fitPlattScaling(samples);

    // Rollback check: if ECE worsened by >10%, keep old params
    const rolledBack = oldECE !== null && newECE > oldECE * 1.1;

    if (!rolledBack) {
      // Update DB
      const { error: updateError } = await supabase
        .from("telekash_oracle_calibration")
        .update({
          platt_a: a,
          platt_b: b,
          expected_calibration_error: newECE,
          training_samples: samples.length,
          last_trained_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("domain", domain);

      if (!updateError) {
        // Update local cache
        this.cache.set(domain, {
          domain,
          version: (currentCal.version || 0) + 1,
          plattA: a,
          plattB: b,
          ece: newECE,
          trainingSamples: samples.length,
          calibratedAt: new Date().toISOString(),
        });
      }

      // Log to changelog
      await supabase.from("telekash_calibration_changelog").insert({
        calibration_version: (currentCal.version || 0) + 1,
        domain,
        change_type: "orbit_update",
        platt_a_before: currentCal.plattA,
        platt_a_after: a,
        platt_b_before: currentCal.plattB,
        platt_b_after: b,
        ece_before: oldECE,
        ece_after: newECE,
        samples_used: samples.length,
        notes: `ORBIT calibration: ECE ${oldECE?.toFixed(4) || "N/A"} → ${newECE.toFixed(4)}`,
      });
    } else {
      // Log rollback
      await supabase.from("telekash_calibration_changelog").insert({
        calibration_version: currentCal.version || 0,
        domain,
        change_type: "rollback",
        platt_a_before: currentCal.plattA,
        platt_a_after: currentCal.plattA,
        platt_b_before: currentCal.plattB,
        platt_b_after: currentCal.plattB,
        ece_before: oldECE,
        ece_after: newECE,
        samples_used: samples.length,
        notes: `ROLLBACK: New ECE ${newECE.toFixed(4)} > old ECE ${oldECE?.toFixed(4)} × 1.1`,
      });
    }

    return {
      success: !rolledBack,
      domain,
      oldECE,
      newECE,
      rolledBack,
      samplesUsed: samples.length,
    };
  }

  /**
   * Check if cache needs refresh
   */
  needsRefresh(): boolean {
    return Date.now() - this.lastLoad > this.CACHE_TTL_MS;
  }
}
