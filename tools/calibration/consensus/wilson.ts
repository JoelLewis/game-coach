// Wilson score interval: a 95% confidence interval for a binomial proportion that stays inside
// [0, 1] and behaves at small n and near 0/1, unlike the naive normal approximation. Used
// wherever a small human-labeled or audit sample needs an honest error bar (K6/K7 brief).
export type WilsonInterval = { estimate: number; lower: number; upper: number; n: number };

// 97.5th percentile of the standard normal distribution, for a two-sided 95% interval.
const Z_95 = 1.959963984540054;

export const wilsonInterval = (successes: number, n: number, z: number = Z_95): WilsonInterval => {
  if (n <= 0) return { estimate: NaN, lower: NaN, upper: NaN, n };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    estimate: p,
    lower: Math.max(0, (center - margin) / denominator),
    upper: Math.min(1, (center + margin) / denominator),
    n,
  };
};
