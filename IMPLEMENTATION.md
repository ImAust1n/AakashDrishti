# IMPLEMENTATION.md — DepthWizard

Read `CLAUDE.md` and `PRD.md` first. Build **real functionality**, not UI mocks or fabricated ML results.

## 1. Build Order

```text
Audit repo
→ Input/GeoTIFF detection
→ Depth Anything V2
→ Depth Pro
→ Alignment + edge-aware fusion
→ Confidence
→ SRTM/DEM/GCP calibration
→ DSM/rDSM export
→ Terrain mesh + RGB texture
→ Three.js flythrough
→ Height/slope
→ Reference validation
→ Optimization/deployment
```

After each major phase: **build/test → fix → continue**.

## 2. Architecture

```text
Next.js / React / TypeScript / Three.js
                 ↕ API
        Python / PyTorch backend
        ├─ depth
        ├─ fusion
        ├─ calibration
        ├─ geospatial
        ├─ reconstruction
        └─ validation
```

Inspect and reuse the existing repository before creating new architecture.

## 3. Input

Support:

- PNG/JPG → relative depth/rDSM.
- TIFF/GeoTIFF → detect actual CRS/transform; calibrate to metric DSM when reference data exists.

For GeoTIFF preserve CRS, transform, bounds, resolution and NoData. Never modify the original input.

## 4. Depth

Create model adapters for:

- Depth Anything V2
- Depth Pro

Pipeline:

```text
Image → DA V2 → save CPU result/unload
      → Depth Pro → save CPU result/unload
```

Use `torch.inference_mode()`, FP16/BF16 where supported, batch size 1 where appropriate, and CUDA cleanup.

**Hard constraint: ~8 GB VRAM. Do not keep two large models loaded simultaneously.**

## 5. Fusion + Confidence

Before fusion:

```text
resize → normalize → mask invalid → align scale
```

Use Depth Pro structural edges to guide edge-aware/guided refinement of the globally consistent DA V2 field. Avoid plain unweighted averaging.

Baseline confidence:

```python
difference = abs(depth_a - depth_b)
confidence = 1 - normalize(difference)
```

Keep it stable, normalized, inspectable and exportable.

## 6. Calibration

For georeferenced imagery:

```text
Fused depth
→ CRS/spatial alignment
→ SRTM/DEM or GCP correspondence
→ scale + offset regression
→ absolute elevation
→ DSM GeoTIFF
```

Handle CRS, resolution mismatch and NoData. Never claim accuracy beyond the reference data.

## 7. Outputs

```text
PNG/JPG:
depth + confidence + rDSM + terrain

GeoTIFF:
depth + confidence + calibrated DSM GeoTIFF + terrain
```

## 8. Processing API

Use jobs for long inference:

```text
UPLOADED → VALIDATING → DEPTH → FUSION
→ CALIBRATION → DSM → MESH → READY
                         ↘ FAILED
```

Suggested endpoints:

```text
POST /api/project/upload
POST /api/pipeline/run
GET  /api/pipeline/{id}
GET  /api/results/{id}
GET  /api/results/{id}/depth
GET  /api/results/{id}/dsm
GET  /api/results/{id}/confidence
GET  /api/results/{id}/mesh
POST /api/measure/height
POST /api/measure/slope
POST /api/validate
```

Keep filesystem paths internal.

## 9. 3D

```text
DSM/heightmap
→ optional downsample
→ vertices + triangles + UVs
→ RGB texture
→ Three.js terrain
```

Viewer must support:

- first-person navigation,
- reset,
- RGB/elevation/confidence/reference/error layers,
- raycast height measurement,
- slope measurement.

Keep mesh browser-friendly.

## 10. Validation

Before comparing reference data:

```text
CRS align → spatial align → resolution match → NoData mask
```

Calculate:

```text
RMSE
MAE
Correlation
Valid pixel count
```

Provide an error map where practical. Never fabricate metrics.

## 11. Testing

Test:

- input/GeoTIFF metadata,
- depth alignment/fusion/confidence,
- CRS transformations,
- RMSE/MAE/correlation,
- slope,
- PNG → rDSM → mesh,
- GeoTIFF → calibration → DSM → mesh,
- frontend upload/progress/results/measurements/errors.

## 12. Environment

Use `.env.example` for model paths, SRTM/reference data, output directory, backend URL and device.

Never commit secrets, model weights or local absolute paths.

If weights are unavailable, provide a clear setup path; do not fake inference.

## 13. Development Rules

- Inspect existing code first.
- Reuse working components.
- Keep ML/geospatial/backend/frontend logic separated.
- Use typed APIs.
- Add logging and actionable errors.
- Do not silently replace the specified architecture.
- Handle CUDA OOM and missing reference data gracefully.
- Add tiling only after the basic pipeline works.
- Prefer focused Git commits.

## 14. Final Target

```text
RGB
→ DA V2 + Depth Pro
→ alignment/fusion
→ confidence
→ calibration when possible
→ DSM/rDSM
→ mesh + RGB texture
→ Three.js flythrough
→ height/slope
→ reference validation
```

The implementation is complete when both PNG/JPG and georeferenced GeoTIFF workflows operate end-to-end with real outputs.

---

## 15. Current Implementation State (living record)

Updated after implementing the real pipeline execution endpoint. This
section reflects actual, verified state -- not intent. Update it after each
major phase.

### Backend (Python/FastAPI) -- `backend/`

**Real and tested:**
- `app/input/detect.py` (FR-1/FR-2): reads any file via rasterio, classifies
  georeferenced vs. non-georeferenced by actually checking CRS + non-identity
  transform. Verified with synthetic non-georeferenced JPG and georeferenced
  (`EPSG:4326`) GeoTIFF inputs.
- `app/depth/da_v2_adapter.py`, `app/depth/depth_pro_adapter.py`,
  `app/depth/pipeline.py`, `app/depth/device.py`: real Depth Anything V2
  (vitb) and Apple Depth Pro inference against the actual checkpoints at
  `model/depth_anything_v2_vitb.pth` and
  `model/ml-depth-pro-main/checkpoints/depth_pro.pt`, loaded/run/unloaded
  sequentially. VRAM confirmed to peak around ~3.7GB reserved (Depth Pro),
  well under the 8GB budget, and never with both models resident at once.
- **`app/fusion/edge_aware.py` (FR-4, new this phase):** real edge-aware
  fusion. Method: (1) convert DA V2's relative inverse-depth to a
  depth-like quantity via `1/(da_v2+eps)`; (2) fit a robust per-image
  affine scale/offset against Depth Pro's metric depth via least-squares
  over a random pixel sample (falls back to identity only when the fit is
  degenerate, e.g. a near-constant field -- verified this fallback firing
  correctly on a synthetic random-noise test image, and a real non-trivial
  fit (`a=0.0225`) on a synthetic image with actual gradient structure);
  (3) a guided filter (He et al. 2010, implemented directly with
  `cv2.boxFilter`, no `ximgproc` dependency) using Depth Pro as the guide to
  sharpen DA V2's edges while preserving its global consistency;
  (4) confidence-weighted blend toward Depth Pro where the two backbones
  agree. Not a naive average.
- **`app/fusion/edge_aware.py` confidence (FR-5):** `confidence = 1 -
  normalize(|guided_da_v2 - depth_pro|)`, per the PRD's baseline formula.
  Always computed (no `unavailable` fallback needed -- it's cheap and has
  no external dependency).
- **`app/calibration/srtm.py` (FR-6, new this phase):** real SRTM/DEM
  calibration: finds an overlapping reference tile under `SRTM_DATA_DIR`,
  reprojects it onto the input's grid via `rasterio.warp.reproject`, and
  fits scale/offset by least-squares regression against valid overlapping
  pixels. **Not validated against real SRTM data** -- `data/reference/` is
  empty in this environment, so every test run returned
  `calibration_status: "unavailable"` with an honest explanatory note. Drop
  a real DEM GeoTIFF into `data/reference/` to exercise the calibrated path.
- **`app/dsm/generate.py` + `app/geospatial/raster_io.py` (FR-7, new this
  phase):** converts fused depth to a relative height field
  (`height = max(depth) - depth`), writes it as a real single-band float32
  GeoTIFF, embedding CRS/transform when the source was georeferenced
  (verified: downloaded a generated `dsm.tif` and confirmed with `rasterio`
  that CRS=`EPSG:4326` and the affine transform exactly matched the input).
  `dsm_is_metric` is only `true` when SRTM calibration actually succeeded.
- **`app/pipeline/run.py` + `app/api/routes_pipeline.py` (new this phase):**
  `POST /api/pipeline/run/{job_id}` and `GET /api/pipeline/{job_id}` are
  real and working, matching the frontend's existing contract exactly.
  Runs as a FastAPI `BackgroundTasks` job so the HTTP request returns
  immediately; every stage transition
  (`VALIDATING -> DEPTH -> FUSION -> CALIBRATION -> DSM -> MESH -> READY`)
  is persisted to the job store as it happens. A concurrent second
  `POST .../run` on an already-running job is rejected (returns the current
  status instead of starting a second GPU load) to protect the 8GB VRAM
  budget -- verified. Any exception marks the job `FAILED` with the real
  error message and never `READY` -- verified by deleting a job's source
  file before running and confirming `FAILED` with an accurate error.
  `GET /api/pipeline/output/{job_id}/{filename}` serves real output files
  with a path-traversal guard (verified: `../../../main.py` returns 404,
  not the file).
- `app/jobs/`, `app/api/routes_project.py`: unchanged from the prior phase,
  except one real bug fix -- `routes_project.py` was setting the initial
  job stage to `VALIDATING` instead of `UPLOADED`, which collided with
  `routes_pipeline.py`'s "already in progress" guard and silently prevented
  `POST /api/pipeline/run` from ever queuing its background task (found via
  a live end-to-end test that hung with the job stuck at `VALIDATING`
  forever; root-caused by direct-invoking the pipeline function outside
  FastAPI to isolate the bug, then confirmed and fixed).

**Not yet implemented (do not treat as done):**
- Mesh generation (FR-8/FR-9): the pipeline passes through `JobStage.MESH`
  without producing any file. `metadata.json.mesh_status` is always
  `"pending"`.
- Reference/LiDAR validation (FR-11): no `GET /api/validate` or equivalent
  exists; the frontend's validation panel is always `available: false`.
- Height/slope measurement tools (FR-10): not implemented.
- Real SRTM calibration is implemented but unexercised against real data
  (see above).

### Frontend (Next.js 16 / React / TypeScript) -- `frontend/`

- `src/lib/api/pipeline.ts`: added `outputUrl()` and `getResultMetadata()`,
  which fetches `outputs.metadata_json` (just another real pipeline output
  file, not a bespoke endpoint) and types its shape (`ResultMetadata`).
- `src/hooks/useDepthWizardWorkflow.ts`: replaced the old
  `buildPendingResult()` (which unconditionally marked every panel
  unavailable) with `buildResultFromOutputs()`, which reads the job's real
  `outputs` map and `metadata.json` to populate `DepthResult`/`DSMResult`/
  `ConfidenceResult` with genuine backend data -- verified in a live browser
  session showing real fused-depth, rDSM, and confidence preview images
  fetched from the running backend. Also fixed the run-pipeline error
  message, which previously assumed a 404 always meant "endpoint not
  implemented" -- now that the endpoint is real, a 404 correctly means "job
  not found" instead.
- `src/components/results/ResultsScreen.tsx`: now renders the real preview
  images for depth/DSM/confidence when available, and shows real DA V2 /
  Depth Pro min-max stats; DSM panel title (`DSM (metric)` vs.
  `rDSM (relative)`) now reflects the real `dsm_is_metric` flag instead of
  just "is the input georeferenced" (georeferenced != calibrated).
- `src/components/results/OriginalImagePreview.tsx` (new): fixes a real bug
  found during this phase's browser testing -- the results screen's
  "Original Image" panel showed a broken-image icon for TIFF/GeoTIFF inputs
  (browsers can't decode TIFF in `<img>`), unlike the upload-preview screen
  which already handled this. Now shows the same honest fallback message.
- `TerrainViewer.tsx`, validation panel: unchanged -- still honestly
  `available: false`, matching the backend's real (non-)implementation of
  FR-8/FR-9/FR-11.

### Files added/changed this phase

New: `backend/app/fusion/{__init__.py,edge_aware.py}`,
`backend/app/dsm/{__init__.py,generate.py}`,
`backend/app/calibration/{__init__.py,srtm.py}`,
`backend/app/geospatial/{__init__.py,raster_io.py}`,
`backend/app/pipeline/{__init__.py,run.py}`,
`backend/app/api/routes_pipeline.py`,
`frontend/src/components/results/OriginalImagePreview.tsx`.

Changed: `backend/app/main.py` (registers the pipeline router),
`backend/app/api/routes_project.py` (bug fix: initial stage `UPLOADED` not
`VALIDATING`), `frontend/src/lib/api/pipeline.ts`,
`frontend/src/hooks/useDepthWizardWorkflow.ts`,
`frontend/src/components/results/ResultsScreen.tsx`.

### Tests performed

- Real HTTP pipeline run (not a direct function call) against the live
  `uvicorn` server: uploaded a synthetic non-georeferenced JPG, called
  `POST /api/pipeline/run/{id}`, polled `GET /api/pipeline/{id}` to
  `READY` (~8s), verified every output key in the response resolves to a
  real, downloadable file.
- Same, with a synthetic georeferenced GeoTIFF (`EPSG:4326`, real gradient
  structure, not random noise): confirmed `calibration_status:
  "unavailable"` with an honest note (no SRTM data present),
  `fusion_scale_a` a real non-degenerate regression coefficient, and the
  downloaded `dsm.tif` verified via `rasterio` to carry the correct
  CRS/transform.
- Concurrency guard: called `POST .../run/{id}` twice back-to-back on the
  same job; second call returned the in-progress status (`DEPTH`) instead
  of starting a second pipeline run.
- Failure path: deleted a job's stored source file, called
  `POST .../run/{id}`; job correctly reached `FAILED` with a real,
  descriptive error message, never `READY`.
- 404 handling: unknown job ID against both `GET /api/pipeline/{id}` and
  `POST /api/pipeline/run/{id}` returns 404.
- Path-traversal guard on the output-serving route: verified 404, not file
  leakage.
- Real headless-browser (Playwright) end-to-end run against the actual
  `npm run dev` frontend + `uvicorn` backend: upload a synthetic GeoTIFF ->
  preview -> Process Image -> real multipart upload -> real pipeline run ->
  Results screen shows 4 real result panels (original/depth/rDSM/confidence)
  with zero console errors -- confirmed visually via screenshot.
- `npm run build` and `npm run lint`: clean.
- All test images were synthetic and generated in this session (random
  noise or a procedural gradient+noise pattern), never anything from
  `model/ml-depth-pro-main/data/` or any other repository sample.

### Known limitations

- Only tested with small (400x600-ish) synthetic images. Real remote-sensing
  imagery (larger, real photographic structure, possibly >8GB-VRAM-relevant
  sizes) has not been tested; tiling (mentioned in IMPLEMENTATION.md Section
  5) is not implemented.
- SRTM calibration code is real but has never run against actual reference
  DEM data in this environment.
- Depth Pro's metric output on a low-structure/random-noise synthetic image
  is essentially uninformative (near-constant, sub-decimeter scale) --
  expected given no real photographic depth cues exist in random noise, but
  a reminder that these tests validate pipeline *mechanics*, not depth
  *accuracy*. Accuracy validation requires FR-11 (not yet implemented) and
  real reference data.
- BackgroundTasks-based execution means a second, unrelated pipeline run
  submitted while one is in flight will queue behind it on the same
  process's GPU (Starlette runs sync background tasks in a threadpool, but
  CUDA work still serializes on the one GPU) -- there is no job queue with
  prioritization; fine for the single-user standalone target (FR-12), not
  for concurrent multi-user load.

### Next step (superseded -- see Section 16)

~~Implement mesh generation (FR-8/FR-9)...~~ Done this phase; see below.

---

## 16. Mesh Generation + Three.js Flythrough (FR-8, FR-9)

### Backend: `app/mesh/generate.py`

Real DSM-to-mesh conversion, no procedural/placeholder geometry:

1. **Downsampling.** The DSM grid (not the texture) is block-averaged via
   `nanmean` over non-overlapping blocks down to a max grid dimension (160)
   so NoData regions stay NoData rather than being smeared, and structure
   survives decimation better than nearest-neighbor sampling.
2. **Horizontal spacing.** Georeferenced input: real-world meters per pixel
   derived from `geo.resolution`, converted from degrees for geographic CRSs
   via the standard 111,320 m/degree-latitude approximation (scaled by
   `cos(latitude)` for longitude), used directly for already-metric
   projected CRSs. Non-georeferenced input: arbitrary 1-unit-per-pixel
   scene spacing (no real horizontal scale exists).
3. **Vertical scale.** A metric (SRTM-calibrated) DSM plots true elevation
   in meters at 2x exaggeration (documented, for legibility). A relative
   (uncalibrated) DSM has no real units, so its range is normalized to 25%
   of the horizontal extent -- a visualization convenience, not an accuracy
   claim (`metadata.json.mesh_vertical_exaggeration` records the exact
   factor used either way).
4. **Triangulation.** A grid quad is only triangulated when all 4 corners
   are finite -- verified with a synthetic DSM containing a deliberate
   NoData rectangle: the hole did not get bridged with stretched triangles.
5. **Texture.** The user's actual uploaded RGB image (read via the existing
   `app/input/detect.read_rgb_array`, capped at 1024px, independent of the
   coarser mesh grid resolution) is embedded directly into the GLB via
   `trimesh`'s `PBRMaterial`/`TextureVisuals`.
6. **Export.** `trimesh.Trimesh(...).export(file_type="glb")` -- verified by
   reloading the exported bytes with `trimesh.load(..., file_type="glb")`
   and confirming vertex/face counts round-trip exactly.
7. **Errors.** An all-NoData or near-empty DSM raises `MeshGenerationError`,
   which the pipeline's existing generic exception handler turns into a
   real `FAILED` job state -- verified.

Wired into `app/pipeline/run.py`'s `JobStage.MESH` (previously a pass-through
placeholder, now does real work), writing `outputs/{job_id}/terrain.glb` and
extending `metadata.json` with `mesh_vertex_count`, `mesh_triangle_count`,
`mesh_grid_rows/cols`, `mesh_downsample_factor`, `mesh_elevation_min/max`,
`mesh_texture_width/height`, `mesh_spacing_units`,
`mesh_vertical_exaggeration`.

### Backend: progress field

`JobStatusResponse` gained a `progress: int` field (0-100), computed
on-the-fly in `routes_pipeline.py` from a `JobStage -> int` lookup table
(`UPLOADED=0, VALIDATING=10, DEPTH=35, FUSION=55, CALIBRATION=65, DSM=80,
MESH=92, READY=100, FAILED=0`) -- not persisted, not fabricated per-frame,
just a coarse mapping of real, already-persisted stage transitions.

### Frontend: `TerrainViewer.tsx` (full rewrite)

- Loads `terrain.glb` via `GLTFLoader` only when `terrain.available` and a
  real `meshUrl` exist; shows an honest error message (not fake terrain) if
  the GLB fails to load or parse.
- Default view: `OrbitControls`, camera auto-framed from the mesh's real
  `THREE.Box3` bounding box (no hardcoded camera position).
- Flythrough: `PointerLockControls` with WASD + mouse-look + Space/Shift for
  vertical movement, entered via an "Enter Flythrough" button.
  Terrain-following camera height: every frame (and once at flythrough
  entry), a downward raycast against the actual loaded mesh clamps
  `camera.position.y` to `hit.point.y + eyeHeight` (eyeHeight derived from
  the mesh's real vertical extent), so the camera cannot start or move
  underground and follows real terrain relief while moving.
- Exit is Escape-only while flythrough is active, matching every other
  Pointer-Lock-API app (a "click-through" exit button was tried first and
  removed -- see "real bug found" below): once the pointer is locked, the
  browser routes **all** mouse events exclusively to the locked element, so
  an on-screen "Exit Flythrough" button is physically unclickable while
  locked. The on-screen hint ("Esc to exit") is the only exit affordance
  shown during flythrough; "Enter Flythrough"/"Reset View" only render in
  the orbit-view state.
- "Reset View" re-frames the camera from the same real bounding box.
- Fog range, camera near/far, movement speed, and eye height are all
  computed from the mesh's actual bounding box each time it loads --
  necessary because a georeferenced mesh spans real-world meters (tens of
  thousands of units) while a relative mesh uses small arbitrary scene
  units; a fixed range for either broke the other.

### Real bugs found and fixed during this phase

1. **Fog range hid the entire terrain.** A fixed `Fog(color, 10, 500)` fully
   fogged out any georeferenced mesh (camera-to-terrain distance routinely
   >500 units for real-world-meter-scale meshes) into the identical
   background color -- found by comparing a direct canvas screenshot
   (fully blank) against the confirmed-correct vertex/triangle counts and
   `trimesh` round-trip validation, which proved the mesh itself was fine
   and the bug was purely in camera/scene setup. Fixed by computing fog
   near/far from the real bounding-box distance in `frameCamera()`.
2. **Flythrough camera silently reverted to the orbit view.** The render
   loop branched on `pointerControls.isLocked`; when pointer lock hadn't
   engaged yet (an async gap even in real browsers, and one that headless
   Chromium's synthetic clicks can leave permanently unresolved), the
   `else` branch called `orbitControls.update()`, which recomputes camera
   position from OrbitControls' own cached spherical state -- silently
   undoing the flythrough repositioning every single frame. Found via a
   canvas-only screenshot immediately after "Enter Flythrough" showing pure
   background instead of a ground-level terrain view. Fixed with an
   explicit `flythroughRequested` intent flag (set on click, independent of
   the actual lock event) that the render loop checks instead.
3. **Unreachable "Exit Flythrough" button** (see above) -- found the same
   way real bugs get found: a Playwright click on it timed out because the
   canvas (the pointer-locked element) was intercepting all pointer events,
   which is correct browser behavior, not a test flake. Fixed by only
   rendering that control set outside flythrough mode.

### Tests performed

- `backend/app/mesh/generate.py` unit-style smoke test (not part of the
  pytest suite): a synthetic DSM with sine-wave structure and a deliberate
  NoData rectangle, for both the non-georeferenced (scene-units) and
  georeferenced+metric (real meters) code paths, plus an all-NaN-DSM error
  case. Verified real vertex/triangle counts, GLB round-trip via
  `trimesh.load`, and the NoData hole not being bridged.
- Real HTTP pipeline runs (georeferenced GeoTIFF and non-georeferenced JPG)
  through to `terrain_glb` in the outputs map; downloaded the GLB and
  independently re-verified vertex count (13,300), triangle count (26,136),
  bounding box, embedded texture presence, and texture dimensions (400x300,
  matching the source image) via `trimesh`, outside of the pipeline code
  that produced it.
- Real headless-browser (Playwright) run: upload -> process -> Results
  screen shows real vertex/triangle counts and "relative elevation" label
  -> canvas screenshot shows the actual DSM-shaped, actual-image-textured
  terrain surface (visually matches the synthetic test image's sine-wave
  pattern) -> "Enter Flythrough" produces a genuine ground-level,
  terrain-following first-person view (confirmed via canvas screenshot, not
  just "no crash") -> simulated `KeyW` press visibly moves the camera and
  the view stays anchored to the terrain surface -> zero console errors
  throughout.
- `npm run build` and `npm run lint`: clean.

### Known limitations

- Escape-driven pointer-lock exit could not be fully automated in headless
  Chromium (Playwright's synthetic Escape keypress does not reliably fire
  the native `pointerlockchange` unlock event this environment relies on).
  The exit mechanism itself is standard `PointerLockControls` library
  behavior (the same code used across the three.js ecosystem), not custom
  logic, but the end-to-end "press Escape, see the button reappear" flow
  should be manually re-confirmed in a real desktop browser before a live
  demo.
- Mesh grid resolution is capped at 160x160; very large or highly detailed
  real remote-sensing images will lose fine detail in the mesh (though not
  in the depth/DSM rasters themselves, which stay at full resolution).
- Only tested with two synthetic images (an aerial-photo-like gradient
  pattern and random noise). Real remote-sensing imagery's mesh quality
  (particularly texture-to-geometry alignment on genuine terrain features)
  has not been visually validated.
- No elevation-colored, confidence-colored, or reference/error-colored mesh
  variants exist -- the GLB only ever carries the RGB texture, since no
  backend capability produces alternate colorings to switch between (per
  the "only enable layers for data that actually exists" principle, no fake
  toggle buttons were added for these).

### Requirement status update

- **FR-8 (terrain mesh + RGB texture): DONE.** Real DSM-derived mesh, real
  uploaded-image texture, verified end-to-end.
- **FR-9 (first-person 3D flythrough): DONE**, with the one noted manual
  re-verification caveat above for the Escape-exit flow in a real browser.

### Next step

Reference/LiDAR validation (FR-11): compare the calibrated DSM against a
real reference DEM (align CRS/grid/resolution, mask NoData, compute
RMSE/MAE/correlation/valid-pixel-count) and surface it in the existing
(currently always-`unavailable`) validation panel. This requires real
reference elevation data in `data/reference/` to exercise -- same
dependency the calibration path (`app/calibration/srtm.py`) is already
waiting on.
