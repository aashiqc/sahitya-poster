import { useEffect } from "react";
import { X } from "lucide-react";
import {
  TEAMS,
  computeStandings,
  snapshotBucket,
  type StandingRow,
} from "~/lib/teams";

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
  const leader = rows[0];
  const noResults = snapshotN === 0;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Team standings"
      className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-black text-white px-5 py-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Team standings</h2>
            <p className="text-xs text-white/80 mt-0.5">
              {noResults
                ? "Standings open after the first 5 results are published."
                : `After ${snapshotN} ${snapshotN === 1 ? "result" : "results"}${
                    totalPublished > snapshotN
                      ? ` · next update at ${snapshotN + 5}`
                      : ""
                  }`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 size-9 grid place-items-center rounded-full bg-black/15 hover:bg-black/25 text-white"
          >
            <X className="size-[18px]" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4 sm:p-5">
          {noResults ? (
            <EmptyState />
          ) : (
            <ol className="space-y-2">
              {rows.map((r, i) => (
                <Row
                  key={r.team.slug}
                  row={r}
                  rank={i + 1}
                  isLeader={r === leader && r.points > 0}
                />
              ))}
            </ol>
          )}

          {!noResults && totalPublished > snapshotN && (
            <p className="text-[11px] text-black/50 mt-4 text-center">
              {totalPublished - snapshotN} new{" "}
              {totalPublished - snapshotN === 1 ? "result" : "results"} since
              this snapshot — figures update at the next multiple of 5.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  rank,
  isLeader,
}: {
  row: StandingRow;
  rank: number;
  isLeader: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${
        isLeader
          ? "border-yellow bg-yellow/10"
          : "border-black/10 bg-white"
      }`}
    >
      <span
        className={`shrink-0 size-7 grid place-items-center rounded-full text-[11px] font-semibold tabular-nums ${
          rank === 1
            ? "bg-yellow text-black"
            : rank === 2
            ? "bg-black/10 text-black"
            : rank === 3
            ? "bg-red text-white"
            : "bg-black/5 text-black/70"
        }`}
      >
        {rank}
      </span>
      <span className="text-sm font-medium text-black flex-1 truncate">
        {row.team.name}
      </span>
      <span className="text-sm font-semibold tabular-nums text-black">
        {row.points}
      </span>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="py-8 text-center">
      <p className="text-sm text-black/70">
        No standings yet. Once 5 results are published, the first snapshot will
        appear here.
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-1.5 text-left">
        {TEAMS.map((t) => (
          <li
            key={t.slug}
            className="text-xs text-black/60 px-2.5 py-1.5 border border-black/10 rounded-lg"
          >
            {t.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
