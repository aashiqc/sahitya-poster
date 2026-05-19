import { useEffect, useRef, useState } from "react";
import type Konva from "konva";
import { Stage, Layer, Image as KImage, Text, Rect, Group } from "react-konva";
import { SITE_URL_FALLBACK, TEMPLATE_SUBDOMAIN } from "~/lib/constants";

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
  /** Per-tenant canonical origin for the "Full result →" share link.
   *  Falls back to SITE_URL_FALLBACK when not supplied. */
  siteUrl?: string;
  levelName: string;
  programName: string;
  programCode: string;
  resultNo: string | null;
  winners: PosterWinner[];
  /** Admin-managed overlay (general templates). Org/sector display name
   *  plus the event date / time / place — rendered in the template's
   *  empty `meta` zone when present. */
  orgName?: string;
  posterDate?: string;
  posterTime?: string;
  posterPlace?: string;
  /** Full CSS font stack applied to ALL poster text. Build it with
   *  posterFontStack(); falls back to BODY_FONT when omitted. */
  fontFamily?: string;
};

// ─────────────────────────────────────────────────────────────────────
// Stage geometry — templates are native 1080×1350 (4:5 portrait).
// All overlay coordinates below are in this native pixel grid.
// ─────────────────────────────────────────────────────────────────────

const STAGE_W = 1080;
const STAGE_H = 1350;

const BODY_FONT = '"Plus Jakarta Sans", "Anek Malayalam", system-ui, sans-serif';

// Selectable poster fonts. One choice per script; the resolved stack is
// applied to EVERY text element on the poster (posterFontStack). The
// families must also be loaded in app/root.tsx.
export const POSTER_FONTS_EN = [
  "Plus Jakarta Sans",
  "Montserrat",
  "Open Sans",
  "Poppins",
] as const;
export const POSTER_FONTS_ML = ["Anek Malayalam", "Manjari"] as const;

/** CSS stack = Latin font, then Malayalam font, then system fallback —
 *  so mixed English/Malayalam posters render correctly with one stack.
 *  Unknown/blank inputs fall back to the first option. */
export function posterFontStack(
  fontEn?: string | null,
  fontMl?: string | null,
): string {
  const en = (POSTER_FONTS_EN as readonly string[]).includes(fontEn ?? "")
    ? (fontEn as string)
    : POSTER_FONTS_EN[0];
  const ml = (POSTER_FONTS_ML as readonly string[]).includes(fontMl ?? "")
    ? (fontMl as string)
    : POSTER_FONTS_ML[0];
  return `"${en}", "${ml}", system-ui, sans-serif`;
}

// Tier colors for the position badges (1st → 4th)
const ORDINAL = ["1st", "2nd", "3rd", "4th"] as const;
const TIER_COLOR = ["#C89412", "#6F6F6F", "#A05A1D", "#3A1414"] as const;

// ─────────────────────────────────────────────────────────────────────
// Per-template layout — every template bakes in its own branding, so
// the empty zone for overlay text differs. Define each one explicitly.
// ─────────────────────────────────────────────────────────────────────

type TemplateLayout = {
  src: string;
  // "legacy" templates carry baked Pantharangadi/date/place branding and
  // are reserved for the Pantharangadi tenant. "general" templates are
  // tenant-neutral — used by every other tenant, with the org name /
  // date / place supplied dynamically via the `meta` block.
  scope: "legacy" | "general";
  // Content block (level + program + winners) — top-left corner & width
  contentX: number;
  contentY: number;
  contentW: number;
  // Text tones
  subtitleColor: string;
  titleColor: string;
  nameColor: string;
  unitColor: string;
  // Result number — large, centered inside a box under the "Result"
  // script. x/y is the box top-left; the digits are centered in boxW.
  resultNo: {
    x: number;
    y: number;
    boxW: number;
    fontSize: number;
    color: string;
  };
  // Admin overlay zone (general templates): org/sector name + date·time
  // + place, stacked from (x,y) within width w.
  meta?: {
    x: number;
    y: number;
    w: number;
    color: string;
    align?: "left" | "center" | "right";
  };
};

const TEMPLATES: TemplateLayout[] = [
  // 01 — cream backdrop, floral panel right-bottom, "Result" top-right
  {
    src: "/poster/templates/01.png",
    scope: "legacy",
    contentX: 80,
    contentY: 460,
    contentW: 560,
    subtitleColor: "#2B2728",
    titleColor: "#BF0603",
    nameColor: "#0B090A",
    unitColor: "#6B6566",
    resultNo: { x: 610, y: 160, boxW: 420, fontSize: 176, color: "#0B090A" },
  },
  // 02 — pink backdrop, landscape right-bottom, white "Result" top-right
  {
    src: "/poster/templates/02.png",
    scope: "legacy",
    contentX: 80,
    contentY: 460,
    contentW: 400,
    subtitleColor: "#2B2728",
    titleColor: "#9C0503",
    nameColor: "#0B090A",
    unitColor: "#4A3F40",
    resultNo: { x: 610, y: 160, boxW: 420, fontSize: 176, color: "#FFFFFF" },
  },
  // 03 — cream backdrop, Matisse cutouts bottom-left, header on the right
  {
    src: "/poster/templates/03.png",
    scope: "legacy",
    contentX: 540,
    contentY: 520,
    contentW: 460,
    subtitleColor: "#2B2728",
    titleColor: "#BF0603",
    nameColor: "#0B090A",
    unitColor: "#6B6566",
    resultNo: { x: 50, y: 270, boxW: 360, fontSize: 136, color: "#3D5DBF" },
  },
  // 04 — dark navy, "Result" script top-left, sage "Sahityotsav"
  // wordmark top-right, flowers bottom-left (Pantharangadi-baked).
  {
    src: "/poster/templates/result-04.png",
    scope: "legacy",
    contentX: 560,
    contentY: 470,
    contentW: 470,
    subtitleColor: "#E9E1CF",
    titleColor: "#F3ECDC",
    nameColor: "#FFFFFF",
    unitColor: "#B7BECC",
    resultNo: { x: 65, y: 271, boxW: 360, fontSize: 150, color: "#EFE6D2" },
  },
  // 05 — dark maroon, pink "Result" script top-right, cyan
  // "Sahityotsav" wordmark top-left, lantern bottom-right
  // (Pantharangadi-baked).
  {
    src: "/poster/templates/result-05.png",
    scope: "legacy",
    contentX: 90,
    contentY: 470,
    contentW: 480,
    subtitleColor: "#F0E4DA",
    titleColor: "#F4E8DC",
    nameColor: "#FFFFFF",
    unitColor: "#CDB8C6",
    resultNo: { x: 659, y: 188, boxW: 340, fontSize: 150, color: "#F4A9C4" },
  },
  // general-01 — navy, flowers bottom-left, "Result" top-left, sage
  // "Sahityotsav" wordmark center-right. Tenant-neutral: org name /
  // date / place come from the admin (meta block). Content in the open
  // navy band on the right; light text.
  {
    src: "/poster/templates/general-01.png",
    scope: "general",
    contentX: 560,
    contentY: 560,
    contentW: 470,
    subtitleColor: "#E9E1CF",
    titleColor: "#F3ECDC",
    nameColor: "#FFFFFF",
    unitColor: "#B7BECC",
    resultNo: { x: 70, y: 250, boxW: 360, fontSize: 140, color: "#EFE6D2" },
    meta: { x: 560, y: 395, w: 470, color: "#D9D2C0", align: "left" },
  },
  // general-02 — maroon, lantern bottom-right, "Result" top-right, cyan
  // "Sahityotsav" wordmark upper-left. Tenant-neutral. Content in the
  // open maroon band on the left; light text.
  {
    src: "/poster/templates/general-02.png",
    scope: "general",
    contentX: 90,
    contentY: 560,
    contentW: 470,
    subtitleColor: "#F0E4DA",
    titleColor: "#F4E8DC",
    nameColor: "#FFFFFF",
    unitColor: "#CDB8C6",
    resultNo: { x: 640, y: 175, boxW: 360, fontSize: 140, color: "#F4A9C4" },
    meta: { x: 90, y: 395, w: 480, color: "#E9D9DF", align: "left" },
  },
];

export const POSTER_TEMPLATE_COUNT = TEMPLATES.length;

/** Template indices a tenant may use. The Pantharangadi tenant keeps the
 *  legacy (baked-branding) set; every other tenant gets the general,
 *  tenant-neutral set. */
export function allowedTemplateIndices(
  subdomain: string | null | undefined,
): number[] {
  const want = subdomain === TEMPLATE_SUBDOMAIN ? "legacy" : "general";
  const idx = TEMPLATES.map((t, i) => (t.scope === want ? i : -1)).filter(
    (i) => i >= 0,
  );
  return idx.length ? idx : TEMPLATES.map((_, i) => i);
}

/** Resolve the concrete template index from the tenant's allowed set,
 *  the saved default position, and a shuffle offset. All inputs are
 *  tolerated (wrapped/clamped) so callers can pass raw DB values. */
export function pickTemplateIndex(
  subdomain: string | null | undefined,
  defaultPos: number,
  shuffle = 0,
): number {
  const allowed = allowedTemplateIndices(subdomain);
  const n = allowed.length;
  const base = (((defaultPos % n) + n) % n + shuffle) % n;
  return allowed[((base % n) + n) % n];
}

// ─────────────────────────────────────────────────────────────────────
// Image loading — tracks loaded/error + a "slow network" flag, and a
// module-level cache so a template is decoded only once per session.
// ─────────────────────────────────────────────────────────────────────

const SLOW_MS = 2400;
const imgCache = new Map<string, HTMLImageElement>();

/** Warm the browser/decoder cache for every poster template so the
 *  first result a user opens renders instantly. Safe to call repeatedly;
 *  best invoked from an idle callback after the chat is interactive. */
export function prefetchPosterAssets(): void {
  if (typeof window === "undefined") return;
  const srcs = [
    ...TEMPLATES.map((t) => t.src),
    "/poster/templates/standings.png",
    "/poster/templates/standings-light.png",
    "/poster/templates/standings-dark.png",
  ];
  for (const src of srcs) {
    if (imgCache.has(src)) continue;
    const el = new window.Image();
    el.decoding = "async";
    el.src = src;
    el.addEventListener("load", () => imgCache.set(src, el), { once: true });
  }
}

export function usePosterImage(src: string): {
  img: HTMLImageElement | null;
  done: boolean;
  slow: boolean;
} {
  const cached = imgCache.get(src) ?? null;
  const [img, setImg] = useState<HTMLImageElement | null>(cached);
  const [done, setDone] = useState<boolean>(!!cached);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hit = imgCache.get(src);
    if (hit) {
      setImg(hit);
      setDone(true);
      setSlow(false);
      return;
    }
    let active = true;
    setImg(null);
    setDone(false);
    setSlow(false);
    const el = new window.Image();
    el.crossOrigin = "anonymous";
    el.decoding = "async";
    const ok = () => {
      if (!active) return;
      imgCache.set(src, el);
      setImg(el);
      setDone(true);
    };
    const fail = () => {
      // Fail-open: let the poster render with its solid fallback rather
      // than hang on the skeleton forever.
      if (active) setDone(true);
    };
    el.addEventListener("load", ok);
    el.addEventListener("error", fail);
    el.src = src;
    if (el.complete && el.naturalWidth > 0) ok();
    const slowTimer = window.setTimeout(() => {
      if (active) setSlow(true);
    }, SLOW_MS);
    return () => {
      active = false;
      el.removeEventListener("load", ok);
      el.removeEventListener("error", fail);
      window.clearTimeout(slowTimer);
    };
  }, [src]);
  return { img, done, slow };
}

/** Shared loading state for both posters — warm shimmer, spinner, and
 *  an honest slow-connection note once it drags. */
export function PosterSkeleton({ slow }: { slow: boolean }) {
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden bg-gradient-to-br from-[#FBEFD4] to-[#F2E3C7]">
      <div className="absolute inset-0 animate-pulse bg-[radial-gradient(60%_50%_at_50%_40%,rgba(255,206,5,0.18),transparent_70%)]" />
      <div className="relative flex flex-col items-center gap-3 px-6 text-center">
        <span
          aria-hidden
          className="size-7 rounded-full border-[3px] border-red/25 border-t-red animate-spin"
        />
        <span className="text-[11px] font-semibold tracking-wide text-ink-500">
          {slow ? "Slow connection — still loading the poster…" : "Loading poster…"}
        </span>
      </div>
    </div>
  );
}

/** Numeric result numbers get a 2-digit minimum (1 → "01", 9 → "09");
 *  10+ are unchanged ("10", "100", "105"). Non-numeric passes through. */
function formatResultNo(s: string): string {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return t;
  return String(parseInt(t, 10)).padStart(2, "0");
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// Tenant meta — org/sector name + date·time + place, in the general
// template's empty `meta` zone. Renders nothing for legacy templates
// (no meta config) or when the admin hasn't supplied any values.
// ─────────────────────────────────────────────────────────────────────

const TenantMeta = ({
  data,
  layout,
}: {
  data: PosterData;
  layout: TemplateLayout;
}) => {
  const m = layout.meta;
  if (!m) return null;
  const dt = [data.posterDate, data.posterTime]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("   ·   ");
  const lines: { text: string; size: number; bold?: boolean }[] = [];
  if (data.orgName?.trim())
    lines.push({ text: data.orgName.trim(), size: 36, bold: true });
  if (dt) lines.push({ text: dt, size: 24 });
  if (data.posterPlace?.trim())
    lines.push({ text: data.posterPlace.trim(), size: 24 });
  if (lines.length === 0) return null;

  let acc = m.y;
  const placed = lines.map((ln) => {
    const y = acc;
    acc += ln.size * 1.32 + 7;
    return { ...ln, y };
  });
  return (
    <>
      {placed.map((ln, i) => (
        <Text
          key={i}
          x={m.x}
          y={ln.y}
          width={m.w}
          align={m.align ?? "left"}
          text={ln.text}
          fontFamily={data.fontFamily || BODY_FONT}
          fontSize={ln.size}
          fontStyle={ln.bold ? "bold" : "normal"}
          fill={m.color}
          lineHeight={1.2}
        />
      ))}
    </>
  );
};

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
  const font = data.fontFamily || BODY_FONT;
  const { img: template, done: imgDone, slow } = usePosterImage(layout.src);

  const w = displayWidth ?? autoW;
  const scale = w / STAGE_W;
  const displayHeight = STAGE_H * scale;
  const ready = mounted && w > 0 && imgDone;

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

          {/* Admin overlay (general templates): org name + date/place */}
          <TenantMeta data={data} layout={layout} />

          {/* Level (subtitle) + Program (title) block */}
          <SubtitleTitle data={data} layout={layout} />

          {/* Winners list — directly below the title block */}
          <WinnersList winners={data.winners} layout={layout} font={font} />

          {/* Result number — large, centered under the "Result" script */}
          {data.resultNo && (
            <Text
              x={layout.resultNo.x}
              y={layout.resultNo.y}
              width={layout.resultNo.boxW}
              align="center"
              text={formatResultNo(data.resultNo)}
              fontFamily={font}
              fontSize={layout.resultNo.fontSize}
              fontStyle="bold"
              fill={layout.resultNo.color}
            />
          )}
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
const SUBTITLE_GAP = 14;
const TITLE_SIZE = 50;
const TITLE_LH = 1.05;
const TITLE_LINE_BUDGET = 2;
const TITLE_TO_WINNERS_GAP = 38;

// Category highlight pill
const PILL_PADX = 22;
const PILL_PADY = 10;
const PILL_RADIUS = 0;
const PILL_BG = "#4FB7B2";
const PILL_TEXT = "#FFFFFF";
const PILL_H = SUBTITLE_SIZE + PILL_PADY * 2;

/** Level name on a rounded highlight. The pill auto-fits the text by
 *  measuring the rendered Konva.Text width after mount. */
function CategoryPill({ text, font }: { text: string; font: string }) {
  const tref = useRef<Konva.Text | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const n = tref.current;
    if (n) setW(Math.ceil(n.getTextWidth()));
  }, [text]);
  return (
    <Group>
      <Rect
        width={w + PILL_PADX * 2}
        height={PILL_H}
        cornerRadius={PILL_RADIUS}
        fill={PILL_BG}
      />
      <Text
        ref={tref}
        x={PILL_PADX}
        y={PILL_PADY}
        text={text}
        fontFamily={font}
        fontSize={SUBTITLE_SIZE}
        fontStyle="bold"
        fill={PILL_TEXT}
      />
    </Group>
  );
}

function SubtitleTitle({
  data,
  layout,
}: {
  data: PosterData;
  layout: TemplateLayout;
}) {
  // Girls' programs carry a longer "(Girls)" qualifier, so trim a touch
  // more so they still fit the title block.
  const titleSize =
    TITLE_SIZE - (/girls/i.test(data.programName) ? 6 : 4);
  const font = data.fontFamily || BODY_FONT;
  return (
    <Group x={layout.contentX} y={layout.contentY}>
      <CategoryPill text={data.levelName} font={font} />
      <Text
        x={0}
        y={PILL_H + SUBTITLE_GAP}
        width={layout.contentW}
        text={data.programName}
        fontFamily={font}
        fontSize={titleSize}
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
  const titleH = TITLE_SIZE * TITLE_LH * TITLE_LINE_BUDGET;
  return (
    layout.contentY +
    PILL_H +
    SUBTITLE_GAP +
    titleH +
    TITLE_TO_WINNERS_GAP
  );
}

function WinnersList({
  winners,
  layout,
  font,
}: {
  winners: PosterWinner[];
  layout: TemplateLayout;
  font: string;
}) {
  const startY = winnersStartY(layout);
  // position < 1 ⇒ grade-only entries (counted for team points, never
  // shown on the poster). Only ranked places 1–4 render here.
  const sorted = [...winners]
    .filter((w) => w.position >= 1)
    .sort((a, b) => a.position - b.position)
    .slice(0, 4);

  return (
    <Group x={layout.contentX} y={startY}>
      {sorted.map((w, i) => (
        <WinnerRow
          key={`${w.position}-${i}`}
          winner={w}
          y={i * (ROW_H + ROW_GAP)}
          layout={layout}
          font={font}
        />
      ))}
    </Group>
  );
}

function WinnerRow({
  winner,
  y,
  layout,
  font,
}: {
  winner: PosterWinner;
  y: number;
  layout: TemplateLayout;
  font: string;
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
        fontFamily={font}
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
        fontFamily={font}
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
          fontFamily={font}
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

// Human-readable caption that travels with the poster image when the
// user shares it (WhatsApp / Telegram / etc. keep the `text` alongside
// the file). Built from our own result data — program, category,
// event, the podium, and a deep link back to the full result.
function buildShareCaption(data: PosterData): { title: string; text: string } {
  const medals = ["🥇", "🥈", "🥉", "🏅"];
  const podium = data.winners
    .filter((w) => w.position >= 1)
    .sort((a, b) => a.position - b.position)
    .slice(0, 4)
    .map((w, i) => {
      const place = medals[i] ?? `${w.position}.`;
      return `${place} ${w.name}${w.unit ? ` — ${w.unit}` : ""}`;
    });

  const heading = `🏆 ${data.programName} · ${data.levelName}`;
  const sub = data.resultNo
    ? `${data.eventName} · Result No. ${data.resultNo}`
    : data.eventName;
  const link = `${data.siteUrl ?? SITE_URL_FALLBACK}/result/${data.programCode}`;

  const text = [heading, sub, "", ...podium, "", `Full result → ${link}`]
    .join("\n")
    .trim();

  return { title: `${data.programName} — ${data.levelName}`, text };
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
      const caption = buildShareCaption(data);
      await nav.share({
        title: caption.title,
        text: caption.text,
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
