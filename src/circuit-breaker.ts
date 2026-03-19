/**
 * Circuit Breaker — Prevents cascading failures when exchanges are down.
 *
 * States: CLOSED (normal) → OPEN (failing, reject all) → HALF_OPEN (probe with one request)
 * Transitions: 3 failures in 60s → OPEN. 60s cooldown → HALF_OPEN. Success → CLOSED. Fail → OPEN.
 */

type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures: number[] = []; // timestamps of recent failures
  private lastFailure: number = 0;
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(
    name: string,
    options?: {
      failureThreshold?: number;
      windowMs?: number;
      cooldownMs?: number;
    },
  ) {
    this.name = name;
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.windowMs = options?.windowMs ?? 60_000;
    this.cooldownMs = options?.cooldownMs ?? 60_000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this.state = "half_open";
        console.error(`[CircuitBreaker:${this.name}] → half_open (probing)`);
      } else {
        throw new Error(
          `Circuit breaker OPEN for ${this.name} — ${Math.round((this.cooldownMs - (Date.now() - this.lastFailure)) / 1000)}s until retry`,
        );
      }
    }

    try {
      const result = await fn();
      if (this.state === "half_open") {
        this.state = "closed";
        this.failures = [];
        console.error(`[CircuitBreaker:${this.name}] → closed (recovered)`);
      }
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.lastFailure = now;
    this.failures.push(now);

    // Keep only failures within the window
    this.failures = this.failures.filter((t) => now - t < this.windowMs);

    if (this.failures.length >= this.failureThreshold) {
      this.state = "open";
      console.error(
        `[CircuitBreaker:${this.name}] → OPEN (${this.failures.length} failures in ${this.windowMs / 1000}s)`,
      );
    }
  }

  getState(): {
    state: CircuitState;
    failures: number;
    lastFailure: number | null;
  } {
    return {
      state: this.state,
      failures: this.failures.length,
      lastFailure: this.lastFailure || null,
    };
  }

  reset(): void {
    this.state = "closed";
    this.failures = [];
    this.lastFailure = 0;
  }
}
