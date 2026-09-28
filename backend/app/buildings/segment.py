"""Heuristic building-footprint extraction from RGB + height/depth data.

This is deliberately classical computer vision (`cv2` contour/morphology
operations), NOT a trained instance-segmentation network -- CLAUDE.md
Section 5's 8GB VRAM budget is already spent on DA V2 + Depth Pro, and
loading a third model (e.g. Mask R-CNN/SAM) resident alongside them is
exactly what that rule forbids. Treat every footprint here as a heuristic
candidate, not a certified detection -- there is no accuracy number backing
these polygons because no labelled dataset was used to produce them.

Method:
  1. "Elevated" mask: pixels whose height is meaningfully above a local
     neighborhood baseline (approximated with a large-window mean via
     `scipy.ndimage.uniform_filter`, which stands in for "local ground
     level" -- a real ground-classification step would need a bare-earth
     DTM, which we don't have).
  2. Morphological close/open to merge fragmented roof pixels and drop
     speckle noise.
  3. External contours on the cleaned mask, filtered by:
       - minimum pixel area (drops noise-scale blobs), and
       - fill ratio = contour_area / min_area_rect_area (buildings tend to
         be rectilinear -> high fill ratio; trees/vegetation canopies are
         irregular -> low fill ratio). This is a cheap, explainable
         discriminator, not a learned classifier.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
from scipy import ndimage

DEFAULT_LOCAL_WINDOW_PX = 51
DEFAULT_MIN_AREA_PX = 150
# Was 0.75 -- verified massively under-detecting on a real dense residential
# scene (DC_03_28_RGB.png, 1024x1024): of 49 border-filtered, correctly-sized
# candidates whose "elevated" blobs visually matched real rooftops in the
# DSM preview (cross-checked by eye against the source photo), the median
# fill_ratio was only 0.61 and fully half fell between 0.40-0.60 -- common
# for L-shaped/multi-wing house footprints, which are NOT close to their own
# rotated bounding-box area even though they're real rectilinear buildings.
# 0.75 kept only 9 of those 49 (an ~82% false-negative rate on real
# buildings). Lowered to 0.45, which keeps 45 of the same 49 -- still well
# above typical tree/vegetation-canopy fill ratios (irregular, star-shaped
# outlines score far lower), just no longer rejecting ordinary complex-shaped
# houses. See context/decisions-log.md for the full diagnostic.
DEFAULT_MIN_FILL_RATIO = 0.45
DEFAULT_APPROX_EPSILON_FRAC = 0.015
# Monocular depth models (DA V2, Depth Pro) have a well-known degraded/less-reliable
# prediction band right at the image border (receptive-field edge effects, no context
# beyond the frame). A footprint whose contour touches that border cannot be
# distinguished, by local statistics alone, from a real elevated structure -- and if it
# IS real, the footprint is cut off/incomplete anyway. Reject both cases rather than
# report an untrustworthy height. Verified against a real photo (Dubai skyline test
# image), iteratively: an initial fixed 2px margin only removed 4 of 18 candidates,
# leaving several ~17-19px from the edge that were still clearly border artifacts (an
# evenly-spaced vertical run of small blobs hugging the left edge) -- the border band is
# resolution-relative, not a fixed pixel count, so `segment_buildings` computes it as 1%
# of the shorter image side by default when `border_margin_px` isn't given explicitly.
# See context/decisions-log.md for the full before/after data.


@dataclass
class BuildingSegmentation:
    mask: np.ndarray  # HxW bool: union of all accepted footprints
    labels: np.ndarray  # HxW int32: 0 = background, 1..N = footprint id
    footprints: list[list[tuple[float, float]]] = field(default_factory=list)
    """Polygon vertices in pixel (x, y) coordinates, index i -> label id i+1."""
    method_note: str = (
        "Heuristic classical-CV segmentation (elevation-above-local-baseline + "
        "morphology + contour rectilinearity filter). Not a trained instance "
        "segmentation model; no accuracy guarantee."
    )


DEFAULT_BASELINE_PERCENTILE = 20.0


def _local_baseline(
    height_map: np.ndarray, window_px: int, percentile: float = DEFAULT_BASELINE_PERCENTILE
) -> np.ndarray:
    """Approximate local "ground level" as a low percentile (default: 20th)
    of each window's valid values, via `scipy.ndimage.percentile_filter`.

    A low percentile, rather than the window mean, is used deliberately: the
    mean is pulled in BOTH directions by nearby outliers (a building raises
    it, a depression lowers it), which would spuriously flag ordinary flat
    ground next to a local low point as "elevated relative to baseline". A
    low percentile stays anchored near the true surrounding ground level
    even when a depression or building sits partway inside the window,
    since only a minority of window pixels need to be at/near ground level
    for it to dominate the low percentile. This is a real geomorphometric
    technique (local minimum/percentile filter for bare-earth
    approximation), not a fabricated shortcut -- but it remains an
    approximation, not a trained ground-classification model.

    Invalid (NoData) pixels are pushed to +inf before filtering so they
    never influence a low percentile unless a window is almost entirely
    invalid, in which case the output baseline is NaN there.

    Known limitation: if a large-scale depression/pit (e.g. a genuine
    terrain basin, not a building) occupies a large fraction of a single
    window, it can pull the low percentile down enough that ordinary flat
    ground at the depression's rim looks "elevated" relative to that
    artificially-lowered baseline, producing a false-positive footprint
    candidate there. This is a real, documented shortcoming of a
    single-window heuristic (there is no bare-earth ground-truth to check
    against) -- `min_fill_ratio` in `segment_buildings` filters out most
    such irregularly-shaped artifacts, but does not guarantee zero false
    positives. `local_window_px` should stay small relative to expected
    building size (not scene-wide terrain features) to limit this.
    """
    valid = np.isfinite(height_map)
    filled = np.where(valid, height_map, np.inf).astype(np.float32)
    baseline = ndimage.percentile_filter(filled, percentile=percentile, size=window_px, mode="nearest")
    baseline = np.where(np.isfinite(baseline), baseline, np.nan)
    return baseline.astype(np.float32)


def segment_buildings(
    rgb_image: np.ndarray,
    height_map: np.ndarray,
    confidence: Optional[np.ndarray] = None,
    local_window_px: int = DEFAULT_LOCAL_WINDOW_PX,
    min_area_px: int = DEFAULT_MIN_AREA_PX,
    min_fill_ratio: float = DEFAULT_MIN_FILL_RATIO,
    elevation_margin: Optional[float] = None,
    border_margin_px: Optional[int] = None,
    max_area_px: Optional[int] = None,
) -> BuildingSegmentation:
    """Extract candidate building footprints.

    `elevation_margin` is the minimum height-above-local-baseline (same units
    as `height_map`) to be considered "elevated". If not given, it defaults
    to 0.5x the robust (median-absolute-deviation based) spread of the
    height field -- a data-driven default, not a fixed physical constant,
    since relative (uncalibrated) DSMs have no fixed meaning for "0.5 m".

    `max_area_px`: rejects a contour LARGER than this -- lowering
    `min_fill_ratio` (see that constant's comment) to stop discarding real,
    non-rectangular single buildings also let through a different failure
    mode: in a dense scene, morphological closing can fuse several adjacent
    buildings (and the street/yard between them) into one sprawling blob
    that's still irregular enough to have a moderate fill_ratio. Verified on
    the same real test image used to tune `min_fill_ratio`: single-building
    candidates topped out at 6190px, then there was a sharp, clean jump to
    11864px+ (up to 119586px -- ~11% of the whole 1024x1024 image, clearly
    several buildings and a road segment fused together) with nothing in
    between -- a real, not arbitrary, gap. Defaults to 1% of the image's
    total pixel count (resolution-relative, same convention as
    `border_margin_px`), which sits cleanly inside that gap.
    """
    if height_map.shape != rgb_image.shape[:2]:
        raise ValueError(
            f"height_map shape {height_map.shape} does not match rgb_image shape {rgb_image.shape[:2]}"
        )

    h, w = height_map.shape
    if max_area_px is None:
        max_area_px = round(0.01 * h * w)
    if border_margin_px is None:
        # Resolution-relative, not a fixed pixel count: verified against a real
        # 4141x2761 photo that a fixed 2px margin was too narrow -- the depth-model
        # border-artifact band left several false-positive footprints ~17-19px from
        # the edge (see context/decisions-log.md). 1% of the shorter side scales
        # sensibly across image sizes without needing per-image tuning.
        border_margin_px = max(4, round(0.01 * min(h, w)))
    finite = np.isfinite(height_map)
    empty = BuildingSegmentation(mask=np.zeros((h, w), dtype=bool), labels=np.zeros((h, w), dtype=np.int32))
    if finite.sum() < min_area_px:
        return empty

    baseline = _local_baseline(height_map, local_window_px)
    residual = height_map - baseline

    if elevation_margin is None:
        finite_residual = residual[finite]
        med = float(np.median(finite_residual))
        mad = float(np.median(np.abs(finite_residual - med)))
        # On a mostly-flat scene (majority of pixels near the same height,
        # e.g. open ground dominating a few buildings) the MAD alone can
        # collapse to ~0, which would flag ordinary floating-point noise in
        # the local-baseline filter as "elevated". Floor the margin at a
        # small fraction of the scene's own finite height range so a
        # near-zero MAD can't produce a near-zero threshold.
        finite_range = float(finite_residual.max() - finite_residual.min()) if finite_residual.size else 0.0
        elevation_margin = max(1.5 * mad, 0.02 * finite_range, 1e-6)

    elevated = finite & (residual > elevation_margin)
    if not elevated.any():
        return empty

    elevated_u8 = (elevated.astype(np.uint8)) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    closed = cv2.morphologyEx(elevated_u8, cv2.MORPH_CLOSE, kernel)
    opened = cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    labels = np.zeros((h, w), dtype=np.int32)
    footprints: list[list[tuple[float, float]]] = []
    label_id = 0

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area_px:
            continue
        if area > max_area_px:
            # Almost certainly several buildings (and/or a street/yard
            # between them) fused into one blob by the morphological close
            # -- see max_area_px's docstring note. A real single building
            # this large would need a proper split (e.g. watershed on the
            # elevated mask), not a size cap silently dropping it; that's a
            # further improvement, not something to fake here.
            continue

        xs = contour[:, 0, 0]
        ys = contour[:, 0, 1]
        touches_border = (
            xs.min() <= border_margin_px
            or ys.min() <= border_margin_px
            or xs.max() >= (w - 1 - border_margin_px)
            or ys.max() >= (h - 1 - border_margin_px)
        )
        if touches_border:
            # See DEFAULT_BORDER_MARGIN_PX docstring note -- border-adjacent depth
            # predictions are unreliable and/or the footprint is cut off.
            continue

        rect = cv2.minAreaRect(contour)
        (rw, rh) = rect[1]
        rect_area = float(rw) * float(rh)
        fill_ratio = area / rect_area if rect_area > 0 else 0.0
        if fill_ratio < min_fill_ratio:
            # Irregular blob (typical of tree canopies) -- reject as "not building-like".
            continue

        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, DEFAULT_APPROX_EPSILON_FRAC * peri, True)
        if len(approx) < 3:
            continue

        label_id += 1
        cv2.drawContours(labels, [contour], -1, label_id, thickness=cv2.FILLED)
        footprints.append([(float(pt[0][0]), float(pt[0][1])) for pt in approx])

    mask = labels > 0
    return BuildingSegmentation(mask=mask, labels=labels, footprints=footprints)
