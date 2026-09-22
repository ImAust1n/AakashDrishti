"""Pipeline execution, status, and output-serving endpoints.

Matches the frontend contract in frontend/src/lib/api/pipeline.ts exactly:
  POST /api/pipeline/run/{job_id}
  GET  /api/pipeline/{job_id}

Processing runs as a FastAPI BackgroundTask so the HTTP request returns
immediately with the current job state; the frontend polls GET .../{job_id}
for real progress (IMPLEMENTATION.md Section 10).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse

from app.api.deps import get_job_store
from app.core.config import Settings, get_settings
from app.core.logging import get_logger
from app.jobs.models import JobStage
from app.jobs.store import JobNotFoundError, JobStore
from app.pipeline.run import execute_pipeline
from app.schemas.pipeline import JobStatusResponse

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])
logger = get_logger(__name__)

# Stages that mean "a background run is already in flight" -- starting a
# second run concurrently would load a second copy of the depth models and
# blow past the 8GB VRAM budget (CLAUDE.md Section 5), so it's rejected.
_IN_PROGRESS_STAGES = {
    JobStage.VALIDATING,
    JobStage.DEPTH,
    JobStage.FUSION,
    JobStage.CALIBRATION,
    JobStage.DSM,
    JobStage.MESH,
}

# Approximate, monotonic progress for UI display. Reflects real stage
# transitions the job store actually persisted -- not a fabricated timer.
_STAGE_PROGRESS: dict[JobStage, int] = {
    JobStage.UPLOADED: 0,
    JobStage.VALIDATING: 10,
    JobStage.DEPTH: 35,
    JobStage.FUSION: 55,
    JobStage.CALIBRATION: 65,
    JobStage.DSM: 80,
    JobStage.MESH: 92,
    JobStage.READY: 100,
    JobStage.FAILED: 0,
}


def _to_response(job) -> JobStatusResponse:
    return JobStatusResponse(
        job_id=job.job_id,
        stage=job.stage,
        error=job.error,
        is_georeferenced=job.is_georeferenced,
        outputs=job.outputs,
        progress=_STAGE_PROGRESS.get(job.stage, 0),
    )


@router.post("/run/{job_id}", response_model=JobStatusResponse)
def run_pipeline(
    job_id: str,
    background_tasks: BackgroundTasks,
    store: JobStore = Depends(get_job_store),
    settings: Settings = Depends(get_settings),
) -> JobStatusResponse:
    try:
        job = store.get(job_id)
    except JobNotFoundError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    if job.stage in _IN_PROGRESS_STAGES:
        # Idempotent: a run is already active for this job. Don't start a
        # second one (VRAM safety) -- just return the current state.
        return _to_response(job)

    if job.stage == JobStage.READY:
        return _to_response(job)

    # Fresh start or retry after FAILED.
    job.stage = JobStage.VALIDATING
    job.error = None
    store.update(job)

    background_tasks.add_task(execute_pipeline, job_id, store, settings)
    logger.info("Queued pipeline run for job %s", job_id)

    return _to_response(job)


@router.get("/{job_id}", response_model=JobStatusResponse)
def get_pipeline_status(
    job_id: str,
    store: JobStore = Depends(get_job_store),
) -> JobStatusResponse:
    try:
        job = store.get(job_id)
    except JobNotFoundError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return _to_response(job)


@router.get("/output/{job_id}/{filename}")
def get_pipeline_output(
    job_id: str,
    filename: str,
    store: JobStore = Depends(get_job_store),
) -> FileResponse:
    try:
        store.get(job_id)  # 404s if the job doesn't exist
    except JobNotFoundError:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    job_dir = store.job_dir(job_id)
    # Path-traversal guard: resolve and ensure the file stays inside job_dir.
    candidate = (job_dir / filename).resolve()
    if job_dir.resolve() not in candidate.parents and candidate != job_dir.resolve():
        raise HTTPException(status_code=400, detail="Invalid output filename")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Output '{filename}' not found for job {job_id}")

    return FileResponse(candidate)
