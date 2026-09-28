"""Sequential DA V2 + Depth Pro inference, respecting the 8GB VRAM constraint.

FR-3: run both backbones. Each is loaded, run, moved to CPU/saved, and
unloaded before the next one loads (CLAUDE.md Section 5 / IMPLEMENTATION.md
Section 4) -- see da_v2_adapter/depth_pro_adapter, which each already scope
their own model lifecycle. This module just sequences the two calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.core.logging import get_logger
from app.depth.da_v2_adapter import run_depth_anything_v2
from app.depth.depth_pro_adapter import run_depth_pro

logger = get_logger(__name__)


@dataclass
class DualDepthResult:
    da_v2_output: np.ndarray  # HxW float32, raw DA V2 output (height-like for the GAMUS checkpoint)
    da_v2_flip_disagreement: np.ndarray  # HxW float32, |orig - flipped|; per-pixel uncertainty
    depth_pro_metric_depth: np.ndarray | None  # HxW float32, meters; None when Depth Pro is disabled
    depth_pro_focallength_px: float | None


def run_dual_depth(
    image_path: Path,
    da_v2_checkpoint: Path,
    da_v2_encoder: str,
    depth_pro_checkpoint: Path,
    depth_pro_precision: str,
    device_preference: str = "cuda",
    known_f_px: float | None = None,
    enable_depth_pro: bool = True,
) -> DualDepthResult:
    logger.info("Running Depth Anything V2 on %s", image_path)
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise FileNotFoundError(f"Could not read image for depth inference: {image_path}")

    da_v2_output, da_v2_disagreement = run_depth_anything_v2(
        image_bgr=image_bgr,
        checkpoint_path=da_v2_checkpoint,
        encoder=da_v2_encoder,
        device_preference=device_preference,
        flip_tta=True,
    )

    depth_pro_depth = None
    depth_pro_focal = None
    if enable_depth_pro:
        # Depth Pro is a camera-distance model: on nadir imagery it is anti-correlated with
        # height, so it is kept as a reference output only and never feeds the height field.
        logger.info("Running Depth Pro on %s", image_path)
        depth_pro_result = run_depth_pro(
            image_path=image_path,
            checkpoint_path=depth_pro_checkpoint,
            device_preference=device_preference,
            precision=depth_pro_precision,
            f_px=known_f_px,
        )
        depth_pro_depth = depth_pro_result["depth"]
        depth_pro_focal = depth_pro_result["focallength_px"]

    return DualDepthResult(
        da_v2_output=da_v2_output,
        da_v2_flip_disagreement=da_v2_disagreement,
        depth_pro_metric_depth=depth_pro_depth,
        depth_pro_focallength_px=depth_pro_focal,
    )
