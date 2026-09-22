"""POST /api/project/upload -- FR-1 / FR-2: accept an image, detect its format
and georeferencing, and create a job for it.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from app.api.deps import get_job_store
from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.input.detect import UnsupportedInputError, detect_input
from app.jobs.models import JobStage, JobState
from app.jobs.store import JobStore
from app.schemas.input import GeoMetadataOut, UploadResponse

router = APIRouter(prefix="/api/project", tags=["project"])
logger = get_logger(__name__)

ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}


@router.post("/upload", response_model=UploadResponse)
async def upload_project(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
    store: JobStore = Depends(get_job_store),
) -> UploadResponse:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Allowed: {sorted(ALLOWED_SUFFIXES)}",
        )

    job_id = uuid.uuid4().hex
    job_dir = store.job_dir(job_id)
    stored_path = job_dir / f"source{suffix}"

    with stored_path.open("wb") as out_file:
        shutil.copyfileobj(file.file, out_file)

    try:
        descriptor = detect_input(stored_path)
    except UnsupportedInputError as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    state = JobState(
        job_id=job_id,
        stage=JobStage.UPLOADED,
        source_filename=file.filename or stored_path.name,
        stored_path=str(stored_path),
        is_georeferenced=descriptor.is_georeferenced,
    )
    store.create(state)

    logger.info(
        "Uploaded job %s: %s (%dx%d, georeferenced=%s)",
        job_id,
        file.filename,
        descriptor.width,
        descriptor.height,
        descriptor.is_georeferenced,
    )

    geo_out = None
    if descriptor.geo is not None:
        geo_out = GeoMetadataOut(
            crs=descriptor.geo.crs,
            transform=descriptor.geo.transform,
            width=descriptor.geo.width,
            height=descriptor.geo.height,
            bounds=descriptor.geo.bounds,
            resolution=descriptor.geo.resolution,
            nodata=descriptor.geo.nodata,
            band_count=descriptor.geo.band_count,
        )

    return UploadResponse(
        job_id=job_id,
        filename=file.filename or stored_path.name,
        width=descriptor.width,
        height=descriptor.height,
        band_count=descriptor.band_count,
        dtype=descriptor.dtype,
        is_georeferenced=descriptor.is_georeferenced,
        geo=geo_out,
    )
