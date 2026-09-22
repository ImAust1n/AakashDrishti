"""Input format detection: PNG/JPG vs. GeoTIFF, and geospatial metadata extraction.

FR-1: accept PNG/JPG/TIFF/GeoTIFF.
FR-2: automatically detect georeferenced vs. non-georeferenced input.

Georeferencing is determined by actually reading the file with rasterio and
checking for a valid CRS + affine transform -- not by file extension. A .tif
with no CRS is treated as non-georeferenced (PNG/JPG-equivalent) input.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError


class UnsupportedInputError(ValueError):
    """Raised when the input file cannot be read as an image or GeoTIFF."""


@dataclass
class GeoMetadata:
    crs: str
    transform: tuple[float, float, float, float, float, float]
    width: int
    height: int
    bounds: tuple[float, float, float, float]  # left, bottom, right, top
    resolution: tuple[float, float]  # pixel size x, y
    nodata: Optional[float]
    band_count: int


@dataclass
class InputDescriptor:
    """Result of inspecting an uploaded image."""

    path: Path
    is_georeferenced: bool
    width: int
    height: int
    band_count: int
    dtype: str
    geo: Optional[GeoMetadata]


def detect_input(path: Path) -> InputDescriptor:
    """Inspect a file and classify it as georeferenced or non-georeferenced.

    Reads the file exactly once via rasterio (which also handles plain
    PNG/JPG through GDAL's image drivers), so behaviour is driven by actual
    file contents rather than the file extension.
    """
    if not path.exists():
        raise UnsupportedInputError(f"File does not exist: {path}")

    try:
        with rasterio.open(path) as dataset:
            width, height = dataset.width, dataset.height
            band_count = dataset.count
            dtype = dataset.dtypes[0] if dataset.dtypes else "uint8"

            has_crs = dataset.crs is not None
            # An identity/undefined transform (rasterio default for non-georeferenced
            # rasters) means there is no real spatial reference even if a CRS object
            # is technically present.
            is_default_transform = dataset.transform.is_identity
            is_georeferenced = has_crs and not is_default_transform

            geo: Optional[GeoMetadata] = None
            if is_georeferenced:
                bounds = dataset.bounds
                geo = GeoMetadata(
                    crs=dataset.crs.to_string(),
                    transform=tuple(dataset.transform)[:6],
                    width=width,
                    height=height,
                    bounds=(bounds.left, bounds.bottom, bounds.right, bounds.top),
                    resolution=(abs(dataset.transform.a), abs(dataset.transform.e)),
                    nodata=dataset.nodata,
                    band_count=band_count,
                )
    except RasterioIOError as exc:
        raise UnsupportedInputError(f"Could not read file as an image or GeoTIFF: {path}") from exc

    return InputDescriptor(
        path=path,
        is_georeferenced=is_georeferenced,
        width=width,
        height=height,
        band_count=band_count,
        dtype=str(dtype),
        geo=geo,
    )


def read_rgb_array(path: Path) -> np.ndarray:
    """Read the first three bands as an HxWx3 uint8 RGB array for model input.

    Handles single-band (grayscale) rasters by replicating to 3 channels, and
    rasters with more than 3 bands (e.g. NIR) by taking the first 3.
    """
    with rasterio.open(path) as dataset:
        band_count = min(dataset.count, 3)
        arr = dataset.read(list(range(1, band_count + 1)))  # (bands, H, W)

    arr = np.transpose(arr, (1, 2, 0))  # H, W, bands

    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)

    if arr.dtype != np.uint8:
        arr = _to_uint8(arr)

    return arr


def _to_uint8(arr: np.ndarray) -> np.ndarray:
    """Percentile-stretch an arbitrary-range raster band stack into uint8."""
    out = np.empty(arr.shape, dtype=np.uint8)
    for band in range(arr.shape[-1]):
        channel = arr[..., band].astype(np.float64)
        finite = channel[np.isfinite(channel)]
        if finite.size == 0:
            out[..., band] = 0
            continue
        lo, hi = np.percentile(finite, [1, 99])
        if hi <= lo:
            lo, hi = finite.min(), finite.max()
        if hi <= lo:
            out[..., band] = 0
            continue
        stretched = np.clip((channel - lo) / (hi - lo), 0, 1) * 255
        out[..., band] = stretched.astype(np.uint8)
    return out
