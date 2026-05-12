import React from "react";
import styles from "./AuthLayout.module.css";

export default function AuthLayout({ title, subtitle, children }) {
  return (
    <div className={styles.root}>
      <div className={styles.grid}>
        <div className={styles.leftPanel}>


          <div className={styles.leftInner}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
            <div className={styles.formSpace}>{children}</div>
          </div>
        </div>

        <div className={styles.rightPanel}>
          <div className={styles.gridOverlay} />

          <div className={styles.squaresWrap}>
            {Array.from({ length: 36 }).map((_, i) => (
              <div
                key={i}
                className={styles.square}
                style={{ opacity: i % 7 === 0 ? 0.45 : 0.15 }}
              />
            ))}
          </div>

          <div className={styles.centerBadgeWrap}>
            <div className={styles.centerBadge}>
                <LogoMark />

              <div className={styles.rightText}>
                <p className={styles.rightTop}>Context-Aware Deepfake Verification System</p>
              </div>
            </div>
          </div>


        </div>
      </div>
    </div>
  );
}


function LogoMark() {
  // Keep your placeholder for now. You can replace with <img /> later.
  return (
    <div>
      <img
        src="src/assets/deepfake_logo.png"
        alt="Deepfake Detector Logo"
        className="w-full h-full object-contain"
      />
    </div>
  );
}
