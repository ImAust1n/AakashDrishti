import type { UploadResult } from "@/lib/types/upload";

interface GeoStatusBadgeProps {
  /** null = not checked yet (before upload), "checking" while the upload request is in flight. */
  uploadResult: UploadResult | null;
  isChecking: boolean;
}

export function GeoStatusBadge({ uploadResult, isChecking }: GeoStatusBadgeProps) {
  if (isChecking) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
        Checking geospatial metadata...
      </span>
    );
  }

  if (!uploadResult) {
    return null;
  }

  if (uploadResult.isGeoreferenced) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        GeoTIFF detected &middot; {uploadResult.geo?.crs ?? "CRS unknown"}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Non-georeferenced image &middot; relative depth only
    </span>
  );
}
