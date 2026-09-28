"""Per-building height from footprint masks + the calibrated DSM/rDSM.

Uses the 90th percentile (not max) of in-footprint height values, per
IMPLEMENTATION.md/research-notes.md guidance that roof-edge DSM noise
(mixed pixels at the roof boundary, guided-filter halo) can spike well
above the true roof height -- p90 is a cheap, real-data-derived way to
reject that tail without fabricating a correction model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class BuildingHeight:
    id: int
    footprint: list[tuple[float, float]]
    area_px: int
    height_value: Optional[float]  # meters if is_metric else relative DSM units
    is_metric: bool
    mean_confidence: Optional[float]


def compute_building_heights(
    footprints: list[list[tuple[float, float]]],
    labels: np.ndarray,
    dsm_height: np.ndarray,
    confidence: Optional[np.ndarray],
    is_metric: bool,
    percentile: float = 90.0,
) -> list[BuildingHeight]:
    """One BuildingHeight per label id in `labels` (1..len(footprints))."""
    results: list[BuildingHeight] = []

    for idx, footprint in enumerate(footprints, start=1):
        mask = labels == idx
        area_px = int(mask.sum())
        if area_px == 0:
            # Footprint polygon exists but the label mask doesn't (shouldn't
            # happen given segment.py always draws the contour it returns a
            # polygon for, but degrade gracefully rather than crash).
            results.append(
                BuildingHeight(
                    id=idx, footprint=footprint, area_px=0, height_value=None, is_metric=is_metric, mean_confidence=None
                )
            )
            continue

        values = dsm_height[mask]
        finite_values = values[np.isfinite(values)]
        height_value = float(np.percentile(finite_values, percentile)) if finite_values.size > 0 else None

        mean_confidence = None
        if confidence is not None:
            conf_values = confidence[mask]
            finite_conf = conf_values[np.isfinite(conf_values)]
            if finite_conf.size > 0:
                mean_confidence = float(finite_conf.mean())

        results.append(
            BuildingHeight(
                id=idx,
                footprint=footprint,
                area_px=area_px,
                height_value=height_value,
                is_metric=is_metric,
                mean_confidence=mean_confidence,
            )
        )

    return results


def scale_buildings_to_reference(
    buildings: list[dict],
    reference_building_id: int,
    reference_height_m: float,
) -> Optional[dict]:
    """Rescale a scene's relative building heights using one user-supplied
    real-world height as an anchor -- a single-point Ground Control Point,
    per the problem statement's "minimal Ground Control Points" calibration
    option (PRD.md), for scenes with no GeoTIFF/SRTM/GCP data at all.

    This is NOT the same as DEM/GCP-verified metric calibration
    (app/calibration/srtm.py) -- it is a linear rescale anchored on exactly
    one caller-supplied fact, so it inherits all of that single measurement's
    error and any segmentation/height-estimation error in the reference
    building itself. Callers (the API layer) must label results from this
    function as "reference-scaled", never as "calibrated" or "metric DSM".

    Returns None if the reference building isn't found or has no usable
    (positive, finite) relative height -- never fabricates a scale.
    """
    reference = next((b for b in buildings if b["id"] == reference_building_id), None)
    if reference is None:
        return None
    ref_value = reference.get("height_m")
    if ref_value is None or not np.isfinite(ref_value) or ref_value <= 0 or reference_height_m <= 0:
        return None

    scale = reference_height_m / ref_value
    scaled = []
    for b in buildings:
        value = b.get("height_m")
        scaled.append(
            {
                **b,
                "height_m": (value * scale) if value is not None and np.isfinite(value) else None,
                "is_metric": False,  # deliberately not True -- see docstring, this is not verified-metric
            }
        )
    return {
        "scale_factor": scale,
        "reference_building_id": reference_building_id,
        "reference_height_m": reference_height_m,
        "buildings": scaled,
    }
