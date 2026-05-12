const TZ = "Asia/Kuala_Lumpur";

export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-MY", { timeZone: TZ });
}

export function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-MY", { timeZone: TZ });
}
