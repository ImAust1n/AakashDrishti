from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class GeoMetadataOut(BaseModel):
    crs: str
    transform: tuple[float, float, float, float, float, float]
    width: int
    height: int
    bounds: tuple[float, float, float, float]
    resolution: tuple[float, float]
    nodata: Optional[float]
    band_count: int


class UploadResponse(BaseModel):
    job_id: str
    filename: str
    width: int
    height: int
    band_count: int
    dtype: str
    is_georeferenced: bool
    geo: Optional[GeoMetadataOut] = None
