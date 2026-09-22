interface ResultPanelProps {
  title: string;
  available: boolean;
  unavailableNote: string;
  children?: React.ReactNode;
}

export function ResultPanel({ title, available, unavailableNote, children }: ResultPanelProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
            available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {available ? "Real result" : "Not yet available"}
        </span>
      </div>
      <div className="flex min-h-40 items-center justify-center p-5">
        {available ? (
          children
        ) : (
          <p className="max-w-xs text-center text-sm text-slate-500">{unavailableNote}</p>
        )}
      </div>
    </div>
  );
}
