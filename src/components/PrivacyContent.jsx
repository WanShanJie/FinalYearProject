import React from "react";

export default function PrivacyContent() {
  return (
    <div>
      <p><b>Effective date:</b> {new Date().getFullYear()}-01-01</p>

      <h3>1) What we collect</h3>
      <ul>
        <li><b>Account info:</b> name (optional), email, password hash.</li>
        <li><b>OAuth info:</b> provider + provider user id (if you sign in with Google/X).</li>
        <li><b>Security logs:</b> basic logs for troubleshooting and security.</li>
      </ul>

      <h3>2) How we use data</h3>
      <ul>
        <li>Authenticate users and protect your account.</li>
        <li>Operate core features (dashboard, system access).</li>
        <li>Improve reliability and security.</li>
      </ul>

      <h3>3) Data sharing</h3>
      <p>
        We do not sell your data. OAuth providers (Google/X) may receive data as part of login flow.
      </p>

      <h3>4) Data retention</h3>
      <p>
        Data is retained as needed for academic demonstration and system operation.
      </p>

      <h3>5) Your choices</h3>
      <ul>
        <li>You can request account deletion by contacting the project administrator.</li>
        <li>You can stop using OAuth and use password login.</li>
      </ul>

      <h3>6) Security</h3>
      <p>
        Passwords are stored as hashes (not plaintext). We use standard protections to reduce risk.
      </p>
    </div>
  );
}
