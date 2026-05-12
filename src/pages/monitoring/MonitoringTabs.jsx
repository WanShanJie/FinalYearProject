import { NavLink } from "react-router-dom";
import styles from "./MonitoringStyles.module.css";
import layout from "../../components/system/SystemLayout.module.css";

export default function MonitoringTabs({ title, subtitle }) {
  return (
    <div className={styles.headerArea}>
      <div className={styles.titleSection}>
        <h1 className={layout.pageTitle}>{title}</h1>
        <p className={layout.pageSub}>{subtitle}</p>
      </div>
      <div className={styles.tabNav}>
        <NavLink to="/admin/monitoring/infra" className={({isActive}) => isActive ? styles.tabActive : styles.tabLink}>
          Infrastructure
        </NavLink>
        <NavLink to="/admin/monitoring/pipeline" className={({isActive}) => isActive ? styles.tabActive : styles.tabLink}>
          Job Pipeline
        </NavLink>
        <NavLink to="/admin/monitoring/traffic" className={({isActive}) => isActive ? styles.tabActive : styles.tabLink}>
          Traffic & API
        </NavLink>
        <NavLink to="/admin/monitoring/models" className={({isActive}) => isActive ? styles.tabActive : styles.tabLink}>
          AI Forensics
        </NavLink>
      </div>
    </div>
  );
}
