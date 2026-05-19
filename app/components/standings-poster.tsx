import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import { Stage, Layer, Image as KImage, Text, Rect, Group } from "react-konva";
import { PosterSkeleton, usePosterImage } from "./poster-canvas";

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

// Match the result poster's count: same family, bold (poster-canvas
// ORDINAL_FONT = Plus Jakarta Sans). One font across both posters.
const BODY_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';
const COUNT_FONT = BODY_FONT;

type SLayout = {
  afterX: number;
  afterY: number;
  afterW: number;
  afterH: number;
  afterSize: number;
  afterColor: string;
  listX: number;
  pointsRight: number;
  pointsBoxW: number;
  nameGap: number;
  rowC0: number; // vertical CENTER of row 1 (native)
  rowPitch: number;
  maxRows: number;
  baseNameSize: number;
  baseColor: string;
};
type STemplate = {
  src: string;
  layout: SLayout;
  // Top-3 emphasis, strictly in priority order; ranks 4+ use base style.
  rankStyle: Record<number, { color: string; size: number }>;
};

// All coords are native 1080×1350 (templates are exactly that size).
export const STANDINGS_TEMPLATES: STemplate[] = [
  // 0 — Original (geometric burst, "after _ Team Point" centred top).
  {
    src: "/poster/templates/standings.png",
    layout: {
      afterX: 558,
      afterY: 98,
      afterW: 170,
      afterH: 130,
      afterSize: 82,
      afterColor: "#7A4A1C",
      listX: 448,
      pointsRight: 1004,
      pointsBoxW: 92,
      nameGap: 8,
      rowC0: 331,
      rowPitch: 61,
      maxRows: 8,
      baseNameSize: 38,
      baseColor: "#4A4445",
    },
    rankStyle: {
      1: { color: "#9C0503", size: 44 },
      2: { color: "#1A1718", size: 42 },
      3: { color: "#1A1718", size: 40 },
    },
  },
  // 1 — Light/peach flowers. "After" + "Team Point" indigo script top-
  // left; bird & flowers right; list in the open left/centre band;
  // footer wordmark bottom-left. Dark text on peach/white.
  {
    src: "/poster/templates/standings-light.png",
    layout: {
      afterX: 180,
      afterY: 190,
      afterW: 160,
      afterH: 130,
      afterSize: 78,
      afterColor: "#3A2FB0",
      listX: 110,
      pointsRight: 548,
      pointsBoxW: 84,
      nameGap: 8,
      rowC0: 378,
      rowPitch: 58,
      maxRows: 8,
      baseNameSize: 35,
      baseColor: "#2B2738",
    },
    rankStyle: {
      1: { color: "#9C0503", size: 42 },
      2: { color: "#262150", size: 40 },
      3: { color: "#262150", size: 38 },
    },
  },
  // 2 — Dark navy flowers. "After" + "Team Point" pink script top-
  // right; flowers left; list in the open right band; footer wordmark
  // bottom-right. Light text on dark navy.
  {
    src: "/poster/templates/standings-dark.png",
    layout: {
      afterX: 595,
      afterY: 108,
      afterW: 170,
      afterH: 130,
      afterSize: 82,
      afterColor: "#F2B5C4",
      listX: 500,
      pointsRight: 1000,
      pointsBoxW: 100,
      nameGap: 8,
      rowC0: 320,
      rowPitch: 62,
      maxRows: 8,
      baseNameSize: 37,
      baseColor: "#D9D2E4",
    },
    rankStyle: {
      1: { color: "#FFFFFF", size: 46 },
      2: { color: "#FFFFFF", size: 43 },
      3: { color: "#FFFFFF", size: 41 },
    },
  },
];

export const STANDINGS_TEMPLATE_NAMES = [
  "Original",
  "Light flowers",
  "Dark flowers",
] as const;


export const StandingsPosterCanvas = ({
  data,
  templateIndex = 0,
  stageRef,
  displayWidth,
}: {
  data: StandingsData;
  templateIndex?: number;
  stageRef?: React.MutableRefObject<Konva.Stage | null>;
  displayWidth?: number;
}) => {
  const tpl =
    STANDINGS_TEMPLATES[
      ((templateIndex | 0) % STANDINGS_TEMPLATES.length +
        STANDINGS_TEMPLATES.length) %
        STANDINGS_TEMPLATES.length
    ];
  const LAYOUT = tpl.layout;
  const RANK_STYLE = tpl.rankStyle;
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

  const { img: template, done: imgDone, slow } = usePosterImage(tpl.src);

  const w = displayWidth ?? autoW;
  const scale = w / STAGE_W;
  const displayHeight = STAGE_H * scale;
  const ready = mounted && w > 0 && imgDone;

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
      {!ready && <PosterSkeleton slow={slow} />}
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
