/**
 * Statistical significance calculations for A/B testing.
 * Uses a two-proportion z-test to compare CTR between variants.
 */

export interface SignificanceResult {
  zScore: number;
  pValue: number;
  confidence: number;
  significant: boolean;
  winner: 'a' | 'b' | 'none';
  ctrA: number;
  ctrB: number;
  ctrLift: number; // percentage lift of winner over loser
}

/**
 * Calculate statistical significance between two variants.
 * @param impressionsA - Number of impressions for variant A
 * @param clicksA - Number of clicks (views) for variant A
 * @param impressionsB - Number of impressions for variant B
 * @param clicksB - Number of clicks (views) for variant B
 * @param confidenceThreshold - Required confidence level (default 0.90 = 90%)
 */
export function calculateSignificance(
  impressionsA: number,
  clicksA: number,
  impressionsB: number,
  clicksB: number,
  confidenceThreshold = 0.90
): SignificanceResult {
  // Need minimum impressions for meaningful results
  if (impressionsA < 100 || impressionsB < 100) {
    return {
      zScore: 0, pValue: 1, confidence: 0, significant: false,
      winner: 'none', ctrA: 0, ctrB: 0, ctrLift: 0,
    };
  }

  const ctrA = clicksA / impressionsA;
  const ctrB = clicksB / impressionsB;

  // Pooled CTR
  const pooledCTR = (clicksA + clicksB) / (impressionsA + impressionsB);

  // Standard error
  const se = Math.sqrt(pooledCTR * (1 - pooledCTR) * (1 / impressionsA + 1 / impressionsB));

  if (se === 0) {
    return {
      zScore: 0, pValue: 1, confidence: 0, significant: false,
      winner: 'none', ctrA, ctrB, ctrLift: 0,
    };
  }

  // Z-score
  const z = (ctrA - ctrB) / se;

  // Two-tailed p-value using approximation of normal CDF
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  const confidence = 1 - pValue;

  const significant = confidence >= confidenceThreshold;
  const winner = !significant ? 'none' : ctrA > ctrB ? 'a' : 'b';

  const higherCTR = Math.max(ctrA, ctrB);
  const lowerCTR = Math.min(ctrA, ctrB);
  const ctrLift = lowerCTR > 0 ? ((higherCTR - lowerCTR) / lowerCTR) * 100 : 0;

  return { zScore: z, pValue, confidence, significant, winner, ctrA, ctrB, ctrLift };
}

/**
 * Approximate normal CDF using Abramowitz and Stegun formula.
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}
