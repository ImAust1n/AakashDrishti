"use client";

import { AppHeader } from "@/components/common/AppHeader";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { UploadDropzone } from "@/components/upload/UploadDropzone";
import { ImagePreviewCard } from "@/components/upload/ImagePreviewCard";
import { ProcessingStages } from "@/components/processing/ProcessingStages";
import { ResultsScreen } from "@/components/results/ResultsScreen";
import { useDepthWizardWorkflow } from "@/hooks/useDepthWizardWorkflow";
import type { UploadResult } from "@/lib/types/upload";

export default function Home() {
  const {
    status,
    uploadedFile,
    validationError,
    uploadResult,
    processingStatus,
    result,
    errorMessage,
    selectFile,
    clearFile,
    startProcessing,
  } = useDepthWizardWorkflow();

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <AppHeader />
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        {status === "idle" && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Upload Your Own Image</h1>
              <p className="mt-1 text-sm text-slate-600">
                Start by uploading a single-view remote-sensing image (PNG, JPG, TIFF, or GeoTIFF). DepthWizard runs
                real Depth Anything V2 + Depth Pro inference, calibrated elevation, and 3D terrain reconstruction on
                it -- there is no sample data preloaded.
              </p>
            </div>
            <UploadDropzone onFileSelected={selectFile} validationError={validationError} />
          </div>
        )}

        {status === "selected" && uploadedFile && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Review Your Image</h1>
              <p className="mt-1 text-sm text-slate-600">
                Confirm this is the correct image, then process it. Nothing is sent to the backend until you click
                Process Image.
              </p>
            </div>
            <ImagePreviewCard
              uploadedFile={uploadedFile}
              uploadResult={uploadResult}
              isCheckingGeo={false}
              onChangeImage={clearFile}
              onProcess={startProcessing}
              processDisabled={false}
              processLabel="Process Image"
            />
          </div>
        )}

        {(status === "uploading" || status === "processing") && uploadedFile && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">Processing</h1>
                <p className="mt-1 text-sm text-slate-600">{uploadedFile.name}</p>
              </div>
              {uploadResult && (
                <ImagePreviewGeoInline uploadResult={uploadResult} />
              )}
            </div>
            <ProcessingStages processingStatus={processingStatus} isUploading={status === "uploading"} />
          </div>
        )}

        {status === "error" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">Processing</h1>
                <p className="mt-1 text-sm text-slate-600">{uploadedFile?.name}</p>
              </div>
              {uploadResult && <ImagePreviewGeoInline uploadResult={uploadResult} />}
            </div>
            {errorMessage && <ErrorBanner message={errorMessage} />}
            <div className="flex gap-3">
              {uploadedFile && (
                <button
                  type="button"
                  onClick={startProcessing}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={clearFile}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
              >
                Upload a Different Image
              </button>
            </div>
          </div>
        )}

        {status === "complete" && result && (
          <ResultsScreen result={result} uploadResult={uploadResult} onStartOver={clearFile} />
        )}
      </main>
      <footer className="border-t border-slate-200 px-6 py-4 text-center text-xs text-slate-500">
        DepthWizard &middot; Disaster Management &middot; Smart India Hackathon 2026
      </footer>
    </div>
  );
}

function ImagePreviewGeoInline({ uploadResult }: { uploadResult: UploadResult }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        uploadResult.isGeoreferenced ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${uploadResult.isGeoreferenced ? "bg-emerald-500" : "bg-amber-500"}`} />
      {uploadResult.isGeoreferenced ? "GeoTIFF detected" : "Non-georeferenced image"}
    </span>
  );
}
