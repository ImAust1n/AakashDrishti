/**
 * Pipeline execution/status endpoints, matching the real backend contract
 * (backend/app/api/routes_pipeline.py):
 *   POST /api/pipeline/run/{job_id}
 *   GET  /api/pipeline/{job_id}
 *   GET  /api/pipeline/output/{job_id}/{filename}
 */

import { API_BASE_URL, ApiError, apiFetch } from "./client";
import type { ProcessingStage, ProcessingStatus } from "@/lib/types/processing";

interface JobStatusDto {
  job_id: string;
  stage: ProcessingStage;
  error: string | null;
  is_georeferenced: boolean;
  outputs: Record<string, string>;
  progress: number;
}

function mapStatus(dto: JobStatusDto): ProcessingStatus {
  return {
    jobId: dto.job_id,
    stage: dto.stage,
    error: dto.error,
    outputs: dto.outputs,
    progress: dto.progress,
  };
}

export async function runPipeline(jobId: string): Promise<ProcessingStatus> {
  const dto = await apiFetch<JobStatusDto>(`/api/pipeline/run/${jobId}`, {
    method: "POST",
  });
  return mapStatus(dto);
}

export async function getJobStatus(jobId: string): Promise<ProcessingStatus> {
  const dto = await apiFetch<JobStatusDto>(`/api/pipeline/${jobId}`);
  return mapStatus(dto);
}

/** Resolves a backend-relative output path (e.g. from `outputs.fused_depth_preview_png`) to a full URL. */
export function outputUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/**
 * Shape of outputs/{job_id}/metadata.json, written by
 * backend/app/pipeline/run.py at the end of a successful run. Fetched
 * directly as a static file (it's just another pipeline output), not
 * through a bespoke endpoint.
 */
export interface ResultMetadata {
  job_id: string;
  source_filename: string;
  is_georeferenced: boolean;
  crs: string | null;
  width: number;
  height: number;
  da_v2_encoder: string;
  da_v2_stats: { min: number; max: number; mean: number };
  depth_pro_stats: { min: number; max: number; mean: number };
  depth_pro_focallength_px: number;
  fusion_method: string;
  confidence_available: boolean;
  calibration_status: "calibrated" | "unavailable" | "not_applicable";
  calibration_note: string;
  dsm_is_metric: boolean;
  mesh_status: "pending" | "ready";
  mesh_vertex_count?: number;
  mesh_triangle_count?: number;
  mesh_grid_rows?: number;
  mesh_grid_cols?: number;
  mesh_downsample_factor?: number;
  mesh_elevation_min?: number;
  mesh_elevation_max?: number;
  mesh_texture_width?: number;
  mesh_texture_height?: number;
  mesh_spacing_units?: "meters" | "scene-units";
  mesh_vertical_exaggeration?: number;
}

export async function getResultMetadata(metadataUrl: string): Promise<ResultMetadata> {
  const response = await fetch(outputUrl(metadataUrl));
  if (!response.ok) {
    throw new ApiError(`Could not load result metadata (${response.status})`, response.status);
  }
  return (await response.json()) as ResultMetadata;
}
