export function AppHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-50 text-cyan-600">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth={1.75}>
              <path d="M3 17l6-6 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 7h7v7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold tracking-wide text-slate-900">DepthWizard</p>
            <p className="text-xs text-slate-500">Single-View Height Estimation &amp; 3D Flythrough</p>
          </div>
        </div>
        <div className="hidden text-right text-xs text-slate-500 sm:block">
          <p>SIH 2026 &middot; PS 26175</p>
          <p>ISRO / Department of Space</p>
        </div>
      </div>
    </header>
  );
}
