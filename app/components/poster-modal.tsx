import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type Konva from "konva";
import { Download, Share2, X } from "lucide-react";
import {
  PosterCanvas,
  exportPosterPng,
  sharePoster,
  type PosterData,
} from "./poster-canvas";

/** Fullscreen zoom view — renders the poster at the largest square that
 *  fits the viewport, with the same Download / Share. Dismisses on
 *  backdrop tap, Escape, or the Close button. */
export function PosterZoomModal({
  data,
  templateIndex = 0,
  customSrc,
  onClose,
}: {
  data: PosterData;
  templateIndex?: number;
  customSrc?: string;
  onClose: () => void;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [busy, setBusy] = useState<null | "download" | "share">(null);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open
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
      await exportPosterPng(stageRef.current, `${data.programCode}_poster.png`);
    } finally {
      setBusy(null);
    }
  }
  async function onShare() {
    setBusy("share");
    try {
      await sharePoster(stageRef.current, data);
    } finally {
      setBusy(null);
    }
  }

  // Portal to <body> so the fixed overlay is relative to the viewport,
  // not a transformed/stacking-context ancestor (the chat bubble).
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Poster preview"
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Close — top-right */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 size-10 grid place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white"
      >
        <X className="size-5" aria-hidden />
      </button>

      {/* 4:5 canvas — width is bound so 5/4·width still fits in 80vh */}
      <div
        className="flex flex-col items-center gap-4 p-4"
        style={{ width: "min(95vw, 64vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-full overflow-hidden shadow-2xl">
          <PosterCanvas
            data={data}
            templateIndex={templateIndex}
            customSrc={customSrc}
            stageRef={stageRef}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onDownload}
            disabled={busy !== null}
            aria-label="Download poster"
            className="inline-flex items-center gap-2 rounded-full bg-paper text-ink-900 hover:bg-paper-2 disabled:opacity-50 px-5 py-3 text-sm font-medium shadow-lg"
          >
            <Download className="size-[18px]" aria-hidden />
            {busy === "download" ? "..." : "Download"}
          </button>
          <button
            type="button"
            onClick={onShare}
            disabled={busy !== null}
            aria-label="Share poster"
            className="inline-flex items-center gap-2 rounded-full bg-brand-700 text-paper hover:bg-brand-800 disabled:opacity-50 px-5 py-3 text-sm font-medium shadow-lg"
          >
            <Share2 className="size-[18px]" aria-hidden />
            {busy === "share" ? "..." : "Share"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
