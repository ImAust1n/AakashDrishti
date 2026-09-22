"""Job state machine for pipeline processing runs.

IMPLEMENTATION.md Section 8:
UPLOADED -> VALIDATING -> DEPTH -> FUSION -> CALIBRATION -> DSM -> MESH -> READY
                                                                          -> FAILED

Only the stages implemented so far are reachable; later stages are added as
FR-4 onward are built.
"""

from __future__ import annotations

import time
import uuid
from enum import StrEnum
from typing import Optional

from pydantic import BaseModel, Field


class JobStage(StrEnum):
    UPLOADED = "UPLOADED"
    VALIDATING = "VALIDATING"
    DEPTH = "DEPTH"
    FUSION = "FUSION"
    CALIBRATION = "CALIBRATION"
    DSM = "DSM"
    MESH = "MESH"
    READY = "READY"
    FAILED = "FAILED"


class JobState(BaseModel):
    job_id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    stage: JobStage = JobStage.UPLOADED
    source_filename: str
    stored_path: str
    is_georeferenced: bool = False
    error: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    outputs: dict[str, str] = Field(default_factory=dict)
    """Relative-to-output-dir file paths keyed by artifact name, e.g.
    "da_v2_depth_npy", "depth_pro_depth_npy", "depth_pro_focallength_px"."""

    def touch(self) -> None:
        self.updated_at = time.time()
