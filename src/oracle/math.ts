/**
 * Oracle Mathematics — TypeScript mirrors of PostgreSQL functions
 *
 * Every function here has a SQL counterpart in 20260305400000_oracle_math_foundation.sql.
 * Language, Code, and Math must align perfectly.
 */

// EQUATION 1: Entropy — H(p) = -p·ln(p) - (1-p)·ln(1-p)
export function entropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -p * Math.log(p) - (1 - p) * Math.log(1 - p);
}

// Maximum entropy for binary outcomes
export const H_MAX = Math.log(2); // 0.693147...

// EQUATION 2: Confidence — C(p,n) = p × (1 - H/H_MAX) × √(n/n_MIN)
export function confidence(p: number, sampleSize: number = 10): number {
  const N_MIN = 10;
  const h = entropy(p);
  const certaintyFactor = 1 - h / H_MAX;
  const sampleFactor = Math.sqrt(Math.max(sampleSize, 1) / N_MIN);
  return p * certaintyFactor * sampleFactor;
}

// EQUATION 3: Freshness — F(t) = e^(-λ·Δt)
export function freshness(signalTime: Date, lambda: number = 0.01): number {
  const deltaHours = (Date.now() - signalTime.getTime()) / (1000 * 60 * 60);
  return Math.exp(-lambda * Math.max(deltaHours, 0));
}

// EQUATION 5: Brier Score — B = (1/N) × Σ(pᵢ - oᵢ)²
export function brierScore(
  predictions: Array<{ predicted: number; actual: number }>,
): number {
  if (predictions.length === 0) return 0.25; // Random baseline
  const sum = predictions.reduce(
    (acc, p) => acc + Math.pow(p.predicted - p.actual, 2),
    0,
  );
  return sum / predictions.length;
}

// EQUATION 10: Platt Scaling — p_calibrated = 1 / (1 + e^(-(A·p_raw + B)))
export function plattScale(rawP: number, a: number, b: number): number {
  return 1.0 / (1.0 + Math.exp(-(a * rawP + b)));
}

// EQUATION 10 (inverse): Fit Platt Scaling from resolved predictions
// Uses Newton's method (log-likelihood optimization)
export function fitPlattScaling(
  predictions: Array<{ predicted: number; actual: number }>,
  maxIterations: number = 50,
): { a: number; b: number; ece: number } {
  if (predictions.length < 10) {
    return { a: 1.0, b: 0.0, ece: 0.25 };
  }

  let a = 1.0;
  let b = 0.0;
  const lr = 0.01;

  for (let iter = 0; iter < maxIterations; iter++) {
    let gradA = 0;
    let gradB = 0;

    for (const { predicted, actual } of predictions) {
      const z = a * predicted + b;
      const sigmoid = 1.0 / (1.0 + Math.exp(-z));
      const error = sigmoid - actual;
      gradA += error * predicted;
      gradB += error;
    }

    gradA /= predictions.length;
    gradB /= predictions.length;

    a -= lr * gradA;
    b -= lr * gradB;

    // Convergence check
    if (Math.abs(gradA) < 1e-8 && Math.abs(gradB) < 1e-8) break;
  }

  const ece = expectedCalibrationError(predictions, a, b);
  return { a, b, ece };
}

// EQUATION 11: Expected Calibration Error
// ECE = Σ(nₖ/N) × |acc(k) - conf(k)|
export function expectedCalibrationError(
  predictions: Array<{ predicted: number; actual: number }>,
  a: number = 1.0,
  b: number = 0.0,
  numBins: number = 10,
): number {
  if (predictions.length === 0) return 1.0;

  const bins: Array<{
    count: number;
    sumPredicted: number;
    sumActual: number;
  }> = Array.from({ length: numBins }, () => ({
    count: 0,
    sumPredicted: 0,
    sumActual: 0,
  }));

  for (const { predicted, actual } of predictions) {
    const calibrated = plattScale(predicted, a, b);
    const binIdx = Math.min(Math.floor(calibrated * numBins), numBins - 1);
    bins[binIdx].count++;
    bins[binIdx].sumPredicted += calibrated;
    bins[binIdx].sumActual += actual;
  }

  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const avgPredicted = bin.sumPredicted / bin.count;
    const avgActual = bin.sumActual / bin.count;
    ece +=
      (bin.count / predictions.length) * Math.abs(avgActual - avgPredicted);
  }

  return ece;
}

// EQUATION 23: EMA — w_new = α·w_observed + (1-α)·w_old
export function ema(
  oldValue: number,
  newObservation: number,
  alpha: number = 0.1,
): number {
  return alpha * newObservation + (1 - alpha) * oldValue;
}

// Correlation coefficient — ρ(X,Y) = Cov(X,Y) / (σ_X × σ_Y)
export function correlationCoefficient(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let cov = 0,
    varX = 0,
    varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom === 0 ? 0 : cov / denom;
}
