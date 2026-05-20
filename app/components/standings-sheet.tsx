import { useEffect, useRef, useState } from "react";
import { Download, Share2, X } from "lucide-react";
import type Konva from "konva";
import {
  StandingsPosterCanvas,
  eventStandingsTemplateList,
  exportStandingsPng,
  pickStandingsTemplate,
  shareStandings,
  usableStandingsTemplates,
} from "./standings-poster";
import {
  posterFontStack,
  type CustomTpl,
  type PosterLayoutMap,
} from "./poster-canvas";

export type StandingsSnapshot = {
  afterN: number;
  template: number;
  templateId: string | null;
  rows: { name: string; points: number }[];
};

/** Subset of PosterMeta this sheet needs to pick the right template
 *  and render the org overlay on general/custom standings posters. */
export type StandingsPosterMeta = {
  subdomain: string;
  orgName: string;
  posterDate: string | null;
  posterPlace: string | null;
  fontEn: string | null;
  fontMl: string | null;
  standingsDefaultTemplate: number;
  standingsDefaultTemplateId: string | null;
  customStandingsTemplates: CustomTpl[];
  disabledStandingsTemplates: string[];
  standingsLayout: PosterLayoutMap | null;
};

export function StandingsSheet({
  history,
  posterMeta,
  onClose,
}: {
  // Newest checkpoint first (loader sorts after_n desc).
  history: StandingsSnapshot[];
  posterMeta: StandingsPosterMeta;
  onClose: () => void;
}) {
  // Index into `history`; 0 is always the latest checkpoint.
  const [sel, setSel] = useState(0);
  const snapshot = history[sel] ?? null;
  const hasData = !!snapshot && snapshot.rows.length > 0;
  const afterN = snapshot?.afterN ?? 0;

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
      await exportStandingsPng(stageRef.current, `standings_after_${afterN}.png`);
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    setBusy("share");
    try {
      await shareStandings(stageRef.current, afterN);
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
              {hasData
                ? `Snapshot after ${afterN} ${afterN === 1 ? "result" : "results"}`
                : "Standings not published yet."}
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

        {/* Checkpoint selector — step through the standings history.
            Only shown when there's more than one checkpoint. */}
        {history.length > 1 && (
          <div className="border-b border-black/10 bg-paper/60 px-3 py-2.5">
            <p className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-ink-400">
              Checkpoint
            </p>
            <div
              role="tablist"
              aria-label="Standings checkpoint"
              className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {history.map((s, i) => {
                const active = i === sel;
                return (
                  <button
                    key={s.afterN}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSel(i)}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all duration-200 ${
                      active
                        ? "bg-red text-white shadow-[0_4px_12px_-4px_rgba(191,6,3,0.55)]"
                        : "bg-white text-ink-700 ring-1 ring-black/10 hover:ring-yellow hover:bg-yellow/10"
                    }`}
                  >
                    {i === 0 ? "Latest" : `After ${s.afterN}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto p-4 sm:p-5">
          {!hasData ? (
            <EmptyState />
          ) : (
            <>
              <div className="overflow-hidden rounded-2xl ring-1 ring-black/10 shadow-[0_12px_30px_-16px_rgba(11,9,10,0.4)]">
                {(() => {
                  const list = usableStandingsTemplates(
                    eventStandingsTemplateList(
                      posterMeta.subdomain,
                      posterMeta.customStandingsTemplates,
                    ),
                    posterMeta.disabledStandingsTemplates,
                  );
                  // Per-snapshot wins; templateId (custom UUID) beats
                  // the numeric template (built-in index).
                  const chosen =
                    pickStandingsTemplate(
                      list,
                      snapshot!.template ??
                        posterMeta.standingsDefaultTemplate,
                      snapshot!.templateId ??
                        posterMeta.standingsDefaultTemplateId,
                      0,
                    ) ?? list[0];
                  return (
                    <StandingsPosterCanvas
                      key={`${snapshot!.afterN}-${chosen?.key}`}
                      data={{ afterN, rows: snapshot!.rows }}
                      templateIndex={chosen?.builtinIndex ?? 0}
                      customSrc={chosen?.src ?? undefined}
                      meta={{
                        orgName: posterMeta.orgName,
                        posterDate: posterMeta.posterDate ?? undefined,
                        posterPlace: posterMeta.posterPlace ?? undefined,
                      }}
                      fontFamily={posterFontStack(
                        posterMeta.fontEn,
                        posterMeta.fontMl,
                      )}
                      standingsOverrides={
                        chosen
                          ? posterMeta.standingsLayout?.[chosen.key]
                          : undefined
                      }
                      stageRef={stageRef}
                    />
                  );
                })()}
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
    <div className="py-10 text-center">
      <p className="text-sm text-ink-700">
        Team standings haven't been published yet.
      </p>
      <p className="text-xs text-ink-400 mt-2">
        They'll appear here as soon as the organisers post the latest
        standings.
      </p>
    </div>
  );
}
