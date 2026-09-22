"""Depth map -> colorized PNG preview, for UI display and quick inspection."""

from __future__ import annotations

from pathlib import Path

import matplotlib
import numpy as np
from PIL import Image


def save_depth_preview(depth: np.ndarray, out_path: Path, cmap_name: str = "Spectral_r") -> None:
    finite = depth[np.isfinite(depth)]
    if finite.size == 0:
        normalized = np.zeros_like(depth)
    else:
        lo, hi = float(finite.min()), float(finite.max())
        if hi <= lo:
            normalized = np.zeros_like(depth)
        else:
            normalized = np.clip((depth - lo) / (hi - lo), 0, 1)

    cmap = matplotlib.colormaps.get_cmap(cmap_name)
    colored = (cmap(normalized)[:, :, :3] * 255).astype(np.uint8)
    Image.fromarray(colored).save(out_path)
