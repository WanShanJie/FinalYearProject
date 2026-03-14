import React from "react";

export default function TermsContent() {
  return (
    <div>
      <p><b>Effective date:</b> {new Date().getFullYear()}-01-01</p>

      <h3>1) Acceptance of Terms</h3>
      <p>
        By using this system, you agree to these Terms and Conditions. If you do not agree, do not use the system.
      </p>

      <h3>2) Account Responsibility</h3>
      <ul>
        <li>You are responsible for maintaining the confidentiality of your account credentials.</li>
        <li>You agree not to misuse the system or attempt unauthorized access.</li>
      </ul>

      <h3>3) Acceptable Use</h3>
      <ul>
        <li>Do not upload illegal content or content you do not have permission to use.</li>
        <li>Do not attempt to disrupt services or overload the system.</li>
      </ul>

      <h3>4) Limitation of Liability</h3>
      <p>
        This system is provided “as is” for academic/FYP purposes. We are not liable for indirect losses.
      </p>

      <h3>5) Changes</h3>
      <p>
        We may update these terms from time to time. Continued use means you accept the updated terms.
      </p>

      <h3>6) Contact</h3>
      <p>
        For questions, contact the project administrator.
      </p>
    </div>
  );
}
