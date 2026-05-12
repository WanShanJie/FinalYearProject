import React, { useState, useEffect, useCallback } from "react";
import { formatDate } from "../utils/formatDate";
import {
  listUsers,
  approveUser,
  revokeUser,
  setUserRole,
  createAdminUser,
} from "../api/auth";

function getCurrentUserId() {
  try {
    const token = localStorage.getItem("token");
    if (!token) return null;
    const payload = JSON.parse(atob(token.split(".")[1]));
    return Number(payload.sub);
  } catch { return null; }
}

function Badge({ label, color, bg, border }) {
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 999,
      fontSize: 11, fontWeight: 700, color,
      background: bg, border: `1px solid ${border || color + "44"}`,
      letterSpacing: "0.04em", whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

const TABS = ["Access Requests", "Administrators", "Invite User"];

export default function AdminPanel() {
  const [tab, setTab]             = useState(0);
  const [allUsers, setAllUsers]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [msg, setMsg]             = useState("");
  const [err, setErr]             = useState("");
  const [suspendTarget, setSuspendTarget] = useState(null);

  // Invite form
  const [newEmail, setNewEmail] = useState("");
  const [newFirst, setNewFirst] = useState("");
  const [newLast,  setNewLast]  = useState("");
  const [creating, setCreating] = useState(false);

  const currentUserId = getCurrentUserId();

  const load = useCallback(async () => {
    setLoading(true); setMsg(""); setErr("");
    try {
      const res = await listUsers();
      if (res.ok) setAllUsers(res.data);
    } catch (e) {
      setErr(e.message || "Failed to load.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Derived views
  // Invited users who haven't completed their first login yet (must_change_password=true means invitation pending)
  const pendingRequests = allUsers.filter(u => u.is_approved && u.must_change_password && u.role !== "ADMIN");
  const admins          = allUsers.filter(u => u.role === "ADMIN");

  async function act(fn, ...args) {
    setMsg(""); setErr("");
    try {
      const res = await fn(...args);
      if (res.ok) { setMsg(res.message || "Done."); load(); }
    } catch (e) { setErr(e.message || "Action failed."); }
    setSuspendTarget(null);
  }

  async function handleInvite(e) {
    e.preventDefault();
    setMsg(""); setErr(""); setCreating(true);
    try {
      const res = await createAdminUser({
        email: newEmail.trim(),
        first_name: newFirst.trim() || null,
        last_name:  newLast.trim()  || null,
        role: "ADMIN",
      });
      if (res.ok) {
        setMsg(res.message || "Invitation sent.");
        setNewEmail(""); setNewFirst(""); setNewLast("");
        setTab(1);
        load();
      }
    } catch (e) { setErr(e.message || "Failed to invite."); }
    finally { setCreating(false); }
  }

  return (
    <div style={S.wrap}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.title}>Admin Panel</h1>
          <p style={S.subtitle}>Manage system access. Users join by invitation only.</p>
        </div>
        <button style={S.btn} onClick={load} disabled={loading}>{loading ? "Loading…" : "↻ Refresh"}</button>
      </div>

      {msg && <div style={{ ...S.strip, background: "#052e16", borderColor: "#22c55e", color: "#86efac" }}>✅ {msg}</div>}
      {err && <div style={{ ...S.strip, background: "#450a0a", borderColor: "#ef4444", color: "#fca5a5" }}>❌ {err}</div>}

      {/* Tabs with badge count on Access Requests */}
      <div style={S.tabBar}>
        {TABS.map((t, i) => (
          <button key={t} style={{ ...S.tab, ...(tab === i ? S.tabActive : {}) }} onClick={() => setTab(i)}>
            {t}
            {i === 0 && pendingRequests.length > 0 && (
              <span style={S.tabBadge}>{pendingRequests.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab 0: Access Requests ────────────────────────────────────────── */}
      {tab === 0 && (
        <div>
          <p style={S.sectionDesc}>
            Users who have been sent an invitation but have not yet logged in and set their password.
            Once they complete first login, they are automatically removed from this list.
          </p>
          {loading && <div style={S.empty}>Loading…</div>}
          {!loading && pendingRequests.length === 0 && (
            <div style={S.emptyBox}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No pending invitations</div>
              <div style={{ color: "#64748b", fontSize: 13 }}>All invited users have completed their first login.</div>
            </div>
          )}
          {!loading && pendingRequests.length > 0 && (
            <div style={S.cardList}>
              {pendingRequests.map(u => (
                <div key={u.id} style={S.requestCard}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                    </div>
                    <div style={{ color: "#64748b", fontSize: 13, marginTop: 2 }}>{u.email}</div>
                    <div style={{ marginTop: 6 }}>
                      <span style={{ fontSize: 11, color: "#475569" }}>
                        Invited {u.created_at ? formatDate(u.created_at) : "—"}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button style={S.btnDeny} onClick={() => act(revokeUser, u.id)}>
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab 1: Administrators ─────────────────────────────────────────── */}
      {tab === 1 && (
        <div>
          <p style={S.sectionDesc}>
            Only administrators have access to this panel, monitoring, and user management.
            Regular users cannot be promoted here — use Invite User to grant admin access directly.
          </p>
          {loading && <div style={S.empty}>Loading…</div>}
          {!loading && (
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["User", "Status", "Account Setup", "Joined", "Actions"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {admins.map(u => {
                    const isSelf = u.id === currentUserId;
                    return (
                      <tr key={u.id} style={{ ...S.tr, ...(isSelf ? { background: "rgba(99,102,241,0.06)" } : {}) }}>
                        <td style={S.td}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                            {isSelf && <span style={S.youTag}>YOU</span>}
                          </div>
                          <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>{u.email}</div>
                        </td>
                        <td style={S.td}>
                          {u.is_approved
                            ? <Badge label="● Active"    color="#86efac" bg="#052e16" />
                            : <Badge label="● Suspended" color="#fca5a5" bg="#450a0a" />}
                        </td>
                        <td style={S.td}>
                          {u.must_change_password
                            ? <Badge label="Pending first login" color="#f59e0b" bg="#451a03" />
                            : <Badge label="✓ Active user"       color="#22c55e" bg="#052e16" />}
                        </td>
                        <td style={{ ...S.td, color: "#475569", fontSize: 12 }}>
                          {u.created_at ? formatDate(u.created_at) : "—"}
                        </td>
                        <td style={S.td}>
                          {!isSelf && (
                            u.is_approved
                              ? <button style={S.btnSuspend} onClick={() => setSuspendTarget(u)} title="Remove admin login access">Suspend</button>
                              : <button style={S.btnActivate} onClick={() => act(approveUser, u.id)} title="Restore login access">Reactivate</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 2: Invite User ────────────────────────────────────────────── */}
      {tab === 2 && (
        <div style={S.inviteWrap}>
          <div style={S.inviteInfo}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: "#e2e8f0" }}>Invite-only access model</div>
            <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6, margin: "0 0 12px" }}>
              This system does not allow open self-registration.
              Only users you invite here will receive login credentials via email.
            </p>
            <div style={S.roleCards}>
              <div style={S.roleCard}>
                <div style={{ color: "#a78bfa", fontWeight: 700, marginBottom: 4 }}>Admin</div>
                <ul style={S.permList}>
                  <li>✓ User management &amp; invitations</li>
                  <li>✓ System monitoring dashboard</li>
                  <li>✓ Submit &amp; view video analyses</li>
                  <li>✓ Manage blocklist</li>
                  <li>✓ Use Chrome extension</li>
                </ul>
              </div>
            </div>
          </div>

          <form style={S.form} onSubmit={handleInvite}>
            <div style={S.formTitle}>Send Invitation</div>
            <div style={S.formRow}>
              <div style={S.formField}>
                <label style={S.label}>Email <span style={{ color: "#ef4444" }}>*</span></label>
                <input style={S.input} type="email" placeholder="user@example.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} required />
              </div>
            </div>
            <div style={S.formRow}>
              <div style={S.formField}>
                <label style={S.label}>First Name</label>
                <input style={S.input} type="text" placeholder="Optional" value={newFirst} onChange={e => setNewFirst(e.target.value)} maxLength={80} />
              </div>
              <div style={S.formField}>
                <label style={S.label}>Last Name</label>
                <input style={S.input} type="text" placeholder="Optional" value={newLast} onChange={e => setNewLast(e.target.value)} maxLength={80} />
              </div>
            </div>
            <button style={S.btnInvite} type="submit" disabled={creating}>
              {creating ? "Sending…" : "Create Account & Send Credentials"}
            </button>
          </form>
        </div>
      )}

      {/* Suspend confirmation */}
      {suspendTarget && (
        <div style={S.overlay}>
          <div style={S.dialog}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Suspend Admin Account?</div>
            <p style={{ color: "#94a3b8", fontSize: 14, margin: "0 0 20px", lineHeight: 1.5 }}>
              <strong style={{ color: "#e2e8f0" }}>{suspendTarget.email}</strong> will lose all system access immediately.
              Their data is preserved and the account can be reactivated at any time.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={S.cancelBtn} onClick={() => setSuspendTarget(null)}>Cancel</button>
              <button style={S.confirmBtn} onClick={() => act(revokeUser, suspendTarget.id)}>Suspend</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap:        { maxWidth: 980, margin: "0 auto", padding: "32px 24px", fontFamily: "'Inter', sans-serif", color: "#e2e8f0" },
  header:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, gap: 16 },
  title:       { fontSize: 26, fontWeight: 700, margin: 0, color: "#f1f5f9" },
  subtitle:    { margin: "6px 0 0", color: "#94a3b8", fontSize: 14 },
  btn:         { padding: "8px 18px", background: "#1e2330", border: "1px solid #374151", borderRadius: 8, color: "#94a3b8", cursor: "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" },
  strip:       { padding: "10px 16px", borderRadius: 8, border: "1px solid", marginBottom: 16, fontSize: 14 },
  tabBar:      { display: "flex", gap: 4, borderBottom: "1px solid #2d3748", marginBottom: 20 },
  tab:         { padding: "10px 20px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#94a3b8", cursor: "pointer", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 },
  tabActive:   { color: "#60a5fa", borderBottom: "2px solid #60a5fa" },
  tabBadge:    { background: "#ef4444", color: "#fff", borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "1px 6px", lineHeight: "16px" },
  sectionDesc: { color: "#64748b", fontSize: 13, marginBottom: 20, lineHeight: 1.5 },
  empty:       { textAlign: "center", padding: "40px 0", color: "#475569" },
  emptyBox:    { textAlign: "center", padding: "48px 0", color: "#94a3b8" },
  cardList:    { display: "flex", flexDirection: "column", gap: 10 },
  requestCard: { background: "#111827", border: "1px solid #1e3a5f", borderRadius: 12, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" },
  tableWrap:   { overflowX: "auto", borderRadius: 12, border: "1px solid #2d3748" },
  table:       { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th:          { padding: "12px 14px", textAlign: "left", color: "#64748b", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #2d3748", background: "#111827" },
  tr:          { borderBottom: "1px solid #1e2a3a" },
  td:          { padding: "11px 14px", verticalAlign: "middle", color: "#cbd5e1" },
  youTag:      { marginLeft: 6, fontSize: 10, color: "#6366f1", background: "#1e1b4b", padding: "1px 6px", borderRadius: 4, fontWeight: 700 },
  btnApprove:  { padding: "6px 16px", background: "#052e16", border: "1px solid #22c55e", borderRadius: 7, color: "#86efac", cursor: "pointer", fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" },
  btnDeny:     { padding: "6px 16px", background: "transparent", border: "1px solid #374151", borderRadius: 7, color: "#64748b", cursor: "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" },
  btnActivate: { padding: "4px 14px", background: "#052e16", border: "1px solid #22c55e", borderRadius: 6, color: "#86efac", cursor: "pointer", fontWeight: 700, fontSize: 12 },
  btnSuspend:  { padding: "4px 14px", background: "transparent", border: "1px solid #374151", borderRadius: 6, color: "#64748b", cursor: "pointer", fontWeight: 600, fontSize: 12 },
  inviteWrap:  { display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" },
  inviteInfo:  { flex: "0 0 300px", background: "#111827", border: "1px solid #2d3748", borderRadius: 14, padding: "20px" },
  roleCards:   { display: "flex", flexDirection: "column", gap: 12 },
  roleCard:    { background: "#1a2035", borderRadius: 10, padding: "12px 14px" },
  permList:    { margin: "0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "#94a3b8" },
  form:        { flex: 1, minWidth: 300, background: "#1a2035", border: "1px solid #2d3748", borderRadius: 14, padding: "24px" },
  formTitle:   { fontWeight: 700, fontSize: 15, marginBottom: 18, color: "#e2e8f0" },
  formRow:     { display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" },
  formField:   { flex: 1, minWidth: 160 },
  label:       { display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13, color: "#cbd5e1" },
  input:       { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e2e8f0", fontSize: 14, boxSizing: "border-box", fontFamily: "Inter, sans-serif" },
  select:      { width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #374151", background: "#111827", color: "#e2e8f0", fontSize: 14, boxSizing: "border-box", cursor: "pointer" },
  btnInvite:   { marginTop: 8, padding: "11px 24px", background: "linear-gradient(135deg,#3b82f6,#6366f1)", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer" },
  overlay:     { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  dialog:      { background: "#1a2035", border: "1px solid #374151", borderRadius: 14, padding: "28px", maxWidth: 420, width: "90%" },
  cancelBtn:   { padding: "8px 20px", background: "transparent", border: "1px solid #374151", borderRadius: 8, color: "#94a3b8", cursor: "pointer", fontWeight: 600, fontSize: 14 },
  confirmBtn:  { padding: "8px 20px", background: "#450a0a", border: "1px solid #ef4444", borderRadius: 8, color: "#fca5a5", cursor: "pointer", fontWeight: 700, fontSize: 14 },
};
