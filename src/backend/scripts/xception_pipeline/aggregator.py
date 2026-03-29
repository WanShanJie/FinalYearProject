from __future__ import annotations

from statistics import mean, median
from typing import Dict, Iterable, List


def aggregate_scores(scores: Iterable[float], method: str = "mean") -> float:
    score_list = [float(score) for score in scores]
    if not score_list:
        raise ValueError("Cannot aggregate an empty score list.")

    method_name = str(method or "mean").strip().lower()
    if method_name == "mean":
        return float(mean(score_list))
    if method_name == "median":
        return float(median(score_list))
    raise ValueError(f"Unsupported aggregation method: {method}")


def classify_score(score: float, threshold: float = 0.5) -> str:
    return "fake" if float(score) >= float(threshold) else "real"


def summarize_video_result(
    per_frame_scores: List[Dict[str, float]],
    aggregation: str = "mean",
    threshold: float = 0.5,
) -> Dict[str, object]:
    scores = [float(item["fake_prob"]) for item in per_frame_scores]
    final_score = aggregate_scores(scores, method=aggregation)
    prediction = classify_score(final_score, threshold=threshold)
    return {
        "per_frame_scores": per_frame_scores,
        "final_score": final_score,
        "prediction": prediction,
        "aggregation": aggregation,
        "threshold": float(threshold),
    }
