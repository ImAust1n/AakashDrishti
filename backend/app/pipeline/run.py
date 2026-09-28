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

import numpy as np

from app.buildings.disaster import (
    find_emergency_landing_zones,
    find_flood_risk_zones,
    find_highrise_fire_access_risk,
)
from app.buildings.height import compute_building_heights
from app.buildings.segment import segment_buildings
from app.buildings.shadow import estimate_shadow_heights, get_sun_elevation_from_metadata
from app.calibration.shadow_calibration import ShadowCrossCheckResult, apply_shadow_cross_check
from app.calibration.srtm import calibrate_with_srtm
from app.core.config import Settings
from app.core.logging import get_logger
from app.depth.pipeline import run_dual_depth
from app.depth.visualize import save_depth_preview
from app.dsm.generate import write_height_geotiff
from app.export.unity import export_unity_bundle
from app.fusion.edge_aware import build_height_field
from app.geospatial.raster_io import write_float32_geotiff
from app.input.detect import UnsupportedInputError, detect_input, read_rgb_array
from app.jobs.models import JobStage, JobState
from app.jobs.store import JobStore
from app.mesh.generate import generate_terrain_mesh
from app.validation.metrics import compute_validation_metrics

logger = get_logger(__name__)


def _output_url(job_id: str, filename: str) -> str:
    return f"/api/pipeline/output/{job_id}/{filename}"


def _depth_stats(arr) -> dict:
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
            enable_depth_pro=settings.enable_depth_pro,
        )

        da_v2_path = job_dir / "depth_anything_v2.tif"
        write_float32_geotiff(dual.da_v2_output, da_v2_path, descriptor.geo)
        job.outputs["depth_anything_v2_tif"] = _output_url(job_id, da_v2_path.name)
        if dual.depth_pro_metric_depth is not None:
            depth_pro_path = job_dir / "depth_pro.tif"
            write_float32_geotiff(dual.depth_pro_metric_depth, depth_pro_path, descriptor.geo)
            job.outputs["depth_pro_tif"] = _output_url(job_id, depth_pro_path.name)
        store.update(job)

        # --- HEIGHT FIELD + CONFIDENCE (fine-tuned DA V2 is the height source; see app/fusion/edge_aware.py) ---
        # NOTE: the output key/file "fused_depth" is kept for API compatibility; it now holds the height field.
        job.stage = JobStage.FUSION
        store.update(job)
        fusion_result = build_height_field(
            dual.da_v2_output, dual.da_v2_flip_disagreement, height_scale=settings.da_v2_height_scale
        )

        fused_path = job_dir / "fused_depth.tif"
        confidence_path = job_dir / "confidence.tif"
        write_float32_geotiff(fusion_result.height, fused_path, descriptor.geo)
        write_float32_geotiff(fusion_result.confidence, confidence_path, descriptor.geo)
        save_depth_preview(fusion_result.height, job_dir / "fused_depth_preview.png", cmap_name="terrain")
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
        relative_height = fusion_result.height
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

        # Read the RGB array once here (used by both building segmentation below and the
        # mesh texture further down) so both stages see the exact same source pixels.
        rgb_image = read_rgb_array(source_path)

        # --- BUILDINGS: heuristic classical-CV footprint extraction + p90 height + shadow cross-check ---
        # No new neural network is loaded here (CLAUDE.md Section 5 VRAM budget) -- see
        # app/buildings/segment.py for why this is deliberately classical CV, not a trained model.
        # Wrapped so a failure degrades to an empty building list, never fails the whole job.
        building_heights: list = []
        building_mask = np.zeros(dsm_height.shape, dtype=bool)
        shadow_cross_check = ShadowCrossCheckResult(
            status="insufficient_data",
            note="Building analysis did not run or failed before the shadow cross-check stage.",
            dsm_height=dsm_height,
            dsm_is_metric=dsm_is_metric,
            scale_factor=None,
            median_ratio=None,
            n_buildings_used=0,
        )
        try:
            segmentation = segment_buildings(rgb_image, dsm_height, fusion_result.confidence)
            building_mask = segmentation.mask
            building_heights = compute_building_heights(
                segmentation.footprints,
                segmentation.labels,
                dsm_height,
                fusion_result.confidence,
                dsm_is_metric,
            )

            pixel_size_m = float(np.mean(descriptor.geo.resolution)) if descriptor.geo is not None else None
            sun_elevation_deg = get_sun_elevation_from_metadata(source_path)
            shadow_estimates = estimate_shadow_heights(
                rgb_image,
                segmentation.footprints,
                segmentation.labels,
                sun_elevation_deg=sun_elevation_deg,
                pixel_size_m=pixel_size_m,
                building_heights=building_heights,
            )
            shadow_by_id = {s.building_id: s for s in shadow_estimates}

            # --- Shadow-geometry cross-check: rescale the height field when the shadow-derived
            # heights and the depth-model heights disagree beyond a threshold (see
            # app/calibration/shadow_calibration.py). Never overrides an already DEM/SRTM-verified
            # DSM. `dsm_height`/`dsm_is_metric` are reassigned here so every stage below (buildings
            # payload, disaster zones, validation, mesh, Unity export, metadata) sees the correction.
            shadow_cross_check = apply_shadow_cross_check(dsm_height, dsm_is_metric, building_heights, shadow_estimates)
            dsm_height = shadow_cross_check.dsm_height
            dsm_is_metric = shadow_cross_check.dsm_is_metric
            if shadow_cross_check.status == "applied":
                for bh in building_heights:
                    if bh.height_value is not None:
                        bh.height_value *= shadow_cross_check.scale_factor
                        bh.is_metric = True
                dsm_path_write = job_dir / "dsm.tif"
                write_height_geotiff(dsm_height, dsm_path_write, descriptor.geo)
                save_depth_preview(dsm_height, job_dir / "dsm_preview.png", cmap_name="terrain")

            buildings_payload = {
                "job_id": job_id,
                "count": len(building_heights),
                "buildings": [
                    {
                        "id": bh.id,
                        "footprint": [list(pt) for pt in bh.footprint],
                        "area_px": bh.area_px,
                        "height_m": bh.height_value,
                        "is_metric": bh.is_metric,
                        "confidence": bh.mean_confidence,
                        "shadow_estimate_m": (shadow_by_id[bh.id].shadow_estimate_m if bh.id in shadow_by_id else None),
                        "depth_vs_shadow_delta_m": (
                            (bh.height_value - shadow_by_id[bh.id].shadow_estimate_m)
                            if bh.id in shadow_by_id
                            and shadow_by_id[bh.id].shadow_estimate_m is not None
                            and bh.height_value is not None
                            else None
                        ),
                    }
                    for bh in building_heights
                ],
                "note": segmentation.method_note,
            }
        except Exception as exc:  # noqa: BLE001 -- building analysis is best-effort, must never fail the job
            logger.exception("Building segmentation/height/shadow analysis failed for job %s", job_id)
            building_heights = []
            building_mask = np.zeros(dsm_height.shape, dtype=bool)
            buildings_payload = {
                "job_id": job_id,
                "count": 0,
                "buildings": [],
                "note": f"Building analysis failed and was skipped: {exc}",
            }

        buildings_path = job_dir / "buildings.json"
        buildings_path.write_text(json.dumps(buildings_payload, indent=2), encoding="utf-8")
        job.outputs["buildings_json"] = _output_url(job_id, buildings_path.name)
        store.update(job)

        # --- DISASTER-MANAGEMENT DECISION SUPPORT (heuristic, see app/buildings/disaster.py) ---
        try:
            zone_features = []
            zone_features += find_emergency_landing_zones(dsm_height, building_mask, geo=descriptor.geo)
            zone_features += find_flood_risk_zones(
                dsm_height, geo=descriptor.geo, building_mask=building_mask, dsm_is_metric=dsm_is_metric
            )
            zone_features += find_highrise_fire_access_risk(building_heights, geo=descriptor.geo)

            zones_out = [
                {
                    "type": feat["properties"]["zone_type"],
                    "geometry": feat["geometry"],
                    "risk_level": feat["properties"].get("risk_level"),
                    "notes": feat["properties"].get("note"),
                    "properties": feat["properties"],
                }
                for feat in zone_features
            ]
            zones_payload = {
                "job_id": job_id,
                "count": len(zones_out),
                "zones": zones_out,
                "note": "All zones are heuristic decision support, not certified surveys -- see app/buildings/disaster.py.",
            }
        except Exception as exc:  # noqa: BLE001 -- disaster-zone analysis is best-effort, must never fail the job
            logger.exception("Disaster-zone analysis failed for job %s", job_id)
            zones_out = []
            zones_payload = {
                "job_id": job_id,
                "count": 0,
                "zones": [],
                "note": f"Disaster-zone analysis failed and was skipped: {exc}",
            }

        zones_path = job_dir / "disaster_zones.json"
        zones_path.write_text(json.dumps(zones_payload, indent=2), encoding="utf-8")
        job.outputs["disaster_zones_json"] = _output_url(job_id, zones_path.name)
        store.update(job)

        # --- VALIDATION (FR-11): RMSE/MAE/correlation vs. reference DEM, if any ---
        try:
            validation = compute_validation_metrics(dsm_height, descriptor.geo, settings.srtm_dir_path, dsm_is_metric)
            validation_payload = {
                "job_id": job_id,
                "result": {
                    "status": validation.status,
                    "note": validation.note,
                    "rmse": validation.rmse,
                    "mae": validation.mae,
                    "correlation": validation.correlation,
                    "valid_pixel_count": validation.valid_pixel_count,
                    "reference_source": validation.reference_source,
                },
            }
        except Exception as exc:  # noqa: BLE001 -- validation is best-effort, must never fail the job
            logger.exception("Validation metrics computation failed for job %s", job_id)
            validation_payload = {
                "job_id": job_id,
                "result": {
                    "status": "unavailable",
                    "note": f"Validation failed and was skipped: {exc}",
                    "rmse": None,
                    "mae": None,
                    "correlation": None,
                    "valid_pixel_count": None,
                    "reference_source": None,
                },
            }

        validation_path = job_dir / "validation.json"
        validation_path.write_text(json.dumps(validation_payload, indent=2), encoding="utf-8")
        job.outputs["validation_json"] = _output_url(job_id, validation_path.name)
        store.update(job)

        # --- MESH: real terrain mesh from the DSM + the user's own uploaded image ---
        job.stage = JobStage.MESH
        store.update(job)
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

        # --- UNITY BUNDLE: heightmap.r16 + texture.jpg + unity_scene.json for the Unity WebGL viewer ---
        unity_scene = export_unity_bundle(
            out_dir=job_dir,
            job_id=job_id,
            dsm_height=dsm_height,
            rgb_image=rgb_image,
            geo=descriptor.geo,
            dsm_is_metric=dsm_is_metric,
            buildings=buildings_payload["buildings"],
            zones=zones_out,
            assumed_gsd_m=settings.assumed_gsd_m,
        )
        for key, filename in (
            ("unity_scene_json", "unity_scene.json"),
            ("unity_heightmap_r16", "heightmap.r16"),
            ("unity_texture_jpg", "texture.jpg"),
        ):
            job.outputs[key] = _output_url(job_id, filename)
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
            "da_v2_stats": _depth_stats(dual.da_v2_output),
            "depth_pro_stats": _depth_stats(
                dual.depth_pro_metric_depth if dual.depth_pro_metric_depth is not None else np.zeros(1)
            ),
            "depth_pro_focallength_px": dual.depth_pro_focallength_px or 0.0,
            "depth_pro_enabled": dual.depth_pro_metric_depth is not None,
            "fusion_method": (
                "Height field from the GAMUS fine-tuned DA V2 (flip-TTA mean, ground = 2nd percentile, "
                "empirical metre scale); confidence from flip disagreement; Depth Pro is reference-only. "
                "See app/fusion/edge_aware.py::build_height_field"
            ),
            "height_ground_level_raw": fusion_result.ground_level,
            "height_scale_applied": settings.da_v2_height_scale,
            "unity_horizontal_scale_source": unity_scene["horizontal_scale_source"],
            "unity_world_size_m": unity_scene["world_size_m"],
            "shadow_calibration_status": shadow_cross_check.status,
            "shadow_calibration_note": shadow_cross_check.note,
            "shadow_calibration_scale_factor": shadow_cross_check.scale_factor,
            "shadow_calibration_median_ratio": shadow_cross_check.median_ratio,
            "shadow_calibration_n_buildings": shadow_cross_check.n_buildings_used,
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
            "buildings_count": buildings_payload["count"],
            "disaster_zones_count": zones_payload["count"],
            "validation_status": validation_payload["result"]["status"],
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
