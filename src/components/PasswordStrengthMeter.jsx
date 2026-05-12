import React from "react";
import { evaluatePassword, PASSWORD_RULES } from "../utils/passwordStrength";

const BAR_COLORS = { "weak": "#ef4444", "fair": "#f59e0b", "strong": "#3b82f6", "very strong": "#22c55e" };

export default function PasswordStrengthMeter({ password }) {
  if (!password) return null;
  const { score, strength, passed } = evaluatePassword(password);

  return (
    <div style={{ marginTop: 8 }}>
      {/* Segmented bar */}
      <div style={{ display: "flex", gap: 3, marginBottom: 6 }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i <= score ? BAR_COLORS[strength] : "rgba(255,255,255,0.1)",
            transition: "background 0.2s",
          }} />
        ))}
      </div>

      {/* Rules checklist */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {PASSWORD_RULES.map((rule, i) => (
          <div key={rule.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ color: passed[i] ? "#22c55e" : "#64748b", fontWeight: 700, lineHeight: 1 }}>
              {passed[i] ? "✓" : "○"}
            </span>
            <span style={{ color: passed[i] ? "#94a3b8" : "#64748b" }}>{rule.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
