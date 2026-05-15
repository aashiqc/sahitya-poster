import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, data } from "react-router";
import type { Route } from "./+types/home";
import { createSupabaseServerClient, loadEvent } from "~/lib/supabase.server";
import { TEAM_BY_SLUG } from "~/lib/teams";
import type Konva from "konva";
import {
  PosterCanvas,
  exportPosterPng,
  sharePoster,
  type PosterData,
} from "~/components/poster-canvas";
import { PosterZoomModal } from "~/components/poster-modal";
import { StandingsSheet } from "~/components/standings-sheet";
import { ArrowLeftRight, Download, Share2, Trophy } from "lucide-react";

export function meta({ data }: Route.MetaArgs) {
  const eventName =
    (data?.event as { name?: string; name_ml?: string } | null)?.name ??
    (data?.event as { name_ml?: string } | null)?.name_ml ??
    "Sahityotsav";
  return [
    { title: `${eventName} · Results` },
    { name: "description", content: `Live results from ${eventName}.` },
    { property: "og:title", content: `${eventName} · Results` },
    { property: "og:type", content: "website" },
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
  const { event, levels, totalPublished, totalPrograms, allWinners } = loaderData;
  const org = (event.organizations as { name?: string } | null)?.name;
  const eventName = event.name ?? event.name_ml;
  const [standingsOpen, setStandingsOpen] = useState(false);

  return (
    <div className="relative min-h-dvh flex flex-col">
      {/* Fixed, layered gradient backdrop — calm + brand accent */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-gradient-to-b from-paper-2 via-white to-paper-3"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -top-40 -left-40 size-[36rem] rounded-full bg-yellow/30 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -bottom-48 -right-32 size-[40rem] rounded-full bg-red/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(80%_60%_at_50%_-10%,rgba(255,206,5,0.10),transparent_70%)]"
      />

      {/* Compact sticky black header */}
      <header className="sticky top-0 z-20 bg-black text-white shadow-sm">
        <div className="max-w-2xl md:max-w-3xl lg:max-w-4xl mx-auto px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {org && (
              <p className="flex items-baseline gap-1.5 leading-none">
                <span
                  className="font-[var(--font-cooper)] text-yellow text-sm sm:text-base leading-none tracking-tight"
                  style={{ fontFamily: "var(--font-cooper)" }}
                >
                  SSF
                </span>
                <span className="text-[10px] sm:text-[11px] font-medium tracking-wide uppercase text-white/85">
                  {org.replace(/^SSF\s+/i, "")}
                </span>
              </p>
            )}
            <h1 className="mt-0.5 leading-none">
              <img
                src="/sahityotsav-logo.png"
                alt={eventName ?? "Sahityotsav"}
                className="h-5 sm:h-6 w-auto select-none"
                draggable={false}
              />
            </h1>
          </div>

          <button
            type="button"
            onClick={() => setStandingsOpen(true)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-yellow text-black hover:bg-yellow/90 px-3 py-1.5 text-[11px] font-semibold cursor-pointer"
          >
            <Trophy className="size-3.5" strokeWidth={2.5} aria-hidden />
            Standings
          </button>
        </div>
      </header>

      {standingsOpen && (
        <StandingsSheet
          totalPublished={totalPublished}
          winners={allWinners}
          onClose={() => setStandingsOpen(false)}
        />
      )}

      <main className="relative z-10 flex-1 max-w-2xl md:max-w-3xl lg:max-w-4xl w-full mx-auto px-4 sm:px-5 py-6">
        <ChatFlow
          levels={levels as Level[]}
          eventName={eventName ?? "Sahityotsav"}
          totalPublished={totalPublished}
          totalPrograms={totalPrograms}
        />
      </main>
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
  totalPublished,
  totalPrograms,
}: {
  levels: Level[];
  eventName: string;
  totalPublished: number;
  totalPrograms: number;
}) {
  // Initial bubbles — rendered SSR, hydrated on client.
  const initial: Bubble[] = [
    {
      id: "greet",
      side: "bot",
      node: (
        <GreetingBubble
          eventName={eventName}
          totalPublished={totalPublished}
          totalPrograms={totalPrograms}
        />
      ),
    },
  ];

  const [bubbles, setBubbles] = useState<Bubble[]>(initial);
  const [typing, setTyping] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++seqRef.current}`;

  // Auto-scroll to bottom on new message
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles.length, typing]);

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

      <div ref={endRef} />
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
    : "max-w-[88%] sm:max-w-[78%]";
  const padCls = tight ? "p-1.5" : isBot ? "px-3.5 py-3" : "px-4 py-2.5";
  const shellCls = isBot
    ? "bg-white border border-black/10 rounded-2xl rounded-bl-sm shadow-sm"
    : "bg-black text-white rounded-2xl rounded-br-sm shadow-sm";
  // Speech-bubble tail at the avatar-facing corner
  const tailCls = isBot
    ? "before:content-[''] before:absolute before:-bottom-px before:-left-1.5 before:w-3 before:h-3 before:bg-white before:border-l before:border-b before:border-black/10 before:[clip-path:polygon(100%_0,100%_100%,0_100%)]"
    : "before:content-[''] before:absolute before:-bottom-px before:-right-1.5 before:w-3 before:h-3 before:bg-black before:[clip-path:polygon(0_0,0_100%,100%_100%)]";
  return (
    <div
      className={`flex items-end gap-2 ${
        isBot ? "justify-start" : "justify-end"
      }`}
    >
      {isBot && <BotAvatar />}
      <div className={`relative ${widthCls} ${padCls} ${shellCls} ${tailCls}`}>
        {children}
      </div>
    </div>
  );
}

function BotAvatar() {
  return (
    <div
      aria-hidden
      className="shrink-0 size-8 grid place-items-center rounded-full bg-red text-white font-semibold text-xs"
    >
      S
    </div>
  );
}

function TypingDots() {
  return (
    <span
      aria-label="Typing"
      className="inline-flex items-center gap-1 py-1.5 px-1"
    >
      <span className="size-1.5 rounded-full bg-black/40 animate-bounce [animation-delay:-0.3s]" />
      <span className="size-1.5 rounded-full bg-black/40 animate-bounce [animation-delay:-0.15s]" />
      <span className="size-1.5 rounded-full bg-black/40 animate-bounce" />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bot bubble contents
// ─────────────────────────────────────────────────────────────────────

function GreetingBubble({
  eventName,
  totalPublished,
  totalPrograms,
}: {
  eventName: string;
  totalPublished: number;
  totalPrograms: number;
}) {
  return (
    <div>
      <p className="text-sm leading-relaxed text-black">
        Welcome to{" "}
        <span className="font-semibold">{eventName}</span> results.
      </p>
      <p className="text-xs text-black/60 mt-1 tabular-nums">
        {totalPublished} of {totalPrograms} published — pick a category to begin.
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
      <p className="text-sm text-black">Which category?</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {levels.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l)}
            className="inline-flex items-baseline gap-1.5 rounded-full border border-black/15 bg-white hover:bg-yellow/10 hover:border-yellow px-3 py-1.5 transition"
          >
            <span className="text-sm font-medium text-black">
              {levelLabel(l)}
            </span>
            <span className="text-[10px] tabular-nums text-black/50">
              {l.published}/{l.total}
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
      <p className="text-sm text-black">
        Programs in{" "}
        <span className="font-semibold">{levelLabel(level)}</span>:
      </p>

      {ready.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {ready.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(level, p)}
              className="group flex items-center gap-3 rounded-xl border border-black/10 bg-white hover:bg-yellow/10 hover:border-yellow transition px-3 py-2 text-left"
            >
              <span className="size-1.5 rounded-full bg-red shrink-0" aria-hidden />
              <span className="text-sm font-medium text-black flex-1 truncate">
                {programLabel(p)}
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-black/40 shrink-0">
                {p.code}
              </span>
              <span className="text-black/30 group-hover:translate-x-0.5 transition shrink-0">
                ›
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-black/50 mt-2">
          No results published yet in this category.
        </p>
      )}

      {pending.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-black/50 font-medium tracking-wide uppercase hover:text-black">
            + {pending.length} awaiting
          </summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {pending.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(level, p)}
                className="rounded-full border border-black/10 bg-white px-2.5 py-1 text-[11px] text-black/60 hover:bg-black/5"
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
      <p className="text-sm text-black">
        <span className="font-semibold">{programLabel(program)}</span>{" "}
        isn't announced yet.
      </p>
      <p className="text-xs text-black/60 mt-1">
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
          className="rounded-full border border-black/15 bg-white hover:bg-yellow/15 hover:border-yellow text-black px-3 py-2 text-xs font-medium transition shrink-0"
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
    <div className="mt-3 flex flex-wrap gap-1.5 pt-3 border-t border-black/10">
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
    ? "rounded-full bg-red text-white hover:bg-brand-600 px-3 py-1.5 text-xs font-medium shadow-sm"
    : "rounded-full border border-black/15 bg-white hover:bg-yellow/15 hover:border-yellow text-black px-3 py-1.5 text-xs font-medium transition";
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
    <div className="min-h-dvh flex items-center justify-center px-4 bg-white">
      <div className="max-w-md w-full text-center bg-white border border-black/10 rounded-2xl shadow-sm px-8 py-12">
        <span className="inline-block rounded-full bg-yellow text-black text-[11px] font-semibold tracking-wide uppercase px-3 py-1">
          Coming soon
        </span>
        <h1 className="text-3xl font-semibold tracking-tight mt-6 text-black">
          {name}
        </h1>
        <hr className="mt-5 max-w-[12rem] mx-auto border-black/15" />
        <p className="text-sm text-black/60 mt-5">
          The first winners will appear here as they are announced.
        </p>
        <Link
          to="/admin"
          className="inline-block mt-8 text-xs text-black/50 hover:text-black underline"
        >
          Admin
        </Link>
      </div>
    </div>
  );
}
