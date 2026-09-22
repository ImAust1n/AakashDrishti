# DepthWizard — Product Requirements Document

## 1. Project Overview

**Product:** DepthWizard  
**Subtitle:** Single-View Height Estimation & 3D Flythrough  
**Hackathon:** Smart India Hackathon (SIH) 2026  
**Problem Statement:** 26175 — Department of Space / ISRO  
**Theme:** Disaster Management  
**Category:** Software

DepthWizard is an end-to-end software pipeline that transforms a single-view optical RGB remote-sensing image into an elevation representation and an interactive 3D terrain environment.

The product must support both non-georeferenced and georeferenced imagery:

- **PNG/JPG:** generate a Relative Digital Surface Model (rDSM).
- **GeoTIFF/TIFF with spatial metadata:** generate an Absolute Digital Surface Model (DSM) with metric elevation after calibration using SRTM/DEM or GCPs.

The official problem statement emphasizes that the solution should provide an integrated elevation-estimation module and an interactive visualization platform. The internal architecture specifies Depth Anything V2 + Depth Pro, edge-aware fusion, uncertainty estimation, geospatial calibration, and Three.js visualization.

---

# 2. Problem

Traditional elevation generation commonly relies on stereo imagery, LiDAR, or InSAR. These approaches can be sensor-dependent, expensive, and computationally intensive.

Single-view monocular depth estimation provides a more agile alternative, but:

- pretrained models are largely developed for natural/egocentric imagery,
- remote-sensing imagery has a domain gap,
- monocular models generally produce relative depth,
- relative depth must be mapped to metric elevation for georeferenced use,
- a static elevation raster must be converted into an interactive 3D asset for practical analysis.

DepthWizard addresses these issues through dual-backbone inference, depth fusion, confidence estimation, scale calibration, DSM generation, and 3D reconstruction.

---

# 3. Goals

## Primary Goals

1. Generate a useful elevation representation from a single RGB remote-sensing image.
2. Support both georeferenced and non-georeferenced imagery.
3. Produce an absolute DSM when spatial/reference information allows calibration.
4. Generate an interactive 3D terrain representation.
5. Allow users to inspect height and slope.
6. Support quantitative validation against reference DEM/LiDAR data.
7. Provide a stable standalone application suitable for SIH demonstration.

## Success Criteria

- Competitive RMSE/MAE against reference data.
- Stable behavior across urban, sparse, hilly, and forested terrain.
- Accurate RGB-to-terrain texture projection.
- Smooth first-person 3D navigation.
- Intuitive analysis interface.
- Reliable standalone deployment.
- Complete source code and documentation.

---

# 4. Users

### Primary

- ISRO/SIH evaluators.
- Disaster-management agencies.
- Urban planners.

### Secondary

- Reconnaissance analysts.
- Defense/terrain analysts.
- Researchers working with remote-sensing imagery.

---

# 5. Inputs

## 5.1 Non-Georeferenced

Accepted:

- PNG
- JPG/JPEG

Pipeline:

```text
RGB Image
 → Depth Anything V2
 → Depth Pro
 → Alignment
 → Edge-Aware Fusion
 → Confidence Map
 → Relative Depth / rDSM
 → 3D Reconstruction
```

## 5.2 Georeferenced

Accepted:

- GeoTIFF
- TIFF containing valid coordinate-system/geospatial metadata

Pipeline:

```text
GeoTIFF
 → Metadata/CRS Detection
 → Depth Anything V2
 → Depth Pro
 → Alignment
 → Edge-Aware Fusion
 → Confidence Map
 → SRTM/DEM/GCP Calibration
 → Absolute DSM
 → GeoTIFF Export
 → 3D Reconstruction
```

---

# 6. Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Accept single-view RGB imagery in PNG, JPG, or TIFF/GeoTIFF | MUST |
| FR-2 | Automatically detect georeferenced vs non-georeferenced input | MUST |
| FR-3 | Run Depth Anything V2 and Depth Pro | MUST |
| FR-4 | Fuse depth maps using edge-aware guided fusion | MUST |
| FR-5 | Generate a per-pixel confidence/uncertainty map | SHOULD |
| FR-6 | Calibrate relative depth to absolute elevation using SRTM/DEM or GCPs | MUST |
| FR-7 | Export DSM in a standard geospatial format | MUST |
| FR-8 | Generate a terrain mesh and project RGB texture | MUST |
| FR-9 | Provide first-person 3D flythrough | MUST |
| FR-10 | Provide height and slope measurement tools | SHOULD |
| FR-11 | Compare estimated output with reference LiDAR/DEM data | SHOULD |
| FR-12 | Provide standalone/self-contained deployment | MUST |

---

# 7. Depth Estimation

## Depth Anything V2

Use Depth Anything V2 as the globally consistent relative-depth backbone.

Responsibilities:

- infer scene-level depth structure,
- preserve broad terrain geometry,
- provide a robust relative depth field.

## Depth Pro

Use Depth Pro as the complementary backbone.

Responsibilities:

- provide structural detail,
- sharpen boundaries,
- contribute metric-prior information where useful.

## VRAM Constraint

The development hardware is approximately an RTX 5060-class GPU with 8 GB VRAM.

Do not keep two large backbones loaded simultaneously.

Preferred approach:

```text
Load Depth Anything V2
 → inference
 → save output
 → unload/clear memory

Load Depth Pro
 → inference
 → save output
 → unload/clear memory
```

Use mixed precision and memory cleanup.

---

# 8. Depth Alignment and Fusion

The two depth maps may have different scales/ranges and must be aligned before fusion.

Required conceptual process:

1. Normalize/inspect both depth maps.
2. Resize to a common spatial resolution.
3. Align relative scale where necessary.
4. Compute edge information.
5. Use Depth Pro structural boundaries to guide refinement.
6. Preserve Depth Anything V2 global consistency.
7. Produce fused depth.
8. Generate disagreement/confidence.

Avoid simple unweighted averaging as the primary fusion method.

---

# 9. Confidence / Uncertainty

Generate a per-pixel disagreement map.

Concept:

```text
disagreement = normalized(|depth_A - depth_B|)
confidence = 1 - disagreement
```

The implementation may improve this formulation.

Requirements:

- normalized range,
- numerical stability,
- visual inspection,
- optional export,
- UI layer toggle.

High disagreement should correspond to lower confidence.

---

# 10. Scale Calibration

Absolute calibration is required for georeferenced imagery when reference information is available.

Possible references:

- SRTM 30m DEM,
- another suitable lower-resolution DEM,
- minimal GCPs.

Concept:

```text
Fused Relative Depth
        +
Reference Elevation
        ↓
Spatial Correspondence
        ↓
Scale/Offset Regression
        ↓
Absolute Elevation
        ↓
DSM
```

The calibration implementation must:

- account for CRS,
- account for spatial alignment,
- handle resolution mismatch,
- mask invalid/no-data values,
- preserve terrain structure,
- report calibration limitations.

Do not claim accuracy beyond what the reference data supports.

---

# 11. DSM/rDSM Generation

## Relative Output

For non-georeferenced imagery:

- output relative depth/rDSM,
- no false absolute metric claim,
- use relative values for visualization.

## Absolute Output

For georeferenced imagery:

- generate metric elevation,
- preserve spatial metadata,
- export GeoTIFF,
- preserve CRS and affine transform where appropriate.

---

# 12. 3D Reconstruction

Convert the elevation map into a triangulated terrain mesh.

Requirements:

- height corresponds to DSM/rDSM,
- RGB image is used as terrain texture,
- invalid pixels are handled,
- mesh density is optimized for browser performance,
- spatial correspondence is preserved.

Pipeline:

```text
DSM/Heightmap
 → Height Sampling
 → Vertex Generation
 → Triangulation
 → Texture Coordinates
 → RGB Texture
 → Three.js Terrain
```

---

# 13. Interactive Visualization

Frontend target:

- Next.js
- React
- TypeScript
- Three.js

Viewer requirements:

- first-person navigation,
- terrain inspection,
- camera reset,
- layer controls,
- RGB texture,
- height/elevation visualization,
- confidence visualization,
- reference/error overlay,
- measurement interaction,
- stable rendering.

The visualization component is worth 50% of the stated evaluation criteria, so it must be treated as a first-class feature rather than a secondary demo.

---

# 14. Analysis

## Height

Click a terrain location and display:

- estimated elevation/height,
- pixel/raster location,
- confidence where available.

## Slope

Calculate slope from local terrain gradients.

Do not estimate slope purely from visual appearance.

## Validation

Where reference data exists:

- align grids,
- align CRS,
- resample appropriately,
- mask no-data,
- compare equivalent units.

Report:

```text
RMSE
MAE
Correlation
Valid Pixel Count
```

Also provide an error/difference map where practical.

---

# 15. Evaluation

## DSM Estimation — 50%

Evaluate:

- RMSE,
- MAE,
- correlation,
- stability across urban, sparse, hilly, and forested landscapes.

## Visualization — 50%

Evaluate:

- projection accuracy,
- visual fidelity,
- flythrough navigability,
- interface intuitiveness,
- software stability,
- standalone deployment.

---

# 16. Non-Functional Requirements

### Accuracy

Minimize DSM error while preserving terrain structure.

### Performance

Target inference within a few seconds per image where practical on an 8 GB GPU-class machine.

### Usability

No specialist training should be required for basic navigation and analysis.

### Stability

The complete pipeline must be reliable during a live demo.

### Portability

The target is a standalone web application.

### Resource Efficiency

Use:

- FP16/BF16,
- sequential model inference,
- batch size 1 where appropriate,
- model unloading,
- caching,
- tiling for large images where required.

---

# 17. Technical Stack

| Layer | Technology |
|---|---|
| Depth | Depth Anything V2, Depth Pro |
| ML | Python, PyTorch |
| Image Processing | NumPy, OpenCV |
| Geospatial | rasterio, GDAL |
| Reference DEM | SRTM 30m |
| Calibration | Regression / guided filtering |
| 3D | Three.js |
| Frontend | Next.js, React, TypeScript |
| Deployment | Standalone web application |

---

# 18. Out of Scope

- Training a new foundational monocular depth model from scratch.
- Real-time satellite tasking.
- Live satellite imagery acquisition.
- Mobile-native application for the initial release.

---

# 19. Milestones

### M1 — Elevation Extraction

Depth Anything V2 and Depth Pro produce usable depth maps.

### M2 — Fusion & Calibration

Fusion, confidence mapping, and SRTM/GCP calibration work.

### M3 — Visualization

Mesh generation, texture projection, and Three.js flythrough work.

### M4 — Analysis & Validation

Height, slope, reference comparison, RMSE/MAE/correlation.

### M5 — Packaging

Standalone deployment, documentation, optimization, demo readiness.

---

# 20. Definition of Done

A complete user journey must work:

```text
Upload
 → Detect format/georeferencing
 → Run depth models
 → Fuse depth
 → Show confidence
 → Calibrate if georeferenced
 → Generate DSM/rDSM
 → Export result
 → Build terrain
 → Apply RGB texture
 → Navigate in 3D
 → Measure height
 → Measure slope
 → Compare reference data
 → View metrics
```

No fake depth, fake DSM, fake confidence, or fabricated validation metrics may be used in the final implementation.
