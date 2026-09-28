"use client";

import { useState, type ComponentProps } from "react";

import { TerrainViewer } from "./TerrainViewer";
import { UnityViewer } from "./UnityViewer";

type Mode = "unity" | "classic";

/** Interactive Unity WebGL viewer (default) or the classic Three.js viewer. Only one is mounted at a time. */
export function ViewerSwitcher(props: ComponentProps<typeof TerrainViewer>) {
  const [mode, setMode] = useState<Mode>("unity");

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-sm">
        {(
          [
            ["unity", "Interactive 3D (Unity)"],
            ["classic", "Classic viewer"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`rounded-full px-4 py-1.5 transition-colors ${
              mode === value ? "bg-white/15 text-foreground" : "text-muted-foreground hover:bg-white/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "unity" ? <UnityViewer jobId={props.jobId} /> : <TerrainViewer {...props} />}
    </div>
  );
}
