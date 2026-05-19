import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Per-template element overrides (admin drag editor). Resolved by
   *  the caller for the active template. x/y = absolute native coords,
   *  s = size scale (1 = default). */
  overrides?: TemplateOverride;
};

export type LayoutEl =
  | "orgName"
  | "date"
  | "place"
  | "level"
  | "program"
  | "winners"
  | "resultNo";
/** Tolerates pre-split keys still present in layouts saved before the
 *  blocks became independent: "content" (level+program) and "meta"
 *  (org name + date + place). */
type StoredLayoutEl = LayoutEl | "content" | "meta";
export type ElOverride = {
  x?: number;
  y?: number;
  s?: number;
  /** Per-element text tone (hex). Empty/unset → the template's baked
   *  default tone for that element. */
  color?: string;
  /** Explicit weight / slant. Unset → the element's natural default. */
  bold?: boolean;
  italic?: boolean;
};
export type TemplateOverride = Partial<Record<StoredLayoutEl, ElOverride>>;
/** Whole-event layout map: { [templateKey]: { el: {x,y,s,…} } }. */
export type PosterLayoutMap = Record<string, TemplateOverride>;

/** Resolve a text element's effective fill — the admin's per-element
 *  color override, else the template's baked tone. */
function ovColor(ov: ElOverride | undefined, fallback: string): string {
  return ov?.color || fallback;
}
/** Konva fontStyle from the element's bold/italic overrides. `defBold`
 *  is the element's natural weight when the admin hasn't set one. */
function ovFontStyle(ov: ElOverride | undefined, defBold: boolean): string {
  const bold = ov?.bold ?? defBold;
  const italic = ov?.italic ?? false;
  return (
    [bold ? "bold" : "", italic ? "italic" : ""].filter(Boolean).join(" ") ||
    "normal"
  );
}
/** Shift a (migrated) override down by `dy` so a split-out sub-block
 *  keeps its original on-poster position. Preserves size/colour/weight. */
function shiftY(
  o: ElOverride | undefined,
  dy: number,
): ElOverride | undefined {
  if (!o) return undefined;
  return { ...o, y: o.y != null ? o.y + dy : undefined };
}

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
  scope: "legacy" | "general" | "custom";
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
    contentX: 580,
    contentY: 470,
    contentW: 450,
    subtitleColor: "#E9E1CF",
    titleColor: "#F3ECDC",
    nameColor: "#FFFFFF",
    unitColor: "#B7BECC",
    resultNo: { x: 70, y: 225, boxW: 340, fontSize: 132, color: "#EFE6D2" },
    // Cluster under the baked "Sahityotsav" wordmark (mirrors the old
    // Pantharangadi result-04 sector/date/place position).
    meta: { x: 130, y: 320, w: 820, color: "#D9D2C0", align: "center" },
  },
  // general-02 — maroon, lantern bottom-right, "Result" top-right, cyan
  // "Sahityotsav" wordmark upper-left. Tenant-neutral. Content in the
  // open maroon band on the left; light text.
  {
    src: "/poster/templates/general-02.png",
    scope: "general",
    contentX: 90,
    contentY: 480,
    contentW: 470,
    subtitleColor: "#F0E4DA",
    titleColor: "#F4E8DC",
    nameColor: "#FFFFFF",
    unitColor: "#CDB8C6",
    resultNo: { x: 645, y: 150, boxW: 340, fontSize: 132, color: "#F4A9C4" },
    // Cluster under the baked upper-left wordmark (mirrors the old
    // Pantharangadi result-05 sector/date/place position).
    meta: { x: 90, y: 300, w: 560, color: "#E9D9DF", align: "left" },
  },
];

export const POSTER_TEMPLATE_COUNT = TEMPLATES.length;

// A tenant-uploaded template (image lives in Supabase Storage; its
// positions live in events.poster_layout keyed by this id).
export type CustomTpl = { id: string; name: string; src: string };

// Default overlay layout for a freshly-uploaded custom image — a neutral
// starting point (mirrors general-01); the admin then drags every block
// to fit their art with the existing layout editor and saves it.
const CUSTOM_DEFAULT_LAYOUT: TemplateLayout = {
  src: "",
  scope: "custom",
  contentX: 560,
  contentY: 470,
  contentW: 460,
  subtitleColor: "#E9E1CF",
  titleColor: "#F3ECDC",
  nameColor: "#FFFFFF",
  unitColor: "#B7BECC",
  resultNo: { x: 70, y: 230, boxW: 340, fontSize: 132, color: "#EFE6D2" },
  meta: { x: 130, y: 320, w: 820, color: "#D9D2C0", align: "center" },
};

export type TemplateChoice = {
  key: string;
  name: string;
  builtinIndex: number | null;
  src: string | null;
};

/** Ordered, selectable templates for an event: the tenant's built-in set
 *  (Pantharangadi → legacy, others → general) followed by its uploaded
 *  custom templates. Built-in keys stay the global index (so existing
 *  poster_layout / result_template keep working); customs key by id. */
export function eventTemplateList(
  subdomain: string | null | undefined,
  custom: CustomTpl[],
): TemplateChoice[] {
  const want = subdomain === TEMPLATE_SUBDOMAIN ? "legacy" : "general";
  const builtins = TEMPLATES.map((t, i) => ({ t, i })).filter(
    (x) => x.t.scope === want,
  );
  const base = builtins.length
    ? builtins
    : TEMPLATES.map((t, i) => ({ t, i }));
  const list: TemplateChoice[] = base.map((x, n) => ({
    key: String(x.i),
    name: `Template ${n + 1}`,
    builtinIndex: x.i,
    src: null,
  }));
  for (const c of custom)
    list.push({
      key: c.id,
      name: c.name || "Custom",
      builtinIndex: null,
      src: c.src,
    });
  return list;
}

/** Resolve the active template from the saved default (custom id, else
 *  numeric built-in position) + a shuffle offset. Inputs tolerated. */
export function pickFromList(
  list: TemplateChoice[],
  defaultIndex: number,
  defaultId: string | null,
  shuffle = 0,
): TemplateChoice | null {
  if (list.length === 0) return null;
  let start = 0;
  if (defaultId) {
    const i = list.findIndex((x) => x.key === defaultId);
    if (i >= 0) start = i;
  } else {
    const builtinCount =
      list.filter((x) => x.builtinIndex !== null).length || list.length;
    start = (((defaultIndex % builtinCount) + builtinCount) % builtinCount);
  }
  const n = list.length;
  return list[(((start + shuffle) % n) + n) % n];
}

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

// Draggable, scalable wrapper for a poster element. Position via x/y,
// SIZE via Group scale (so all child text scales together). In editable
// mode the group is draggable and reports its new native coords.
function DraggableEl({
  el,
  baseX,
  baseY,
  ov,
  editable,
  onMove,
  children,
}: {
  el: LayoutEl;
  baseX: number;
  baseY: number;
  ov?: ElOverride;
  editable?: boolean;
  onMove?: (el: LayoutEl, x: number, y: number) => void;
  children: ReactNode;
}) {
  const x = ov?.x ?? baseX;
  const y = ov?.y ?? baseY;
  const s = ov?.s ?? 1;
  return (
    <Group
      x={x}
      y={y}
      scaleX={s}
      scaleY={s}
      draggable={!!editable}
      listening={!!editable}
      onDragEnd={(e) =>
        onMove?.(el, Math.round(e.target.x()), Math.round(e.target.y()))
      }
    >
      {children}
    </Group>
  );
}

// Tenant meta — org/sector name, date and place. Each is its own
// independently draggable/styled block now; these are the text sizes
// and the default stacked offsets (relative to the template's meta
// anchor) so an un-positioned poster looks like the old cluster.
const META_NAME_SIZE = 36;
const META_LINE_SIZE = 24;
const META_NAME_DY = 0;
const META_DATE_DY = Math.round(META_NAME_SIZE * 1.32 + 7); // 55
const META_PLACE_DY =
  META_DATE_DY + Math.round(META_LINE_SIZE * 1.32 + 7); // 55 + 39

// One tenant-meta line, rendered relative to (0,0) — DraggableEl
// provides the position/scale; ov supplies colour/weight overrides.
const MetaLine = ({
  text,
  size,
  defBold,
  layout,
  data,
  ov,
}: {
  text: string;
  size: number;
  defBold: boolean;
  layout: TemplateLayout;
  data: PosterData;
  ov?: ElOverride;
}) => {
  const m = layout.meta;
  if (!m) return null;
  return (
    <Text
      x={0}
      y={0}
      width={m.w}
      align={m.align ?? "left"}
      text={text}
      fontFamily={data.fontFamily || BODY_FONT}
      fontSize={size}
      fontStyle={ovFontStyle(ov, defBold)}
      fill={ovColor(ov, m.color)}
      lineHeight={1.2}
    />
  );
};

// Poster — client-only Konva stage. Overlays level/program/winners and
// the result number on top of a chosen template.
// ─────────────────────────────────────────────────────────────────────

export const PosterCanvas = ({
  data,
  templateIndex = 0,
  customSrc,
  stageRef,
  displayWidth,
  editable = false,
  onMove,
}: {
  data: PosterData;
  templateIndex?: number;
  /** Tenant-uploaded background URL. When set, the built-in template is
   *  ignored and the neutral custom layout is used (admin positions it
   *  via the existing editor → poster_layout). */
  customSrc?: string;
  stageRef?: React.MutableRefObject<Konva.Stage | null>;
  /** When omitted, the canvas fills the parent container width. */
  displayWidth?: number;
  /** Drag-to-position mode (admin layout editor). */
  editable?: boolean;
  onMove?: (el: LayoutEl, x: number, y: number) => void;
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

  const layout = customSrc
    ? { ...CUSTOM_DEFAULT_LAYOUT, src: customSrc }
    : TEMPLATES[templateIndex % TEMPLATES.length];
  const font = data.fontFamily || BODY_FONT;
  const { img: template, done: imgDone, slow } = usePosterImage(layout.src);

  const w = displayWidth ?? autoW;
  const scale = w / STAGE_W;
  const displayHeight = STAGE_H * scale;
  const ready = mounted && w > 0 && imgDone;

  // Some blocks used to be merged and have since been split so each is
  // movable on its own. Fall back to the old combined override so
  // already-positioned layouts keep their look; new edits write the
  // split keys. Sub-blocks inherit the parent's offset + their old gap.
  //   content → level + program
  //   meta    → orgName + date + place
  const co = data.overrides?.content;
  const levelOv: ElOverride | undefined = data.overrides?.level ?? co;
  const programOv: ElOverride | undefined =
    data.overrides?.program ?? shiftY(co, PROGRAM_DY);

  const mo = data.overrides?.meta;
  const orgNameOv: ElOverride | undefined = data.overrides?.orgName ?? mo;
  const dateOv: ElOverride | undefined =
    data.overrides?.date ?? shiftY(mo, META_DATE_DY);
  const placeOv: ElOverride | undefined =
    data.overrides?.place ?? shiftY(mo, META_PLACE_DY);

  return (
    <div
      ref={wrapRef}
      className="w-full"
      style={{
        aspectRatio: "4 / 5",
        overflow: "hidden",
        // Read-only posters must NOT swallow taps/scrolls (parent handles
        // tap-to-zoom). The editor needs pointer events for dragging.
        pointerEvents: editable ? "auto" : "none",
        touchAction: editable ? "none" : "pan-y",
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

          {/* Admin overlay (general/custom templates): org name, date
              and place — each its own independently movable block */}
          {layout.meta && data.orgName?.trim() && (
            <DraggableEl
              el="orgName"
              baseX={layout.meta.x}
              baseY={layout.meta.y + META_NAME_DY}
              ov={orgNameOv}
              editable={editable}
              onMove={onMove}
            >
              <MetaLine
                text={data.orgName.trim()}
                size={META_NAME_SIZE}
                defBold
                layout={layout}
                data={data}
                ov={orgNameOv}
              />
            </DraggableEl>
          )}
          {layout.meta && data.posterDate?.trim() && (
            <DraggableEl
              el="date"
              baseX={layout.meta.x}
              baseY={layout.meta.y + META_DATE_DY}
              ov={dateOv}
              editable={editable}
              onMove={onMove}
            >
              <MetaLine
                text={data.posterDate.trim()}
                size={META_LINE_SIZE}
                defBold={false}
                layout={layout}
                data={data}
                ov={dateOv}
              />
            </DraggableEl>
          )}
          {layout.meta && data.posterPlace?.trim() && (
            <DraggableEl
              el="place"
              baseX={layout.meta.x}
              baseY={layout.meta.y + META_PLACE_DY}
              ov={placeOv}
              editable={editable}
              onMove={onMove}
            >
              <MetaLine
                text={data.posterPlace.trim()}
                size={META_LINE_SIZE}
                defBold={false}
                layout={layout}
                data={data}
                ov={placeOv}
              />
            </DraggableEl>
          )}

          {/* Category / level — independently positioned & styled */}
          <DraggableEl
            el="level"
            baseX={layout.contentX}
            baseY={layout.contentY}
            ov={levelOv}
            editable={editable}
            onMove={onMove}
          >
            <LevelText data={data} layout={layout} ov={levelOv} />
          </DraggableEl>

          {/* Program name — its own block, moved & styled separately */}
          <DraggableEl
            el="program"
            baseX={layout.contentX}
            baseY={layout.contentY + PROGRAM_DY}
            ov={programOv}
            editable={editable}
            onMove={onMove}
          >
            <ProgramText data={data} layout={layout} ov={programOv} />
          </DraggableEl>

          {/* Winners list */}
          <DraggableEl
            el="winners"
            baseX={layout.contentX}
            baseY={winnersStartY(layout)}
            ov={data.overrides?.winners}
            editable={editable}
            onMove={onMove}
          >
            <WinnersList
              winners={data.winners}
              layout={layout}
              font={font}
              ov={data.overrides?.winners}
            />
          </DraggableEl>

          {/* Result number — large, centered under the "Result" script */}
          {data.resultNo && (
            <DraggableEl
              el="resultNo"
              baseX={layout.resultNo.x}
              baseY={layout.resultNo.y}
              ov={data.overrides?.resultNo}
              editable={editable}
              onMove={onMove}
            >
              <Text
                x={0}
                y={0}
                width={layout.resultNo.boxW}
                align="center"
                text={formatResultNo(data.resultNo)}
                fontFamily={font}
                fontSize={layout.resultNo.fontSize}
                fontStyle={ovFontStyle(data.overrides?.resultNo, true)}
                fill={ovColor(data.overrides?.resultNo, layout.resultNo.color)}
              />
            </DraggableEl>
          )}
        </Layer>
      </Stage>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Level (category) and program — two independent text blocks. The
// highlight that used to sit behind the level is part of each template's
// artwork now, so nothing is drawn behind the text here.
// ─────────────────────────────────────────────────────────────────────

const SUBTITLE_SIZE = 34;
const SUBTITLE_GAP = 14;
const TITLE_SIZE = 50;
const TITLE_LH = 1.05;
const TITLE_LINE_BUDGET = 2;
const TITLE_TO_WINNERS_GAP = 38;

// Default vertical offset of the program block below the level block.
// Kept equal to the legacy pill height + gap so existing templates and
// already-saved layouts don't shift now that the baked highlight is gone.
const LEVEL_BLOCK_H = 54;
const PROGRAM_DY = LEVEL_BLOCK_H + SUBTITLE_GAP;

function LevelText({
  data,
  layout,
  ov,
}: {
  data: PosterData;
  layout: TemplateLayout;
  ov?: ElOverride;
}) {
  const font = data.fontFamily || BODY_FONT;
  return (
    <Text
      x={0}
      y={0}
      text={data.levelName}
      fontFamily={font}
      fontSize={SUBTITLE_SIZE}
      fontStyle={ovFontStyle(ov, true)}
      fill={ovColor(ov, layout.subtitleColor)}
    />
  );
}

function ProgramText({
  data,
  layout,
  ov,
}: {
  data: PosterData;
  layout: TemplateLayout;
  ov?: ElOverride;
}) {
  // Girls' programs carry a longer "(Girls)" qualifier, so trim a touch
  // more so they still fit the title block.
  const titleSize =
    TITLE_SIZE - (/girls/i.test(data.programName) ? 6 : 4);
  const font = data.fontFamily || BODY_FONT;
  return (
    <Text
      x={0}
      y={0}
      width={layout.contentW}
      text={data.programName}
      fontFamily={font}
      fontSize={titleSize}
      fontStyle={ovFontStyle(ov, true)}
      fill={ovColor(ov, layout.titleColor)}
      lineHeight={TITLE_LH}
      wrap="word"
    />
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
    PROGRAM_DY +
    titleH +
    TITLE_TO_WINNERS_GAP
  );
}

function WinnersList({
  winners,
  layout,
  font,
  ov,
}: {
  winners: PosterWinner[];
  layout: TemplateLayout;
  font: string;
  ov?: ElOverride;
}) {
  // position < 1 ⇒ grade-only entries (counted for team points, never
  // shown on the poster). Only ranked places 1–4 render here.
  const sorted = [...winners]
    .filter((w) => w.position >= 1)
    .sort((a, b) => a.position - b.position)
    .slice(0, 4);

  return (
    <>
      {sorted.map((w, i) => (
        <WinnerRow
          key={`${w.position}-${i}`}
          winner={w}
          y={i * (ROW_H + ROW_GAP)}
          layout={layout}
          font={font}
          ov={ov}
        />
      ))}
    </>
  );
}

function WinnerRow({
  winner,
  y,
  layout,
  font,
  ov,
}: {
  winner: PosterWinner;
  y: number;
  layout: TemplateLayout;
  font: string;
  ov?: ElOverride;
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
        fontStyle={ovFontStyle(ov, true)}
        fill={ovColor(ov, layout.nameColor)}
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
          fontStyle={ovFontStyle(ov, false)}
          fill={ovColor(ov, layout.unitColor)}
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
