const VERDICT_CONFIG = {
  REAL: {
    label: "Real",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.15)"
  },
  FAKE: {
    label: "Fake",
    color: "#ef4444",
    bg: "rgba(239,68,68,0.15)"
  },
  SUSPICIOUS: {
    label: "Suspicious",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.15)"
  },
  INCONCLUSIVE: {
    label: "Inconclusive",
    color: "#6b7280",
    bg: "rgba(107,114,128,0.15)"
  }
};

function getVerdictFromScore(score) {
  if (score <= 30) return "REAL";
  if (score <= 60) return "INCONCLUSIVE";
  if (score <= 80) return "SUSPICIOUS";
  return "FAKE";
}

if (typeof window !== "undefined") {
  window.VERDICT_CONFIG = VERDICT_CONFIG;
  window.getVerdictFromScore = getVerdictFromScore;
}
