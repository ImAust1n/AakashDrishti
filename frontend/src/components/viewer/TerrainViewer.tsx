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
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

import type { TerrainMeshResult } from "@/lib/types/results";

interface TerrainViewerProps {
  terrain: TerrainMeshResult;
}

const MOVE_SPEED_FRACTION = 0.25; // fraction of terrain size crossed per second
const EYE_HEIGHT_FRACTION = 0.08; // fraction of terrain vertical extent used as eye height above ground

export function TerrainViewer({ terrain }: TerrainViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isFlythrough, setIsFlythrough] = useState(false);

  const resetViewRef = useRef<() => void>(() => {});
  const enterFlythroughRef = useRef<() => void>(() => {});
  const exitFlythroughRef = useRef<() => void>(() => {});

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
    scene.background = new THREE.Color(0x0b1120);
    // Fog near/far is set from the real mesh's bounding box once it loads
    // (frameCamera below) -- a fixed range would either fog out the whole
    // terrain (georeferenced meshes can span tens of thousands of meters)
    // or do nothing at all (small relative-scale meshes).
    scene.fog = new THREE.Fog(0x0b1120, 1, 10000);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.05, 5000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

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

    const loader = new GLTFLoader();
    loader.load(
      terrain.meshUrl,
      (gltf) => {
        if (disposed) return;
        terrainMesh = gltf.scene;
        scene.add(terrainMesh);

        const box = new THREE.Box3().setFromObject(terrainMesh);
        boxSize = box.getSize(new THREE.Vector3());
        boxCenter = box.getCenter(new THREE.Vector3());
        eyeHeight = Math.max(boxSize.y * EYE_HEIGHT_FRACTION, boxSize.length() * 0.01, 0.05);
        moveSpeed = Math.max(boxSize.length() * MOVE_SPEED_FRACTION, 0.5);

        frameCamera();
        setIsLoaded(true);
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
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
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
    };
  }, [terrain.available, terrain.meshUrl]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-800">3D Terrain Flythrough</p>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              terrain.available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
            }`}
          >
            {terrain.available ? "Real result" : "Pending"}
          </span>
          {terrain.available && (
            <span className="text-[11px] text-slate-500">
              {terrain.vertexCount?.toLocaleString()} vertices &middot; {terrain.triangleCount?.toLocaleString()} tris
              {" "}&middot; {terrain.isMetric ? "metric" : "relative"} elevation
            </span>
          )}
        </div>
        {isLoaded && !isFlythrough && (
          // Once flythrough is active, the Pointer Lock API captures every mouse event for the
          // canvas -- these buttons would be visually present but genuinely unclickable, so they're
          // only rendered in the orbit-view state. Escape (native browser behavior, see the on-screen
          // hint below) is the only way out of flythrough, matching every other pointer-lock app/game.
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => enterFlythroughRef.current()}
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500"
            >
              Enter Flythrough
            </button>
            <button
              type="button"
              onClick={() => resetViewRef.current()}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
            >
              Reset View
            </button>
          </div>
        )}
      </div>
      <div ref={containerRef} className="relative flex h-96 items-center justify-center bg-slate-950">
        {!terrain.available && (
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-slate-500" stroke="currentColor" strokeWidth={1.5}>
              <path d="M3 20l6-10 4 6 3-4 5 8H3z" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="17" cy="6" r="2" />
            </svg>
            <p className="text-sm text-slate-400">
              3D terrain mesh has not been generated for this job yet -- no placeholder terrain is shown here.
            </p>
          </div>
        )}
        {terrain.available && loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 px-6 text-center">
            <p className="text-sm text-red-300">Failed to load terrain.glb: {loadError}</p>
          </div>
        )}
        {terrain.available && !isLoaded && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-slate-500">Loading terrain mesh...</p>
          </div>
        )}
        {isFlythrough && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-slate-950/80 px-3 py-1.5 text-[11px] text-slate-300">
            W/A/S/D to move &middot; mouse to look &middot; Space/Shift up/down &middot; Esc to exit
          </div>
        )}
      </div>
    </div>
  );
}
