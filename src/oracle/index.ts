/**
 * Oracle Client — The GH Fractal TORUS inside the MCP Server
 *
 * Composes all fractal systems:
 *   MAG (observe) → HELIX (orient) → PHI (decide) → NOX (act) → loop
 *
 * Backed by AKASH (memory), COMPASS (time), SUMU (revenue),
 * KILO (intelligence), AXIOM (audit), AURA (growth).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalibrationManager } from "./calibration.js";
import { HelixEngine } from "./helix.js";
import { MAGObserver } from "./mag.js";
import { CompassManager } from "./compass.js";
import { AuraTracker } from "./aura.js";
import { KiloMonitor } from "./kilo.js";
import { AxiomAuditor } from "./axiom.js";

export class OracleClient {
  readonly calibration: CalibrationManager;
  readonly helix: HelixEngine;
  readonly mag: MAGObserver;
  readonly compass: CompassManager;
  readonly aura: AuraTracker;
  readonly kilo: KiloMonitor;
  readonly axiom: AxiomAuditor;

  private initialized = false;

  constructor() {
    this.calibration = new CalibrationManager();
    this.helix = new HelixEngine();
    this.mag = new MAGObserver();
    this.compass = new CompassManager(this.calibration, this.helix, this.mag);
    this.aura = new AuraTracker();
    this.kilo = new KiloMonitor();
    this.axiom = new AxiomAuditor(this.kilo);
  }

  /**
   * Initialize oracle systems — load calibration state from DB
   */
  async initialize(supabase: SupabaseClient): Promise<void> {
    if (this.initialized) return;

    try {
      await this.calibration.load(supabase);
      this.initialized = true;
      console.error(
        "[Oracle] Fractal TORUS initialized — MAG, HELIX, COMPASS, AURA, KILO, AXIOM online",
      );
    } catch (err) {
      console.error(
        "[Oracle] Init warning (non-fatal):",
        err instanceof Error ? err.message : err,
      );
      this.initialized = true; // Continue with defaults
    }
  }

  /**
   * Calibrate a raw probability — returns both raw and calibrated
   */
  calibrate(
    rawProbability: number,
    domain: string,
  ): {
    raw_confidence: number;
    calibrated_confidence: number;
    calibration_version: number;
    calibration_domain: string;
    next_orbit: string;
  } {
    const result = this.calibration.calibrate(rawProbability, domain);
    return {
      ...result,
      next_orbit: this.compass.getNextOrbitTime(),
    };
  }

  /**
   * Observe a tool call (MAG)
   */
  observeToolCall(agentId: string, toolName: string): void {
    this.mag.observe(agentId, toolName);
  }

  /**
   * Get agent profile with AURA enrichment
   */
  getAgentInsight(
    agentId: string,
    brierScore: number | null,
    totalPredictions: number,
  ): Record<string, unknown> {
    const profile = this.mag.getProfile(agentId);
    if (!profile) return {};

    const auraData = this.aura.formatForResponse(
      profile.archetype,
      brierScore,
      totalPredictions,
    );

    const recommendations = this.mag.getRecommendations(agentId);

    return {
      ...auraData,
      _agent: {
        archetype: profile.archetype,
        growth_stage: profile.growthStage,
        total_queries: profile.totalQueries,
        recommendations:
          recommendations.length > 0 ? recommendations : undefined,
      },
    };
  }

  /**
   * Run ORBIT cycle (daily calibration)
   */
  async runOrbit(supabase: SupabaseClient) {
    return this.compass.runOrbit(supabase);
  }

  /**
   * Run EPOCH cycle (weekly deep learning)
   */
  async runEpoch(supabase: SupabaseClient) {
    return this.compass.runEpoch(supabase);
  }

  /**
   * Run structural audit (AXIOM)
   */
  async audit(supabase: SupabaseClient) {
    return this.axiom.audit(supabase);
  }

  /**
   * Check if calibration cache needs refresh
   */
  async refreshIfNeeded(supabase: SupabaseClient): Promise<void> {
    if (this.calibration.needsRefresh()) {
      await this.calibration.load(supabase);
    }
  }
}

// Re-export types
export type { CalibrationState } from "./calibration.js";
export type { DetectedPattern, PatternStatus } from "./helix.js";
export type { AgentArchetype, GrowthStage, AgentProfile } from "./mag.js";
export type { CycleType, CycleResult } from "./compass.js";
export type { AuraTier } from "./aura.js";
export type { SourceHealth } from "./kilo.js";
export type { AuditStatus, AuditElement } from "./axiom.js";
