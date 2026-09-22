import type { UploadedFile, UploadResult } from "@/lib/types/upload";
import { formatBytes } from "@/lib/validation/file";
import { GeoStatusBadge } from "./GeoStatusBadge";

interface ImagePreviewCardProps {
  uploadedFile: UploadedFile;
  uploadResult: UploadResult | null;
  isCheckingGeo: boolean;
  onChangeImage: () => void;
  onProcess: () => void;
  processDisabled: boolean;
  processLabel: string;
}

export function ImagePreviewCard({
  uploadedFile,
  uploadResult,
  isCheckingGeo,
  onChangeImage,
  onProcess,
  processDisabled,
  processLabel,
}: ImagePreviewCardProps) {
  const isTiff = uploadedFile.extension === "tif" || uploadedFile.extension === "tiff";

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="relative flex h-72 items-center justify-center bg-slate-100">
        {isTiff && uploadedFile.width === null ? (
          <div className="flex flex-col items-center gap-2 px-6 text-center text-slate-500">
            <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 15l4-4 5 5 3-3 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-sm">
              Browser preview isn&apos;t available for this TIFF/GeoTIFF. It will still be uploaded and processed
              as-is.
            </p>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- previewUrl is a blob: object URL from the user's File, not a static asset next/image can optimize.
          <img
            src={uploadedFile.previewUrl}
            alt={`Preview of uploaded file ${uploadedFile.name}`}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-900">{uploadedFile.name}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {formatBytes(uploadedFile.sizeBytes)}
              {uploadedFile.width && uploadedFile.height ? ` · ${uploadedFile.width}×${uploadedFile.height}px` : ""}
              {" · "}
              {uploadedFile.extension.toUpperCase()}
            </p>
          </div>
          <button
            type="button"
            onClick={onChangeImage}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
          >
            Change Image
          </button>
        </div>

        <GeoStatusBadge uploadResult={uploadResult} isChecking={isCheckingGeo} />

        <button
          type="button"
          onClick={onProcess}
          disabled={processDisabled}
          className="w-full rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {processLabel}
        </button>
      </div>
    </div>
  );
}
