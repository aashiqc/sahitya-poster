import { useEffect, useRef, useState } from "react";
import { Download, Share2, X } from "lucide-react";
import type Konva from "konva";
import {
  TEAMS,
  computeStandings,
  snapshotBucket,
} from "~/lib/teams";
import {
  StandingsPosterCanvas,
  exportStandingsPng,
  shareStandings,
} from "./standings-poster";

export type StandingsWinner = {
  unit_ml: string | null;
  marks: number | null;
  grade: string | null;
};

export function StandingsSheet({
  totalPublished,
  winners,
  onClose,
}: {
  totalPublished: number;
  winners: ReadonlyArray<StandingsWinner>;
  onClose: () => void;
}) {
  const snapshotN = snapshotBucket(totalPublished);
  const rows = computeStandings(winners);
  const noResults = snapshotN === 0;

  const stageRef = useRef<Konva.Stage | null>(null);
  const [busy, setBusy] = useState<null | "download" | "share">(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function onDownload() {
    setBusy("download");
    try {
      await exportStandingsPng(stageRef.current, `standings_after_${snapshotN}.png`);
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    setBusy("share");
    try {
      await shareStandings(stageRef.current, snapshotN);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Team standings"
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center bg-black/55 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative bg-gradient-to-b from-[#23110F] to-[#0B090A] text-white px-5 py-4 flex items-start justify-between gap-3">
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-yellow/60 to-transparent"
          />
          <div>
            <h2 className="text-lg font-bold">Team Standings</h2>
            <p className="text-xs text-white/70 mt-0.5">
              {noResults
                ? "Standings open after the first 5 results."
                : `Snapshot after ${snapshotN} ${snapshotN === 1 ? "result" : "results"}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 size-9 grid place-items-center rounded-full bg-white/12 hover:bg-white/20 text-white transition-colors"
          >
            <X className="size-[18px]" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 sm:p-5">
          {noResults ? (
            <EmptyState />
          ) : (
            <>
              <div className="overflow-hidden rounded-2xl ring-1 ring-black/10 shadow-[0_12px_30px_-16px_rgba(11,9,10,0.4)]">
                <StandingsPosterCanvas
                  data={{
                    afterN: snapshotN,
                    rows: rows.map((r) => ({
                      name: r.team.name,
                      points: r.points,
                    })),
                  }}
                  stageRef={stageRef}
                />
              </div>

              <div className="mt-4 flex items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 rounded-full bg-red text-white px-5 py-2.5 text-sm font-semibold shadow-[0_6px_16px_-6px_rgba(191,6,3,0.6)] transition-all duration-200 active:scale-[0.97] hover:bg-brand-600 disabled:opacity-50"
                >
                  {busy === "download" ? <Spinner /> : <Download className="size-[18px]" aria-hidden />}
                  Download
                </button>
                <button
                  type="button"
                  onClick={onShare}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 rounded-full border border-black/15 bg-white text-ink-800 px-5 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-[0.97] hover:border-yellow hover:bg-yellow/15 disabled:opacity-50"
                >
                  {busy === "share" ? <Spinner /> : <Share2 className="size-[18px]" aria-hidden />}
                  Share
                </button>
              </div>

              {totalPublished > snapshotN && (
                <p className="text-[11px] text-ink-400 mt-3 text-center">
                  Figures refresh at the next multiple of 5 results.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 rounded-full border-2 border-current/30 border-t-current animate-spin"
    />
  );
}

function EmptyState() {
  return (
    <div className="py-8 text-center">
      <p className="text-sm text-ink-700">
        No standings yet. Once 5 results are published, the first standings
        poster will appear here.
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-1.5 text-left">
        {TEAMS.map((t) => (
          <li
            key={t.slug}
            className="text-xs text-ink-500 px-2.5 py-1.5 border border-black/10 rounded-lg"
          >
            {t.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
