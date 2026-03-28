import { VERDICT_CONFIG } from "../constants/verdictColors";
import { getVerdictFromScore } from "../utils/riskMapping";

export function getDisplayMetrics(backendVerdict, rawScore) {
  const verdict = (backendVerdict || "").toUpperCase();
  const riskScore = Math.round((rawScore ?? 0) * 100);

  let mappedVerdict = verdict;
  if (!mappedVerdict || mappedVerdict === "UNKNOWN" || mappedVerdict === "PROCESSED") {
    mappedVerdict = getVerdictFromScore(riskScore);
  } else if (!VERDICT_CONFIG[mappedVerdict]) {
    mappedVerdict = getVerdictFromScore(riskScore);
  }

  const scoreVerdict = getVerdictFromScore(riskScore);
  let riskLevel = "Medium Risk";
  if (scoreVerdict === "FAKE") riskLevel = "High Risk";
  else if (scoreVerdict === "REAL") riskLevel = "Low Risk";

  if (mappedVerdict === "REAL") {
    riskLevel = riskScore < 30 ? "Low Risk" : "Legitimate";
  }

  const verdictConfig = VERDICT_CONFIG[mappedVerdict] || VERDICT_CONFIG.INCONCLUSIVE;
  const scoreConfig = VERDICT_CONFIG[scoreVerdict] || VERDICT_CONFIG.INCONCLUSIVE;

  return {
    riskScore,
    displayVerdictKey: mappedVerdict,
    displayVerdict: verdictConfig.label,
    riskLevel,
    scoreColor: scoreConfig.color,
    scoreBg: scoreConfig.bg,
    verdictColor: verdictConfig.color,
    verdictBg: verdictConfig.bg
  };
}

export function getPolicyAction(displayVerdictKey) {
  if (displayVerdictKey === "FAKE") {
    return {
      text: "Warning recommended. Block or restrict sharing of this content.",
      color: VERDICT_CONFIG.FAKE.color,
      bg: VERDICT_CONFIG.FAKE.bg
    };
  }

  if (displayVerdictKey === "REAL") {
    return {
      text: "No immediate action required. The content was classified as authentic by the final decision logic.",
      color: VERDICT_CONFIG.REAL.color,
      bg: VERDICT_CONFIG.REAL.bg
    };
  }

  return {
    text: "Review carefully before trusting or sharing. Mixed signals detected.",
    color: VERDICT_CONFIG.SUSPICIOUS.color,
    bg: VERDICT_CONFIG.SUSPICIOUS.bg
  };
}

function asPercent(value, digits = 0) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function asNumber(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(digits);
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function describeQualityFailure(code) {
  const [key, rawValue] = String(code || "").split(":");
  switch (key) {
    case "too_few_sequence_frames":
      return `Only ${rawValue || "too few"} stable face frames were available for decision-making.`;
    case "usable_ratio_too_low":
      return `Too few captured frames were usable after filtering (${rawValue || "low"} usable ratio).`;
    case "avg_blur_too_low":
      return `The usable frames were too blurry for a reliable verdict (blur score ${rawValue || "low"}).`;
    case "avg_brightness_too_low":
      return `The usable frames were too dark for a reliable verdict (brightness ${rawValue || "low"}).`;
    default:
      return titleCase(code);
  }
}

function describeRejectReason(code) {
  const [key, rawValue] = String(code || "").split(":");
  switch (key) {
    case "warmup_skip":
      return "Initial warm-up frames were skipped before analysis began.";
    case "blank_frame":
      return "Blank or black frames were discarded.";
    case "no_face_found":
      return "No face was detected in some frames.";
    case "no_usable_face":
      return "Detected faces in some frames did not meet size, blur, or brightness thresholds.";
    case "duplicate_frame":
      return "Repeated near-identical frames were removed to avoid biasing the sequence.";
    case "decode_failed":
      return "Some captured frames could not be decoded.";
    case "detector_init_failed":
      return "Face detector setup failed for part of the capture.";
    case "no_candidate":
      return "No candidate face matched the tracked subject in part of the sequence.";
    case "geometry_rejected":
      return "Some face candidates were rejected because they did not stay geometrically consistent with the tracked subject.";
    case "iou_too_low":
      return `Face overlap was too inconsistent (${rawValue || "low"} IoU).`;
    case "centre_jump":
      return `Face position shifted too sharply between frames (${rawValue || "large"} jump).`;
    case "area_drop":
      return `Face size changed too abruptly between frames (${rawValue || "large"} area drop).`;
    default:
      return titleCase(code);
  }
}

function summarizeRejectReasons(rejectReasons) {
  const entries = Object.entries(rejectReasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  return entries.map(([reason, count]) => {
    const description = describeRejectReason(reason);
    return count > 1 ? `${description} (${count} frames)` : description;
  });
}

function describeDecisionRule(reasonCode, decision, qualityGate, calibration) {
  const seqFrames = qualityGate.sequence_frames_used ?? 0;
  const riskScore = decision.score != null ? Math.round(Number(decision.score) * 100) : null;
  const rawScore = decision.raw_score != null ? Math.round(Number(decision.raw_score) * 100) : null;
  const qualityBand = decision.quality_band || "unknown";
  const evidenceQuality = calibration.evidence_quality != null ? asPercent(calibration.evidence_quality) : null;

  switch (reasonCode) {
    case "quality_gate_failed":
      return "The quality gate stopped the pipeline before a model verdict was trusted.";
    case "stable_bright_talking_head_override":
      return `The stable bright talking-head override was applied because the sequence was strong, visually stable, and better matched authentic interview-style footage than manipulated content.`;
    case "very_high_raw_fake_score_on_strong_sequence":
      return `The sequence met strong-quality requirements and the raw model score reached ${rawScore || "a very high level"}, so the system escalated to a FAKE verdict.`;
    case "low_fake_score_with_strong_quality":
      return `The sequence met strong-quality requirements (${seqFrames} usable frames, ${qualityBand} quality band) and the model score stayed low at ${riskScore || 0}%, so the result was accepted as REAL.`;
    case "high_score_downgraded_to_suspicious":
      return `The model score was high (${rawScore || riskScore || "high"}), but the evidence was not strong enough for a final FAKE classification, so it was downgraded to SUSPICIOUS.`;
    case "anomaly_detected_on_weak_quality_sequence":
      return `The model detected anomaly signals on a weak-quality sequence, so the system kept the result at SUSPICIOUS instead of making a stronger claim.`;
    case "score_in_uncertain_band":
      return `The model output stayed in the uncertain range with a ${qualityBand} quality band, so the system could not confidently finalize it as REAL or FAKE.`;
    default:
      return evidenceQuality
        ? `The system used the ${titleCase(reasonCode || "default")} rule with evidence quality ${evidenceQuality}.`
        : `The system used the ${titleCase(reasonCode || "default")} rule.`;
  }
}

function addUnique(list, value) {
  if (!value || list.includes(value)) return;
  list.push(value);
}

export function buildReasoning(item, metrics) {
  const decision = item.meta?.decision || {};
  const qgate = item.meta?.quality_gate || {};
  const opencv = item.meta?.opencv || {};
  const stability = opencv.stability || item.meta?.stability || {};
  const altfreezing = item.meta?.altfreezing || {};
  const calibration = altfreezing.calibration || {};
  const reasonCode = decision.reason || altfreezing.error || "";
  const qualityBand = decision.quality_band || (qgate.pass ? "strong" : "weak");
  const usableRatioPct = asPercent(qgate.usable_ratio, 0);
  const blur = asNumber(qgate.avg_blur, 1);
  const brightness = asNumber(qgate.avg_brightness, 1);
  const seqFrames = qgate.sequence_frames_used ?? 0;
  const totalFrames = qgate.frames_total ?? 0;
  const rawScorePct = decision.raw_score != null ? Math.round(Number(decision.raw_score) * 100) : null;
  const evidenceQualityPct = asPercent(calibration.evidence_quality, 0);
  const temporalDiversityPct = asPercent(calibration.temporal_diversity, 0);
  const failReasons = (qgate.fail_reasons || []).map(describeQualityFailure);
  const topRejectReasons = summarizeRejectReasons(qgate.reject_reasons || {});

  let summary = decision.final_explanation || "";
  if (!summary) {
    switch (reasonCode) {
      case "quality_gate_failed":
        summary = failReasons.length > 0
          ? `The system marked this result as ${metrics.displayVerdict} because the captured sequence failed minimum quality checks. ${failReasons.join(" ")}`
          : "The system could not trust this capture enough to produce a confident verdict, so it remained inconclusive.";
        break;
      case "stable_bright_talking_head_override":
        summary = `Although the raw model score was elevated at about ${rawScorePct || metrics.riskScore}%, the final verdict was changed to REAL because the sequence was bright, stable, and consistent with authentic talking-head footage.`;
        break;
      case "very_high_raw_fake_score_on_strong_sequence":
        summary = `This media was classified as FAKE because it produced a very high raw model score of about ${rawScorePct || metrics.riskScore}% on a strong-quality sequence with enough usable face frames for a reliable decision.`;
        break;
      case "low_fake_score_with_strong_quality":
        summary = `This media was classified as REAL because the model score stayed low at ${metrics.riskScore}% and the captured sequence met the system's strong-quality requirements.`;
        break;
      case "high_score_downgraded_to_suspicious":
        summary = `This media was marked SUSPICIOUS because the model saw strong manipulation signals (${rawScorePct || metrics.riskScore}% raw score), but the supporting evidence was not strong enough for a final FAKE verdict.`;
        break;
      case "anomaly_detected_on_weak_quality_sequence":
        summary = `This media was marked SUSPICIOUS because anomaly signals were present, but the capture quality was weak, so the system avoided over-claiming.`;
        break;
      case "score_in_uncertain_band":
        summary = `This media was marked INCONCLUSIVE because the score did not clearly support either authentic or manipulated content under the available sequence quality.`;
        break;
      default:
        if (metrics.displayVerdictKey === "REAL") {
          summary = "Analysis found no significant evidence of digital manipulation, and the available sequence evidence was acceptable for a real-media decision.";
        } else if (metrics.displayVerdictKey === "FAKE") {
          summary = "The AI model detected manipulation patterns strongly enough to support a fake classification.";
        } else if (metrics.displayVerdictKey === "SUSPICIOUS") {
          summary = "The analysis found some manipulation indicators, but not enough evidence for a definitive fake verdict.";
        } else {
          summary = "The analysis returned mixed signals, and the available evidence was not strong enough for a definitive conclusion.";
        }
    }
  }

  let interpretation = "";
  if (reasonCode === "quality_gate_failed") {
    interpretation = `The system reviewed the capture, but there were not enough clear and consistent frames to trust a final verdict.`;
  } else if (reasonCode === "score_in_uncertain_band") {
    interpretation = "The result landed in the middle range, so the system could not confidently call the media real or fake.";
  } else if (metrics.displayVerdictKey === "FAKE") {
    interpretation = "Warning signs appeared often enough across the clip for the system to treat it as likely manipulated.";
  } else if (metrics.displayVerdictKey === "REAL") {
    interpretation = "The clip stayed visually stable and consistent during analysis, so the system accepted it as authentic.";
  } else {
    interpretation = "The system saw some warning signs, but the evidence stayed mixed and was not strong enough for a fake verdict.";
  }

  if (qualityBand === "weak") {
    interpretation += " The available evidence was weaker than ideal.";
  } else if (qualityBand === "strong" && metrics.displayVerdictKey !== "INCONCLUSIVE") {
    interpretation += " The available evidence was strong enough to support the final result.";
  }

  const highlights = [];
  if (metrics.displayVerdictKey === "INCONCLUSIVE") {
    if (confidenceIsLow(decision, calibration)) {
      addUnique(highlights, "The system did not have enough confidence to make a firm decision.");
    }
    if (qualityBand === "weak" || failReasons.length > 0) {
      addUnique(highlights, "The available frames were not strong enough for a reliable conclusion.");
    }
    if (stability.stable === false) {
      addUnique(highlights, "Face tracking was unstable in parts of the clip.");
    }
    if (temporalDiversityPct && Number(temporalDiversityPct.replace("%", "")) < 6) {
      addUnique(highlights, "There was very little variation between frames, which weakened the evidence.");
    }
    if (duplicateFrameCount(qgate) > 0) {
      addUnique(highlights, "Too many repeated frames reduced how much useful evidence the system could use.");
    }
  } else if (metrics.displayVerdictKey === "FAKE") {
    addUnique(highlights, "The system found repeated signs of possible manipulation across the analyzed frames.");
    if (stability.stable === false || highDrift(stability)) {
      addUnique(highlights, "Facial movement or alignment looked inconsistent between frames.");
    }
    if (rawScorePct != null || metrics.riskScore >= 70) {
      addUnique(highlights, `The manipulation score was high at ${rawScorePct || metrics.riskScore}%.`);
    }
    if (qualityBand === "moderate" || qualityBand === "strong") {
      addUnique(highlights, "The evidence quality was strong enough to support a fake verdict.");
    }
  } else if (metrics.displayVerdictKey === "REAL") {
    addUnique(highlights, "The analyzed frames stayed visually consistent throughout the clip.");
    if (stability.stable || !highDrift(stability)) {
      addUnique(highlights, "Face tracking and movement remained stable.");
    }
    addUnique(highlights, `The manipulation score remained low at ${metrics.riskScore}%.`);
    if (qualityBand === "moderate" || qualityBand === "strong") {
      addUnique(highlights, "The system had enough clear evidence to support an authentic result.");
    }
  } else {
    addUnique(highlights, "The system noticed some warning signs, but they were not strong enough to confirm manipulation.");
    if (stability.stable === false || highDrift(stability)) {
      addUnique(highlights, "Some instability was seen in facial tracking or alignment.");
    }
    if (qualityBand === "weak" || failReasons.length > 0) {
      addUnique(highlights, "The evidence quality was weaker than ideal, which limited certainty.");
    }
    if (rawScorePct != null || metrics.riskScore > 0) {
      addUnique(highlights, `The manipulation score reached ${rawScorePct || metrics.riskScore}%, which raised concern but was not decisive.`);
    }
  }

  if (highlights.length === 0) {
    addUnique(highlights, summary);
  }

  const signals = [];
  if (qgate.pass) {
    signals.push(`Quality gate passed with ${seqFrames} usable face frames out of ${totalFrames || seqFrames} captured frames.`);
  } else if (failReasons.length > 0) {
    signals.push(...failReasons);
  }

  if (usableRatioPct) signals.push(`Usable frame ratio: ${usableRatioPct}.`);
  if (blur) signals.push(`Average blur score of usable frames: ${blur}.`);
  if (brightness) signals.push(`Average brightness of usable frames: ${brightness}.`);

  if (stability.stable) {
    signals.push("Face tracking remained stable across the analyzed sequence.");
  } else if (stability.reason && stability.reason !== "ok") {
    signals.push(`Sequence stability warnings: ${stability.reason}.`);
  }

  if (stability.avg_iou != null) {
    signals.push(`Average face overlap consistency: ${Math.round(Number(stability.avg_iou) * 100)}%.`);
  }
  if (stability.max_centre_drift != null) {
    signals.push(`Maximum centre drift across frames: ${Math.round(Number(stability.max_centre_drift) * 100)}%.`);
  }
  if (stability.size_consistency != null) {
    signals.push(`Face size consistency across the sequence: ${Math.round(Number(stability.size_consistency) * 100)}%.`);
  }

  if (altfreezing.high_frame_count != null && Number(altfreezing.high_frame_count) > 0) {
    signals.push(`${altfreezing.high_frame_count} frames showed elevated manipulation signals in the model output.`);
  }

  if (topRejectReasons.length > 0) {
    signals.push(...topRejectReasons);
  }

  if (signals.length === 0) {
    signals.push("No detailed evidence signals were stored for this record.");
  }

  const logic = describeDecisionRule(reasonCode, decision, qgate, calibration);

  return { summary, interpretation, highlights: highlights.slice(0, 3), signals, logic };
}

function confidenceIsLow(decision, calibration) {
  const confidence = String(decision.confidence || calibration.confidence || "").toLowerCase();
  return confidence === "low";
}

function duplicateFrameCount(qgate) {
  return Number(qgate.reject_reasons?.duplicate_frame || 0);
}

function highDrift(stability) {
  return stability.max_centre_drift != null && Number(stability.max_centre_drift) > 0.12;
}
