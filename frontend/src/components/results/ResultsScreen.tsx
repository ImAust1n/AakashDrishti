import type { UploadResult } from "@/lib/types/upload";
import type { ProcessingResult } from "@/lib/types/results";
import { OriginalImagePreview } from "./OriginalImagePreview";
import { ResultPanel } from "./ResultPanel";
import { TerrainViewer } from "@/components/viewer/TerrainViewer";

interface ResultsScreenProps {
  result: ProcessingResult;
  uploadResult: UploadResult | null;
  onStartOver: () => void;
}

export function ResultsScreen({ result, uploadResult, onStartOver }: ResultsScreenProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Results</h2>
          <p className="text-sm text-slate-500">Job {result.jobId}</p>
        </div>
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
        >
          Process Another Image
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">Original Image</p>
            <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
              Real result
            </span>
          </div>
          <div className="flex h-64 items-center justify-center bg-slate-100 p-3">
            <OriginalImagePreview src={result.originalImageUrl} />
          </div>
        </div>

        <ResultPanel
          title="Fused Depth Map"
          available={result.depth.available}
          unavailableNote="Depth Anything V2 + Depth Pro fusion has not been run for this job yet."
        >
          {result.depth.previewUrl && (
            <div className="flex h-full w-full flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={result.depth.previewUrl}
                alt="Fused depth map"
                className="max-h-52 w-full object-contain"
              />
              {result.depth.daV2Stats && result.depth.depthProStats && (
                <p className="text-center text-[11px] text-slate-500">
                  DA V2: {result.depth.daV2Stats.min.toFixed(2)}&ndash;{result.depth.daV2Stats.max.toFixed(2)} &middot;
                  {" "}Depth Pro: {result.depth.depthProStats.min.toFixed(3)}&ndash;{result.depth.depthProStats.max.toFixed(3)} m
                </p>
              )}
            </div>
          )}
        </ResultPanel>

        <ResultPanel
          title={result.dsm.isMetric ? "DSM (metric)" : "rDSM (relative)"}
          available={result.dsm.available}
          unavailableNote="DSM/rDSM generation (FR-6/FR-7) has not been implemented on the backend yet."
        >
          {result.dsm.previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.dsm.previewUrl} alt="DSM / rDSM elevation map" className="max-h-full max-w-full object-contain" />
          )}
        </ResultPanel>

        <ResultPanel
          title="Confidence / Uncertainty"
          available={result.confidence.available}
          unavailableNote="Confidence mapping (FR-5) has not been implemented on the backend yet."
        >
          {result.confidence.previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.confidence.previewUrl} alt="Depth confidence map" className="max-h-full max-w-full object-contain" />
          )}
        </ResultPanel>
      </div>

      <TerrainViewer terrain={result.terrain} />

      <ResultPanel
        title="Reference Validation (RMSE / MAE / Correlation)"
        available={result.validation.available}
        unavailableNote="Reference/LiDAR validation (FR-11) requires calibration + reference DEM data and has not been implemented yet."
      />

      {uploadResult?.geo && (
        <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
          <p className="mb-2 text-sm font-medium text-slate-800">Geospatial Metadata (from backend)</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-4">
            <dt className="text-slate-500">CRS</dt>
            <dd className="col-span-3 text-slate-700">{uploadResult.geo.crs}</dd>
            <dt className="text-slate-500">Resolution</dt>
            <dd className="col-span-3 text-slate-700">
              {uploadResult.geo.resolution[0].toFixed(3)} x {uploadResult.geo.resolution[1].toFixed(3)}
            </dd>
            <dt className="text-slate-500">Bounds</dt>
            <dd className="col-span-3 text-slate-700">{uploadResult.geo.bounds.map((b) => b.toFixed(2)).join(", ")}</dd>
            <dt className="text-slate-500">NoData</dt>
            <dd className="col-span-3 text-slate-700">{uploadResult.geo.nodata ?? "none"}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
