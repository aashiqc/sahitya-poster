import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, data } from "react-router";
import type { Route } from "./+types/home";
import { createSupabaseServerClient, loadEvent } from "~/lib/supabase.server";
import { SITE_URL } from "~/lib/constants";
import { TEAM_BY_SLUG } from "~/lib/teams";
import type Konva from "konva";
import {
  PosterCanvas,
  exportPosterPng,
  prefetchPosterAssets,
  sharePoster,
  type PosterData,
} from "~/components/poster-canvas";
import { PosterZoomModal } from "~/components/poster-modal";
import { StandingsSheet } from "~/components/standings-sheet";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Download,
  Share2,
  Sparkles,
  Trophy,
} from "lucide-react";

export function meta({ data }: Route.MetaArgs) {
  const eventName =
    (data?.event as { name?: string; name_ml?: string } | null)?.name ??
    (data?.event as { name_ml?: string } | null)?.name_ml ??
    "Sahityotsav";
  const title = `${eventName} · Results`;
  const description = `Live results from ${eventName} — browse winners by category as they're announced.`;
  const image = `${SITE_URL}/sahityotsav-logo.png`;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: SITE_URL },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: SITE_URL },
    { property: "og:site_name", content: "SSF Pantharangadi Sahityotsav" },
    { property: "og:locale", content: "en_IN" },
    { property: "og:image", content: image },
    { property: "og:image:alt", content: `${eventName} logo` },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const event = await loadEvent(supabase);
  if (event.status !== "published") {
    return data(
      { event, published: false as const },
      { headers: { ...Object.fromEntries(headers), "Cache-Control": "no-store" } },
    );
  }

  const [levelsRes, programsRes, resultsRes] = await Promise.all([
    supabase
      .from("levels")
      .select("id, code, name_ml, sort_order")
      .eq("event_id", event.id)
      .order("sort_order"),
    supabase
      .from("programs")
      .select("id, code, name_ml, name_en, sort_order, level_id")
      .eq("event_id", event.id)
      .eq("is_active", true)
      .order("sort_order")
      .order("code"),
    supabase
      .from("results")
      .select(`
        id, result_no, program_id, published_at,
        result_winners(position, name_ml, name_en, unit_ml, marks, grade)
      `)
      .eq("event_id", event.id)
      .eq("status", "published"),
  ]);

  const levels = levelsRes.data ?? [];
  const programs = programsRes.data ?? [];
  const results = resultsRes.data ?? [];

  type WinnerRow = {
    position: number;
    name_ml: string;
    name_en: string | null;
    unit_ml: string | null;
    marks: number | null;
    grade: string | null;
  };
  type ResultSummary = {
    id: string;
    result_no: string | null;
    published_at: string | null;
    winners: WinnerRow[];
  };
  const resultByProgram = new Map<string, ResultSummary>();
  const allWinners: WinnerRow[] = [];
  for (const r of results) {
    const winners = ((r.result_winners as WinnerRow[]) ?? []).map((w) => ({
      ...w,
      marks: w.marks !== null && w.marks !== undefined ? Number(w.marks) : null,
    }));
    resultByProgram.set(r.program_id, {
      id: r.id,
      result_no: r.result_no,
      published_at: r.published_at,
      winners,
    });
    allWinners.push(...winners);
  }

  const enrichedLevels = levels.map((l) => {
    const lps = programs
      .filter((p) => p.level_id === l.id)
      .map((p) => ({ ...p, result: resultByProgram.get(p.id) ?? null }));
    return {
      ...l,
      programs: lps,
      total: lps.length,
      published: lps.filter((p) => p.result).length,
    };
  });

  return data(
    {
      event,
      published: true as const,
      levels: enrichedLevels,
      totalPublished: results.length,
      totalPrograms: programs.length,
      allWinners,
    },
    {
      headers: {
        ...Object.fromEntries(headers),
        "Cache-Control": "public, max-age=30, s-maxage=120",
      },
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

type Winner = {
  position: number;
  name_ml: string;
  name_en: string | null;
  unit_ml: string | null;
};

type Program = {
  id: string;
  code: string;
  name_ml: string;
  name_en: string | null;
  level_id: string;
  sort_order: number;
  result: {
    id: string;
    result_no: string | null;
    published_at: string | null;
    winners: Winner[];
  } | null;
};

type Level = {
  id: string;
  code: string;
  name_ml: string;
  sort_order: number;
  programs: Program[];
  published: number;
  total: number;
};

// ─────────────────────────────────────────────────────────────────────
// English display helpers — the bot speaks English. Levels carry no
// name_en, so the slug code is title-cased (high-school → High School).
// ─────────────────────────────────────────────────────────────────────

function levelLabel(level: { code: string; name_ml: string }): string {
  if (!level.code) return level.name_ml;
  return level.code
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function programLabel(program: { name_en: string | null; code: string }): string {
  return program.name_en?.trim() || program.code;
}

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export default function Home({ loaderData }: Route.ComponentProps) {
  if (!loaderData.published) {
    return <NotYetLive event={loaderData.event} />;
  }
  const { event, levels, totalPublished, allWinners } = loaderData;
  const org = (event.organizations as { name?: string } | null)?.name;
  const eventName = event.name ?? event.name_ml;
  const [standingsOpen, setStandingsOpen] = useState(false);

  const sector = (org ? org.replace(/^SSF\s+/i, "") : "") || "Sahityotsav";

  return (
    <div className="relative min-h-dvh flex flex-col">
      {/* Flowing layered waves — clean warm base + parallax wave bands */}
      <WaveBackground />

      {/* ── Header — compact, mobile-first, sector-led ── */}
      <header className="sticky top-0 z-20">
        <div className="relative bg-gradient-to-b from-[#23110F] via-[#160C0D] to-[#0B090A] text-white backdrop-blur-xl shadow-[0_12px_34px_-14px_rgba(11,9,10,0.75)]">
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-yellow/70 to-transparent"
          />
          <div className="mx-auto max-w-2xl md:max-w-3xl lg:max-w-4xl px-4 sm:px-5">
            {/* Row 1 — brand + primary action */}
            <div className="flex items-center justify-between gap-3 pt-3 pb-2">
              <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                <span className="ssf-mark shrink-0 text-white text-[1.6rem] leading-none drop-shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
                  SSF
                </span>
                <span aria-hidden className="h-7 w-px shrink-0 bg-white/20" />
                <img
                  src="/sahityotsav-logo.png"
                  alt={eventName ?? "Sahityotsav"}
                  className="h-[18px] w-auto min-w-0 select-none"
                  draggable={false}
                />
              </div>

              <button
                type="button"
                onClick={() => setStandingsOpen(true)}
                className="font-opensans group shrink-0 inline-flex items-center gap-1.5 rounded-full bg-white text-black px-3.5 py-2 text-xs font-bold tracking-wide uppercase shadow-[0_4px_14px_-4px_rgba(0,0,0,0.5)] transition-all duration-200 active:scale-[0.96] hover:shadow-[0_6px_18px_-4px_rgba(0,0,0,0.6)]"
              >
                <Trophy
                  className="size-4 transition-transform duration-200 group-hover:-rotate-12"
                  strokeWidth={2.5}
                  aria-hidden
                />
                Standings
              </button>
            </div>

            {/* Row 2 — sector (full width, prominent) + live heartbeat.
                On its own line so it never collides with the button. */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2.5 border-t border-white/10 pt-2">
              <span className="font-opensans text-[13px] font-bold uppercase tracking-[0.16em] text-yellow">
                {sector}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px]">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-yellow/70" />
                  <span className="relative inline-flex size-2 rounded-full bg-yellow" />
                </span>
                <span className="font-bold tracking-[0.14em] uppercase text-yellow/90">
                  Live
                </span>
              </span>
            </div>
          </div>

          {/* Decorative full-bleed brand edge */}
          <div
            aria-hidden
            className="h-[3px] w-full bg-gradient-to-r from-red via-yellow to-red opacity-90"
          />
        </div>
      </header>

      {standingsOpen && (
        <StandingsSheet
          totalPublished={totalPublished}
          winners={allWinners}
          onClose={() => setStandingsOpen(false)}
        />
      )}

      <main className="relative z-10 flex-1 w-full max-w-2xl md:max-w-3xl lg:max-w-4xl mx-auto px-3.5 sm:px-5 py-6 sm:py-8">
        <ChatFlow
          levels={levels as Level[]}
          eventName={eventName ?? "Sahityotsav"}
          sector={sector}
        />
      </main>
    </div>
  );
}

// SSF wordmark — always rendered in the brand Cooper Black letterform.
function Ssf({ className = "" }: { className?: string }) {
  return <span className={`ssf-mark ${className}`}>SSF</span>;
}

// Flowing layered-wave background — a clean warm base with three
// parallax wave bands scrolling horizontally (CSS/SVG only).
function WaveBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <div className="app-backdrop absolute inset-0" />
      <div className="app-wave app-wave--back" />
      <div className="app-wave app-wave--mid" />
      <div className="app-wave app-wave--front" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Chat flow
// ─────────────────────────────────────────────────────────────────────

type Bubble = {
  id: string;
  side: "bot" | "user";
  node: ReactNode;
  wide?: boolean;
  tight?: boolean;
};

function ChatFlow({
  levels,
  eventName,
  sector,
}: {
  levels: Level[];
  eventName: string;
  sector: string;
}) {
  // Initial bubbles — rendered SSR, hydrated on client.
  const initial: Bubble[] = [
    {
      id: "greet",
      side: "bot",
      node: (
        <GreetingBubble sector={sector} />
      ),
    },
  ];

  const [bubbles, setBubbles] = useState<Bubble[]>(initial);
  const [typing, setTyping] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++seqRef.current}`;

  const scrollToEnd = () =>
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });

  // Warm the poster-template cache once the chat is interactive so the
  // first result a user opens renders instantly (idle, low priority).
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    };
    const run = () => prefetchPosterAssets();
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run);
      return () => (w as unknown as { cancelIdleCallback?: (n: number) => void })
        .cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(run, 1200);
    return () => window.clearTimeout(t);
  }, []);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    scrollToEnd();
  }, [bubbles.length, typing]);

  // Track whether the reader has scrolled up through history
  useEffect(() => {
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >=
        document.body.offsetHeight - 120;
      setAtBottom(nearBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function push(b: Bubble) {
    setBubbles((prev) => [...prev, b]);
  }

  async function withTyping(ms: number, fn: () => void) {
    setTyping(true);
    await new Promise((r) => setTimeout(r, ms));
    setTyping(false);
    fn();
  }

  // Handlers — referenced from rendered bubbles below
  function handlePickLevel(level: Level) {
    push({
      id: nextId("u"),
      side: "user",
      node: <span>{levelLabel(level)}</span>,
    });
    withTyping(380, () => {
      push({
        id: nextId("b"),
        side: "bot",
        node: <ProgramPickerBubble level={level} onPick={handlePickProgram} onDifferentLevel={handleDifferentLevel} />,
      });
    });
  }

  function handlePickProgram(level: Level, program: Program) {
    push({
      id: nextId("u"),
      side: "user",
      node: <span>{programLabel(program)}</span>,
    });
    withTyping(program.result ? 480 : 280, () => {
      if (program.result) {
        push({
          id: nextId("b"),
          side: "bot",
          wide: true,
          tight: true,
          node: (
            <ResultBubble
              eventName={eventName}
              level={level}
              program={program}
              winners={program.result.winners}
              resultNo={program.result.result_no}
              onAnotherInLevel={() => handleAnotherInLevel(level)}
              onDifferentLevel={handleDifferentLevel}
            />
          ),
        });
      } else {
        push({
          id: nextId("b"),
          side: "bot",
          node: (
            <AwaitingBubble
              level={level}
              program={program}
              onAnotherInLevel={() => handleAnotherInLevel(level)}
              onDifferentLevel={handleDifferentLevel}
            />
          ),
        });
      }
    });
  }

  function handleAnotherInLevel(level: Level) {
    push({
      id: nextId("u"),
      side: "user",
      node: (
        <>
          Another in {levelLabel(level)}
        </>
      ),
    });
    withTyping(220, () => {
      push({
        id: nextId("b"),
        side: "bot",
        node: <ProgramPickerBubble level={level} onPick={handlePickProgram} onDifferentLevel={handleDifferentLevel} />,
      });
    });
  }

  function handleDifferentLevel() {
    push({ id: nextId("u"), side: "user", node: <>Different category</> });
    withTyping(220, () => {
      push({
        id: nextId("b"),
        side: "bot",
        node: <LevelPickerBubble levels={levels} onPick={handlePickLevel} />,
      });
    });
  }

  // Render
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="space-y-3.5 pb-2"
    >
      {bubbles.map((b) => (
        <BubbleRow key={b.id} side={b.side} wide={b.wide} tight={b.tight}>
          {b.node}
        </BubbleRow>
      ))}

      {/* The seeded first interaction prompt — always shown initially, then user can re-enter via Different category */}
      {bubbles.length === 1 && !typing && (
        <BubbleRow side="bot">
          <LevelPickerBubble levels={levels} onPick={handlePickLevel} />
        </BubbleRow>
      )}

      {typing && (
        <BubbleRow side="bot">
          <TypingDots />
        </BubbleRow>
      )}

      <div ref={endRef} className="h-px" />

      {/* Jump-to-latest — appears only while reading back through history */}
      <button
        type="button"
        onClick={scrollToEnd}
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
        className={`fixed bottom-5 left-1/2 z-30 inline-flex items-center gap-1.5 rounded-full bg-black text-white px-4 py-2 text-xs font-semibold shadow-[0_10px_30px_-8px_rgba(11,9,10,0.55)] ring-1 ring-yellow/30 transition-all duration-300 ${
          atBottom
            ? "pointer-events-none translate-y-4 opacity-0"
            : "-translate-x-1/2 opacity-100 hover:-translate-y-0.5"
        }`}
        style={atBottom ? { transform: "translate(-50%, 1rem)" } : undefined}
      >
        <ChevronDown className="size-4 text-yellow" strokeWidth={2.5} aria-hidden />
        Latest
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bubble shell
// ─────────────────────────────────────────────────────────────────────

function BubbleRow({
  side,
  wide = false,
  tight = false,
  children,
}: {
  side: "bot" | "user";
  wide?: boolean;
  tight?: boolean;
  children: ReactNode;
}) {
  const isBot = side === "bot";
  const widthCls = wide
    ? "w-full md:max-w-[600px]"
    : "max-w-[84%] sm:max-w-[76%]";
  const padCls = tight ? "p-1.5" : isBot ? "px-4 py-3" : "px-4 py-2.5";
  // Asymmetric radius gives the speech-bubble read without a fragile
  // clip-path tail (the old tail broke at sub-pixel sizes on mobile).
  const shellCls = isBot
    ? "bubble-bot text-ink-900 rounded-[1.25rem] rounded-tl-md"
    : "bubble-user text-white rounded-[1.25rem] rounded-tr-md";
  return (
    <div
      className={`animate-bubble-in flex items-start gap-2 sm:gap-2.5 ${
        isBot ? "justify-start" : "justify-end"
      }`}
    >
      {isBot && <BotAvatar />}
      <div className={`relative ${widthCls} ${padCls} ${shellCls}`}>
        {children}
      </div>
      {!isBot && <span aria-hidden className="w-1 shrink-0" />}
    </div>
  );
}

function BotAvatar() {
  return (
    <div
      aria-hidden
      className="mt-0.5 shrink-0 size-8 sm:size-9 grid place-items-center rounded-full bg-gradient-to-br from-red to-brand-800 text-yellow shadow-[0_4px_12px_-4px_rgba(191,6,3,0.6)] ring-2 ring-white"
    >
      <Sparkles className="size-[15px] sm:size-4" strokeWidth={2.5} aria-hidden />
    </div>
  );
}

function TypingDots() {
  return (
    <span
      aria-label="Typing"
      className="inline-flex items-center gap-1.5 py-1.5 px-1"
    >
      <span className="size-2 rounded-full bg-red/60 animate-bounce [animation-delay:-0.3s]" />
      <span className="size-2 rounded-full bg-red/60 animate-bounce [animation-delay:-0.15s]" />
      <span className="size-2 rounded-full bg-red/60 animate-bounce" />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bot bubble contents
// ─────────────────────────────────────────────────────────────────────

function GreetingBubble({ sector }: { sector: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-red/80">
        Sahityotsav · Live Results
      </p>
      <p className="font-opensans text-xl sm:text-[1.6rem] font-semibold leading-snug text-ink-900 mt-1.5">
        <span>Welcome to </span>
        <Ssf className="text-red text-[1.1em] align-baseline mr-1.5" />
        <span className="font-bold text-red">{sector}</span>
      </p>
      <p className="text-[13px] leading-relaxed text-ink-500 mt-2">
        Pick a category below to see the winners — new results appear here the
        moment they're announced.
      </p>
    </div>
  );
}

function LevelPickerBubble({
  levels,
  onPick,
}: {
  levels: Level[];
  onPick: (l: Level) => void;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-ink-800">Which category?</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {levels.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l)}
            className="group inline-flex items-center gap-2 rounded-full border border-black/12 bg-white px-4 py-2.5 transition-all duration-200 hover:border-yellow hover:bg-yellow/10 hover:-translate-y-px hover:shadow-[0_6px_16px_-8px_rgba(11,9,10,0.25)] active:translate-y-0 active:scale-[0.97]"
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${
                l.published > 0
                  ? "bg-green-600 group-hover:bg-green-600"
                  : "bg-ink-300"
              }`}
            />
            <span className="text-sm font-semibold text-ink-900">
              {levelLabel(l)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProgramPickerBubble({
  level,
  onPick,
  onDifferentLevel,
}: {
  level: Level;
  onPick: (l: Level, p: Program) => void;
  onDifferentLevel: () => void;
}) {
  const ready = level.programs.filter((p) => p.result);
  const pending = level.programs.filter((p) => !p.result);

  return (
    <div>
      <p className="text-sm text-ink-700">
        Programs in{" "}
        <span className="font-semibold text-ink-900">{levelLabel(level)}</span>
        {ready.length > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-bold uppercase tracking-wide text-green-700">
            <span className="size-1.5 rounded-full bg-green-600 animate-pulse" />
            Live
          </span>
        )}
      </p>

      {ready.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1">
          {ready.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(level, p)}
              className="group flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-left transition-all duration-200 active:scale-[0.99] hover:border-yellow hover:bg-yellow/[0.07] hover:shadow-[0_6px_14px_-12px_rgba(11,9,10,0.35)]"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-ink-900">
                {programLabel(p)}
              </span>
              <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                {p.code}
              </span>
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-full bg-black/[0.04] text-ink-500 transition-all duration-200 group-hover:bg-yellow group-hover:text-black"
              >
                <ChevronRight
                  className="size-3.5 transition-transform duration-200 group-hover:translate-x-px"
                  strokeWidth={2.75}
                />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-400 mt-2">
          No results published yet in this category.
        </p>
      )}

      {pending.length > 0 && (
        <details className="mt-3 group">
          <summary className="inline-flex items-center gap-1 cursor-pointer text-[11px] text-ink-400 font-semibold tracking-wide uppercase hover:text-ink-700 transition-colors">
            <ChevronDown
              className="size-3 transition-transform duration-200 group-open:rotate-180"
              strokeWidth={3}
              aria-hidden
            />
            Programs awaiting results
          </summary>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {pending.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(level, p)}
                className="rounded-full border border-dashed border-black/15 bg-paper-2 px-3 py-1 text-[11px] font-medium text-ink-500 transition-colors hover:border-solid hover:border-red/40 hover:text-red"
              >
                <span>{programLabel(p)}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      <ChoiceRow>
        <ChoiceButton onClick={onDifferentLevel}>Different category</ChoiceButton>
      </ChoiceRow>
    </div>
  );
}

function AwaitingBubble({
  level,
  program,
  onAnotherInLevel,
  onDifferentLevel,
}: {
  level: Level;
  program: Program;
  onAnotherInLevel: () => void;
  onDifferentLevel: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-ink-800">
        <span className="font-semibold text-ink-900">{programLabel(program)}</span>{" "}
        isn't announced yet.
      </p>
      <p className="text-xs text-ink-500 mt-1">
        Try another program — results come in fast.
      </p>
      <ChoiceRow>
        <ChoiceButton onClick={onAnotherInLevel}>
          Another in {levelLabel(level)}
        </ChoiceButton>
        <ChoiceButton onClick={onDifferentLevel}>Different category</ChoiceButton>
      </ChoiceRow>
    </div>
  );
}

function ResultBubble({
  eventName,
  level,
  program,
  winners,
  resultNo,
  onDifferentLevel,
}: {
  eventName: string;
  level: Level;
  program: Program;
  winners: Winner[];
  resultNo: string | null;
  onAnotherInLevel: () => void;
  onDifferentLevel: () => void;
}) {
  const sorted = [...winners].sort((a, b) => a.position - b.position);
  const stageRef = useRef<Konva.Stage | null>(null);
  const [busy, setBusy] = useState<null | "download" | "share">(null);
  const [zoom, setZoom] = useState(false);
  const [tmpl, setTmpl] = useState(() => Math.floor(Math.random() * 3));

  const posterData: PosterData = {
    eventName,
    levelName: levelLabel(level),
    programName: program.name_en ?? program.code,
    programCode: program.code,
    resultNo,
    winners: sorted.map((w) => {
      const slug = w.unit_ml?.toLowerCase() ?? null;
      const unitEn = slug ? TEAM_BY_SLUG[slug]?.name ?? w.unit_ml : w.unit_ml;
      return {
        position: w.position,
        name: w.name_en ?? w.name_ml,
        unit: unitEn,
      };
    }),
  };

  async function onDownload() {
    setBusy("download");
    try {
      await exportPosterPng(stageRef.current, `${program.code}_poster.png`);
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    setBusy("share");
    try {
      await sharePoster(stageRef.current, posterData);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label="View poster full size"
        style={{ touchAction: "manipulation" }}
        className="block w-full overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
      >
        <PosterCanvas data={posterData} templateIndex={tmpl} stageRef={stageRef} />
      </button>

      <div className="mt-2 px-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <IconButton
            label="Download poster"
            onClick={onDownload}
            disabled={busy !== null}
            tone="brand"
          >
            {busy === "download" ? <Spinner /> : <DownloadIcon />}
          </IconButton>
          <IconButton
            label="Share poster"
            onClick={onShare}
            disabled={busy !== null}
            tone="brand"
          >
            {busy === "share" ? <Spinner /> : <ShareIcon />}
          </IconButton>
          <IconButton
            label="Switch template"
            onClick={() => setTmpl((t) => (t + 1) % 3)}
            tone="ghost"
          >
            <SwapIcon />
          </IconButton>
        </div>
        <button
          type="button"
          onClick={onDifferentLevel}
          className="rounded-full border border-black/15 bg-white px-4 py-2 text-xs font-semibold text-ink-800 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-yellow hover:bg-yellow/15 active:translate-y-0 active:scale-[0.97] shrink-0"
        >
          Another result
        </button>
      </div>

      {zoom && (
        <PosterZoomModal
          data={posterData}
          templateIndex={tmpl}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  );
}


function IconButton({
  label,
  onClick,
  disabled,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone: "brand" | "ghost";
  children: ReactNode;
}) {
  const toneCls =
    tone === "brand"
      ? "bg-red hover:bg-brand-600 text-white shadow-sm"
      : "bg-white hover:bg-yellow/15 border border-black/10 text-black";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center size-10 rounded-full disabled:opacity-50 transition ${toneCls}`}
    >
      {children}
    </button>
  );
}

const SwapIcon = () => <ArrowLeftRight className="size-[18px]" aria-hidden />;
const DownloadIcon = () => <Download className="size-[18px]" aria-hidden />;
const ShareIcon = () => <Share2 className="size-[18px]" aria-hidden />;

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 rounded-full border-2 border-current/30 border-t-current animate-spin"
    />
  );
}

function ChoiceRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2 pt-3 border-t border-dashed border-black/10">
      {children}
    </div>
  );
}

function ChoiceButton({
  onClick,
  children,
  primary = false,
}: {
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
}) {
  const cls = primary
    ? "rounded-full bg-red text-white px-4 py-2 text-xs font-semibold shadow-[0_4px_14px_-4px_rgba(191,6,3,0.6)] transition-all duration-200 hover:-translate-y-px hover:bg-brand-600 active:translate-y-0 active:scale-[0.97]"
    : "rounded-full border border-black/15 bg-white text-ink-800 px-4 py-2 text-xs font-semibold transition-all duration-200 hover:-translate-y-px hover:border-yellow hover:bg-yellow/15 active:translate-y-0 active:scale-[0.97]";
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Not-yet-live
// ─────────────────────────────────────────────────────────────────────

function NotYetLive({
  event,
}: {
  event: { name_ml: string | null; name: string };
}) {
  const name = event.name ?? event.name_ml;
  return (
    <div className="relative min-h-dvh flex items-center justify-center px-4">
      <WaveBackground />

      <div className="animate-bubble-in max-w-md w-full text-center bubble-bot rounded-3xl px-8 py-14">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow text-black text-[11px] font-bold tracking-[0.18em] uppercase px-3.5 py-1.5 shadow-[0_4px_14px_-4px_rgba(255,206,5,0.7)]">
          <span className="size-1.5 rounded-full bg-black animate-pulse" />
          Coming soon
        </span>
        <h1 className="font-editorial text-4xl font-semibold tracking-tight mt-7 text-ink-900">
          {name}
        </h1>
        <div
          aria-hidden
          className="mt-6 mx-auto h-px max-w-[10rem] bg-gradient-to-r from-transparent via-red/40 to-transparent"
        />
        <p className="text-sm text-ink-500 mt-6 leading-relaxed">
          The first winners will appear here, live, as they are announced.
        </p>
        <Link
          to="/admin"
          className="inline-block mt-9 text-xs font-medium text-ink-400 hover:text-red transition-colors underline underline-offset-4"
        >
          Admin
        </Link>
      </div>
    </div>
  );
}
