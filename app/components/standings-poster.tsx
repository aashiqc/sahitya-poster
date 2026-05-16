import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import { Stage, Layer, Image as KImage, Text, Rect, Group } from "react-konva";

// ─────────────────────────────────────────────────────────────────────
// Standings poster — overlays the "after N" number and the team/points
// table onto the bespoke standings template artwork. Same Konva engine
// and native 1080×1350 grid as the result poster.
//
// Template asset expected at: /poster/templates/standings.png
// (the blank artwork: geometric burst left, "after __ Team Point" script
//  header, footer wordmark + samastha logos).
// ─────────────────────────────────────────────────────────────────────

export type StandingsRow = { name: string; points: number };

export type StandingsData = {
  afterN: number;
  rows: StandingsRow[];
};

const STAGE_W = 1080;
const STAGE_H = 1350;
const TEMPLATE_SRC = "/poster/templates/standings.png";

// Match the result poster's count: same family, bold (poster-canvas
// ORDINAL_FONT = Plus Jakarta Sans). One font across both posters.
const BODY_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';
const COUNT_FONT = BODY_FONT;

// ── Layout (native 1080×1350). Tuned to the supplied template/demo. ──
const LAYOUT = {
  // "after [N] Team Point" — N centered in the gap between the cursive
  // words. Demo: gap center ≈ native (643, 163).
  afterX: 558,
  afterY: 98,
  afterW: 170,
  afterH: 130,
  afterSize: 82,
  afterColor: "#7A4A1C",

  // Team table — matched to demostandings.jpg: names start clear of the
  // burst (native x≈470), points hard-right (right edge ≈ native 1000).
  listX: 448,
  pointsRight: 1004,
  pointsBoxW: 92,
  nameGap: 8,
  rowC0: 331, // vertical CENTER of row 1 (native)
  rowPitch: 61,
  maxRows: 8,
  baseNameSize: 38,
  baseColor: "#4A4445",
} as const;

// Top-3 emphasis, strictly in priority order; ranks 4+ use base style.
const RANK_STYLE: Record<number, { color: string; size: number }> = {
  1: { color: "#9C0503", size: 44 },
  2: { color: "#1A1718", size: 42 },
  3: { color: "#1A1718", size: 40 },
};

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

export const StandingsPosterCanvas = ({
  data,
  stageRef,
  displayWidth,
}: {
  data: StandingsData;
  stageRef?: React.MutableRefObject<Konva.Stage | null>;
  displayWidth?: number;
}) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    let active = true;
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
      .fonts;
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

  const template = useImage(TEMPLATE_SRC);

  const w = displayWidth ?? autoW;
  const scale = w / STAGE_W;
  const displayHeight = STAGE_H * scale;
  const ready = mounted && w > 0;

  const rows = data.rows.slice(0, LAYOUT.maxRows);

  return (
    <div
      ref={wrapRef}
      className="w-full"
      style={{
        aspectRatio: "4 / 5",
        overflow: "hidden",
        pointerEvents: "none",
        touchAction: "pan-y",
      }}
    >
      {!ready && <div className="w-full h-full bg-night-800/10 animate-pulse" />}
      {ready && (
        <Stage
          ref={stageRef as React.RefObject<Konva.Stage>}
          width={w}
          height={displayHeight}
          scaleX={scale}
          scaleY={scale}
        >
          <Layer imageSmoothingEnabled>
            <Rect x={0} y={0} width={STAGE_W} height={STAGE_H} fill="#FFFFFF" />

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

            {/* "after [N] Team Point" — only the N is overlaid, centered
                in the gap between the two cursive words */}
            <Text
              x={LAYOUT.afterX}
              y={LAYOUT.afterY}
              width={LAYOUT.afterW}
              height={LAYOUT.afterH}
              align="center"
              verticalAlign="middle"
              text={String(data.afterN).padStart(2, "0")}
              fontFamily={COUNT_FONT}
              fontSize={LAYOUT.afterSize}
              fontStyle="bold"
              fill={LAYOUT.afterColor}
            />

            {/* Team table — top 3 emphasised strictly in priority order,
                everyone else in normal text. Each row is vertically
                centred on its baseline so mixed sizes stay aligned. */}
            {rows.map((r, i) => {
              const rank = i + 1;
              const rk = RANK_STYLE[rank];
              const size = rk ? rk.size : LAYOUT.baseNameSize;
              const color = rk ? rk.color : LAYOUT.baseColor;
              const centerY = LAYOUT.rowC0 + i * LAYOUT.rowPitch;
              const y = centerY - size / 2;
              const nameW =
                LAYOUT.pointsRight -
                LAYOUT.pointsBoxW -
                LAYOUT.nameGap -
                LAYOUT.listX;
              return (
                <Group key={`${r.name}-${i}`}>
                  <Text
                    x={LAYOUT.listX}
                    y={y}
                    width={nameW}
                    text={r.name}
                    fontFamily={BODY_FONT}
                    fontSize={size}
                    fontStyle={rk ? "bold" : "normal"}
                    fill={color}
                    wrap="none"
                    ellipsis
                  />
                  <Text
                    x={LAYOUT.pointsRight - LAYOUT.pointsBoxW}
                    y={y}
                    width={LAYOUT.pointsBoxW}
                    align="right"
                    text={String(r.points)}
                    fontFamily={BODY_FONT}
                    fontSize={size}
                    fontStyle="bold"
                    fill={color}
                  />
                </Group>
              );
            })}
          </Layer>
        </Stage>
      )}
    </div>
  );
};

// ── Export / share ──────────────────────────────────────────────────

function exportPixelRatio(): number {
  if (typeof window === "undefined") return 2;
  return Math.min(window.devicePixelRatio || 2, 3);
}

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

export async function exportStandingsPng(
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

export async function shareStandings(
  stage: Konva.Stage | null,
  afterN: number,
): Promise<"shared" | "downloaded" | "unsupported"> {
  if (!stage) return "unsupported";
  const blob: Blob | null = await withNativeResolution(
    stage,
    (s) =>
      new Promise<Blob | null>((resolve) => {
        s.toCanvas({ pixelRatio: exportPixelRatio() }).toBlob(
          (b) => resolve(b),
          "image/png",
        );
      }),
  );
  if (!blob) return "unsupported";

  const file = new File([blob], `standings_after_${afterN}.png`, {
    type: "image/png",
  });
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
  };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        title: `Team standings — after ${afterN} results`,
        files: [file],
      });
      return "shared";
    } catch {
      // dismissed — fall through to download
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
