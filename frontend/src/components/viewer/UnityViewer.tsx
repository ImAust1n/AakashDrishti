"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";

import { API_BASE_URL } from "@/lib/api/client";

/** Messages the Unity WebGL build posts to its parent window (see the Unity project's README). */
type ViewerMessage =
  | { type: "ready" }
  | { type: "progress"; value: number }
  | { type: "error"; message: string }
  | { type: "buildingSelected"; id: number; height_m: number };

interface UnityViewerProps {
  jobId: string;
}

export function UnityViewer({ jobId }: UnityViewerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: number; heightM: number } | null>(null);

  useEffect(() => {
    setProgress(0);
    setError(null);
    setSelected(null);

    function onMessage(event: MessageEvent<ViewerMessage>) {
      // The build posts with target origin "*", so only trust our own iframe.
      if (event.source !== frameRef.current?.contentWindow || !event.data) return;
      const msg = event.data;
      if (msg.type === "progress") setProgress(msg.value);
      else if (msg.type === "error") setError(msg.message);
      else if (msg.type === "buildingSelected") setSelected({ id: msg.id, heightM: msg.height_m });
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [jobId]);

  const src = `/unity/index.html?api=${encodeURIComponent(API_BASE_URL)}&job=${encodeURIComponent(jobId)}`;

  return (
    <div className="glass-panel rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
        <span>
          Orbit: left-drag / wheel · Fly: press <kbd>C</kbd>, then WASD + mouse (Q/E down/up, Shift = fast)
        </span>
        <span className="flex items-center gap-3">
          {selected && (
            <span className="text-foreground">
              Building #{selected.id}: {selected.heightM.toFixed(1)} m
            </span>
          )}
          <button
            type="button"
            onClick={() => frameRef.current?.requestFullscreen?.()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-white/10"
          >
            <Maximize2 className="size-3.5" /> Fullscreen
          </button>
        </span>
      </div>

      <iframe
        ref={frameRef}
        key={jobId}
        src={src}
        title="AakashDrishti 3D viewer"
        allow="fullscreen"
        className="h-[70vh] min-h-[480px] w-full rounded-xl border border-white/10 bg-[#0b0e14]"
      />

      {error ? (
        <p className="mt-2 whitespace-pre-wrap px-2 text-xs text-red-400">Viewer error: {error}</p>
      ) : progress > 0 && progress < 1 ? (
        <p className="mt-2 px-2 text-xs text-muted-foreground">Loading scene… {Math.round(progress * 100)}%</p>
      ) : null}
    </div>
  );
}
