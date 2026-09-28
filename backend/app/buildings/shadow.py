"""Shadow-based cross-check for building heights.

research-notes.md "Shadow-based building height estimation (classical
remote sensing)": BH = shadow_length * tan(sun_elevation_angle). This is a
real, well-known formula, but it is only computable when a sun elevation
angle is actually known -- we never guess one. `sun_elevation_deg` is an
optional argument; if it (or the pixel size) is unavailable, shadow-height
computation is skipped for that run (returns None), not defaulted to a
made-up angle.

Shadow detection is HSV/luminance thresholding (low value, low saturation)
near each footprint -- another classical-CV heuristic, not a trained model,
consistent with the VRAM constraint that rules out a second network.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from app.buildings.height import BuildingHeight
from app.core.logging import get_logger

logger = get_logger(__name__)

DEFAULT_SEARCH_RADIUS_PX = 40
DEFAULT_SHADOW_VALUE_PERCENTILE = 25.0
DEFAULT_SHADOW_SATURATION_MAX = 120.0


@dataclass
class ShadowEstimate:
    building_id: int
    shadow_length_px: Optional[float]
    shadow_estimate_m: Optional[float]
    depth_vs_shadow_delta_m: Optional[float]
    sun_elevation_deg: Optional[float]
    note: str


def get_sun_elevation_from_metadata(path: Path) -> Optional[float]:
    """Best-effort lookup of a sun elevation angle from file metadata.

    There is no universal GeoTIFF/EXIF tag for solar elevation, so this
    opportunistically scans rasterio dataset tags (vendor metadata some
    satellite products embed, e.g. "SUN_ELEVATION") and, for JPEG/TIFF,
    Pillow EXIF tags. Returns None (never a guessed value) if nothing is
    found -- callers must treat that as "unavailable", per CLAUDE.md
    Section 7 ("never fabricate validation metrics or model outputs").
    """
    try:
        import rasterio

        with rasterio.open(path) as dataset:
            tag_sources = [dataset.tags(), dataset.tags(ns="IMAGE_STRUCTURE") or {}]
            for tags in tag_sources:
                for key, value in tags.items():
                    if "SUN" in key.upper() and "ELEV" in key.upper():
                        try:
                            return float(value)
                        except (TypeError, ValueError):
                            continue
    except Exception:  # noqa: BLE001 -- metadata probing is best-effort only
        logger.debug("No sun elevation found via rasterio tags for %s", path, exc_info=True)

    try:
        from PIL import Image, ExifTags

        with Image.open(path) as img:
            exif = img.getexif()
            if exif:
                tag_map = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
                for key in ("SunElevation", "GPSAltitude"):  # opportunistic; rarely present
                    if key in tag_map:
                        try:
                            return float(tag_map[key])
                        except (TypeError, ValueError):
                            continue
    except Exception:  # noqa: BLE001
        logger.debug("No sun elevation found via EXIF for %s", path, exc_info=True)

    return None


def _shadow_mask(rgb_image: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2HSV)
    value = hsv[..., 2].astype(np.float32)
    saturation = hsv[..., 1].astype(np.float32)
    value_threshold = float(np.percentile(value, DEFAULT_SHADOW_VALUE_PERCENTILE))
    return (value <= value_threshold) & (saturation <= DEFAULT_SHADOW_SATURATION_MAX)


def estimate_shadow_heights(
    rgb_image: np.ndarray,
    footprints: list[list[tuple[float, float]]],
    labels: np.ndarray,
    sun_azimuth_deg: Optional[float] = None,
    sun_elevation_deg: Optional[float] = None,
    pixel_size_m: Optional[float] = None,
    building_heights: Optional[list[BuildingHeight]] = None,
    search_radius_px: int = DEFAULT_SEARCH_RADIUS_PX,
) -> list[ShadowEstimate]:
    """One ShadowEstimate per footprint. Height computation is skipped
    (None) whenever sun elevation or pixel size is unavailable."""
    if not footprints:
        return []

    shadow_mask_full = _shadow_mask(rgb_image)
    building_mask = labels > 0
    height_by_id = {bh.id: bh for bh in (building_heights or [])}

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (search_radius_px, search_radius_px))
    results: list[ShadowEstimate] = []

    for idx, footprint in enumerate(footprints, start=1):
        footprint_mask = labels == idx
        if not footprint_mask.any():
            results.append(
                ShadowEstimate(idx, None, None, None, sun_elevation_deg, "Empty footprint mask; no shadow analysis.")
            )
            continue

        dilated = cv2.dilate(footprint_mask.astype(np.uint8), kernel).astype(bool)
        search_ring = dilated & ~building_mask
        shadow_candidate = search_ring & shadow_mask_full

        if not shadow_candidate.any():
            results.append(
                ShadowEstimate(idx, None, None, None, sun_elevation_deg, "No shadow pixels detected adjacent to footprint.")
            )
            continue

        poly = np.asarray(footprint, dtype=np.float32)
        building_centroid = poly.mean(axis=0)  # (x, y)
        shadow_ys, shadow_xs = np.nonzero(shadow_candidate)
        shadow_points = np.stack([shadow_xs, shadow_ys], axis=1).astype(np.float32)
        shadow_centroid = shadow_points.mean(axis=0)

        if sun_azimuth_deg is not None:
            # Compass azimuth (0=N, 90=E) -> image-plane unit vector (x right, y down).
            # Shadows fall opposite the sun, i.e. along azimuth + 180 degrees.
            shadow_az_rad = math.radians(sun_azimuth_deg + 180.0)
            direction = np.array([math.sin(shadow_az_rad), -math.cos(shadow_az_rad)], dtype=np.float32)
        else:
            direction = shadow_centroid - building_centroid
            norm = float(np.linalg.norm(direction))
            if norm < 1e-6:
                results.append(
                    ShadowEstimate(idx, None, None, None, sun_elevation_deg, "Shadow direction indeterminate.")
                )
                continue
            direction = direction / norm

        projections = shadow_points @ direction
        shadow_length_px = float(projections.max() - projections.min())

        shadow_estimate_m: Optional[float] = None
        note = "Shadow length measured; sun elevation or pixel size unavailable so no metric height was computed."
        if sun_elevation_deg is not None and pixel_size_m is not None and sun_elevation_deg > 0:
            shadow_estimate_m = shadow_length_px * pixel_size_m * math.tan(math.radians(sun_elevation_deg))
            note = "shadow_estimate_m = shadow_length_px * pixel_size_m * tan(sun_elevation_deg)."

        depth_vs_shadow_delta_m: Optional[float] = None
        bh = height_by_id.get(idx)
        if (
            shadow_estimate_m is not None
            and bh is not None
            and bh.is_metric
            and bh.height_value is not None
        ):
            depth_vs_shadow_delta_m = float(bh.height_value - shadow_estimate_m)

        results.append(
            ShadowEstimate(
                building_id=idx,
                shadow_length_px=shadow_length_px,
                shadow_estimate_m=shadow_estimate_m,
                depth_vs_shadow_delta_m=depth_vs_shadow_delta_m,
                sun_elevation_deg=sun_elevation_deg,
                note=note,
            )
        )

    return results
