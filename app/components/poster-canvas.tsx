import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import { Stage, Layer, Image as KImage, Text, Rect, Group } from "react-konva";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type PosterWinner = {
  position: number;
  name: string;
  unit: string | null;
};

export type PosterData = {
  eventName: string;
  levelName: string;
  programName: string;
  programCode: string;
  resultNo: string | null;
  winners: PosterWinner[];
};

// ─────────────────────────────────────────────────────────────────────
// Stage geometry — templates are native 1080×1350 (4:5 portrait).
// All overlay coordinates below are in this native pixel grid.
// ─────────────────────────────────────────────────────────────────────

const STAGE_W = 1080;
const STAGE_H = 1350;

const BODY_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';
const ORDINAL_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';

// Tier colors for the position badges (1st → 4th)
const ORDINAL = ["1st", "2nd", "3rd", "4th"] as const;
const TIER_COLOR = ["#C89412", "#6F6F6F", "#A05A1D", "#3A1414"] as const;

// ─────────────────────────────────────────────────────────────────────
// Per-template layout — every template bakes in its own branding, so
// the empty zone for overlay text differs. Define each one explicitly.
// ─────────────────────────────────────────────────────────────────────

type TemplateLayout = {
  src: string;
  // Content block (level + program + winners) — top-left corner & width
  contentX: number;
  contentY: number;
  contentW: number;
  // Text tones
  subtitleColor: string;
  titleColor: string;
  nameColor: string;
  unitColor: string;
  // Result number badge — round chip beside the decorative "Result" script.
  // x/y is the chip's top-left corner.
  resultNo: {
    x: number;
    y: number;
    fontSize: number;
    color: string;
    bg: string;
  };
};

const TEMPLATES: TemplateLayout[] = [
  // 01 — cream backdrop, floral panel right-bottom, "Result" top-right
  {
    src: "/poster/templates/01.png",
    contentX: 80,
    contentY: 460,
    contentW: 560,
    subtitleColor: "#2B2728",
    titleColor: "#BF0603",
    nameColor: "#0B090A",
    unitColor: "#6B6566",
    resultNo: { x: 700, y: 200, fontSize: 44, color: "#E85937", bg: "#FFFFFF" },
  },
  // 02 — pink backdrop, landscape right-bottom, white "Result" top-right
  {
    src: "/poster/templates/02.png",
    contentX: 80,
    contentY: 460,
    contentW: 400,
    subtitleColor: "#2B2728",
    titleColor: "#9C0503",
    nameColor: "#0B090A",
    unitColor: "#4A3F40",
    resultNo: { x: 700, y: 200, fontSize: 44, color: "#FFFFFF", bg: "#2B2728" },
  },
  // 03 — cream backdrop, Matisse cutouts bottom-left, header on the right
  {
    src: "/poster/templates/03.png",
    contentX: 540,
    contentY: 520,
    contentW: 460,
    subtitleColor: "#2B2728",
    titleColor: "#BF0603",
    nameColor: "#0B090A",
    unitColor: "#6B6566",
    resultNo: { x: 200, y: 300, fontSize: 44, color: "#3D5DBF", bg: "#FFFFFF" },
  },
];

// ─────────────────────────────────────────────────────────────────────
// useImage — load HTMLImageElement for Konva
// ─────────────────────────────────────────────────────────────────────

function useImage(src: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = new window.Image();
    el.crossOrigin = "anonymous";
    el.decoding = "async";
    el.src = src;
    let active = true;
    const onLoad = () => {
      if (active) setImg(el);
    };
    if (el.complete && el.naturalWidth > 0) onLoad();
    else el.addEventListener("load", onLoad);
    return () => {
      active = false;
      el.removeEventListener("load", onLoad);
    };
  }, [src]);
  return img;
}

/** Numeric result numbers get a 2-digit minimum (1 → "01", 9 → "09");
 *  10+ are unchanged ("10", "100", "105"). Non-numeric passes through. */
function formatResultNo(s: string): string {
  const t = s.trim();
  return /^\d+$/.test(t) ? t.padStart(2, "0") : t;
}

// ─────────────────────────────────────────────────────────────────────
// Poster — client-only Konva stage. Overlays level/program/winners and
// the result number on top of a chosen template.
// ─────────────────────────────────────────────────────────────────────

export const PosterCanvas = ({
  data,
  templateIndex = 0,
  stageRef,
  displayWidth,
}: {
  data: PosterData;
  templateIndex?: number;
  stageRef?: React.MutableRefObject<Konva.Stage | null>;
  /** When omitted, the canvas fills the parent container width. */
  displayWidth?: number;
}) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    let active = true;
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    const start = () => {
      if (active) setMounted(true);
    };
    if (fonts?.ready) fonts.ready.then(start).catch(start);
    else start();
    return () => {
      active = false;
    };
  }, []);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [autoW, setAutoW] = useState(0);
  useEffect(() => {
    if (displayWidth) return;
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setAutoW(el.clientWidth);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [displayWidth, mounted]);

  const layout = TEMPLATES[templateIndex % TEMPLATES.length];
  const template = useImage(layout.src);

  const w = displayWidth ?? autoW;
  const scale = w / STAGE_W;
  const displayHeight = STAGE_H * scale;
  const ready = mounted && w > 0;

  return (
    <div
      ref={wrapRef}
      className="w-full"
      style={{
        aspectRatio: "4 / 5",
        overflow: "hidden",
        // Canvas must NOT swallow taps or vertical scrolls — the parent
        // <button> handles the tap-to-zoom, and the page needs to scroll.
        pointerEvents: "none",
        touchAction: "pan-y",
      }}
    >
      {!ready && (
        <div className="w-full h-full bg-night-800/10 animate-pulse" />
      )}
      {ready && (
      <Stage
        ref={stageRef as React.RefObject<Konva.Stage>}
        width={w}
        height={displayHeight}
        scaleX={scale}
        scaleY={scale}
      >
        <Layer imageSmoothingEnabled>
          {/* Solid fallback while the bitmap is decoding */}
          <Rect x={0} y={0} width={STAGE_W} height={STAGE_H} fill="#F5EFE6" />

          {/* Template background — drawn at native 1080×1350 */}
          {template && (
            <KImage
              image={template}
              x={0}
              y={0}
              width={STAGE_W}
              height={STAGE_H}
              listening={false}
            />
          )}

          {/* Level (subtitle) + Program (title) block */}
          <SubtitleTitle data={data} layout={layout} />

          {/* Winners list — directly below the title block */}
          <WinnersList winners={data.winners} layout={layout} />

          {/* Result number — round chip beside the "Result" script */}
          {data.resultNo && (() => {
            const r = layout.resultNo;
            const d = Math.round(r.fontSize * 2.3);
            return (
              <Group x={r.x} y={r.y}>
                <Rect
                  width={d}
                  height={d}
                  cornerRadius={d / 2}
                  fill={r.bg}
                />
                <Text
                  width={d}
                  height={d}
                  align="center"
                  verticalAlign="middle"
                  text={formatResultNo(data.resultNo)}
                  fontFamily={ORDINAL_FONT}
                  fontSize={r.fontSize}
                  fontStyle="bold"
                  fill={r.color}
                />
              </Group>
            );
          })()}
        </Layer>
      </Stage>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Subtitle (level) + title (program)
// ─────────────────────────────────────────────────────────────────────

const SUBTITLE_SIZE = 34;
const SUBTITLE_LH = 1;
const SUBTITLE_GAP = 10;
const TITLE_SIZE = 50;
const TITLE_LH = 1.05;
const TITLE_LINE_BUDGET = 2;
const TITLE_TO_WINNERS_GAP = 38;

function SubtitleTitle({
  data,
  layout,
}: {
  data: PosterData;
  layout: TemplateLayout;
}) {
  return (
    <Group x={layout.contentX} y={layout.contentY}>
      <Text
        x={0}
        y={0}
        width={layout.contentW}
        text={data.levelName}
        fontFamily={BODY_FONT}
        fontSize={SUBTITLE_SIZE}
        fill={layout.subtitleColor}
        lineHeight={SUBTITLE_LH}
        wrap="word"
      />
      <Text
        x={0}
        y={SUBTITLE_SIZE * SUBTITLE_LH + SUBTITLE_GAP}
        width={layout.contentW}
        text={data.programName}
        fontFamily={BODY_FONT}
        fontSize={TITLE_SIZE}
        fontStyle="bold"
        fill={layout.titleColor}
        lineHeight={TITLE_LH}
        wrap="word"
      />
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Winners list — stacks below the title block
// ─────────────────────────────────────────────────────────────────────

const ROW_H = 76;
const ROW_GAP = 14;
const CHIP_SIZE = 50;
const CHIP_TEXT_GAP = 18;
const NAME_SIZE = 35;
const UNIT_SIZE = 25;
const NAME_TO_UNIT_GAP = 6;

function winnersStartY(layout: TemplateLayout): number {
  const subtitleH = SUBTITLE_SIZE * SUBTITLE_LH;
  const titleH = TITLE_SIZE * TITLE_LH * TITLE_LINE_BUDGET;
  return (
    layout.contentY +
    subtitleH +
    SUBTITLE_GAP +
    titleH +
    TITLE_TO_WINNERS_GAP
  );
}

function WinnersList({
  winners,
  layout,
}: {
  winners: PosterWinner[];
  layout: TemplateLayout;
}) {
  const startY = winnersStartY(layout);
  const sorted = [...winners].sort((a, b) => a.position - b.position).slice(0, 4);

  return (
    <Group x={layout.contentX} y={startY}>
      {sorted.map((w, i) => (
        <WinnerRow
          key={`${w.position}-${i}`}
          winner={w}
          y={i * (ROW_H + ROW_GAP)}
          layout={layout}
        />
      ))}
    </Group>
  );
}

function WinnerRow({
  winner,
  y,
  layout,
}: {
  winner: PosterWinner;
  y: number;
  layout: TemplateLayout;
}) {
  const idx = Math.min(Math.max(winner.position, 1), 4) - 1;
  const chipR = CHIP_SIZE / 2;
  const chipY = 4;
  const textX = CHIP_SIZE + CHIP_TEXT_GAP;
  const textW = layout.contentW - textX;

  return (
    <Group y={y}>
      {/* Position badge */}
      <Rect
        x={0}
        y={chipY}
        width={CHIP_SIZE}
        height={CHIP_SIZE}
        cornerRadius={chipR}
        fill={TIER_COLOR[idx]}
      />
      <Text
        x={0}
        y={chipY}
        width={CHIP_SIZE}
        height={CHIP_SIZE}
        align="center"
        verticalAlign="middle"
        text={ORDINAL[idx]}
        fontFamily={ORDINAL_FONT}
        fontSize={20}
        fontStyle="bold"
        fill="#FFFFFF"
      />

      {/* Name */}
      <Text
        x={textX}
        y={0}
        width={textW}
        text={winner.name}
        fontFamily={BODY_FONT}
        fontSize={NAME_SIZE}
        fontStyle="bold"
        fill={layout.nameColor}
        lineHeight={1.05}
        wrap="none"
        ellipsis
      />
      {winner.unit && (
        <Text
          x={textX}
          y={NAME_SIZE + NAME_TO_UNIT_GAP}
          width={textW}
          text={winner.unit}
          fontFamily={BODY_FONT}
          fontSize={UNIT_SIZE}
          fill={layout.unitColor}
          lineHeight={1}
          wrap="none"
          ellipsis
        />
      )}
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Export helpers — render at 2-3× device pixel ratio for crisp output.
// ─────────────────────────────────────────────────────────────────────

function exportPixelRatio(): number {
  if (typeof window === "undefined") return 2;
  return Math.min(window.devicePixelRatio || 2, 3);
}

/** Reset to native stage size while exporting so resolution is independent
 *  of the on-screen preview width. */
function withNativeResolution<T>(
  stage: Konva.Stage,
  fn: (stage: Konva.Stage) => T,
): T {
  const origW = stage.width();
  const origH = stage.height();
  const origScaleX = stage.scaleX();
  const origScaleY = stage.scaleY();
  stage.scale({ x: 1, y: 1 });
  stage.size({ width: STAGE_W, height: STAGE_H });
  try {
    return fn(stage);
  } finally {
    stage.scale({ x: origScaleX, y: origScaleY });
    stage.size({ width: origW, height: origH });
  }
}

export async function exportPosterPng(
  stage: Konva.Stage | null,
  filename: string,
): Promise<void> {
  if (!stage) return;
  const dataUrl = withNativeResolution(stage, (s) =>
    s.toDataURL({ mimeType: "image/png", pixelRatio: exportPixelRatio() }),
  );
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export async function sharePoster(
  stage: Konva.Stage | null,
  data: PosterData,
): Promise<"shared" | "downloaded" | "unsupported"> {
  if (!stage) return "unsupported";
  const blob: Blob | null = await withNativeResolution(stage, (s) =>
    new Promise<Blob | null>((resolve) => {
      s.toCanvas({ pixelRatio: exportPixelRatio() }).toBlob(
        (b) => resolve(b),
        "image/png",
      );
    }),
  );
  if (!blob) return "unsupported";

  const file = new File([blob], `${data.programCode}_poster.png`, {
    type: "image/png",
  });
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        title: `${data.programName} — ${data.levelName}`,
        text: `#Result ${data.resultNo ?? ""}`.trim(),
        files: [file],
      });
      return "shared";
    } catch {
      // user dismissed — fall through to download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return "downloaded";
}
