from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from app.jobs.models import JobStage


class JobStatusResponse(BaseModel):
    job_id: str
    stage: JobStage
    error: Optional[str] = None
    is_georeferenced: bool
    outputs: dict[str, str]
    progress: int


class DepthStatsOut(BaseModel):
    min: float
    max: float
    mean: float


class DepthResultResponse(BaseModel):
    job_id: str
    da_v2: DepthStatsOut
    depth_pro: DepthStatsOut
    depth_pro_focallength_px: float
