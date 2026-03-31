/**
 * useAnalysisPoller
 *
 * React hook that polls GET /api/analysis/{id}/status every `intervalMs`
 * milliseconds until the analysis reaches a terminal state (DONE or ERROR),
 * then stops automatically.
 *
 * Usage
 * ─────
 *   const { status, progress, stage, verdict, score, error } =
 *     useAnalysisPoller(analysisId, { intervalMs: 3000 });
 *
 * Returns null values for fields that are not yet available
 * (e.g. verdict is null while status === "PROCESSING").
 */

import { useEffect, useRef, useState } from "react";
import { getAnalysisStatus } from "../api/auth";

const TERMINAL_STATES = new Set(["DONE", "ERROR"]);

export function useAnalysisPoller(analysisId, { intervalMs = 3000 } = {}) {
  const [state, setState] = useState({
    status:   null,   // PENDING | PROCESSING | DONE | ERROR
    progress: 0,      // 0-100 (worker stage %)
    stage:    null,   // human-readable stage name from worker
    verdict:  null,   // REAL | FAKE | SUSPICIOUS | INCONCLUSIVE
    score:    null,   // 0.0–1.0
    confidence: null,
    reason:   null,
    error:    null,
  });

  const timerRef      = useRef(null);
  const activeIdRef   = useRef(null);   // track which analysisId we're polling

  useEffect(() => {
    // Nothing to poll
    if (!analysisId) return;

    activeIdRef.current = analysisId;

    // Reset state when the analysisId changes
    setState({
      status: null, progress: 0, stage: null,
      verdict: null, score: null, confidence: null,
      reason: null, error: null,
    });

    let stopped = false;

    async function poll() {
      if (stopped || activeIdRef.current !== analysisId) return;

      try {
        const data = await getAnalysisStatus(analysisId);

        if (stopped || activeIdRef.current !== analysisId) return;

        setState({
          status:     data.status     ?? null,
          progress:   data.progress   ?? 0,
          stage:      data.stage      ?? null,
          verdict:    data.verdict    ?? null,
          score:      data.score      ?? null,
          confidence: data.confidence ?? null,
          reason:     data.reason     ?? null,
          error:      data.error      ?? null,
        });

        // Stop polling once a terminal state is reached
        if (TERMINAL_STATES.has(data.status)) return;

        // Schedule next poll
        timerRef.current = setTimeout(poll, intervalMs);
      } catch (err) {
        if (stopped) return;
        console.error("[useAnalysisPoller] fetch error:", err);
        // Retry after interval even on transient network errors
        timerRef.current = setTimeout(poll, intervalMs);
      }
    }

    poll(); // kick off immediately

    return () => {
      stopped = true;
      clearTimeout(timerRef.current);
    };
  }, [analysisId, intervalMs]);

  return state;
}
