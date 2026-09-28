"""Application configuration, loaded from environment variables / .env.

Paths are resolved relative to the repository root so the backend can be
started from any working directory.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


def _resolve(path_str: str) -> Path:
    path = Path(path_str)
    if not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    return path


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Depth Anything V2
    # Default points at the GAMUS-fine-tuned checkpoint (measured RMSE 3.94m -> 2.40m improvement over the
    # stock pretrained weights on held-out remote-sensing AGL-height data -- see
    # model/training/runs/da_v2_gamus_full/train_log.jsonl and context/research-notes.md). This .env value
    # is normally set explicitly (see .env.example); this default only applies if unset.
    depth_anything_v2_encoder: str = "vitb"
    depth_anything_v2_checkpoint: str = "./model/depth_anything_v2_vitb_gamus_best.pth"

    # Depth Pro
    depth_pro_checkpoint: str = "./model/ml-depth-pro-main/checkpoints/depth_pro.pt"
    depth_pro_precision: str = "float16"
    # Depth Pro is reference-only (it does not feed the height field); disable to save ~60% runtime.
    enable_depth_pro: bool = True

    # Model-output -> approximate metres. Empirical median slope of true AGL vs the fine-tuned DA V2
    # output over 6 held-out GAMUS test tiles (range 1.8-3.1, one tall-building outlier at 8.4).
    da_v2_height_scale: float = 2.6

    # Horizontal metres-per-pixel assumed for non-georeferenced images in the Unity export
    # (an assumption, reported as "assumed_gsd" in unity_scene.json -- not measured).
    assumed_gsd_m: float = 0.5

    # Device
    device: str = "cuda"

    # Reference elevation data
    srtm_data_dir: str = "./data/reference"

    # Storage
    upload_dir: str = "./data/uploads"
    output_dir: str = "./data/outputs"

    # API
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    cors_origins: str = "http://localhost:3000"

    @property
    def da_v2_checkpoint_path(self) -> Path:
        return _resolve(self.depth_anything_v2_checkpoint)

    @property
    def depth_pro_checkpoint_path(self) -> Path:
        return _resolve(self.depth_pro_checkpoint)

    @property
    def srtm_dir_path(self) -> Path:
        return _resolve(self.srtm_data_dir)

    @property
    def upload_dir_path(self) -> Path:
        return _resolve(self.upload_dir)

    @property
    def output_dir_path(self) -> Path:
        return _resolve(self.output_dir)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_dir_path.mkdir(parents=True, exist_ok=True)
    settings.output_dir_path.mkdir(parents=True, exist_ok=True)
    return settings
