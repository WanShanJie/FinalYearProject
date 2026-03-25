export function getVerdictFromScore(score) {
  if (score <= 30) return "REAL";
  if (score <= 60) return "INCONCLUSIVE";
  if (score <= 80) return "SUSPICIOUS";
  return "FAKE";
}
