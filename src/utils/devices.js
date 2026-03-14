export function getDeviceId() {
  let id = localStorage.getItem("device_id");
  if (!id) {
    // Use browser crypto if available; otherwise fallback
    if (crypto?.randomUUID) id = crypto.randomUUID();
    else id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("device_id", id);
  }
  return id;
}
