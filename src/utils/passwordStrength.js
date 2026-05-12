/**
 * Shared password strength validator.
 * Rules must match the backend schema regex exactly.
 */
export const PASSWORD_RULES = [
  { id: "length",    label: "At least 8 characters",          test: (p) => p.length >= 8 },
  { id: "upper",     label: "One uppercase letter (A–Z)",      test: (p) => /[A-Z]/.test(p) },
  { id: "lower",     label: "One lowercase letter (a–z)",      test: (p) => /[a-z]/.test(p) },
  { id: "digit",     label: "One number (0–9)",                test: (p) => /\d/.test(p) },
  { id: "special",   label: "One special character (!@#$…)",   test: (p) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(p) },
];

/**
 * Returns { score: 0-5, strength: "weak"|"fair"|"strong"|"very strong", passed: bool[] }
 */
export function evaluatePassword(password) {
  const passed = PASSWORD_RULES.map((r) => r.test(password));
  const score  = passed.filter(Boolean).length;
  let strength = "weak";
  if (score === 5)      strength = "very strong";
  else if (score >= 4)  strength = "strong";
  else if (score >= 3)  strength = "fair";
  return { score, strength, passed };
}

/** Returns true only when every rule passes. */
export function isStrongPassword(password) {
  return PASSWORD_RULES.every((r) => r.test(password));
}
