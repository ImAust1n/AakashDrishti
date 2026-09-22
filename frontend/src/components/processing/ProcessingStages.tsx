import { PROCESSING_STAGE_ORDER, STAGE_LABEL, type ProcessingStatus } from "@/lib/types/processing";

interface ProcessingStagesProps {
  processingStatus: ProcessingStatus | null;
  /** True while we're still uploading, before the backend has assigned a stage. */
  isUploading: boolean;
}

export function ProcessingStages({ processingStatus, isUploading }: ProcessingStagesProps) {
  const currentIndex = processingStatus ? PROCESSING_STAGE_ORDER.indexOf(processingStatus.stage) : -1;

  const progress = isUploading ? 0 : (processingStatus?.progress ?? 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">
          {isUploading ? "Uploading image to backend..." : "Processing pipeline"}
        </p>
        <span className="text-xs font-medium text-slate-500">{progress}%</span>
      </div>
      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-cyan-600 transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="space-y-4">
        {PROCESSING_STAGE_ORDER.map((stage, index) => {
          const isDone = currentIndex > index;
          const isActive = currentIndex === index;
          return (
            <li key={stage} className="flex items-center gap-3">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  isDone
                    ? "bg-cyan-600 text-white"
                    : isActive
                      ? "border-2 border-cyan-500 text-cyan-600"
                      : "border border-slate-300 text-slate-400"
                }`}
              >
                {isDone ? "✓" : index + 1}
              </span>
              <span
                className={`text-sm ${
                  isDone ? "text-slate-400 line-through decoration-slate-300" : isActive ? "font-medium text-slate-900" : "text-slate-500"
                }`}
              >
                {STAGE_LABEL[stage]}
              </span>
              {isActive && (
                <span className="ml-auto flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-500 [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-500 [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-500" />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
