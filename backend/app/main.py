"""FastAPI application entrypoint.

Wires up: upload (FR-1/FR-2), pipeline run/status/output (FR-3 through
FR-8: depth, fusion, confidence, calibration, DSM/rDSM, and terrain mesh
generation all run for real -- see app/pipeline/run.py). First-person
flythrough (FR-9) is a frontend concern (Three.js) and reference
validation (FR-11) remains unimplemented -- see IMPLEMENTATION.md.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes_pipeline import router as pipeline_router
from app.api.routes_project import router as project_router
from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()

settings = get_settings()

app = FastAPI(title="AakashDrishti API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(project_router)
app.include_router(pipeline_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
