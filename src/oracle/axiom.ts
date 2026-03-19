/**
 * AXIOM — Structural Integrity Auditor
 *
 * Self-audits the MCP server for completeness, accuracy correlation,
 * tool coverage, and data health. Reports AXIOM/AXIOS/VOID per element.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { KiloMonitor } from "./kilo.js";

export type AuditStatus = "AXIOM" | "AXIOS" | "VOID";

export interface AuditElement {
  element: string;
  status: AuditStatus;
  score: number; // 1-10
  note: string;
}

export class AxiomAuditor {
  constructor(private kilo: KiloMonitor) {}

  /**
   * Run full structural audit
   */
  async audit(supabase: SupabaseClient): Promise<{
    score_pct: number;
    axiom_count: number;
    axios_count: number;
    void_count: number;
    elements: AuditElement[];
  }> {
    const elements: AuditElement[] = [];

    // 1. Data source freshness
    const sources = await this.kilo.checkSourceFreshness(supabase);
    for (const source of sources) {
      elements.push({
        element: `source:${source.source}`,
        status: source.isFresh ? "AXIOM" : "AXIOS",
        score: source.isFresh ? 9 : 4,
        note: source.isFresh
          ? `Fresh (${source.staleSinceMinutes}min ago)`
          : `Stale: ${source.staleSinceMinutes} min since last update`,
      });
    }

    // 2. Calibration health
    const { data: calibrations } = await supabase
      .from("telekash_oracle_calibration")
      .select("*");

    for (const cal of calibrations || []) {
      const hasSamples = (cal.training_samples || 0) >= 20;
      const eceOk =
        cal.expected_calibration_error === null ||
        Number(cal.expected_calibration_error) < 0.15;

      elements.push({
        element: `calibration:${cal.domain}`,
        status: hasSamples && eceOk ? "AXIOM" : hasSamples ? "AXIOS" : "VOID",
        score: hasSamples && eceOk ? 8 : hasSamples ? 5 : 2,
        note: hasSamples
          ? `ECE: ${Number(cal.expected_calibration_error || 0).toFixed(4)}, ${cal.training_samples} samples`
          : `Insufficient training data (${cal.training_samples || 0} samples)`,
      });
    }

    // 3. Snapshot pipeline health
    const { count: snapshotCount } = await supabase
      .from("telekash_probability_snapshots")
      .select("id", { count: "exact", head: true })
      .gte("snapshot_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());

    elements.push({
      element: "pipeline:snapshots",
      status:
        (snapshotCount || 0) > 100
          ? "AXIOM"
          : (snapshotCount || 0) > 0
            ? "AXIOS"
            : "VOID",
      score: (snapshotCount || 0) > 100 ? 9 : (snapshotCount || 0) > 0 ? 5 : 1,
      note: `${snapshotCount || 0} snapshots in last hour`,
    });

    // 4. COMPASS cycle health
    const { data: recentCycles } = await supabase
      .from("telekash_compass_cycles")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(5);

    const lastOrbit = recentCycles?.find((c) => c.cycle_type === "orbit");
    const orbitFresh =
      lastOrbit &&
      Date.now() - new Date(lastOrbit.started_at).getTime() <
        25 * 60 * 60 * 1000;

    elements.push({
      element: "compass:orbit_cycle",
      status:
        orbitFresh && lastOrbit?.status === "completed"
          ? "AXIOM"
          : orbitFresh
            ? "AXIOS"
            : "VOID",
      score:
        orbitFresh && lastOrbit?.status === "completed"
          ? 9
          : orbitFresh
            ? 5
            : 2,
      note: lastOrbit
        ? `Last ORBIT: ${lastOrbit.status} at ${lastOrbit.started_at}`
        : "No ORBIT cycles recorded",
    });

    // 5. Tool revenue audit
    const revenue = await this.kilo.getRevenuePerTool(supabase);
    const toolsWithRevenue = Object.values(revenue).filter(
      (r) => r.revenue > 0,
    ).length;
    elements.push({
      element: "sumu:tool_revenue",
      status:
        toolsWithRevenue > 3
          ? "AXIOM"
          : toolsWithRevenue > 0
            ? "AXIOS"
            : "VOID",
      score: toolsWithRevenue > 3 ? 8 : toolsWithRevenue > 0 ? 4 : 1,
      note: `${toolsWithRevenue} tools generating revenue this week`,
    });

    // Calculate totals
    const axiomCount = elements.filter((e) => e.status === "AXIOM").length;
    const axiosCount = elements.filter((e) => e.status === "AXIOS").length;
    const voidCount = elements.filter((e) => e.status === "VOID").length;
    const totalScore = elements.reduce((sum, e) => sum + e.score, 0);
    const maxScore = elements.length * 10;

    return {
      score_pct: Math.round((totalScore / maxScore) * 100),
      axiom_count: axiomCount,
      axios_count: axiosCount,
      void_count: voidCount,
      elements,
    };
  }
}
