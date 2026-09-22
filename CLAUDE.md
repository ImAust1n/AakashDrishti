# CLAUDE.md — DepthWizard

## Project

**DepthWizard — Single-View Height Estimation & 3D Flythrough**

- SIH 2026
- ISRO / Department of Space
- Problem Statement: **26175**
- Theme: **Disaster Management**
- Category: **Software**

This is the project-level context for Claude Code.

**Read these files before implementing:**
- `PRD.md` → WHAT to build
- `IMPLEMENTATION.md` → HOW to build it
- `CLAUDE.md` → project rules and constraints

---

## 1. Goal

Build a real end-to-end pipeline:

```text
Single RGB Remote-Sensing Image
        ↓
Input / GeoTIFF Detection
        ↓
Depth Anything V2 + Depth Pro
        ↓
Depth Alignment
        ↓
Edge-Aware Fusion
        ↓
Confidence / Uncertainty
        ↓
SRTM / DEM / GCP Calibration
        ↓
DSM / rDSM
        ↓
Terrain Mesh + RGB Texture
        ↓
Three.js 3D Flythrough
        ↓
Height + Slope + Validation
```

### Inputs

**PNG/JPG**
→ relative depth / rDSM → 3D visualization.

**GeoTIFF/TIFF with geospatial metadata**
→ calibrated metric DSM → GeoTIFF + 3D visualization.

The official SIH requirement supports pretrained monocular depth, DEM/GCP scale calibration, 3D terrain reconstruction, first-person navigation, and validation using RMSE/MAE/correlation. The internal DepthWizard architecture specifically uses Depth Anything V2 + Depth Pro.

---

## 2. Core Architecture

### Layer 1 — Depth

- Detect image type.
- Read GeoTIFF metadata.
- Run **Depth Anything V2**.
- Run **Depth Pro**.
- Use sequential inference when GPU memory is limited.

### Layer 2 — Fusion & Calibration

- Align depth maps.
- Use edge-aware/guided fusion.
- Preserve structural boundaries.
- Generate confidence from model disagreement.
- For georeferenced input, calibrate relative depth using:
  - SRTM 30m / suitable DEM, or
  - GCPs.
- Produce absolute DSM.

### Layer 3 — 3D

- Convert heightmap/DSM to terrain mesh.
- Project original RGB image as texture.
- Render using **Three.js**.
- Provide first-person navigation.
- Provide height/slope tools.
- Provide reference/error overlays.

---

## 3. Required Features

| ID | Feature | Priority |
|---|---|---|
| FR-1 | PNG/JPG/TIFF/GeoTIFF input | MUST |
| FR-2 | Georeferenced detection | MUST |
| FR-3 | Depth Anything V2 + Depth Pro | MUST |
| FR-4 | Edge-aware depth fusion | MUST |
| FR-5 | Confidence/uncertainty map | SHOULD |
| FR-6 | SRTM/DEM/GCP calibration | MUST |
| FR-7 | Standard DSM export | MUST |
| FR-8 | Terrain mesh + RGB texture | MUST |
| FR-9 | First-person 3D flythrough | MUST |
| FR-10 | Height/slope measurement | SHOULD |
| FR-11 | LiDAR/DEM comparison | SHOULD |
| FR-12 | Standalone deployment | MUST |

---

## 4. Technical Stack

### ML / Backend

- Python
- PyTorch
- NumPy
- OpenCV
- rasterio
- GDAL

### Models

- Depth Anything V2
- Depth Pro

### Frontend / 3D

- Next.js
- React
- TypeScript
- Three.js

### Reference

- SRTM 30m / suitable DEM
- GCPs
- LiDAR/reference data for validation

---

## 5. Critical Hardware Constraint

Development target: **RTX 5060-class GPU, 8 GB VRAM**.

Never assume unlimited GPU memory.

Use:

```text
Load DA V2
→ inference
→ move/save output to CPU
→ unload model
→ clear CUDA cache

Load Depth Pro
→ inference
→ move/save output to CPU
→ unload model
→ clear CUDA cache
```

Use:

- `torch.inference_mode()`
- FP16/BF16 where supported
- batch size 1 where appropriate
- explicit model cleanup
- tiling for large images if necessary

Do not load two large models simultaneously unless verified safe.

---

## 6. Geospatial Rules

For GeoTIFF:

- preserve CRS,
- preserve affine transform,
- preserve bounds where applicable,
- handle NoData,
- document resampling,
- never silently discard georeferencing.

Calibration must account for:

- CRS,
- spatial alignment,
- resolution mismatch,
- invalid pixels.

Do not claim metric accuracy beyond the quality of the reference data.

---

## 7. Validation

Compare estimated DSM against reference DEM/LiDAR after:

1. CRS alignment.
2. Spatial alignment.
3. Resolution matching.
4. NoData masking.
5. Unit verification.

Calculate:

```text
RMSE
MAE
Correlation
Valid Pixel Count
```

Never fabricate validation metrics or model outputs.

---

## 8. 3D Requirements

Terrain viewer must support:

- first-person navigation,
- camera reset,
- RGB terrain texture,
- elevation visualization,
- confidence visualization,
- reference/error overlays,
- terrain raycasting,
- height measurement,
- slope measurement.

Avoid excessive mesh density; optimize for browser performance.

---

## 9. Engineering Rules

### Before coding

1. Read `CLAUDE.md`, `PRD.md`, and `IMPLEMENTATION.md`.
2. Inspect the existing repository.
3. Identify what already works.
4. Map implementation to FR-1 → FR-12.
5. Make a short plan.
6. Implement incrementally.
7. Run tests/build after each major phase.

### While coding

- Reuse working code.
- Do not rewrite the project unnecessarily.
- Keep ML, geospatial, backend, and frontend logic separated.
- Do not hardcode local paths.
- Use environment variables/configuration.
- Add useful logging and error handling.
- Keep APIs typed/documented.
- Do not create fake ML functionality where real functionality is required.
- Do not silently replace the specified architecture.
- If a dependency/model is unavailable, create a clean adapter/setup path and clearly report the limitation.

---

## 10. Build Priority

```text
1. Input + metadata
2. Depth Anything V2
3. Depth Pro
4. Alignment + fusion
5. Confidence
6. SRTM/GCP calibration
7. DSM/rDSM export
8. Terrain mesh
9. RGB texture
10. Three.js flythrough
11. Height/slope tools
12. Reference validation
13. Optimization + deployment
```

Build the smallest **real** end-to-end pipeline first, then improve accuracy, UX, and performance.

---

## 11. Definition of Done

A complete demo must allow:

```text
Upload RGB image
→ detect format/georeferencing
→ run real depth models
→ fuse depth
→ view confidence
→ calibrate GeoTIFF when reference data exists
→ generate DSM/rDSM
→ export
→ generate terrain
→ apply RGB texture
→ navigate in 3D
→ measure height/slope
→ compare reference data
→ show RMSE/MAE/correlation
```

The final system should be stable enough for a live SIH demonstration.

---

## 12. Requirement Authority

Use this hierarchy:

```text
Official SIH/ISRO PS 26175
        ↓
DepthWizard PRD.md
        ↓
Existing project architecture
        ↓
Engineering decisions
```

Do not describe internal implementation choices as official ISRO requirements.

The official problem statement allows alternatives such as Unity/Babylon.js, but **DepthWizard's intended implementation is Next.js + Three.js + Python/PyTorch with Depth Anything V2 + Depth Pro**.

