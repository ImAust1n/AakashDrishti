"""In-memory job store, persisted to disk as JSON for restart durability.

Deliberately not a database: DepthWizard targets a standalone single-user
demo deployment (FR-12), so a process-local dict backed by JSON files under
OUTPUT_DIR/<job_id>/job.json is sufficient and keeps the deployment simple.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from app.jobs.models import JobState


class JobNotFoundError(KeyError):
    pass


class JobStore:
    def __init__(self, output_dir: Path):
        self._output_dir = output_dir
        self._lock = threading.Lock()
        self._jobs: dict[str, JobState] = {}

    def job_dir(self, job_id: str) -> Path:
        path = self._output_dir / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def create(self, state: JobState) -> JobState:
        with self._lock:
            self._jobs[state.job_id] = state
            self._persist(state)
        return state

    def get(self, job_id: str) -> JobState:
        with self._lock:
            if job_id in self._jobs:
                return self._jobs[job_id]
        loaded = self._load_from_disk(job_id)
        if loaded is None:
            raise JobNotFoundError(job_id)
        with self._lock:
            self._jobs[job_id] = loaded
        return loaded

    def update(self, state: JobState) -> JobState:
        state.touch()
        with self._lock:
            self._jobs[state.job_id] = state
            self._persist(state)
        return state

    def _persist(self, state: JobState) -> None:
        job_dir = self.job_dir(state.job_id)
        (job_dir / "job.json").write_text(state.model_dump_json(indent=2), encoding="utf-8")

    def _load_from_disk(self, job_id: str) -> Optional[JobState]:
        job_file = self._output_dir / job_id / "job.json"
        if not job_file.exists():
            return None
        return JobState.model_validate_json(job_file.read_text(encoding="utf-8"))
