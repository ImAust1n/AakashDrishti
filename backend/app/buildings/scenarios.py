"""Disaster/hazard SCENARIO simulations -- decision-support planning tools,
same heuristic/honesty discipline as `app/buildings/disaster.py` (imported
from there rather than duplicated: `_pixel_spacing`, `BuildingHeight`).

Every function here is explicitly a planning-approximation tool, not a
certified simulation:

- `simulate_flood_level` -- a "bathtub model" (flag DSM pixels at/below a
  given water level as submerged). This is a real, standard, honestly-crude
  technique for rapid flood-extent screening, NOT a hydrological/hydraulic
  model: it accounts for no water flow, absorption, drainage, or
  infiltration, and because the DSM is a *surface* model (it includes
  building roofs, not just bare ground), a building's roof pixels are
  treated as if they were ground elevation too -- see the function
  docstring for the concrete consequence of that limitation.
- `simulate_explosion_impact` -- a real, textbook cube-root scaled-distance
  (Z = R / W^(1/3)) structural-damage-radius approximation, the same
  category of safety-engineering screening tool as ATF/OSHA/NFPA
  quantity-distance tables used for industrial explosion standoff planning:
  which real detected buildings fall within each of three standard
  structural-damage-severity radii of a point. Deliberately computes NO
  weapons-effects, casualty, injury, or lethality figures -- ever.
- `compute_drone_water_drop` -- real, textbook (no-drag) projectile motion
  for a hovering firefighting-drone water release, anchored on one real
  piece of project data: the actual DSM elevation at the fire point.

None of this is weapons-effects, casualty, or hydraulic-engineering
software -- it is illustrative, explicitly-labeled decision support built on
top of AakashDrishti's real height/DSM output.
"""

from __future__ import annotations

import math
from typing import Optional

import cv2
import matplotlib
import numpy as np
from PIL import Image

from app.buildings.disaster import _pixel_spacing  # reuse: see module docstring
from app.buildings.height import BuildingHeight
from app.input.detect import GeoMetadata

GRAVITY_MPS2 = 9.81


def _sanitize_level_for_filename(level: float) -> str:
    """`2.5` -> `2p50`, `-1.0` -> `neg1p00` -- safe for a filesystem path."""
    sign = "neg" if level < 0 else ""
    return f"{sign}{abs(level):.2f}".replace(".", "p")


def _rasterize_footprint(footprint: list, shape: tuple[int, int]) -> np.ndarray:
    """Boolean mask of a building footprint polygon (pixel [x, y] coords, per
    the Building schema convention) rasterized onto a DSM-shaped grid."""
    mask = np.zeros(shape, dtype=np.uint8)
    if not footprint or len(footprint) < 3:
        return mask.astype(bool)
    pts = np.round(np.asarray(footprint, dtype=np.float64)).astype(np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(mask, [pts], 1)
    return mask.astype(bool)


def save_flood_preview(dsm_height: np.ndarray, submerged_mask: np.ndarray, out_path) -> None:
    """Blue-overlay flood-extent preview PNG, following the same
    normalize-then-colormap convention as `app/depth/visualize.py:save_depth_preview`."""
    finite = dsm_height[np.isfinite(dsm_height)]
    if finite.size == 0:
        base = np.zeros((*dsm_height.shape, 3), dtype=np.uint8)
    else:
        lo, hi = float(finite.min()), float(finite.max())
        if hi <= lo:
            normalized = np.zeros_like(dsm_height, dtype=np.float64)
        else:
            normalized = np.clip((dsm_height - lo) / (hi - lo), 0, 1)
        cmap = matplotlib.colormaps.get_cmap("terrain")
        base = (cmap(np.nan_to_num(normalized))[:, :, :3] * 255).astype(np.uint8)

    overlay = base.astype(np.float32).copy()
    blue = np.array([30.0, 90.0, 220.0], dtype=np.float32)
    alpha = 0.55
    overlay[submerged_mask] = (1 - alpha) * base[submerged_mask].astype(np.float32) + alpha * blue
    Image.fromarray(overlay.astype(np.uint8)).save(out_path)


def simulate_flood_level(
    dsm_height: np.ndarray,
    water_level: float,
    buildings: Optional[list[BuildingHeight]] = None,
    geo: Optional[GeoMetadata] = None,
    dsm_is_metric: bool = False,
) -> dict:
    """Bathtub-model flood-extent approximation: flags DSM pixels at or
    below `water_level` as submerged.

    LIMITATION (read before using this for anything beyond rough screening):
    this is NOT a hydrological/hydraulic model -- no water flow, absorption,
    drainage, or infiltration is simulated, and connectivity to an actual
    water source is not checked (an enclosed low-lying courtyard below
    `water_level` will be flagged "submerged" even if it has no path for
    water to reach it). More specific to this pipeline: the DSM is a
    *surface* model, not a bare-earth DEM -- it includes building rooftops.
    This function therefore necessarily treats a low rooftop as if it were
    low ground, and a building's "at least partly submerged" flag is a
    footprint-mean-DSM-value proxy (again treating roof pixels as ground),
    not a real assessment of water reaching the building's base.

    `water_level` is interpreted in meters if `dsm_is_metric`, else in the
    DSM's own relative units (reported back in `unit`).
    """
    finite = np.isfinite(dsm_height)
    total_finite = int(finite.sum())
    if total_finite == 0:
        return {
            "status": "unavailable",
            "note": "DSM has no valid (finite) pixels to simulate against.",
            "water_level": water_level,
            "unit": "meters" if dsm_is_metric else "relative_dsm_units",
            "submerged_pixel_fraction": None,
            "submerged_area_m2": None,
            "affected_building_ids": [],
        }

    submerged = finite & (dsm_height <= water_level)
    submerged_count = int(submerged.sum())
    submerged_fraction = submerged_count / total_finite

    dx, dz, spacing_units = _pixel_spacing(geo)
    submerged_area_m2 = submerged_count * dx * dz if spacing_units == "meters" else None

    affected_building_ids: list[int] = []
    if buildings:
        for b in buildings:
            mask = _rasterize_footprint(b.footprint, dsm_height.shape)
            if not mask.any():
                continue
            values = dsm_height[mask]
            finite_values = values[np.isfinite(values)]
            if finite_values.size == 0:
                continue
            if float(finite_values.mean()) <= water_level:
                affected_building_ids.append(b.id)

    return {
        "status": "simulated",
        "note": (
            "Bathtub-model approximation (DSM pixels at/below the given water level are flagged "
            "submerged) -- NOT a hydrological/hydraulic flood model (no flow, absorption, drainage, or "
            "source-connectivity is simulated). The DSM is a surface model that includes building "
            "roofs, not bare-earth ground, so low rooftops are necessarily treated as low ground; "
            "'affected' buildings use a footprint-mean-DSM-value proxy for the same reason, not a real "
            "assessment of water reaching the building's base. Treat as rapid decision-support "
            "screening only."
        ),
        "water_level": water_level,
        "unit": "meters" if dsm_is_metric else "relative_dsm_units",
        "submerged_pixel_fraction": submerged_fraction,
        "submerged_area_m2": submerged_area_m2,
        "area_note": (
            None
            if submerged_area_m2 is not None
            else "Real-world submerged area requires georeferenced pixel spacing; this image has none, so only the pixel fraction is reported."
        ),
        "affected_building_ids": affected_building_ids,
        "_submerged_mask": submerged,  # internal: consumed by the route to render the preview, stripped before the HTTP response
    }


SCALED_DISTANCE_BANDS = (
    # (severity, Z) -- standard published cube-root scaled-distance (Hopkinson-Cranz)
    # reference points used in safety-engineering quantity-distance planning:
    # Z = R / W^(1/3), R in meters, W in kg TNT-equivalent.
    #   Z=3.0  -> ~severe structural damage threshold
    #   Z=6.0  -> ~moderate damage (window breakage / non-structural) threshold
    #   Z=15.0 -> ~light/cosmetic damage threshold
    ("severe", 3.0),
    ("moderate", 6.0),
    ("light", 15.0),
)


def simulate_explosion_impact(
    buildings: list[BuildingHeight],
    epicenter_px: tuple[float, float],
    yield_kg: float,
    geo: Optional[GeoMetadata],
) -> dict:
    """Cube-root scaled-distance (Z = R / W^(1/3)) structural-damage-radius
    safety-engineering approximation -- the same category of tool as
    ATF/OSHA/NFPA quantity-distance planning tables used for industrial
    explosion standoff planning, NOT a weapons-effects or
    casualty/injury/lethality calculator. Computes three standard
    structural-damage-severity radii (see SCALED_DISTANCE_BANDS) from
    `yield_kg` alone -- these are pure physics and always computable, no
    image calibration needed. Relates each radius to real detected
    buildings by converting to pixel space via `_pixel_spacing(geo)`, which
    (unlike the old hazard-exposure tool this replaces) does NOT refuse when
    `geo is None` -- it falls back to an illustrative 1px~=1m visualization
    (`spacing_units: "pixels"`) rather than making the whole tool
    unavailable on every non-georeferenced image.
    """
    dx, dz, spacing_units = _pixel_spacing(geo)
    mean_spacing = (dx + dz) / 2.0

    valid_buildings = [b for b in buildings if b.footprint]
    if not valid_buildings:
        return {
            "status": "unavailable",
            "note": "No detected buildings with valid footprints are available to assess against this epicenter.",
            "epicenter_px": None,
            "yield_kg": None,
            "spacing_units": None,
            "bands": [],
        }

    epicenter = np.asarray(epicenter_px, dtype=np.float64)
    centroids = {
        b.id: np.mean(np.asarray(b.footprint, dtype=np.float64), axis=0) for b in valid_buildings
    }
    dists_px = {b.id: float(np.linalg.norm(centroids[b.id] - epicenter)) for b in valid_buildings}

    bands = []
    for severity, z in SCALED_DISTANCE_BANDS:
        radius_m = z * (yield_kg ** (1.0 / 3.0))
        radius_px = (radius_m / mean_spacing) if mean_spacing > 0 else 0.0
        # Cumulative-inclusive: a building within "severe" is also listed
        # under "moderate" and "light" (concentric-ring semantics -- the
        # frontend can treat band membership as "at least this severity").
        building_ids = [b.id for b in valid_buildings if dists_px[b.id] <= radius_px]
        bands.append({"severity": severity, "radius_m": radius_m, "building_ids": building_ids})

    note = (
        "Real cube-root scaled-distance (Z = R / W^(1/3)) structural-damage-radius safety-engineering "
        "approximation, the same category of tool as ATF/OSHA/NFPA quantity-distance planning tables "
        "used for industrial explosion standoff planning -- NOT a weapons-effects or "
        "casualty/injury/lethality calculation. Bands represent structural damage severity to "
        "buildings only."
    )
    if spacing_units == "pixels":
        note += (
            " This image/job is not georeferenced, so radii are shown using an illustrative "
            "1px~=1m visualization scale only, not a calibrated real-world distance."
        )

    return {
        "status": "simulated",
        "note": note,
        "epicenter_px": [float(epicenter_px[0]), float(epicenter_px[1])],
        "yield_kg": yield_kg,
        "spacing_units": spacing_units,
        "bands": bands,
    }


def compute_drone_water_drop(
    dsm_height: np.ndarray,
    fire_point_px: tuple[float, float],
    hover_altitude_agl_m: float,
    water_exit_velocity_mps: float,
    geo: Optional[GeoMetadata] = None,
    dsm_is_metric: bool = False,
) -> dict:
    """Firefighting-drone water-drop trajectory: standard no-drag projectile
    motion for a drone hovering directly above the target and releasing
    water HORIZONTALLY (the standard simple case for a hovering water-cannon
    drone; an angled-release variant is a possible future extension, not
    built here). Uses the REAL DSM elevation at `fire_point_px` as the
    target's ground/surface elevation -- only meaningful when `dsm_is_metric`
    (otherwise there is no real "meters" to report a standoff distance in,
    so this returns `status: "unavailable"` rather than a fake pixel-unit
    number).

    fall_time_s = sqrt(2 * hover_altitude_agl_m / g), g = 9.81 m/s^2
    horizontal_reach_m = water_exit_velocity_mps * fall_time_s

    `geo` is accepted for signature symmetry with the other scenario
    functions but is not currently used (fire_point_px is pixel-space and
    dsm_height is already the real elevation grid); reserved for a future
    map-coordinate input variant.
    """
    del geo  # not needed yet -- see docstring

    if not dsm_is_metric:
        return {
            "status": "unavailable",
            "note": (
                "A real standoff/reach distance in meters requires a metrically-calibrated DSM "
                "(SRTM/DEM/GCP calibration). This job's DSM is in relative units, so no real-world "
                "distance is computed -- a pixel-unit number would misleadingly imply a real physical "
                "distance."
            ),
        }

    col = int(round(fire_point_px[0]))
    row = int(round(fire_point_px[1]))
    height, width = dsm_height.shape
    if not (0 <= row < height and 0 <= col < width):
        return {
            "status": "unavailable",
            "note": f"fire_point_px {list(fire_point_px)} is outside the DSM bounds ({width}x{height}).",
        }

    target_elevation_m = float(dsm_height[row, col])
    if not np.isfinite(target_elevation_m):
        return {
            "status": "unavailable",
            "note": "DSM has no valid (finite) elevation at the given fire_point_px (NoData pixel).",
        }

    fall_time_s = math.sqrt(2.0 * hover_altitude_agl_m / GRAVITY_MPS2)
    horizontal_reach_m = water_exit_velocity_mps * fall_time_s
    drone_absolute_altitude_m = target_elevation_m + hover_altitude_agl_m

    return {
        "status": "computed",
        "note": (
            "Standard no-drag projectile-motion estimate for a drone hovering directly above the "
            "target and releasing water horizontally. Assumes flat local terrain between drone and "
            "target and no air resistance -- an angled-release variant is a possible future extension."
        ),
        "fall_time_s": fall_time_s,
        "horizontal_reach_m": horizontal_reach_m,
        "hover_altitude_agl_m": hover_altitude_agl_m,
        "target_elevation_m": target_elevation_m,
        "drone_absolute_altitude_m": drone_absolute_altitude_m,
        "assumptions": {
            "water_exit_velocity_mps": water_exit_velocity_mps,
            "g": GRAVITY_MPS2,
            "caveats": [
                "no air resistance",
                "horizontal release",
                "flat local terrain between drone and target",
            ],
        },
    }
