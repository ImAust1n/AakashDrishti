"""Adapter around the vendored Depth Anything V2 model (model/Depth-Anything-V2).

Produces a *relative* inverse-depth field (larger value = closer to camera).
Not metric. Loaded, run, and unloaded within a single call so the model is
never resident on the GPU longer than necessary.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from app.core.logging import get_logger
from app.depth.device import cuda_scope, resolve_device

logger = get_logger(__name__)

_MODEL_CONFIGS = {
    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
    "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
    "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
    "vitg": {"encoder": "vitg", "features": 384, "out_channels": [1536, 1536, 1536, 1536]},
}


class DepthAnythingV2Unavailable(RuntimeError):
    """Raised when the checkpoint or model source is missing."""


def run_depth_anything_v2(
    image_bgr: np.ndarray,
    checkpoint_path: Path,
    encoder: str = "vitb",
    device_preference: str = "cuda",
    input_size: int = 518,
    flip_tta: bool = False,
) -> np.ndarray | tuple[np.ndarray, np.ndarray]:
    """Run Depth Anything V2 inference on a single BGR image array.

    Args:
        image_bgr: HxWx3 uint8 array in BGR channel order (OpenCV convention).
        checkpoint_path: path to the `depth_anything_v2_<encoder>.pth` file.
        encoder: one of vits/vitb/vitl/vitg; must match the checkpoint.
        device_preference: "cuda" or "cpu".
        input_size: network input resolution (multiple of 14).

        flip_tta: also run on the horizontally flipped image.

    Returns:
        HxW float32 array of the raw model output. For stock weights this is relative
        inverse depth (larger = closer); for the GAMUS fine-tuned checkpoint it is a
        height-above-ground-like field (larger = taller, ground ~0).
        With `flip_tta=True`, returns `(mean_output, abs_flip_disagreement)`.
    """
    if not checkpoint_path.exists():
        raise DepthAnythingV2Unavailable(
            f"Depth Anything V2 checkpoint not found at {checkpoint_path}. "
            "Set DEPTH_ANYTHING_V2_CHECKPOINT in .env to a valid local path."
        )
    if encoder not in _MODEL_CONFIGS:
        raise ValueError(f"Unknown DA V2 encoder '{encoder}', expected one of {list(_MODEL_CONFIGS)}")

    try:
        from depth_anything_v2.dpt import DepthAnythingV2
    except ImportError as exc:
        raise DepthAnythingV2Unavailable(
            "depth_anything_v2 package not importable. Install it with "
            "`pip install -e model/Depth-Anything-V2` from the repo root."
        ) from exc

    device = resolve_device(device_preference)

    with cuda_scope("DepthAnythingV2"):
        model = DepthAnythingV2(**_MODEL_CONFIGS[encoder])
        state_dict = torch.load(checkpoint_path, map_location="cpu")
        model.load_state_dict(state_dict)
        model = model.to(device).eval()
        logger.info("Loaded Depth Anything V2 (%s) from %s", encoder, checkpoint_path)

        with torch.inference_mode():
            depth = model.infer_image(image_bgr, input_size=input_size)
            if flip_tta:
                # Horizontal-flip test-time augmentation: the mean is a slightly better
                # estimate, and |orig - flipped| is a real per-pixel uncertainty signal
                # (used as the confidence map -- see app/fusion/edge_aware.py).
                flipped = model.infer_image(np.ascontiguousarray(image_bgr[:, ::-1]), input_size=input_size)
                flipped = flipped[:, ::-1]
                disagreement = np.abs(depth - flipped).astype(np.float32)
                depth = 0.5 * (depth + flipped)

        del model
    depth = depth.astype(np.float32)
    return (depth, disagreement) if flip_tta else depth
