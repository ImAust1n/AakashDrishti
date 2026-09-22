"""Pipeline orchestration: the actual sequence executed by POST /api/pipeline/run/{job_id}.

Input validation -> Depth Anything V2 -> unload -> Depth Pro -> unload ->
edge-aware fusion -> confidence -> geospatial calibration (if applicable) ->
DSM/rDSM -> persist outputs -> READY.

Runs as a FastAPI background task (see app/api/routes_pipeline.py). Every
stage transition and output is persisted to the JobStore immediately so
GET /api/pipeline/{job_id} always reflects real, current progress. Any
exception marks the job FAILED with the real error message -- the job is
never marked READY after an exception.

Mesh generation (FR-8) converts the real DSM/rDSM plus the user's own
uploaded image into a textured GLB terrain mesh (app/mesh/generate.py). If
mesh generation fails (e.g. an all-NoData DSM), the whole job is marked
FAILED, not READY with a missing mesh -- see the except block below.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from app.calibration.srtm import calibrate_with_srtm
from app.core.config import Settings
from app.core.logging import get_logger
from app.depth.pipeline import run_dual_depth
from app.depth.visualize import save_depth_preview
from app.dsm.generate import depth_to_relative_height, write_height_geotiff
from app.fusion.edge_aware import fuse_depth_maps
from app.geospatial.raster_io import write_float32_geotiff
from app.input.detect import UnsupportedInputError, detect_input, read_rgb_array
from app.jobs.models import JobStage, JobState
from app.jobs.store import JobStore
from app.mesh.generate import generate_terrain_mesh

logger = get_logger(__name__)


def _output_url(job_id: str, filename: str) -> str:
    return f"/api/pipeline/output/{job_id}/{filename}"


def _depth_stats(arr) -> dict:
    import numpy as np

    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return {"min": 0.0, "max": 0.0, "mean": 0.0}
    return {"min": float(finite.min()), "max": float(finite.max()), "mean": float(finite.mean())}


def execute_pipeline(job_id: str, store: JobStore, settings: Settings) -> None:
    logger.info("execute_pipeline: entered for job %s", job_id)
    job: JobState = store.get(job_id)
    job_dir = store.job_dir(job_id)
    started_at = time.time()

    try:
        source_path = Path(job.stored_path)
        if not source_path.exists():
            raise UnsupportedInputError(f"Uploaded source file is missing: {source_path}")

        job.stage = JobStage.VALIDATING
        store.update(job)
        descriptor = detect_input(source_path)
        job.is_georeferenced = descriptor.is_georeferenced
        store.update(job)

        # --- DEPTH: DA V2 then Depth Pro, sequentially, VRAM-scoped per adapter ---
        job.stage = JobStage.DEPTH
        store.update(job)
        dual = run_dual_depth(
            image_path=source_path,
            da_v2_checkpoint=settings.da_v2_checkpoint_path,
            da_v2_encoder=settings.depth_anything_v2_encoder,
            depth_pro_checkpoint=settings.depth_pro_checkpoint_path,
            depth_pro_precision=settings.depth_pro_precision,
            device_preference=settings.device,
        )

        da_v2_path = job_dir / "depth_anything_v2.tif"
        depth_pro_path = job_dir / "depth_pro.tif"
        write_float32_geotiff(dual.da_v2_relative_depth, da_v2_path, descriptor.geo)
        write_float32_geotiff(dual.depth_pro_metric_depth, depth_pro_path, descriptor.geo)
        job.outputs["depth_anything_v2_tif"] = _output_url(job_id, da_v2_path.name)
        job.outputs["depth_pro_tif"] = _output_url(job_id, depth_pro_path.name)
        store.update(job)

        # --- FUSION + CONFIDENCE ---
        job.stage = JobStage.FUSION
        store.update(job)
        fusion_result = fuse_depth_maps(dual.da_v2_relative_depth, dual.depth_pro_metric_depth)

        fused_path = job_dir / "fused_depth.tif"
        confidence_path = job_dir / "confidence.tif"
        write_float32_geotiff(fusion_result.fused_depth, fused_path, descriptor.geo)
        write_float32_geotiff(fusion_result.confidence, confidence_path, descriptor.geo)
        save_depth_preview(fusion_result.fused_depth, job_dir / "fused_depth_preview.png")
        save_depth_preview(fusion_result.confidence, job_dir / "confidence_preview.png", cmap_name="viridis")
        job.outputs.update(
            {
                "fused_depth_tif": _output_url(job_id, fused_path.name),
                "fused_depth_preview_png": _output_url(job_id, "fused_depth_preview.png"),
                "confidence_tif": _output_url(job_id, confidence_path.name),
                "confidence_preview_png": _output_url(job_id, "confidence_preview.png"),
            }
        )
        store.update(job)

        # --- CALIBRATION (georeferenced input only) ---
        job.stage = JobStage.CALIBRATION
        store.update(job)
        relative_height = depth_to_relative_height(fusion_result.fused_depth)
        dsm_height = relative_height
        dsm_is_metric = False
        if descriptor.is_georeferenced and descriptor.geo is not None:
            calibration = calibrate_with_srtm(relative_height, descriptor.geo, settings.srtm_dir_path)
            if calibration.status == "calibrated" and calibration.calibrated_height is not None:
                dsm_height = calibration.calibrated_height
                dsm_is_metric = True
        else:
            calibration = None
        store.update(job)

        # --- DSM / rDSM ---
        job.stage = JobStage.DSM
        store.update(job)
        dsm_path = job_dir / "dsm.tif"
        write_height_geotiff(dsm_height, dsm_path, descriptor.geo)
        save_depth_preview(dsm_height, job_dir / "dsm_preview.png", cmap_name="terrain")
        job.outputs.update(
            {
                "dsm_tif": _output_url(job_id, dsm_path.name),
                "dsm_preview_png": _output_url(job_id, "dsm_preview.png"),
            }
        )
        store.update(job)

        # --- MESH: real terrain mesh from the DSM + the user's own uploaded image ---
        job.stage = JobStage.MESH
        store.update(job)
        rgb_image = read_rgb_array(source_path)
        mesh_result = generate_terrain_mesh(
            dsm_height=dsm_height,
            rgb_image=rgb_image,
            geo=descriptor.geo,
            dsm_is_metric=dsm_is_metric,
        )
        glb_path = job_dir / "terrain.glb"
        glb_path.write_bytes(mesh_result.glb_bytes)
        job.outputs["terrain_glb"] = _output_url(job_id, glb_path.name)
        store.update(job)

        # --- metadata.json: real, inspectable record of what actually ran ---
        metadata = {
            "job_id": job_id,
            "source_filename": job.source_filename,
            "is_georeferenced": descriptor.is_georeferenced,
            "crs": descriptor.geo.crs if descriptor.geo else None,
            "width": descriptor.width,
            "height": descriptor.height,
            "da_v2_encoder": settings.depth_anything_v2_encoder,
            "da_v2_stats": _depth_stats(dual.da_v2_relative_depth),
            "depth_pro_stats": _depth_stats(dual.depth_pro_metric_depth),
            "depth_pro_focallength_px": dual.depth_pro_focallength_px,
            "fusion_method": (
                "Scale-aligned (robust least-squares) + guided-filter edge-aware blend; "
                "see app/fusion/edge_aware.py"
            ),
            "fusion_scale_a": fusion_result.scale_a,
            "fusion_scale_b": fusion_result.scale_b,
            "confidence_available": True,
            "calibration_status": calibration.status if calibration else "not_applicable",
            "calibration_note": (
                calibration.note if calibration else "Input is not georeferenced; DSM output is a relative rDSM."
            ),
            "dsm_is_metric": dsm_is_metric,
            "mesh_status": "ready",
            "mesh_vertex_count": mesh_result.vertex_count,
            "mesh_triangle_count": mesh_result.triangle_count,
            "mesh_source_dsm": "dsm.tif",
            "mesh_source_image": job.source_filename,
            "mesh_grid_rows": mesh_result.grid_rows,
            "mesh_grid_cols": mesh_result.grid_cols,
            "mesh_downsample_factor": mesh_result.downsample_factor,
            "mesh_elevation_min": mesh_result.elevation_min,
            "mesh_elevation_max": mesh_result.elevation_max,
            "mesh_texture_width": mesh_result.texture_width,
            "mesh_texture_height": mesh_result.texture_height,
            "mesh_horizontal_spacing_x": mesh_result.horizontal_spacing_x,
            "mesh_horizontal_spacing_z": mesh_result.horizontal_spacing_z,
            "mesh_spacing_units": mesh_result.spacing_units,
            "mesh_vertical_exaggeration": mesh_result.vertical_exaggeration,
            "started_at": started_at,
            "completed_at": time.time(),
        }
        metadata_path = job_dir / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        job.outputs["metadata_json"] = _output_url(job_id, "metadata.json")
        job.outputs["original"] = _output_url(job_id, source_path.name)

        job.stage = JobStage.READY
        job.error = None
        store.update(job)
        logger.info("Pipeline completed for job %s in %.1fs", job_id, time.time() - started_at)

    except Exception as exc:  # noqa: BLE001 -- any failure here is real and must be reported, not swallowed
        logger.exception("Pipeline failed for job %s", job_id)
        job.stage = JobStage.FAILED
        job.error = str(exc)
        store.update(job)
