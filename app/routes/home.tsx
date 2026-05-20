import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, data, useRevalidator } from "react-router";
import type { Route } from "./+types/home";
import {
  createSupabaseServerClient,
  loadTenantEvent,
  resolveTenant,
  siteUrlFromRequest,
} from "~/lib/supabase.server";
import { ROOT_DOMAIN } from "~/lib/constants";
import type Konva from "konva";
import {
  PosterCanvas,
  eventTemplateList,
  exportPosterPng,
  pickFromList,
  posterFontStack,
  prefetchPosterAssets,
  rotationOffset,
  sharePoster,
  usableTemplates,
  type CustomTpl,
  type PosterData,
  type PosterLayoutMap,
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
  const d = data as
    | {
        mode?: "apex" | "tenant";
        event?: {
          name?: string;
          name_ml?: string;
          organizations?: { name?: string } | null;
        };
        siteUrl?: string;
      }
    | undefined;
  const base = d?.siteUrl ?? "";
  if (d?.mode === "apex") {
    const title = "Sahityotsav · Live results from every sector";
    const description =
      "Browse live Sahityotsav results sector by sector. Each SSF sector publishes its own winners as they're announced.";
    const image = `${base}/sahityotsav-logo.png`;
    return [
      { title },
      { name: "description", content: description },
      { tagName: "link", rel: "canonical", href: base },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: base },
      { property: "og:site_name", content: "Sahityotsav" },
      { property: "og:locale", content: "en_IN" },
      { property: "og:image", content: image },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ];
  }
  const ev = d?.event;
  const brand =
    ev?.organizations?.name ?? ev?.name ?? ev?.name_ml ?? "Sahityotsav";
  const title = `${brand} · Results`;
  const description = `Live results from ${brand} — browse winners by category as they're announced.`;
  const image = `${base}/sahityotsav-logo.png`;
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: base },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: base },
    { property: "og:site_name", content: brand },
    { property: "og:locale", content: "en_IN" },
    { property: "og:image", content: image },
    { property: "og:image:alt", content: `${brand} logo` },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const siteUrl = siteUrlFromRequest(request);

  // Apex / reserved host (`sahityotsav.live`, `www`, `app`, `api`) →
  // a friendly landing with a directory of live sectors + a CTA to
  // register a new organisation, instead of the 404 unknown-sector
  // page (which is correct for genuine unknown subdomains only).
  if (!resolveTenant(request)) {
    const { data: orgs } = await supabase
      .from("organizations")
      .select(
        "name, subdomain, org_level, events!inner(status, is_current)",
      )
      .eq("events.is_current", true)
      .eq("events.status", "published")
      .not("subdomain", "is", null)
      .order("name", { ascending: true });
    type Sector = {
      name: string;
      subdomain: string;
      org_level: string | null;
    };
    const sectors: Sector[] = (orgs ?? []).map((o) => ({
      name: (o as { name: string }).name,
      subdomain: (o as { subdomain: string }).subdomain,
      org_level: (o as { org_level?: string | null }).org_level ?? null,
    }));
    return data(
      {
        mode: "apex" as const,
        siteUrl,
        rootDomain: ROOT_DOMAIN,
        sectors,
        contactEmail: "owner@sahityotsav.live",
      },
      {
        headers: {
          ...Object.fromEntries(headers),
          "Cache-Control": "public, max-age=60, s-maxage=300",
        },
      },
    );
  }

  const event = await loadTenantEvent(request, supabase);
  if (event.status !== "published") {
    return data(
      { mode: "tenant" as const, event, published: false as const, siteUrl },
      { headers: { ...Object.fromEntries(headers), "Cache-Control": "no-store" } },
    );
  }

  const [levelsRes, programsRes, resultsRes, standingsRes] = await Promise.all([
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
    supabase
      .from("team_standings")
      .select("after_n, rank, team_name, points, template")
      .eq("event_id", event.id)
      .order("after_n", { ascending: false })
      .order("rank", { ascending: true }),
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

  // Latest admin-uploaded standings snapshot (rows are ordered after_n
  // desc, rank asc — so the first group is the most recent checkpoint).
  type SRow = {
    after_n: number;
    rank: number;
    team_name: string;
    points: number;
    template: number | null;
  };
  const sRows = (standingsRes.data ?? []) as SRow[];
  // Group every uploaded checkpoint by its `after_n` so the UI can let
  // the reader step through the standings history. Newest first.
  const byN = new Map<number, SRow[]>();
  for (const r of sRows) {
    const g = byN.get(r.after_n);
    if (g) g.push(r);
    else byN.set(r.after_n, [r]);
  }
  const standingsHistory = [...byN.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([afterN, rows]) => ({
      afterN,
      // Each checkpoint carries its own template (uniform across its
      // rows) — the poster uses that checkpoint's own choice.
      template: rows[0]?.template ?? 0,
      rows: rows
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((r) => ({ name: r.team_name, points: Number(r.points) })),
    }));
  const standings = standingsHistory[0] ?? null;

  return data(
    {
      mode: "tenant" as const,
      event,
      published: true as const,
      siteUrl,
      levels: enrichedLevels,
      totalPublished: results.length,
      totalPrograms: programs.length,
      allWinners,
      standings,
      standingsHistory,
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

type Standings = {
  afterN: number;
  template: number;
  rows: { name: string; points: number }[];
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

type PosterLang = "ml" | "en";

function posterLevelName(
  level: { code: string; name_ml: string },
  lang: PosterLang,
): string {
  return lang === "ml"
    ? level.name_ml?.trim() || levelLabel(level)
    : levelLabel(level);
}

function posterProgramName(
  p: { name_en: string | null; name_ml: string; code: string },
  lang: PosterLang,
): string {
  return lang === "ml"
    ? p.name_ml?.trim() || p.name_en?.trim() || p.code
    : p.name_en?.trim() || p.name_ml?.trim() || p.code;
}

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export default function Home({ loaderData }: Route.ComponentProps) {
  // Apex / reserved host → friendly landing instead of the unknown-
  // tenant 404. Bailed out BEFORE any hooks so the apex tree never
  // pays for the public-chat machinery.
  if (loaderData.mode === "apex") {
    return <ApexLanding {...loaderData} />;
  }
  // Live auto-refresh: silently re-runs the loader so newly published
  // results surface without a manual reload. Called before any early
  // return so hook order stays stable if `published` flips false→true.
  useLiveRefresh();
  const [standingsOpen, setStandingsOpen] = useState(false);

  if (!loaderData.published) {
    return <NotYetLive event={loaderData.event} />;
  }
  const { event, levels, standings, standingsHistory, siteUrl } = loaderData;
  const org = (event.organizations as { name?: string } | null)?.name;
  const eventName = event.name ?? event.name_ml;
  const finalPosterUrl =
    (event as { final_poster_url?: string | null }).final_poster_url ?? null;

  const sector = (org ? org.replace(/^SSF\s+/i, "") : "") || "Sahityotsav";

  const orgRel = event.organizations as
    | { name?: string; subdomain?: string }
    | null;
  const evRel = event as {
    result_template?: number;
    result_template_id?: string | null;
    custom_templates?: CustomTpl[] | null;
    disabled_templates?: string[] | null;
    poster_lang?: string | null;
    poster_name?: string | null;
    poster_font_en?: string | null;
    poster_font_ml?: string | null;
    poster_layout?: PosterLayoutMap | null;
    poster_date?: string | null;
    poster_time?: string | null;
    poster_place?: string | null;
  };
  const posterMeta: PosterMeta = {
    subdomain: orgRel?.subdomain ?? "",
    defaultTemplate: evRel.result_template ?? 0,
    defaultTemplateId: evRel.result_template_id ?? null,
    customTemplates: Array.isArray(evRel.custom_templates)
      ? evRel.custom_templates
      : [],
    disabledTemplates: Array.isArray(evRel.disabled_templates)
      ? evRel.disabled_templates
      : [],
    lang: evRel.poster_lang === "ml" ? "ml" : "en",
    fontEn: evRel.poster_font_en ?? null,
    fontMl: evRel.poster_font_ml ?? null,
    layout: evRel.poster_layout ?? null,
    orgName: evRel.poster_name?.trim() || orgRel?.name || "",
    posterDate: evRel.poster_date ?? null,
    posterTime: evRel.poster_time ?? null,
    posterPlace: evRel.poster_place ?? null,
  };

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
          history={standingsHistory}
          onClose={() => setStandingsOpen(false)}
        />
      )}

      <main className="relative z-10 flex-1 w-full max-w-2xl md:max-w-3xl lg:max-w-4xl mx-auto px-3.5 sm:px-5 py-6 sm:py-8">
        <ChatFlow
          levels={levels as Level[]}
          eventName={eventName ?? "Sahityotsav"}
          siteUrl={siteUrl}
          posterMeta={posterMeta}
          sector={sector}
          standings={standings}
          finalPosterUrl={finalPosterUrl}
          onOpenStandings={() => setStandingsOpen(true)}
        />
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Live auto-refresh — polls the loader on an interval and on tab
// refocus / reconnect. Revalidation does NOT remount the route, so the
// chat (its useState) is preserved: no flicker, no scroll jump, no lost
// place. Pauses while the tab is hidden or offline to stay light.
// ─────────────────────────────────────────────────────────────────────
function useLiveRefresh(intervalMs = 60_000) {
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;
  const stateRef = useRef(revalidator.state);
  stateRef.current = revalidator.state;

  useEffect(() => {
    const tick = () => {
      if (
        document.visibilityState === "visible" &&
        navigator.onLine !== false &&
        stateRef.current === "idle"
      ) {
        revalidateRef.current();
      }
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", tick);
    };
  }, [intervalMs]);
}

// SSF wordmark — always rendered in the brand Cooper Black letterform.
function Ssf({ className = "" }: { className?: string }) {
  return <span className={`ssf-mark ${className}`}>SSF</span>;
}

// ─────────────────────────────────────────────────────────────────────
// Apex landing — shown on sahityotsav.live (and reserved hosts) when
// there's no tenant to resolve. Directory of live sectors + a clear
// "Contact admin to register" CTA, so first-time visitors aren't met
// by a 404. Designed lean and static-feeling; no chat/poster runtime.
// ─────────────────────────────────────────────────────────────────────
function ApexLanding({
  sectors,
  rootDomain,
  contactEmail,
}: {
  sectors: { name: string; subdomain: string; org_level: string | null }[];
  rootDomain: string;
  contactEmail: string;
}) {
  const mailto =
    `mailto:${contactEmail}?subject=${encodeURIComponent("Sahityotsav · sector registration")}` +
    `&body=${encodeURIComponent(
      "Hi,\n\nI'd like to set up Sahityotsav results for our organisation.\n\nName of organisation:\nLevel (unit / sector / division / district):\nContact person + number:\n\nThanks.",
    )}`;
  return (
    <main className="relative min-h-dvh bg-paper text-ink-900">
      <WaveBackground />
      <div className="relative mx-auto max-w-5xl px-5 pb-24 pt-12 sm:pt-20">
        {/* Hero */}
        <header className="text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-brand-700">
            <Ssf /> · Sahityotsav
          </p>
          <h1 className="mt-3 font-display text-4xl leading-[1.05] tracking-tight sm:text-5xl">
            Live results from every sector.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-700 sm:text-base">
            Each SSF sector that runs Sahityotsav has its own live address.
            Pick yours below — winners stream in as the results are
            announced.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href={mailto}
              className="inline-flex items-center gap-2 rounded-full bg-brand-700 px-5 py-2.5 text-sm font-semibold text-paper shadow-sm hover:bg-brand-800"
            >
              Register your sector →
            </a>
            <Link
              to="/admin"
              className="inline-flex items-center gap-2 rounded-full border border-ink-200 px-5 py-2.5 text-sm font-medium text-ink-800 hover:bg-paper-2"
            >
              Sector admin sign in
            </Link>
          </div>
        </header>

        {/* Live sectors */}
        <section className="mt-14">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-xl tracking-tight sm:text-2xl">
              Live sectors
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-ink-500">
              {sectors.length} live
            </span>
          </div>
          {sectors.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-ink-200 bg-paper-2/60 px-5 py-8 text-center text-sm text-ink-600">
              No sectors are live right now — check back during festival
              season, or{" "}
              <a
                href={mailto}
                className="font-medium text-brand-700 underline-offset-2 hover:underline"
              >
                register your sector
              </a>
              .
            </p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sectors.map((s) => (
                <li key={s.subdomain}>
                  <a
                    href={`https://${s.subdomain}.${rootDomain}`}
                    className="group block rounded-xl border border-ink-200 bg-paper px-4 py-3.5 shadow-sm transition hover:border-brand-300 hover:bg-paper-2"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-ink-900">
                        {s.name}
                      </span>
                      {s.org_level && (
                        <span className="shrink-0 rounded-full bg-yellow/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-800">
                          {s.org_level}
                        </span>
                      )}
                    </div>
                    <span className="mt-1 block truncate font-mono text-[11px] text-ink-500 group-hover:text-brand-700">
                      {s.subdomain}.{rootDomain}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Register CTA */}
        <section className="mt-14 rounded-2xl border border-ink-200 bg-paper-2/60 p-6 sm:p-8">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <h2 className="font-display text-xl tracking-tight sm:text-2xl">
                Run Sahityotsav at your sector?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                Contact the admin to get your own live results address —
                <span className="font-mono text-ink-900">
                  {" "}
                  your-sector.{rootDomain}
                </span>{" "}
                — with an admin account, your program list and ready-made
                result posters.
              </p>
            </div>
            <a
              href={mailto}
              className="inline-flex shrink-0 items-center gap-2 rounded-full bg-ink-900 px-5 py-2.5 text-sm font-semibold text-paper hover:bg-ink-800"
            >
              Email {contactEmail}
            </a>
          </div>
        </section>

        <footer className="mt-16 text-center text-[11px] text-ink-500">
          © Sahityotsav · Samastha Kerala Islamic Sahithya Sangam
        </footer>
      </div>
    </main>
  );
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

type PosterMeta = {
  subdomain: string;
  defaultTemplate: number;
  defaultTemplateId: string | null;
  customTemplates: CustomTpl[];
  disabledTemplates: string[];
  lang: PosterLang;
  fontEn: string | null;
  fontMl: string | null;
  layout: PosterLayoutMap | null;
  orgName: string;
  posterDate: string | null;
  posterTime: string | null;
  posterPlace: string | null;
};

function ChatFlow({
  levels,
  eventName,
  siteUrl,
  posterMeta,
  sector,
  standings,
  finalPosterUrl,
  onOpenStandings,
}: {
  levels: Level[];
  eventName: string;
  siteUrl: string;
  posterMeta: PosterMeta;
  sector: string;
  standings: Standings | null;
  finalPosterUrl: string | null;
  onOpenStandings: () => void;
}) {
  // Initial bubbles — rendered SSR, hydrated on client. When a final
  // poster is published it leads the conversation (the event's finale);
  // then the greeting, then the live standings top three.
  const hasStandings = !!standings && standings.rows.length > 0;
  const initial: Bubble[] = [
    ...(finalPosterUrl
      ? [
          {
            id: "final-poster",
            side: "bot" as const,
            wide: true,
            tight: true,
            node: <FinalPosterBubble url={finalPosterUrl} />,
          },
        ]
      : []),
    {
      id: "greet",
      side: "bot",
      node: (
        <GreetingBubble sector={sector} />
      ),
    },
    ...(hasStandings
      ? [
          {
            id: "standings",
            side: "bot" as const,
            node: (
              <StandingsBubble
                standings={standings!}
                onOpenFull={onOpenStandings}
              />
            ),
          },
        ]
      : []),
  ];

  const [bubbles, setBubbles] = useState<Bubble[]>(initial);
  const [typing, setTyping] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++seqRef.current}`;
  // Mirrors `atBottom` for synchronous reads inside effects — lets us
  // follow new bubbles only when the reader is already at the bottom,
  // so an auto-announced result never yanks them out of history.
  const atBottomRef = useRef(true);
  // Skip the very first auto-scroll so the page opens at the top — the
  // reader should see the lead bubble (e.g. the final poster), not be
  // thrown to the bottom on load.
  const firstRenderRef = useRef(true);

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

  // Auto-scroll to bottom on new message — but only if the reader is
  // following along. If they've scrolled up, the "Latest" pill (which
  // shows whenever !atBottom) is their cue instead.
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return; // initial load — stay at the top, show the lead bubble
    }
    if (atBottomRef.current) scrollToEnd();
  }, [bubbles.length, typing]);

  // Track whether the reader has scrolled up through history
  useEffect(() => {
    const onScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >=
        document.body.offsetHeight - 120;
      atBottomRef.current = nearBottom;
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
    const ranked =
      program.result?.winners.filter((w) => w.position >= 1) ?? [];
    withTyping(program.result ? 480 : 280, () => {
      if (program.result && ranked.length >= 2) {
        push({
          id: nextId("b"),
          side: "bot",
          wide: true,
          tight: true,
          node: (
            <ResultBubble
              eventName={eventName}
              siteUrl={siteUrl}
              posterMeta={posterMeta}
              level={level}
              program={program}
              winners={program.result.winners}
              resultNo={program.result.result_no}
              onAnotherInLevel={() => handleAnotherInLevel(level)}
              onDifferentLevel={handleDifferentLevel}
            />
          ),
        });
      } else if (program.result) {
        // <2 ranked winners: published but no poster — compact text card.
        push({
          id: nextId("b"),
          side: "bot",
          node: (
            <ResultTextBubble
              level={level}
              program={program}
              winners={ranked}
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

  // Surface results that get published while the page is open. Auto-
  // refresh keeps `levels` fresh; here we diff against what we've
  // already seen and append a chat-native "just announced" bubble.
  // Append-only — existing bubbles are never mutated.
  const seenResultsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    // First run: snapshot everything already published so we don't
    // announce the backlog that was present on page load.
    if (seenResultsRef.current === null) {
      const seed = new Set<string>();
      for (const lv of levels)
        for (const p of lv.programs) if (p.result) seed.add(p.id);
      seenResultsRef.current = seed;
      return;
    }
    const seen = seenResultsRef.current;
    const fresh: { level: Level; program: Program }[] = [];
    for (const lv of levels)
      for (const p of lv.programs)
        if (p.result && !seen.has(p.id)) {
          seen.add(p.id);
          fresh.push({ level: lv, program: p });
        }
    if (fresh.length === 0) return;
    push({
      id: nextId("new"),
      side: "bot",
      node: (
        <NewResultsBubble
          items={fresh}
          onView={(lv, p) => handlePickProgram(lv, p)}
        />
      ),
    });
  }, [levels]);

  // One-time party-popper when a final poster leads the chat. Gated on
  // a mount effect so it's client-only — SSR renders nothing, so there's
  // no hydration mismatch from the randomised pieces.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (finalPosterUrl) setCelebrate(true);
  }, [finalPosterUrl]);

  // Render
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="space-y-3.5 pb-2"
    >
      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}
      {bubbles.map((b) => (
        <BubbleRow key={b.id} side={b.side} wide={b.wide} tight={b.tight}>
          {b.node}
        </BubbleRow>
      ))}

      {/* The seeded first interaction prompt — shown until the reader
          takes their first action, then re-enterable via Different category */}
      {bubbles.length === initial.length && !typing && (
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

// Initial chat card — the current top three teams with points, plus a
// way into the full poster + checkpoint history. Mirrors the bot
// bubble visual language so it reads as the bot opening with the
// headline standings.
function StandingsBubble({
  standings,
  onOpenFull,
}: {
  standings: Standings;
  onOpenFull: () => void;
}) {
  const top = standings.rows.slice(0, 3);
  const TIER = [
    { ring: "ring-yellow/60", chip: "bg-yellow text-black", label: "1st" },
    { ring: "ring-ink-300", chip: "bg-ink-200 text-ink-800", label: "2nd" },
    { ring: "ring-[#d8a26a]/60", chip: "bg-[#caa06a] text-white", label: "3rd" },
  ] as const;
  return (
    <div>
      <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-red/80">
        <Trophy className="size-3.5 text-red" strokeWidth={2.5} aria-hidden />
        Team standings
      </p>
      <p className="text-[12px] leading-relaxed text-ink-500 mt-1">
        Current top three after{" "}
        <span className="font-semibold text-ink-700">
          {standings.afterN} {standings.afterN === 1 ? "result" : "results"}
        </span>
        .
      </p>

      <ol className="mt-2.5 flex flex-col gap-1.5">
        {top.map((t, i) => {
          const tier = TIER[i] ?? TIER[2];
          return (
            <li
              key={`${t.name}-${i}`}
              className={`flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 shadow-sm ring-1 ${tier.ring}`}
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${tier.chip}`}
              >
                {tier.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900">
                {t.name}
              </span>
              <span className="shrink-0 font-opensans text-sm font-bold tabular-nums text-ink-900">
                {t.points}
                <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                  pts
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={onOpenFull}
        className="group mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-black/15 bg-white px-4 py-2 text-xs font-semibold text-ink-800 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-yellow hover:bg-yellow/15 active:translate-y-0 active:scale-[0.97]"
      >
        Full standings &amp; history
        <ChevronRight
          className="size-3.5 text-ink-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-red"
          strokeWidth={2.5}
          aria-hidden
        />
      </button>
    </div>
  );
}

// The published final standings poster — a finished image (real data
// baked in, no template) that leads the chat. Tap to view full size;
// download / share the image as-is.
function FinalPosterBubble({ url }: { url: string }) {
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState<null | "download" | "share">(null);

  async function fetchBlob(): Promise<Blob | null> {
    try {
      const r = await fetch(url, { mode: "cors" });
      if (!r.ok) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  async function onDownload() {
    setBusy("download");
    try {
      const blob = await fetchBlob();
      if (!blob) {
        window.open(url, "_blank", "noopener");
        return;
      }
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "final-standings.png";
      a.click();
      URL.revokeObjectURL(href);
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    setBusy("share");
    try {
      const blob = await fetchBlob();
      const nav = navigator as Navigator & {
        canShare?: (d: ShareData) => boolean;
      };
      const title = "Final standings";
      if (blob && nav.share) {
        const file = new File([blob], "final-standings.png", {
          type: blob.type || "image/png",
        });
        if (nav.canShare?.({ files: [file] })) {
          try {
            await nav.share({ title, files: [file] });
            return;
          } catch {
            /* dismissed — fall through */
          }
        }
      }
      if (nav.share) {
        try {
          await nav.share({ title, url });
          return;
        } catch {
          /* dismissed */
        }
      }
      window.open(url, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label="View final standings poster full size"
        style={{ touchAction: "manipulation" }}
        className="block w-full overflow-hidden rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
      >
        <img
          src={url}
          alt="Final team standings"
          className="block w-full h-auto select-none"
          draggable={false}
        />
      </button>

      <div className="mt-2 px-1 flex items-center gap-1.5">
        <IconButton
          label="Download final poster"
          onClick={onDownload}
          disabled={busy !== null}
          tone="brand"
        >
          {busy === "download" ? <Spinner /> : <DownloadIcon />}
        </IconButton>
        <IconButton
          label="Share final poster"
          onClick={onShare}
          disabled={busy !== null}
          tone="brand"
        >
          {busy === "share" ? <Spinner /> : <ShareIcon />}
        </IconButton>
        <span className="ml-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          Final standings
        </span>
      </div>

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Final standings poster"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setZoom(false)}
        >
          <img
            src={url}
            alt="Final team standings"
            className="max-h-[92vh] max-w-full w-auto rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setZoom(false)}
            aria-label="Close"
            className="absolute top-4 right-4 size-10 grid place-items-center rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors"
          >
            <span aria-hidden className="text-xl leading-none">
              ✕
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// Dependency-free party-popper. Renders a fixed, non-interactive layer
// of pieces animated with the Web Animations API, then unmounts itself.
// Honours prefers-reduced-motion (skips straight to done).
function Confetti({ onDone }: { onDone: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduce) {
      onDone();
      return;
    }

    const COLORS = [
      "#BF0603",
      "#FFCE05",
      "#E58C2A",
      "#2BB3A3",
      "#E84E8A",
      "#FFFFFF",
    ];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const COUNT = Math.min(90, Math.max(46, Math.round(W / 9)));
    const anims: Animation[] = [];

    for (let i = 0; i < COUNT; i++) {
      const piece = document.createElement("span");
      const size = 6 + Math.random() * 8;
      const round = Math.random() < 0.35;
      piece.style.cssText = `position:absolute;top:-24px;left:${
        Math.random() * 100
      }vw;width:${size}px;height:${size * (round ? 1 : 1.6)}px;background:${
        COLORS[(Math.random() * COLORS.length) | 0]
      };border-radius:${round ? "50%" : "1px"};will-change:transform,opacity;`;
      host.appendChild(piece);

      const driftX = (Math.random() - 0.5) * 280;
      const fallY = H + 80;
      const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 900);
      const duration = 2400 + Math.random() * 1400;
      const delay = Math.random() * 450;
      const a = piece.animate(
        [
          { transform: "translate3d(0,0,0) rotate(0deg)", opacity: 1 },
          {
            transform: `translate3d(${driftX * 0.4}px, ${
              fallY * 0.55
            }px, 0) rotate(${spin * 0.6}deg)`,
            opacity: 1,
            offset: 0.7,
          },
          {
            transform: `translate3d(${driftX}px, ${fallY}px, 0) rotate(${spin}deg)`,
            opacity: 0,
          },
        ],
        {
          duration,
          delay,
          easing: "cubic-bezier(.18,.7,.42,1)",
          fill: "forwards",
        },
      );
      anims.push(a);
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone();
    };
    const last = anims[anims.length - 1];
    if (last) last.addEventListener("finish", finish);
    const t = window.setTimeout(finish, 4200);

    return () => {
      window.clearTimeout(t);
      anims.forEach((a) => a.cancel());
      host.replaceChildren();
    };
  }, [onDone]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] overflow-hidden"
    />
  );
}

// Auto-injected when a result is published while the page is open.
// Visual language matches the other bot bubbles (rounded rows, the
// red/yellow palette, ChevronRight) so it never reads as a "system"
// interruption — it's the bot continuing the conversation.
function NewResultsBubble({
  items,
  onView,
}: {
  items: { level: Level; program: Program }[];
  onView: (level: Level, program: Program) => void;
}) {
  const shown = items.slice(0, 6);
  return (
    <div>
      <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-red/80">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-red/70" />
          <span className="relative inline-flex size-1.5 rounded-full bg-red" />
        </span>
        Just announced
      </p>
      <p className="font-opensans text-[15px] font-semibold text-ink-900 mt-1.5">
        {items.length === 1
          ? "A new result is in"
          : `${items.length} new results are in`}
      </p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {shown.map(({ level, program }) => (
          <button
            key={program.id}
            type="button"
            onClick={() => onView(level, program)}
            className="group flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-left shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-yellow hover:bg-yellow/10 active:translate-y-0 active:scale-[0.99]"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-900">
                {programLabel(program)}
              </span>
              <span className="block truncate text-[11px] text-ink-500">
                {levelLabel(level)}
              </span>
            </span>
            <ChevronRight
              className="size-4 shrink-0 text-ink-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-red"
              strokeWidth={2.5}
              aria-hidden
            />
          </button>
        ))}
        {items.length > shown.length && (
          <span className="px-1 pt-0.5 text-[11px] text-ink-500">
            +{items.length - shown.length} more — pick a category to see all
          </span>
        )}
      </div>
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

// Compact, poster-less result — used when a program has fewer than 2
// ranked winners. Still published; points come from the uploaded
// standings, so no poster is generated for these.
function ResultTextBubble({
  level,
  program,
  winners,
  onAnotherInLevel,
  onDifferentLevel,
}: {
  level: Level;
  program: Program;
  winners: Winner[];
  onAnotherInLevel: () => void;
  onDifferentLevel: () => void;
}) {
  const ranked = [...winners]
    .filter((w) => w.position >= 1)
    .sort((a, b) => a.position - b.position);
  const ordinal = ["1st", "2nd", "3rd", "4th"];
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-red/80">
        {levelLabel(level)}
      </p>
      <p className="text-base font-semibold text-ink-900 mt-1">
        {programLabel(program)}
      </p>
      {ranked.length === 0 ? (
        <p className="text-xs text-ink-500 mt-1.5">Result published.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {ranked.map((w, i) => {
            const unit = w.unit_ml;
            return (
              <li key={i} className="flex items-baseline gap-2 text-sm">
                <span className="shrink-0 inline-flex w-9 justify-center rounded-full bg-red/10 py-0.5 text-[10px] font-bold text-red">
                  {ordinal[Math.min(Math.max(w.position, 1), 4) - 1] ??
                    w.position}
                </span>
                <span className="font-semibold text-ink-900">
                  {w.name_en ?? w.name_ml}
                </span>
                {unit && (
                  <span className="text-xs text-ink-500">· {unit}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-ink-400 mt-2.5">
        Small program — no poster for this one; points are in the team
        standings.
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
  siteUrl,
  posterMeta,
  level,
  program,
  winners,
  resultNo,
  onDifferentLevel,
}: {
  eventName: string;
  siteUrl: string;
  posterMeta: PosterMeta;
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
  // Shuffle offset from the tenant's saved default within its allowed set.
  const [tmpl, setTmpl] = useState(0);
  const tplChoices = usableTemplates(
    eventTemplateList(posterMeta.subdomain, posterMeta.customTemplates),
    posterMeta.disabledTemplates,
  );
  // Each result steps through the whole template set (deterministic by
  // result number); the shuffle button still adds on top of that.
  const tpl =
    pickFromList(
      tplChoices,
      posterMeta.defaultTemplate,
      posterMeta.defaultTemplateId,
      rotationOffset(resultNo, program.code) + tmpl,
    ) ?? tplChoices[0];

  const posterData: PosterData = {
    eventName,
    siteUrl,
    fontFamily: posterFontStack(posterMeta.fontEn, posterMeta.fontMl),
    overrides: tpl ? posterMeta.layout?.[tpl.key] : undefined,
    orgName: posterMeta.orgName,
    posterDate: posterMeta.posterDate ?? undefined,
    posterTime: posterMeta.posterTime ?? undefined,
    posterPlace: posterMeta.posterPlace ?? undefined,
    levelName: posterLevelName(level, posterMeta.lang),
    programName: posterProgramName(program, posterMeta.lang),
    programCode: program.code,
    resultNo,
    winners: sorted.map((w) => {
      const unitEn = w.unit_ml;
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
        <PosterCanvas
          data={posterData}
          templateIndex={tpl?.builtinIndex ?? 0}
          customSrc={tpl?.src ?? undefined}
          stageRef={stageRef}
        />
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
            onClick={() => setTmpl((t) => t + 1)}
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
          templateIndex={tpl?.builtinIndex ?? 0}
          customSrc={tpl?.src ?? undefined}
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
