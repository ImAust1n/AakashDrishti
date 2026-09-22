/**
 * Result panel types. Every "available: false" field must be rendered as a
 * clearly-labeled placeholder ("not yet implemented" / "pending"), never as
 * fabricated data. See PRD.md Section 20 / CLAUDE.md Section 7 & 11.
 */

export interface DepthStats {
  min: number;
  max: number;
  mean: number;
}

export interface DepthResult {
  available: boolean;
  daV2Stats: DepthStats | null;
  depthProStats: DepthStats | null;
  depthProFocalLengthPx: number | null;
  previewUrl: string | null;
}

export interface DSMResult {
  available: boolean;
  isMetric: boolean;
  previewUrl: string | null;
  downloadUrl: string | null;
}

export interface ConfidenceResult {
  available: boolean;
  previewUrl: string | null;
}

export interface TerrainMeshResult {
  available: boolean;
  meshUrl: string | null;
  vertexCount: number | null;
  triangleCount: number | null;
  isMetric: boolean;
  spacingUnits: "meters" | "scene-units" | null;
}

export interface ValidationResult {
  available: boolean;
  rmse: number | null;
  mae: number | null;
  correlation: number | null;
  validPixelCount: number | null;
}

export interface ProcessingResult {
  jobId: string;
  /** Object URL of the user's own uploaded file -- never a repo/sample asset. */
  originalImageUrl: string;
  isGeoreferenced: boolean;
  depth: DepthResult;
  dsm: DSMResult;
  confidence: ConfidenceResult;
  terrain: TerrainMeshResult;
  validation: ValidationResult;
}
