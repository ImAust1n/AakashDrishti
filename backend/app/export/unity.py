"""Unity WebGL scene bundle: heightmap.r16 + texture.jpg + unity_scene.json.

Contract consumed by the Unity viewer (all coordinates in scene metres; x = east, z = north,
origin at the terrain's bottom-left corner):

- heightmap.r16   raw little-endian uint16, row-major, first row = NORTH edge.
                  height_m = min_m + (v / 65535) * (max_m - min_m)
                  (raw bytes on purpose: Texture2D.LoadImage would truncate a 16-bit PNG to 8-bit).
- texture.jpg     the uploaded RGB image, capped at `max_texture_dim`.
- unity_scene.json  sizes, height range, buildings, disaster zones (schema below).

Horizontal scale: GeoTIFF resolution when the input is georeferenced, otherwise an *assumed*
ground sample distance (reported in `horizontal_scale_source`) -- never presented as measured.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np
import rasterio

from app.input.detect import GeoMetadata
from app.mesh.generate import _geo_pixel_spacing_meters

HEIGHTMAP_FILE = "heightmap.r16"
TEXTURE_FILE = "texture.jpg"
SCENE_FILE = "unity_scene.json"
MIN_BUILDING_HEIGHT_M = 0.5


def _heightmap_grid(dsm_height: np.ndarray, max_dim: int) -> np.ndarray:
    """Area-downsample to <= max_dim on the long side; NoData is filled with the minimum."""
    finite = np.isfinite(dsm_height)
    if not finite.any():
        raise ValueError("DSM has no finite pixels; cannot export a heightmap")
    filled = np.where(finite, dsm_height, float(dsm_height[finite].min())).astype(np.float32)
    h, w = filled.shape
    scale = min(1.0, max_dim / max(h, w))
    if scale < 1.0:
        filled = cv2.resize(filled, (max(2, round(w * scale)), max(2, round(h * scale))), interpolation=cv2.INTER_AREA)
    return filled


def export_unity_bundle(
    out_dir: Path,
    job_id: str,
    dsm_height: np.ndarray,
    rgb_image: np.ndarray,
    geo: Optional[GeoMetadata],
    dsm_is_metric: bool,
    buildings: list[dict[str, Any]],
    zones: list[dict[str, Any]],
    assumed_gsd_m: float,
    max_heightmap_dim: int = 512,
    max_texture_dim: int = 2048,
) -> dict[str, Any]:
    """Write the bundle into `out_dir` and return the scene dict (also written as JSON)."""
    grid = _heightmap_grid(dsm_height, max_heightmap_dim)
    rows, cols = grid.shape
    min_m, max_m = float(grid.min()), float(grid.max())
    if max_m - min_m < 1e-3:
        max_m = min_m + 1e-3

    quantised = np.round((grid - min_m) / (max_m - min_m) * 65535.0).astype("<u2")
    (out_dir / HEIGHTMAP_FILE).write_bytes(quantised.tobytes())

    src_h, src_w = dsm_height.shape
    if geo is not None:
        dx, dz = _geo_pixel_spacing_meters(geo)
        scale_source = "geotiff"
    else:
        dx = dz = assumed_gsd_m
        scale_source = "assumed_gsd"
    size_x, size_z = src_w * abs(dx), src_h * abs(dz)

    tex_h, tex_w = rgb_image.shape[:2]
    tex_scale = min(1.0, max_texture_dim / max(tex_h, tex_w))
    texture = rgb_image
    if tex_scale < 1.0:
        texture = cv2.resize(rgb_image, (round(tex_w * tex_scale), round(tex_h * tex_scale)), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(texture, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise RuntimeError("Failed to encode terrain texture as JPEG")
    (out_dir / TEXTURE_FILE).write_bytes(jpg.tobytes())

    def px_to_scene(col: float, row: float) -> list[float]:
        return [round(col / src_w * size_x, 3), round((src_h - row) / src_h * size_z, 3)]

    building_out = []
    for b in buildings:
        height = b.get("height_m")
        footprint = b.get("footprint") or []
        if height is None or height < MIN_BUILDING_HEIGHT_M or len(footprint) < 3:
            continue
        building_out.append(
            {
                "id": b["id"],
                "height_m": round(float(height), 2),
                "footprint": [px_to_scene(x, y) for x, y in footprint],
            }
        )

    to_pixel = ~rasterio.Affine(*geo.transform) if geo is not None else None
    zone_out = []
    for i, z in enumerate(zones, start=1):
        geometry = z.get("geometry") or {}
        if geometry.get("type") != "Polygon" or not geometry.get("coordinates"):
            continue
        ring = geometry["coordinates"][0]
        if to_pixel is not None:  # zones carry map coordinates for georeferenced input
            ring = [to_pixel * (x, y) for x, y in ring]
        zone_out.append(
            {
                "id": i,
                "type": z.get("type"),
                "level": z.get("risk_level"),  # "low" | "medium" | "high" | null
                "polygon": [px_to_scene(x, y) for x, y in ring],
            }
        )

    scene = {
        "job_id": job_id,
        "heightmap": {"file": HEIGHTMAP_FILE, "width": cols, "height": rows, "min_m": min_m, "max_m": max_m},
        "texture": {"file": TEXTURE_FILE},
        "world_size_m": {"x": round(size_x, 3), "z": round(size_z, 3)},
        "is_metric": dsm_is_metric,
        "horizontal_scale_source": scale_source,
        "buildings": building_out,
        "disaster_zones": zone_out,
    }
    (out_dir / SCENE_FILE).write_text(json.dumps(scene, indent=2), encoding="utf-8")
    return scene
