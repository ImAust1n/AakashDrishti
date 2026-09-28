"use client";

/**
 * Three.js terrain viewer.
 *
 * FR-8/FR-9: loads the real terrain.glb produced by
 * backend/app/mesh/generate.py (real DSM-derived vertices + the user's own
 * uploaded image as texture, see IMPLEMENTATION.md) via GLTFLoader, and
 * provides an orbit view plus a terrain-following first-person flythrough.
 *
 * If `terrain.available` is false, or the GLB fails to load/parse, this
 * shows an honest empty/error state -- it never renders a placeholder or
 * procedural terrain (CLAUDE.md Section 7: never fabricate model outputs).
 *
 * Phase 3 additions (all optional/best-effort -- a missing/unreachable
 * backend endpoint degrades to "toggle disabled, no data", never a crash):
 *  - Building height labels (billboarded HTML pills via CSS2DRenderer),
 *    fetched from GET /api/pipeline/{job_id}/buildings.
 *  - Two-point height/slope measurement tool (raycast against the mesh).
 *  - Confidence overlay: a translucent textured plane over the terrain,
 *    using the same confidence_preview_png the 2D panel already shows.
 *  - Disaster-zone overlay: filled/outlined polygons for landing zones,
 *    flood risk, and fire-access risk, from
 *    GET /api/pipeline/{job_id}/disaster-zones.
 *
 * Coordinate-mapping caveat: the buildings/disaster-zones contract gives
 * footprints/geometries as raw coordinate arrays without a documented CRS
 * (the backend endpoints are still being built in parallel). This component
 * maps them onto the mesh by normalizing all footprint/geometry points into
 * a shared bounding box and rescaling that box onto the loaded mesh's
 * XZ footprint. That is a reasonable best-effort assumption (all of these
 * artifacts are derived from the same source image/DSM extent), but it
 * should be revisited once the backend's exact coordinate convention for
 * these two endpoints is confirmed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

import type { TerrainMeshResult, Building, DisasterZone } from "@/lib/types/results";
import { getBuildings, getDisasterZones } from "@/lib/api/pipeline";

/** A raw click on the terrain, reported in BOTH spaces: `px`/`py` are in the
 * same original-image pixel space building footprints/backend scenario
 * endpoints use (`epicenter_px`/`fire_point_px`), derived by inverting the
 * same `mapPoint()` transform this component already uses forward for
 * building labels/disaster-zone polygons -- see that function for the caveat
 * this inherits (best-effort, scaled to the buildings/zones bounding box, not
 * a verified CRS-exact mapping). `null` if no buildings/zones exist yet for
 * this job (there is no reference frame to invert against without them). */
interface TerrainPick {
  px: number | null;
  py: number | null;
  mesh: { x: number; y: number; z: number };
}

interface TerrainViewerProps {
  terrain: TerrainMeshResult;
  jobId: string;
  /** Same confidence preview PNG URL already shown in the 2D results panel, if any. */
  confidencePreviewUrl: string | null;

  // --- Scenario-page live-overlay additions (all optional/additive; every
  // existing caller -- ResultsScreen.tsx, JobDetailClient.tsx -- keeps
  // working unchanged with none of these supplied). ---

  /** Raw DSM-unit water level (same units the flood scenario endpoint takes/
   * returns -- meters if the job is metric, else relative DSM units). When
   * set, renders a live, client-side-only translucent water plane at the
   * correct mesh height, computed via `(waterLevelOverlay - elevationMin) *
   * verticalExaggeration` -- the exact inverse of how app/mesh/generate.py
   * computed the mesh's own vertex Y values, not an approximation. Requires
   * `elevationMin`/`verticalExaggeration` (from the job's metadata.json,
   * `mesh_elevation_min`/`mesh_vertical_exaggeration`) to position correctly. */
  waterLevelOverlay?: number | null;
  elevationMin?: number | null;
  verticalExaggeration?: number | null;

  /** When true, a plain click on the terrain (not a drag, not measure mode,
   * not a building) reports its position via `onTerrainPick` instead of doing
   * nothing. Used by the hazard-exposure/wildfire-drone scenario pickers. */
  pickModeActive?: boolean;
  onTerrainPick?: (pick: TerrainPick) => void;

  /** Renders concentric rings (not filled, to stay legible over other
   * overlays) at `centerPx`, one per damage-severity band, for the bomb/
   * explosion-impact scenario. Each `radiusM` is converted into the same
   * original-pixel space `centerPx` and building footprints already share
   * via `metersPerOriginalPixel` (top-level prop below), then run through
   * the normal forward `mapPoint()` transform. */
  bombMarker?: {
    centerPx: [number, number];
    bands: { severity: string; radiusM: number; color: string }[];
    /** "meters" = radiusM is a real calibrated distance (needs
     * `metersPerOriginalPixel` to place); "pixels" = radiusM is already an
     * illustrative 1px~=1m image-pixel count (this job isn't georeferenced),
     * placed directly via the image-pixels-to-mesh-units ratio instead. */
    spacingUnits: "meters" | "pixels";
    /** A fresh object reference each time a NEW simulation result lands
     * (e.g. the actual result object from BombSimulationPanel's onResult) --
     * triggers the expanding-shockwave/rings animation once per real run,
     * not on every parent re-render. */
    justComputed?: object | null;
  } | null;

  /** A live flame visual at the wildfire-drone scenario's marked fire
   * location. `justComputed` (a fresh object reference each time a NEW
   * "Calculate Drop" result lands, e.g. the actual result object from
   * WildfireDronePanel's onResult) triggers the fly-in-and-extinguish
   * animation; a plain re-pick (no result yet) just shows the flame. */
  fireMarker?: {
    px: [number, number];
    hoverAltitudeAglM?: number | null;
    horizontalReachM?: number | null;
    justComputed?: object | null;
  } | null;

  /** Ranked emergency-landing zone the user selected, with a 2D aircraft
   * footprint drawn on the ground and (when `animate` is true, i.e. a fresh
   * selection) a simple procedural aircraft model animating down onto it. */
  landingMarker?: {
    centerPx: [number, number];
    widthM: number;
    lengthM: number;
    angleDeg: number;
    aircraftType: "plane" | "helicopter";
    fits: boolean | null;
    /** Same "meters" vs "pixels" degradation as `bombMarker.spacingUnits`. */
    spacingUnits: "meters" | "pixels";
    animate?: object | null;
  } | null;

  /** Original source-image pixel dimensions (ResultMetadata.width/height).
   * Used as the layout-bounds fallback so `onTerrainPick` still works on a
   * job with zero detected buildings/zones -- without this, layoutBoundsRef
   * would stay null (computeLayoutBounds only ever saw building/zone points)
   * and every terrain click would silently resolve to px:null/py:null. */
  imageWidth?: number | null;
  imageHeight?: number | null;

  /** Real-world meters-per-ORIGINAL-image-pixel (caller-derived, see
   * scenarios/page.tsx). Combined with `imageWidth` and the loaded mesh's
   * own bounding-box width, gives a real-meters-to-mesh-units scale factor
   * used to size the bomb rings' reference markers, the landing aircraft
   * model, and the wildfire drone model correctly relative to buildings. */
  metersPerOriginalPixel?: number | null;
}

const MOVE_SPEED_FRACTION = 0.25; // fraction of terrain size crossed per second
const EYE_HEIGHT_FRACTION = 0.08; // fraction of terrain vertical extent used as eye height above ground

const ZONE_COLOR: Record<DisasterZone["type"], string> = {
  landing_zone: "#22c55e",
  flood_risk: "#38bdf8",
  fire_access_risk: "#f97316",
};

const ZONE_LABEL: Record<DisasterZone["type"], string> = {
  landing_zone: "Landing Zone",
  flood_risk: "Flood Risk",
  fire_access_risk: "Fire Access Risk",
};

interface LayoutBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function collectPoints(buildings: Building[], zones: DisasterZone[]): number[][] {
  const points: number[][] = [];
  for (const b of buildings) {
    for (const p of b.footprint) points.push(p);
  }
  for (const z of zones) {
    for (const ring of z.geometry.coordinates) {
      for (const p of ring) points.push(p);
    }
  }
  return points;
}

function computeLayoutBounds(points: number[][], imageWidth?: number | null, imageHeight?: number | null): LayoutBounds | null {
  // Prefer the full source-image extent when known -- it's the space every
  // pixel coordinate (building footprints, terrain picks) actually lives in,
  // and it must exist even when there are zero buildings/zones to derive
  // bounds from (a bare DSM-only job), otherwise onTerrainPick can never work.
  if (imageWidth && imageHeight) {
    return { minX: 0, maxX: imageWidth, minY: 0, maxY: imageHeight };
  }
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** Disposes every mesh's geometry/material under `obj` (recursively) --
 * shared cleanup for the procedural marker groups below, all of which are
 * rebuilt from scratch on every prop change. */
function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}

/** Original-image-pixels-to-mesh-units scale factor -- always available
 * once the mesh/image dimensions are known, unlike `computeMeshUnitsPerMeter`
 * (which needs real georeferenced calibration). Used to size/place overlays
 * whose backend numbers are in "illustrative 1px~=1m" units (bomb-sim /
 * landing-zone `spacing_units: "pixels"`) directly from image pixels,
 * instead of going dead on every non-georeferenced job. */
function computeMeshUnitsPerPixel(boxSizeX: number, imageWidth: number | null): number | null {
  if (!imageWidth || !boxSizeX) return null;
  return boxSizeX / imageWidth;
}

/** Real-meters-to-mesh-units scale factor for the currently-loaded mesh, or
 * `null` when it can't be derived (non-georeferenced job -- no real-world
 * scale exists to size a to-scale 3D model against). Shared by every
 * procedural model below so aircraft/drones read as correctly small next to
 * real buildings instead of a fixed, scene-relative "schematic" size. */
function computeMeshUnitsPerMeter(
  boxSizeX: number,
  imageWidth: number | null,
  metersPerOriginalPixel: number | null,
): number | null {
  if (!imageWidth || !metersPerOriginalPixel || !boxSizeX) return null;
  const realWorldWidthM = imageWidth * metersPerOriginalPixel;
  if (realWorldWidthM <= 0) return null;
  return boxSizeX / realWorldWidthM;
}

/** Procedural flame -- a few stacked, tapered cones in fire colors. No
 * texture asset needed; `unitPerMeter` sizes it to a real, illustrative
 * ~1.6m flame height (or a scene-relative fallback when ungeoreferenced). */
function createFlameGroup(unitPerMeter: number): THREE.Group {
  const group = new THREE.Group();
  const layers: { heightM: number; radiusM: number; color: number; yOffsetM: number }[] = [
    { heightM: 1.6, radiusM: 0.45, color: 0xea580c, yOffsetM: 0 },
    { heightM: 1.1, radiusM: 0.3, color: 0xf97316, yOffsetM: 0.15 },
    { heightM: 0.65, radiusM: 0.16, color: 0xfacc15, yOffsetM: 0.35 },
  ];
  for (const layer of layers) {
    const geom = new THREE.ConeGeometry(layer.radiusM * unitPerMeter, layer.heightM * unitPerMeter, 10);
    const mat = new THREE.MeshBasicMaterial({ color: layer.color, transparent: true, opacity: 0.9 });
    const cone = new THREE.Mesh(geom, mat);
    cone.position.y = (layer.heightM / 2 + layer.yOffsetM) * unitPerMeter;
    cone.userData.flameBaseY = cone.position.y;
    group.add(cone);
  }
  return group;
}

/** Procedural small firefighting drone -- a body box + 4 thin rotor arms,
 * sized to a real, illustrative ~1.2m body width. */
function createDroneGroup(unitPerMeter: number): THREE.Group {
  const group = new THREE.Group();
  const bodyGeom = new THREE.BoxGeometry(0.5 * unitPerMeter, 0.22 * unitPerMeter, 0.5 * unitPerMeter);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1f2937 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  group.add(body);

  const tankGeom = new THREE.CylinderGeometry(0.16 * unitPerMeter, 0.16 * unitPerMeter, 0.2 * unitPerMeter, 12);
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9 });
  const tank = new THREE.Mesh(tankGeom, tankMat);
  tank.position.y = -0.18 * unitPerMeter;
  group.add(tank);

  const armPositions: [number, number][] = [
    [0.55, 0.55],
    [0.55, -0.55],
    [-0.55, 0.55],
    [-0.55, -0.55],
  ];
  for (const [ax, az] of armPositions) {
    const armGeom = new THREE.CylinderGeometry(0.02 * unitPerMeter, 0.02 * unitPerMeter, 0.35 * unitPerMeter, 6);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x374151 });
    const arm = new THREE.Mesh(armGeom, armMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set((ax * 0.5) * unitPerMeter, 0.05 * unitPerMeter, (az * 0.5) * unitPerMeter);
    group.add(arm);

    const rotorGeom = new THREE.CylinderGeometry(0.16 * unitPerMeter, 0.16 * unitPerMeter, 0.015 * unitPerMeter, 16);
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0x111827, transparent: true, opacity: 0.55 });
    const rotor = new THREE.Mesh(rotorGeom, rotorMat);
    rotor.position.set(ax * unitPerMeter, 0.12 * unitPerMeter, az * unitPerMeter);
    group.add(rotor);
  }
  return group;
}

/** Procedural small fixed-wing aircraft -- fuselage box + wing box + tail
 * cone, sized to a real, illustrative ~8m length / ~11m wingspan. */
function createPlaneGroup(unitPerMeter: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xdc2626 });

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.55 * unitPerMeter, 6 * unitPerMeter, 4, 8), mat);
  fuselage.rotation.z = Math.PI / 2;
  group.add(fuselage);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6 * unitPerMeter, 0.12 * unitPerMeter, 11 * unitPerMeter), mat);
  wing.position.y = 0.1 * unitPerMeter;
  group.add(wing);

  const tailFin = new THREE.Mesh(new THREE.ConeGeometry(0.05 * unitPerMeter, 1.4 * unitPerMeter, 4), accentMat);
  tailFin.rotation.x = Math.PI / 2;
  tailFin.position.set(-3.6 * unitPerMeter, 0.9 * unitPerMeter, 0);
  tailFin.rotation.z = Math.PI;
  group.add(tailFin);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(0.7 * unitPerMeter, 0.08 * unitPerMeter, 3 * unitPerMeter), mat);
  tailWing.position.set(-3.6 * unitPerMeter, 0, 0);
  group.add(tailWing);

  return group;
}

/** Procedural small emergency/medevac helicopter -- body cylinder + tail
 * boom + main rotor disc, sized to a real, illustrative ~13m length / ~14m
 * rotor diameter. */
function createHelicopterGroup(unitPerMeter: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xdc2626 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9 * unitPerMeter, 3.5 * unitPerMeter, 4, 10), mat);
  body.rotation.z = Math.PI / 2;
  group.add(body);

  const tailBoom = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18 * unitPerMeter, 0.28 * unitPerMeter, 6 * unitPerMeter, 8),
    mat,
  );
  tailBoom.rotation.z = Math.PI / 2;
  tailBoom.position.x = -5 * unitPerMeter;
  group.add(tailBoom);

  const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.05 * unitPerMeter, 1.2 * unitPerMeter, 0.08 * unitPerMeter), accentMat);
  tailRotor.position.set(-7.8 * unitPerMeter, 0.3 * unitPerMeter, 0);
  group.add(tailRotor);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * unitPerMeter, 0.05 * unitPerMeter, 0.6 * unitPerMeter, 8), mat);
  mast.position.y = 0.9 * unitPerMeter;
  group.add(mast);

  const rotorBlades = new THREE.Mesh(new THREE.BoxGeometry(14 * unitPerMeter, 0.04 * unitPerMeter, 0.35 * unitPerMeter), accentMat);
  rotorBlades.position.y = 1.2 * unitPerMeter;
  rotorBlades.userData.isMainRotor = true;
  group.add(rotorBlades);

  return group;
}

interface MeasureResult {
  distance: number;
  horizontalDistance: number;
  heightDelta: number;
  slopeDegrees: number;
}

export function TerrainViewer({
  terrain,
  jobId,
  confidencePreviewUrl,
  waterLevelOverlay = null,
  elevationMin = null,
  verticalExaggeration = null,
  pickModeActive = false,
  onTerrainPick,
  bombMarker = null,
  fireMarker = null,
  landingMarker = null,
  imageWidth = null,
  imageHeight = null,
  metersPerOriginalPixel = null,
}: TerrainViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isFlythrough, setIsFlythrough] = useState(false);

  const [buildings, setBuildings] = useState<Building[]>([]);
  const [buildingsAvailable, setBuildingsAvailable] = useState(false);
  const [disasterZones, setDisasterZones] = useState<DisasterZone[]>([]);
  const [zonesAvailable, setZonesAvailable] = useState(false);

  const [showBuildingLabels, setShowBuildingLabels] = useState(true);
  const [showConfidence, setShowConfidence] = useState(false);
  const [showZones, setShowZones] = useState(true);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState<Building | null>(null);

  const resetViewRef = useRef<() => void>(() => {});
  const enterFlythroughRef = useRef<() => void>(() => {});
  const exitFlythroughRef = useRef<() => void>(() => {});

  // Shared across effects: populated once the scene/mesh exist.
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const terrainMeshRef = useRef<THREE.Object3D | null>(null);
  const boxSizeRef = useRef(new THREE.Vector3(1, 1, 1));
  const boxCenterRef = useRef(new THREE.Vector3(0, 0, 0));
  const buildingLabelsGroupRef = useRef<THREE.Group | null>(null);
  const buildingHitGroupRef = useRef<THREE.Group | null>(null);
  const selectionHighlightRef = useRef<THREE.LineLoop | null>(null);
  const zonesGroupRef = useRef<THREE.Group | null>(null);
  const confidencePlaneRef = useRef<THREE.Mesh | null>(null);
  const measureGroupRef = useRef<THREE.Group | null>(null);
  const measurePointsRef = useRef<THREE.Vector3[]>([]);
  const measureModeRef = useRef(false);
  const rebuildLabelsAndZonesRef = useRef<() => void>(() => {});
  /** The buildings/zones pixel-space bounding box `rebuildLabelsAndZonesRef`
   * computes for its forward `mapPoint()` transform -- lifted into a ref so
   * the pointer-click handler (a different effect) can invert the same
   * transform for scenario terrain-picking. Null when there's no buildings/
   * zones data to derive a reference frame from. */
  const layoutBoundsRef = useRef<LayoutBounds | null>(null);
  const waterPlaneRef = useRef<THREE.Mesh | null>(null);
  const bombRingsGroupRef = useRef<THREE.Group | null>(null);
  const fireMarkerGroupRef = useRef<THREE.Group | null>(null);
  const landingMarkerGroupRef = useRef<THREE.Group | null>(null);
  const pickModeActiveRef = useRef(false);
  const onTerrainPickRef = useRef<TerrainViewerProps["onTerrainPick"]>(undefined);
  /** Per-frame update callbacks registered by overlay effects (flame
   * flicker, drone/aircraft fly-in animations) -- a single shared hook into
   * the one real render loop (in the mesh-loading effect below) instead of
   * each overlay effect running its own requestAnimationFrame loop. */
  const frameCallbacksRef = useRef<Set<(dt: number, elapsed: number) => void>>(new Set());
  /** Last `fireMarker.justComputed` reference seen -- distinguishes "a
   * genuinely new wildfire-drop result just landed" (fly the drone in) from
   * "same result, new render" (parent re-render doesn't recreate this object
   * unless `runWildfireDroneScenario` actually returned a fresh one). */
  const prevFireResultRef = useRef<object | null>(null);
  /** Same "only animate on a genuinely new selection" pattern as
   * `prevFireResultRef`, for the landing-zone aircraft animation. */
  const prevLandingAnimateRef = useRef<object | null>(null);
  /** Same pattern, for the bomb-simulation shockwave/ring-expansion animation. */
  const prevBombResultRef = useRef<object | null>(null);

  // Fullscreen state can change via the browser (Esc, F11, OS UI), not just
  // our own button -- listen for the real event rather than only toggling on
  // click, so the icon/label never gets out of sync with reality.
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {
        // Fullscreen can be denied (no user gesture, iframe restrictions,
        // etc.) -- degrade silently rather than throwing, the toggle button
        // just has no visible effect in that case.
      });
    }
  }, []);

  // Mirror these two props into refs so the imperative Three.js event
  // handlers (registered once, inside the mesh-loading effect) always read
  // the latest value without needing that whole effect to re-run on every
  // prop change (it owns expensive WebGL setup, not a cheap effect to redo).
  useEffect(() => {
    pickModeActiveRef.current = pickModeActive;
  }, [pickModeActive]);
  useEffect(() => {
    onTerrainPickRef.current = onTerrainPick;
  }, [onTerrainPick]);

  const toggleMeasureMode = useCallback(() => {
    setMeasureMode((prev) => {
      const next = !prev;
      measureModeRef.current = next;
      return next;
    });
    measurePointsRef.current = [];
    measureGroupRef.current?.clear();
    setMeasureResult(null);
  }, []);

  // Fetch buildings/disaster-zones independently of the mesh -- these are
  // new backend endpoints that may not be live/populated yet.
  useEffect(() => {
    let cancelled = false;
    getBuildings(jobId)
      .then((data) => {
        if (cancelled) return;
        setBuildings(data);
        setBuildingsAvailable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBuildings([]);
        setBuildingsAvailable(false);
      });
    getDisasterZones(jobId)
      .then((data) => {
        if (cancelled) return;
        setDisasterZones(data);
        setZonesAvailable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDisasterZones([]);
        setZonesAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const findHeightAt = useCallback((x: number, z: number): number | null => {
    const mesh = terrainMeshRef.current;
    if (!mesh) return null;
    const raycaster = new THREE.Raycaster();
    const boxSize = boxSizeRef.current;
    const boxCenter = boxCenterRef.current;
    raycaster.set(new THREE.Vector3(x, boxCenter.y + boxSize.y * 4 + 10, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(mesh, true);
    return hits.length > 0 ? hits[0].point.y : null;
  }, []);

  // Rebuild building-label and disaster-zone overlays whenever the mesh or
  // the underlying data changes. Kept as a ref-stored function so the main
  // scene-setup effect can call it once the mesh finishes loading too.
  useEffect(() => {
    rebuildLabelsAndZonesRef.current = () => {
      const scene = sceneRef.current;
      const mesh = terrainMeshRef.current;
      const labelsGroup = buildingLabelsGroupRef.current;
      const hitGroup = buildingHitGroupRef.current;
      const zonesGroup = zonesGroupRef.current;
      if (!scene || !mesh || !labelsGroup || !hitGroup || !zonesGroup) return;

      // Clear previous overlay contents.
      for (const child of [...labelsGroup.children]) {
        labelsGroup.remove(child);
        const el = (child as CSS2DObject).element;
        el?.remove();
      }
      for (const child of [...hitGroup.children]) {
        hitGroup.remove(child);
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mat = child.material as THREE.Material;
          mat.dispose();
        }
      }
      for (const child of [...zonesGroup.children]) {
        zonesGroup.remove(child);
        if (child instanceof THREE.Mesh || child instanceof THREE.LineLoop) {
          child.geometry.dispose();
          const mat = child.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      }

      const bounds = computeLayoutBounds(collectPoints(buildings, disasterZones), imageWidth, imageHeight);
      layoutBoundsRef.current = bounds;
      const boxSize = boxSizeRef.current;
      const boxCenter = boxCenterRef.current;

      const mapPoint = (px: number, py: number): { x: number; z: number } => {
        if (!bounds) return { x: boxCenter.x, z: boxCenter.z };
        const spanX = bounds.maxX - bounds.minX || 1;
        const spanY = bounds.maxY - bounds.minY || 1;
        const nx = (px - bounds.minX) / spanX - 0.5;
        const ny = (py - bounds.minY) / spanY - 0.5;
        return { x: boxCenter.x + nx * boxSize.x, z: boxCenter.z + ny * boxSize.z };
      };

      for (const building of buildings) {
        if (building.footprint.length === 0) continue;
        const cx = building.footprint.reduce((s, p) => s + p[0], 0) / building.footprint.length;
        const cy = building.footprint.reduce((s, p) => s + p[1], 0) / building.footprint.length;
        const { x, z } = mapPoint(cx, cy);
        const y = findHeightAt(x, z);
        if (y === null) continue;

        const el = document.createElement("div");
        el.className =
          "pointer-events-none rounded-full border border-muted-foreground/50 bg-card/80 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground shadow";
        el.textContent = `${building.heightM.toFixed(1)} m`;
        const label = new CSS2DObject(el);
        label.position.set(x, y + boxSize.y * 0.03 + 0.05, z);
        label.visible = showBuildingLabels;
        label.userData.isBuildingLabel = true;
        labelsGroup.add(label);

        // Invisible (but raycastable) footprint mesh, click target for the
        // "select a building to see its height" interaction -- separate from
        // the always-on label above, since a dense scene may have labels
        // toggled off but clicking should still work.
        if (building.footprint.length >= 3) {
          const shape = new THREE.Shape();
          const outlineY = y + boxSize.y * 0.012;
          const outlinePoints: THREE.Vector3[] = [];
          building.footprint.forEach(([px, py], i) => {
            const p = mapPoint(px, py);
            if (i === 0) shape.moveTo(p.x, p.z);
            else shape.lineTo(p.x, p.z);
            outlinePoints.push(new THREE.Vector3(p.x, outlineY, p.z));
          });
          const hitGeom = new THREE.ShapeGeometry(shape);
          const hitMat = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          const hitMesh = new THREE.Mesh(hitGeom, hitMat);
          hitMesh.rotation.x = -Math.PI / 2;
          hitMesh.position.y = y + boxSize.y * 0.01;
          hitMesh.userData.building = building;
          hitMesh.userData.outlinePoints = outlinePoints;
          hitGroup.add(hitMesh);
        }
      }

      for (const zone of disasterZones) {
        const ring = zone.geometry.coordinates[0];
        if (!ring || ring.length < 3) continue;
        const shape = new THREE.Shape();
        ring.forEach(([px, py], i) => {
          const { x, z } = mapPoint(px, py);
          if (i === 0) shape.moveTo(x, z);
          else shape.lineTo(x, z);
        });
        const color = new THREE.Color(ZONE_COLOR[zone.type]);
        const fillGeom = new THREE.ShapeGeometry(shape);
        const fillMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.28,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const fillMesh = new THREE.Mesh(fillGeom, fillMat);
        fillMesh.rotation.x = -Math.PI / 2;
        fillMesh.position.y = boxCenter.y + boxSize.y * 0.02;
        fillMesh.visible = showZones;
        zonesGroup.add(fillMesh);

        const outlinePoints = ring.map(([px, py]) => {
          const { x, z } = mapPoint(px, py);
          return new THREE.Vector3(x, boxCenter.y + boxSize.y * 0.025, z);
        });
        const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePoints);
        const outlineMat = new THREE.LineBasicMaterial({ color });
        const outline = new THREE.LineLoop(outlineGeom, outlineMat);
        outline.visible = showZones;
        zonesGroup.add(outline);
      }
    };
    rebuildLabelsAndZonesRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, disasterZones, isLoaded, findHeightAt, imageWidth, imageHeight]);

  // Toggle visibility without rebuilding geometry.
  useEffect(() => {
    buildingLabelsGroupRef.current?.children.forEach((c) => {
      c.visible = showBuildingLabels;
    });
  }, [showBuildingLabels]);

  useEffect(() => {
    zonesGroupRef.current?.children.forEach((c) => {
      c.visible = showZones;
    });
  }, [showZones]);

  useEffect(() => {
    if (confidencePlaneRef.current) {
      confidencePlaneRef.current.visible = showConfidence;
    }
  }, [showConfidence]);

  // Load the confidence texture once a URL is available.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !confidencePreviewUrl || !isLoaded) return;

    let disposed = false;
    const loader = new THREE.TextureLoader();
    loader.load(confidencePreviewUrl, (texture) => {
      if (disposed) return;
      const boxSize = boxSizeRef.current;
      const boxCenter = boxCenterRef.current;
      const geom = new THREE.PlaneGeometry(boxSize.x, boxSize.z);
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(geom, mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(boxCenter.x, boxCenter.y + boxSize.y * 1.03, boxCenter.z);
      plane.visible = showConfidence;
      scene.add(plane);
      confidencePlaneRef.current = plane;
    });

    return () => {
      disposed = true;
      const plane = confidencePlaneRef.current;
      if (plane) {
        scene.remove(plane);
        plane.geometry.dispose();
        const mat = plane.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
        confidencePlaneRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confidencePreviewUrl, isLoaded]);

  // Live flood water-level plane. Client-side only, no backend round-trip --
  // exact inverse of the vertex-height formula in
  // app/mesh/generate.py:generate_terrain_mesh (`ys = (raw_dsm - elev_min) *
  // elevation_scale`), so the plane sits at the real corresponding mesh
  // height, not an approximation. Rebuilt (not just repositioned) on every
  // change since the plane must also (dis)appear when the value becomes
  // null -- the cost is trivial (a single quad).
  useEffect(() => {
    const scene = sceneRef.current;
    const existing = waterPlaneRef.current;
    if (existing) {
      scene?.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
      waterPlaneRef.current = null;
    }
    if (!scene || !isLoaded || waterLevelOverlay == null || elevationMin == null || verticalExaggeration == null) {
      return;
    }
    const boxSize = boxSizeRef.current;
    const boxCenter = boxCenterRef.current;
    const meshY = (waterLevelOverlay - elevationMin) * verticalExaggeration;
    const geom = new THREE.PlaneGeometry(boxSize.x * 1.3, boxSize.z * 1.3);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2563eb,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(geom, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(boxCenter.x, meshY, boxCenter.z);
    scene.add(plane);
    waterPlaneRef.current = plane;

    return () => {
      scene.remove(plane);
      geom.dispose();
      mat.dispose();
      if (waterPlaneRef.current === plane) waterPlaneRef.current = null;
    };
  }, [waterLevelOverlay, elevationMin, verticalExaggeration, isLoaded]);

  // Bomb/explosion-impact concentric damage-severity rings. When
  // `spacingUnits === "meters"`, each band's `radiusM` is a real calibrated
  // distance converted to image-pixel space via `metersPerOriginalPixel`;
  // when `"pixels"` (job isn't georeferenced), the backend's own graceful
  // degradation already makes `radiusM`'s numeric value an illustrative
  // image-pixel count directly (see simulate_explosion_impact's 1px~=1m
  // fallback), so it's used as-is -- this scenario must still render on a
  // plain, non-georeferenced test image, not go dead. Either way, the
  // resulting pixel-space ring is run through the same forward
  // `mapPoint()`-style transform used for building labels/disaster-zone
  // polygons, reusing `layoutBoundsRef` -- not a separately-derived scale.
  useEffect(() => {
    const scene = sceneRef.current;
    const existing = bombRingsGroupRef.current;
    if (existing) {
      scene?.remove(existing);
      disposeObject3D(existing);
      bombRingsGroupRef.current = null;
    }
    if (!scene || !isLoaded || !bombMarker) return;
    if (bombMarker.spacingUnits === "meters" && !metersPerOriginalPixel) return;
    const bounds = layoutBoundsRef.current;
    if (!bounds) return;

    const boxSize = boxSizeRef.current;
    const boxCenter = boxCenterRef.current;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const mapPoint = (px: number, py: number) => {
      const nx = (px - bounds.minX) / spanX - 0.5;
      const ny = (py - bounds.minY) / spanY - 0.5;
      return { x: boxCenter.x + nx * boxSize.x, z: boxCenter.z + ny * boxSize.z };
    };

    const [cx, cy] = bombMarker.centerPx;
    const { x: originX, z: originZ } = mapPoint(cx, cy);
    const groundY = findHeightAt(originX, originZ) ?? boxCenter.y;
    const ringY = groundY + boxSize.y * 0.03;
    const segments = 64;

    // Rings/fills are built as LOCAL-origin geometry (relative to the
    // epicenter, not baked at world scale) so the whole marker can be
    // uniformly scaled for a real expanding-shockwave animation instead of
    // popping in at full size.
    const markerRoot = new THREE.Group();
    markerRoot.position.set(originX, ringY, originZ);
    // Widest (least-severe) band first so a narrower/more-severe ring/fill
    // drawn after it is never visually hidden underneath.
    const sorted = [...bombMarker.bands].sort((a, b) => b.radiusM - a.radiusM);
    for (const band of sorted) {
      const radiusPx = bombMarker.spacingUnits === "meters" ? band.radiusM / metersPerOriginalPixel! : band.radiusM;
      const localPts: THREE.Vector3[] = [];
      for (let i = 0; i < segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const { x, z } = mapPoint(cx + radiusPx * Math.cos(theta), cy + radiusPx * Math.sin(theta));
        localPts.push(new THREE.Vector3(x - originX, 0, z - originZ));
      }
      const ringRadiusLocal = localPts[0]?.length() ?? 0;

      const fillGeom = new THREE.CircleGeometry(ringRadiusLocal, segments);
      const fillMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(band.color),
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      fill.rotation.x = -Math.PI / 2;
      markerRoot.add(fill);

      const ringGeom = new THREE.BufferGeometry().setFromPoints(localPts);
      const ringMat = new THREE.LineBasicMaterial({ color: new THREE.Color(band.color), linewidth: 2 });
      const ring = new THREE.LineLoop(ringGeom, ringMat);
      ring.position.y = 0.01 * (boxSize.y || 1);
      markerRoot.add(ring);
    }

    // Epicenter flash marker.
    const flashGeom = new THREE.SphereGeometry(Math.max(boxSize.length() * 0.01, 0.04), 16, 16);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xfff7ed });
    const flash = new THREE.Mesh(flashGeom, flashMat);
    markerRoot.add(flash);

    scene.add(markerRoot);
    bombRingsGroupRef.current = markerRoot;

    const isNewResult = bombMarker.justComputed != null && bombMarker.justComputed !== prevBombResultRef.current;
    prevBombResultRef.current = bombMarker.justComputed ?? prevBombResultRef.current;

    let shockwave: THREE.Mesh | null = null;
    let expandCb: ((dt: number, elapsed: number) => void) | null = null;
    if (isNewResult) {
      markerRoot.scale.setScalar(0.001);
      const startTime = performance.now();
      const DURATION_S = 1.1;

      const maxRadiusPx =
        bombMarker.spacingUnits === "meters"
          ? sorted[0].radiusM / metersPerOriginalPixel!
          : sorted[0].radiusM;
      const { x: edgeX, z: edgeZ } = mapPoint(cx + maxRadiusPx, cy);
      const maxRadiusLocal = new THREE.Vector3(edgeX - originX, 0, edgeZ - originZ).length();
      const shockGeom = new THREE.RingGeometry(maxRadiusLocal * 0.85, maxRadiusLocal, 48);
      const shockMat = new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      shockwave = new THREE.Mesh(shockGeom, shockMat);
      shockwave.rotation.x = -Math.PI / 2;
      shockwave.position.y = 0.02 * (boxSize.y || 1);
      markerRoot.add(shockwave);

      expandCb = () => {
        const t = Math.min((performance.now() - startTime) / 1000 / DURATION_S, 1);
        const eased = 1 - Math.pow(1 - t, 2);
        markerRoot.scale.setScalar(Math.max(eased, 0.001));
        if (shockwave) {
          const shockScale = 0.3 + eased * 1.4;
          shockwave.scale.setScalar(shockScale / Math.max(eased, 0.001));
          (shockwave.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
        }
        if (t >= 1) {
          if (expandCb) frameCallbacksRef.current.delete(expandCb);
          if (shockwave) {
            markerRoot.remove(shockwave);
            disposeObject3D(shockwave);
            shockwave = null;
          }
        }
      };
      frameCallbacksRef.current.add(expandCb);
    }

    return () => {
      if (expandCb) frameCallbacksRef.current.delete(expandCb);
      scene.remove(markerRoot);
      disposeObject3D(markerRoot);
      if (bombRingsGroupRef.current === markerRoot) bombRingsGroupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bombMarker, isLoaded, metersPerOriginalPixel]);

  // Wildfire fire-point marker: an animated flame at the picked point, plus
  // -- once a real "Calculate Drop" result exists -- a properly-real-meters-
  // sized drone that flies in from its computed standoff distance and
  // extinguishes the flame. `justComputed` is the actual result object from
  // WildfireDronePanel's onResult (a stable reference across re-renders,
  // only changing when a genuinely new API result lands), so the fly-in only
  // plays once per real drop calculation, not on every parent re-render.
  useEffect(() => {
    const scene = sceneRef.current;
    const existing = fireMarkerGroupRef.current;
    if (existing) {
      scene?.remove(existing);
      disposeObject3D(existing);
      fireMarkerGroupRef.current = null;
    }
    if (!scene || !isLoaded || !fireMarker) return;
    const bounds = layoutBoundsRef.current;
    if (!bounds) return;

    const boxSize = boxSizeRef.current;
    const boxCenter = boxCenterRef.current;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const nx = (fireMarker.px[0] - bounds.minX) / spanX - 0.5;
    const ny = (fireMarker.px[1] - bounds.minY) / spanY - 0.5;
    const x = boxCenter.x + nx * boxSize.x;
    const z = boxCenter.z + ny * boxSize.z;
    const groundY = findHeightAt(x, z) ?? boxCenter.y;

    const unitPerMeter =
      computeMeshUnitsPerMeter(boxSize.x, imageWidth, metersPerOriginalPixel) ?? Math.max(boxSize.length() * 0.012, 0.05);

    const group = new THREE.Group();

    // A single point-flame reads as a candle, not a wildfire -- scatter
    // several flame clusters over an illustrative fire-front area (a
    // visualization aid, not a computed fire-spread simulation -- this app
    // has no fire-spread model) so the marked location visibly "reveals the
    // fire" and shows the ground area it covers, like the bomb-simulation
    // rings do for blast radius.
    const FIRE_AREA_RADIUS_M = 6;
    const fireRadius = FIRE_AREA_RADIUS_M * unitPerMeter;
    const flame = new THREE.Group();
    flame.position.set(x, groundY, z);
    group.add(flame);

    const areaDiscGeom = new THREE.CircleGeometry(fireRadius, 40);
    const areaDiscMat = new THREE.MeshBasicMaterial({
      color: 0xb91c1c,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const areaDisc = new THREE.Mesh(areaDiscGeom, areaDiscMat);
    areaDisc.rotation.x = -Math.PI / 2;
    areaDisc.position.y = 0.01 * unitPerMeter;
    flame.add(areaDisc);

    const areaRingPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
      const theta = (i / 48) * Math.PI * 2;
      areaRingPts.push(new THREE.Vector3(Math.cos(theta) * fireRadius, 0.015 * unitPerMeter, Math.sin(theta) * fireRadius));
    }
    const areaRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(areaRingPts),
      new THREE.LineBasicMaterial({ color: 0xea580c, transparent: true }),
    );
    flame.add(areaRing);

    // Fixed (not random-per-render) scatter offsets within the area, biggest
    // cluster at the exact marked point.
    const CLUSTER_OFFSETS: [number, number, number][] = [
      [0, 0, 1],
      [0.55, 0.35, 0.7],
      [-0.5, 0.5, 0.65],
      [0.2, -0.6, 0.6],
      [-0.55, -0.4, 0.55],
      [0.75, -0.1, 0.5],
    ];
    const flameClusters: THREE.Group[] = [];
    for (const [ox, oz, scale] of CLUSTER_OFFSETS) {
      const cluster = createFlameGroup(unitPerMeter * scale);
      cluster.position.set(ox * fireRadius * 0.7, 0, oz * fireRadius * 0.7);
      flame.add(cluster);
      flameClusters.push(cluster);
    }
    const flameMeshes = flameClusters.flatMap((c) => c.children as THREE.Mesh[]);

    const isNewResult =
      fireMarker.justComputed != null && fireMarker.justComputed !== prevFireResultRef.current;
    prevFireResultRef.current = fireMarker.justComputed ?? prevFireResultRef.current;

    let droneGroup: THREE.Group | null = null;
    if (fireMarker.hoverAltitudeAglM != null && elevationMin != null && verticalExaggeration != null) {
      const droneY = groundY + fireMarker.hoverAltitudeAglM * verticalExaggeration;
      const hoverPos = new THREE.Vector3(x, droneY, z);
      const reachUnits = (fireMarker.horizontalReachM ?? 0) * unitPerMeter;
      const spawnPos = new THREE.Vector3(x + reachUnits, droneY + 5 * unitPerMeter, z + reachUnits);

      droneGroup = createDroneGroup(unitPerMeter);
      droneGroup.position.copy(isNewResult ? spawnPos : hoverPos);
      group.add(droneGroup);
    }

    scene.add(group);
    fireMarkerGroupRef.current = group;

    // Continuous flicker -- runs for as long as the flame exists.
    const flickerCb = (_dt: number, elapsed: number) => {
      flameMeshes.forEach((mesh, i) => {
        const baseY = (mesh.userData.flameBaseY as number) ?? mesh.position.y;
        mesh.position.y = baseY + Math.sin(elapsed * 6 + i * 2) * 0.06 * unitPerMeter;
        mesh.scale.setScalar(1 + Math.sin(elapsed * 8 + i) * 0.06);
      });
    };
    frameCallbacksRef.current.add(flickerCb);

    let flyCb: ((dt: number, elapsed: number) => void) | null = null;
    if (droneGroup && isNewResult && fireMarker.hoverAltitudeAglM != null && elevationMin != null && verticalExaggeration != null) {
      const droneY = groundY + fireMarker.hoverAltitudeAglM * verticalExaggeration;
      const hoverPos = new THREE.Vector3(x, droneY, z);
      const spawnPos = droneGroup.position.clone();
      const startTime = performance.now();
      const FLY_DURATION_S = 2.0;
      const drone = droneGroup;
      flyCb = () => {
        const t = Math.min((performance.now() - startTime) / 1000 / FLY_DURATION_S, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        drone.position.lerpVectors(spawnPos, hoverPos, eased);
        if (t >= 1) {
          if (flyCb) frameCallbacksRef.current.delete(flyCb);
          const extinguishStart = performance.now();
          const EXTINGUISH_DURATION_S = 1.5;
          const extinguishCb = () => {
            const et = Math.min((performance.now() - extinguishStart) / 1000 / EXTINGUISH_DURATION_S, 1);
            const scale = Math.max(1 - et, 0.001);
            flame.scale.setScalar(scale);
            flameMeshes.forEach((mesh) => {
              (mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - et);
            });
            (areaDisc.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - et);
            (areaRing.material as THREE.LineBasicMaterial).opacity = 1 - et;
            if (et >= 1) frameCallbacksRef.current.delete(extinguishCb);
          };
          frameCallbacksRef.current.add(extinguishCb);
        }
      };
      frameCallbacksRef.current.add(flyCb);
    }

    return () => {
      frameCallbacksRef.current.delete(flickerCb);
      if (flyCb) frameCallbacksRef.current.delete(flyCb);
      scene.remove(group);
      disposeObject3D(group);
      if (fireMarkerGroupRef.current === group) fireMarkerGroupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fireMarker, isLoaded, elevationMin, verticalExaggeration, imageWidth, metersPerOriginalPixel]);

  // Emergency-landing zone marker: a ground footprint outline (rectangle for
  // a plane, circle for a helicopter) sized/rotated to the zone's real
  // minAreaRect dimensions, colored by fit, plus -- on a genuinely new
  // selection (`animate` a fresh object reference) -- the matching
  // procedural aircraft descending onto it.
  useEffect(() => {
    const scene = sceneRef.current;
    const existing = landingMarkerGroupRef.current;
    if (existing) {
      scene?.remove(existing);
      disposeObject3D(existing);
      landingMarkerGroupRef.current = null;
    }
    if (!scene || !isLoaded || !landingMarker) return;
    if (landingMarker.spacingUnits === "meters" && !metersPerOriginalPixel) return;
    const bounds = layoutBoundsRef.current;
    if (!bounds) return;

    const boxSize = boxSizeRef.current;
    const boxCenter = boxCenterRef.current;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const [cx, cy] = landingMarker.centerPx;
    const nx = (cx - bounds.minX) / spanX - 0.5;
    const ny = (cy - bounds.minY) / spanY - 0.5;
    const x = boxCenter.x + nx * boxSize.x;
    const z = boxCenter.z + ny * boxSize.z;
    const groundY = findHeightAt(x, z) ?? boxCenter.y;

    const schematicFallback = Math.max(boxSize.length() * 0.012, 0.05);
    // The footprint's own width_m/length_m are illustrative image-pixel
    // counts (not real meters) when spacingUnits is "pixels" -- scale those
    // by the pixels-to-mesh-units ratio, not the real-meters one, or a
    // "200px" zone would render at an absurd real-meters-derived size.
    const footprintUnitScale =
      landingMarker.spacingUnits === "meters"
        ? (computeMeshUnitsPerMeter(boxSize.x, imageWidth, metersPerOriginalPixel) ?? schematicFallback)
        : (computeMeshUnitsPerPixel(boxSize.x, imageWidth) ?? schematicFallback);
    // The aircraft MODEL's own dimensions are hardcoded real illustrative
    // meters (see createPlaneGroup/createHelicopterGroup) regardless of the
    // zone's units -- it needs a real-meters scale, or the schematic
    // fallback when this job has no real-world calibration at all.
    const unitPerMeter = computeMeshUnitsPerMeter(boxSize.x, imageWidth, metersPerOriginalPixel) ?? schematicFallback;

    const group = new THREE.Group();
    const fitColor = landingMarker.fits === false ? 0xef4444 : landingMarker.fits === true ? 0x22c55e : 0x94a3b8;
    const footprintY = groundY + boxSize.y * 0.015;
    // Mesh XZ isn't necessarily aligned with image pixel X/Y (mapPoint can
    // flip/scale each axis independently), so the footprint's rotation is
    // derived from the same forward transform rather than reused directly
    // from the backend's image-space angleDeg.
    const p1 = (() => {
      const rad = (landingMarker.angleDeg * Math.PI) / 180;
      const px2 = cx + Math.cos(rad) * 10;
      const py2 = cy + Math.sin(rad) * 10;
      const nx2 = (px2 - bounds.minX) / spanX - 0.5;
      const ny2 = (py2 - bounds.minY) / spanY - 0.5;
      return { x: boxCenter.x + nx2 * boxSize.x, z: boxCenter.z + ny2 * boxSize.z };
    })();
    const meshAngle = Math.atan2(p1.z - z, p1.x - x);

    if (landingMarker.aircraftType === "plane") {
      // `widthM`/`lengthM` are both the diameter of the zone's largest
      // inscribed clear circle (see disaster.py:find_emergency_landing_zones),
      // not an independently-measured rectangle. Rendering a DxD square at
      // that diameter would have corners ~41% past the circle's edge --
      // potentially over a building the distance transform never verified
      // as clear. Only a square inscribed IN the circle (side = diameter /
      // sqrt(2)) is geometrically guaranteed to stay within the safe area
      // -- matches assess_aircraft_fit's identical correction backend-side.
      const inscribedSide = (Math.min(landingMarker.widthM, landingMarker.lengthM) / Math.SQRT2) * footprintUnitScale;
      const w = inscribedSide;
      const l = inscribedSide;
      const fillGeom = new THREE.PlaneGeometry(l, w);
      const fillMat = new THREE.MeshBasicMaterial({ color: fitColor, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.rotation.z = -meshAngle;
      fill.position.set(x, footprintY, z);
      group.add(fill);

      const outlinePts = [
        [-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2],
      ].map(([lx, lz]) => {
        const rx = lx * Math.cos(meshAngle) - lz * Math.sin(meshAngle);
        const rz = lx * Math.sin(meshAngle) + lz * Math.cos(meshAngle);
        return new THREE.Vector3(x + rx, footprintY + 0.01 * footprintUnitScale, z + rz);
      });
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outlinePts), new THREE.LineBasicMaterial({ color: fitColor }));
      group.add(outline);
    } else {
      const radius = Math.max(landingMarker.widthM, landingMarker.lengthM) / 2 * footprintUnitScale;
      const fillGeom = new THREE.CircleGeometry(radius, 32);
      const fillMat = new THREE.MeshBasicMaterial({ color: fitColor, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(x, footprintY, z);
      group.add(fill);

      const ringPts: THREE.Vector3[] = [];
      for (let i = 0; i <= 48; i++) {
        const theta = (i / 48) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(x + Math.cos(theta) * radius, footprintY + 0.01 * footprintUnitScale, z + Math.sin(theta) * radius));
      }
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: fitColor }));
      group.add(outline);
    }

    const isNewSelection = landingMarker.animate != null && landingMarker.animate !== prevLandingAnimateRef.current;
    prevLandingAnimateRef.current = landingMarker.animate ?? prevLandingAnimateRef.current;

    const aircraft = landingMarker.aircraftType === "plane" ? createPlaneGroup(unitPerMeter) : createHelicopterGroup(unitPerMeter);
    aircraft.rotation.y = -meshAngle;
    const landedPos = new THREE.Vector3(x, groundY + 0.5 * unitPerMeter, z);
    const startPos = new THREE.Vector3(x, groundY + 40 * unitPerMeter, z);
    aircraft.position.copy(isNewSelection ? startPos : landedPos);
    group.add(aircraft);

    scene.add(group);
    landingMarkerGroupRef.current = group;

    let landCb: ((dt: number, elapsed: number) => void) | null = null;
    if (isNewSelection) {
      const startTime = performance.now();
      const DURATION_S = 2.5;
      landCb = () => {
        const t = Math.min((performance.now() - startTime) / 1000 / DURATION_S, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        aircraft.position.lerpVectors(startPos, landedPos, eased);
        if (t >= 1 && landCb) frameCallbacksRef.current.delete(landCb);
      };
      frameCallbacksRef.current.add(landCb);
    }

    // Spinning main rotor for the helicopter, whether landed or mid-descent.
    const rotorBlades = aircraft.children.find((c) => c.userData.isMainRotor) as THREE.Mesh | undefined;
    let rotorCb: ((dt: number, elapsed: number) => void) | null = null;
    if (rotorBlades) {
      rotorCb = (dt: number) => {
        rotorBlades.rotation.y += dt * 12;
      };
      frameCallbacksRef.current.add(rotorCb);
    }

    return () => {
      if (landCb) frameCallbacksRef.current.delete(landCb);
      if (rotorCb) frameCallbacksRef.current.delete(rotorCb);
      scene.remove(group);
      disposeObject3D(group);
      if (landingMarkerGroupRef.current === group) landingMarkerGroupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingMarker, isLoaded, imageWidth, metersPerOriginalPixel]);

  useEffect(() => {
    if (!terrain.available || !terrain.meshUrl) {
      // No mesh to load; this component is remounted per result (ResultsScreen
      // only renders once processing completes), so initial state is already correct.
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x0b1120);
    // Fog near/far is set from the real mesh's bounding box once it loads
    // (frameCamera below) -- a fixed range would either fog out the whole
    // terrain (georeferenced meshes can span tens of thousands of meters)
    // or do nothing at all (small relative-scale meshes).
    scene.fog = new THREE.Fog(0x0b1120, 1, 10000);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.05, 5000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.left = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    labelRenderer.domElement.style.overflow = "hidden";
    container.appendChild(labelRenderer.domElement);

    const buildingLabelsGroup = new THREE.Group();
    scene.add(buildingLabelsGroup);
    buildingLabelsGroupRef.current = buildingLabelsGroup;

    const buildingHitGroup = new THREE.Group();
    scene.add(buildingHitGroup);
    buildingHitGroupRef.current = buildingHitGroup;

    const zonesGroup = new THREE.Group();
    scene.add(zonesGroup);
    zonesGroupRef.current = zonesGroup;

    const measureGroup = new THREE.Group();
    scene.add(measureGroup);
    measureGroupRef.current = measureGroup;

    scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x30271f, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 1.5, 1);
    scene.add(sun);

    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;

    const pointerControls = new PointerLockControls(camera, renderer.domElement);

    let terrainMesh: THREE.Object3D | null = null;
    let boxSize = new THREE.Vector3(1, 1, 1);
    let boxCenter = new THREE.Vector3(0, 0, 0);
    let eyeHeight = 1;
    let moveSpeed = 1;

    const raycaster = new THREE.Raycaster();
    const downVector = new THREE.Vector3(0, -1, 0);

    const keys = { forward: false, back: false, left: false, right: false, up: false, down: false };

    function clampToTerrain(target: THREE.Vector3) {
      if (!terrainMesh) return;
      raycaster.set(new THREE.Vector3(target.x, boxCenter.y + boxSize.y * 4 + 10, target.z), downVector);
      const hits = raycaster.intersectObject(terrainMesh, true);
      if (hits.length > 0) {
        target.y = hits[0].point.y + eyeHeight;
      }
    }

    function frameCamera() {
      const distance = boxSize.length() * 0.8 + 0.5;
      camera.position.set(
        boxCenter.x,
        boxCenter.y + boxSize.y + distance * 0.5,
        boxCenter.z + distance,
      );
      camera.near = Math.max(distance / 1000, 0.01);
      camera.far = distance * 100;
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = distance * 1.5;
        scene.fog.far = distance * 6;
      }
      camera.updateProjectionMatrix();
      orbitControls.target.copy(boxCenter);
      orbitControls.update();
    }

    // Tracks intent, not just PointerLockControls.isLocked: the 'lock' event
    // can lag a frame (or, in some environments, never fire, e.g. headless
    // testing without a real user gesture). Without this separate flag, the
    // render loop's orbitControls.update() call would snap the camera back
    // to the orbit-framed view every frame until the lock event lands.
    let flythroughRequested = false;

    resetViewRef.current = () => {
      exitFlythroughRef.current();
      frameCamera();
    };

    enterFlythroughRef.current = () => {
      const startPos = new THREE.Vector3(boxCenter.x, boxCenter.y + boxSize.y + eyeHeight, boxCenter.z);
      clampToTerrain(startPos);
      camera.position.copy(startPos);
      camera.lookAt(boxCenter.x, boxCenter.y, boxCenter.z - boxSize.z);
      orbitControls.enabled = false;
      flythroughRequested = true;
      setIsFlythrough(true);
      pointerControls.lock();
    };

    exitFlythroughRef.current = () => {
      flythroughRequested = false;
      setIsFlythrough(false);
      orbitControls.enabled = true;
      pointerControls.unlock();
    };

    pointerControls.addEventListener("unlock", () => {
      // The browser can unlock the pointer on its own (Esc, Alt-Tab, etc.),
      // not just via exitFlythroughRef -- keep state in sync either way.
      flythroughRequested = false;
      setIsFlythrough(false);
      orbitControls.enabled = true;
    });

    function onKeyDown(e: KeyboardEvent) {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          keys.forward = true;
          break;
        case "KeyS":
        case "ArrowDown":
          keys.back = true;
          break;
        case "KeyA":
        case "ArrowLeft":
          keys.left = true;
          break;
        case "KeyD":
        case "ArrowRight":
          keys.right = true;
          break;
        case "Space":
          keys.up = true;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          keys.down = true;
          break;
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          keys.forward = false;
          break;
        case "KeyS":
        case "ArrowDown":
          keys.back = false;
          break;
        case "KeyA":
        case "ArrowLeft":
          keys.left = false;
          break;
        case "KeyD":
        case "ArrowRight":
          keys.right = false;
          break;
        case "Space":
          keys.up = false;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          keys.down = false;
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Measurement tool: click-to-pick two points on the terrain surface.
    // Distinguishes an actual click from an orbit-drag by pointer movement.
    let pointerDownPos: { x: number; y: number } | null = null;
    const MEASURE_MARKER_COLOR = 0xf59e0b;

    function addMeasureMarker(point: THREE.Vector3) {
      const radius = Math.max(boxSize.length() * 0.006, 0.02);
      const geom = new THREE.SphereGeometry(radius, 16, 16);
      const mat = new THREE.MeshBasicMaterial({ color: MEASURE_MARKER_COLOR });
      const marker = new THREE.Mesh(geom, mat);
      marker.position.copy(point);
      measureGroup.add(marker);
    }

    function onPointerDown(e: PointerEvent) {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    }

    const SELECTION_HIGHLIGHT_COLOR = 0x60a5fa;

    function highlightSelectedBuilding(points: THREE.Vector3[] | null) {
      const existing = selectionHighlightRef.current;
      if (existing) {
        scene.remove(existing);
        existing.geometry.dispose();
        (existing.material as THREE.Material).dispose();
        selectionHighlightRef.current = null;
      }
      if (!points || points.length < 3) return;
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color: SELECTION_HIGHLIGHT_COLOR, linewidth: 2 });
      const loop = new THREE.LineLoop(geom, mat);
      scene.add(loop);
      selectionHighlightRef.current = loop;
    }

    function onPointerUpBuildingSelect(e: PointerEvent) {
      if (measureModeRef.current || !pointerDownPos) return;
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (Math.hypot(dx, dy) > 5) return; // was a drag, not a click

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(buildingHitGroup.children, false);
      if (hits.length === 0) {
        setSelectedBuilding(null);
        highlightSelectedBuilding(null);
        return;
      }
      const hitMesh = hits[0].object as THREE.Mesh;
      setSelectedBuilding(hitMesh.userData.building as Building);
      highlightSelectedBuilding(hitMesh.userData.outlinePoints as THREE.Vector3[]);
    }

    function onPointerUpTerrainPick(e: PointerEvent): boolean {
      if (!pickModeActiveRef.current || measureModeRef.current || !terrainMesh || !pointerDownPos) return false;
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (Math.hypot(dx, dy) > 5) return true; // was a drag -- consume the event, but no pick

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(terrainMesh, true);
      if (hits.length === 0) return true;

      const meshPoint = hits[0].point;
      const bounds = layoutBoundsRef.current;
      let px: number | null = null;
      let py: number | null = null;
      if (bounds) {
        // Exact inverse of mapPoint() in rebuildLabelsAndZonesRef -- same
        // fallback-to-1 for a degenerate (zero-width/height) bounds span.
        const spanX = bounds.maxX - bounds.minX || 1;
        const spanY = bounds.maxY - bounds.minY || 1;
        const nx = (meshPoint.x - boxCenter.x) / boxSize.x;
        const nz = (meshPoint.z - boxCenter.z) / boxSize.z;
        px = (nx + 0.5) * spanX + bounds.minX;
        py = (nz + 0.5) * spanY + bounds.minY;
      }
      onTerrainPickRef.current?.({ px, py, mesh: { x: meshPoint.x, y: meshPoint.y, z: meshPoint.z } });
      return true;
    }

    function onPointerUp(e: PointerEvent) {
      if (onPointerUpTerrainPick(e)) {
        pointerDownPos = null;
        return;
      }
      onPointerUpBuildingSelect(e);
      if (!measureModeRef.current || !terrainMesh || !pointerDownPos) {
        pointerDownPos = null;
        return;
      }
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      pointerDownPos = null;
      if (Math.hypot(dx, dy) > 5) return; // was a drag, not a click

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(terrainMesh, true);
      if (hits.length === 0) return;

      const points = measurePointsRef.current;
      if (points.length >= 2) {
        points.length = 0;
        measureGroup.clear();
      }
      points.push(hits[0].point.clone());
      addMeasureMarker(hits[0].point);

      if (points.length === 2) {
        const [a, b] = points;
        const lineGeom = new THREE.BufferGeometry().setFromPoints([a, b]);
        const lineMat = new THREE.LineBasicMaterial({ color: MEASURE_MARKER_COLOR });
        measureGroup.add(new THREE.Line(lineGeom, lineMat));

        const horizontalDistance = Math.hypot(b.x - a.x, b.z - a.z);
        const heightDelta = Math.abs(b.y - a.y);
        const distance = a.distanceTo(b);
        const slopeDegrees =
          horizontalDistance > 1e-9 ? (Math.atan2(heightDelta, horizontalDistance) * 180) / Math.PI : 90;
        setMeasureResult({ distance, horizontalDistance, heightDelta, slopeDegrees });
      } else {
        setMeasureResult(null);
      }
    }

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const loader = new GLTFLoader();
    loader.load(
      terrain.meshUrl,
      (gltf) => {
        if (disposed) return;
        terrainMesh = gltf.scene;
        terrainMeshRef.current = terrainMesh;
        scene.add(terrainMesh);

        const box = new THREE.Box3().setFromObject(terrainMesh);
        boxSize = box.getSize(new THREE.Vector3());
        boxCenter = box.getCenter(new THREE.Vector3());
        boxSizeRef.current = boxSize;
        boxCenterRef.current = boxCenter;
        eyeHeight = Math.max(boxSize.y * EYE_HEIGHT_FRACTION, boxSize.length() * 0.01, 0.05);
        moveSpeed = Math.max(boxSize.length() * MOVE_SPEED_FRACTION, 0.5);

        frameCamera();
        setIsLoaded(true);
        rebuildLabelsAndZonesRef.current();
      },
      undefined,
      (err) => {
        if (disposed) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load terrain.glb");
      },
    );

    const clock = new THREE.Clock();
    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      const elapsed = clock.getElapsedTime();
      frameCallbacksRef.current.forEach((cb) => cb(dt, elapsed));

      if (flythroughRequested) {
        const step = moveSpeed * dt;
        if (keys.forward) pointerControls.moveForward(step);
        if (keys.back) pointerControls.moveForward(-step);
        if (keys.right) pointerControls.moveRight(step);
        if (keys.left) pointerControls.moveRight(-step);
        if (keys.up) camera.position.y += step;
        if (keys.down) camera.position.y -= step;
        clampToTerrain(camera.position);
      } else {
        orbitControls.update();
      }

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      labelRenderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);
    // Entering/exiting fullscreen resizes the container element without
    // necessarily firing a window "resize" event (the viewport itself
    // doesn't change size, only the container does) -- without this, the
    // renderer/camera would keep the pre-fullscreen aspect ratio.
    document.addEventListener("fullscreenchange", handleResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("fullscreenchange", handleResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      cancelAnimationFrame(frameId);
      pointerControls.unlock();
      pointerControls.dispose();
      orbitControls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of materials) {
            mat.map?.dispose();
            mat.dispose?.();
          }
        }
      });
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      if (container.contains(labelRenderer.domElement)) {
        container.removeChild(labelRenderer.domElement);
      }
      sceneRef.current = null;
      cameraRef.current = null;
      terrainMeshRef.current = null;
      buildingLabelsGroupRef.current = null;
      buildingHitGroupRef.current = null;
      selectionHighlightRef.current = null;
      zonesGroupRef.current = null;
      confidencePlaneRef.current = null;
      measureGroupRef.current = null;
      layoutBoundsRef.current = null;
      waterPlaneRef.current = null;
      bombRingsGroupRef.current = null;
      fireMarkerGroupRef.current = null;
      landingMarkerGroupRef.current = null;
      frameCallbacksRef.current.clear();
    };
  }, [terrain.available, terrain.meshUrl]);

  const hasBuildingLabels = buildingsAvailable && buildings.length > 0;
  const hasZones = zonesAvailable && disasterZones.length > 0;
  const zoneTypesPresent = Array.from(new Set(disasterZones.map((z) => z.type)));

  return (
    <div className="glass-panel overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">3D Terrain Flythrough</p>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              terrain.available
                ? "border border-secondary/30 bg-secondary/10 text-secondary"
                : "border border-border bg-muted/50 text-muted-foreground"
            }`}
          >
            {terrain.available ? "Real result" : "Pending"}
          </span>
          {terrain.available && (
            <span className="text-[11px] text-muted-foreground">
              {terrain.vertexCount?.toLocaleString()} vertices &middot; {terrain.triangleCount?.toLocaleString()} tris
              {" "}&middot; {terrain.isMetric ? "metric" : "relative"} elevation
            </span>
          )}
          {hasBuildingLabels && (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
              {buildings.length} building{buildings.length === 1 ? "" : "s"} detected
            </span>
          )}
        </div>
        {isLoaded && !isFlythrough && (
          // Once flythrough is active, the Pointer Lock API captures every mouse event for the
          // canvas -- these buttons would be visually present but genuinely unclickable, so they're
          // only rendered in the orbit-view state. Escape (native browser behavior, see the on-screen
          // hint below) is the only way out of flythrough, matching every other pointer-lock app/game.
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => enterFlythroughRef.current()}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Enter Flythrough
            </button>
            <button
              type="button"
              onClick={() => resetViewRef.current()}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              Reset View
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "View fullscreen"}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </button>
          </div>
        )}
      </div>

      {isLoaded && !isFlythrough && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/60 px-5 py-2.5">
          <ToggleChip
            label="Building Labels"
            active={showBuildingLabels}
            disabled={!hasBuildingLabels}
            onClick={() => setShowBuildingLabels((v) => !v)}
            title={hasBuildingLabels ? undefined : "No building height data available for this job yet"}
          />
          <ToggleChip
            label="Confidence Overlay"
            active={showConfidence}
            disabled={!confidencePreviewUrl}
            onClick={() => setShowConfidence((v) => !v)}
            title={confidencePreviewUrl ? undefined : "No confidence preview available for this job"}
          />
          <ToggleChip
            label="Disaster Zones"
            active={showZones}
            disabled={!hasZones}
            onClick={() => setShowZones((v) => !v)}
            title={hasZones ? undefined : "No disaster-zone data available for this job yet"}
          />
          <ToggleChip
            label={measureMode ? "Measuring... (click 2 points)" : "Measure Height/Slope"}
            active={measureMode}
            onClick={toggleMeasureMode}
            accent="neutral"
          />
        </div>
      )}

      <div
        ref={containerRef}
        className={`relative flex items-center justify-center bg-black/40 ${
          isFullscreen ? "h-screen w-screen" : "h-96"
        } ${measureMode || pickModeActive ? "cursor-crosshair" : ""}`}
      >
        {!terrain.available && (
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-muted-foreground" stroke="currentColor" strokeWidth={1.5}>
              <path d="M3 20l6-10 4 6 3-4 5 8H3z" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="17" cy="6" r="2" />
            </svg>
            <p className="text-sm text-muted-foreground">
              3D terrain mesh has not been generated for this job yet -- no placeholder terrain is shown here.
            </p>
          </div>
        )}
        {terrain.available && loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/80 px-6 text-center">
            <p className="text-sm text-red-300">Failed to load terrain.glb: {loadError}</p>
          </div>
        )}
        {terrain.available && !isLoaded && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading terrain mesh...</p>
          </div>
        )}
        {isFlythrough && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-card/80 px-3 py-1.5 text-[11px] text-muted-foreground">
            W/A/S/D to move &middot; mouse to look &middot; Space/Shift up/down &middot; Esc to exit
          </div>
        )}
        {isLoaded && !isFlythrough && measureMode && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-card/85 px-3 py-2 text-[11px] text-muted-foreground">
            {measureResult ? (
              <>
                Distance: {measureResult.distance.toFixed(2)} m &middot; Horizontal:{" "}
                {measureResult.horizontalDistance.toFixed(2)} m &middot; &Delta;height:{" "}
                {measureResult.heightDelta.toFixed(2)} m &middot; Slope: {measureResult.slopeDegrees.toFixed(1)}&deg;
              </>
            ) : (
              "Click two points on the terrain to measure distance and slope."
            )}
          </div>
        )}
        {isLoaded && !isFlythrough && !measureMode && hasBuildingLabels && (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg bg-card/85 px-3 py-2 text-[11px] text-muted-foreground">
            {selectedBuilding ? (
              <>
                <span className="font-semibold text-foreground">Selected building</span> &middot; Height:{" "}
                {selectedBuilding.heightM.toFixed(1)} m {!selectedBuilding.isMetric && "(relative)"}
                {typeof selectedBuilding.confidence === "number" && (
                  <> &middot; Confidence: {(selectedBuilding.confidence * 100).toFixed(0)}%</>
                )}
                {selectedBuilding.shadowEstimateM != null && (
                  <> &middot; Shadow est.: {selectedBuilding.shadowEstimateM.toFixed(1)} m</>
                )}
              </>
            ) : (
              "Click a building on the terrain to see its height."
            )}
          </div>
        )}
        {isLoaded && !isFlythrough && showZones && zoneTypesPresent.length > 0 && (
          <div className="pointer-events-none absolute right-3 top-3 space-y-1 rounded-lg bg-card/85 px-3 py-2 text-[11px] text-muted-foreground">
            {zoneTypesPresent.map((type) => (
              <div key={type} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: ZONE_COLOR[type] }} />
                {ZONE_LABEL[type]}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleChip({
  label,
  active,
  disabled,
  onClick,
  title,
  accent = "primary",
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  accent?: "primary" | "neutral";
}) {
  const activeClass =
    accent === "neutral"
      ? "border-muted-foreground/50 bg-muted-foreground/15 text-muted-foreground"
      : "border-primary/50 bg-primary/15 text-primary";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground"
          : active
            ? activeClass
            : "border-border bg-muted/50 text-muted-foreground hover:border-primary/40 hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
