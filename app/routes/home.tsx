import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Form,
  Link,
  data,
  useActionData,
  useNavigation,
  useRevalidator,
} from "react-router";
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
import { InstallPrompt } from "~/components/install-prompt";
import {
  ArrowLeftRight,
  Award,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Crown,
  Download,
  Medal,
  RotateCcw,
  Share2,
  Sparkles,
  Trophy,
  X,
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
    const title = "Sahityotsav · Live results";
    const description =
      "Live Sahityotsav results. Every SSF unit, sector, division and district that runs Sahityotsav has its own live address — winners stream in as they're announced.";
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

/** Apex access-request form. Anonymous insert is allowed by RLS with
 *  length-guarded CHECK constraints; the owner console reads via the
 *  service-role client and either approves or rejects each row. */
export async function action({ request }: Route.ActionArgs) {
  const fd = await request.formData();
  const name = String(fd.get("name") ?? "").trim();
  const mobile = String(fd.get("mobile") ?? "").trim();
  const organization_name = String(fd.get("organization_name") ?? "").trim();
  if (
    name.length < 2 ||
    mobile.length < 6 ||
    organization_name.length < 2
  ) {
    return data(
      { error: "Please fill in your name, mobile and organisation name." },
      { status: 400 },
    );
  }
  if (
    name.length > 120 ||
    mobile.length > 30 ||
    organization_name.length > 200
  ) {
    return data({ error: "Some fields are too long." }, { status: 400 });
  }
  const { supabase, headers } = createSupabaseServerClient(request);
  const { error } = await supabase
    .from("access_requests")
    .insert({ name, mobile, organization_name });
  if (error)
    return data(
      { error: "Couldn’t send the request — please try again." },
      { status: 500, headers: Object.fromEntries(headers) },
    );
  return data(
    { ok: true as const, message: "Request sent — we’ll be in touch." },
    { headers: Object.fromEntries(headers) },
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const siteUrl = siteUrlFromRequest(request);

  // Apex / reserved host (`sahityotsav.live`, `www`, `app`, `api`) →
  // a friendly landing with a "register your organisation" CTA, instead
  // of the 404 unknown-org page (which is correct only for genuine
  // unknown subdomains).
  if (!resolveTenant(request)) {
    return data(
      {
        mode: "apex" as const,
        siteUrl,
        rootDomain: ROOT_DOMAIN,
      },
      {
        headers: {
          ...Object.fromEntries(headers),
          // The page is dynamic now (POSTs the form), so no public CDN
          // caching — short browser cache only.
          "Cache-Control": "private, max-age=30",
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
      .select("after_n, rank, team_name, points, template, template_id")
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
    template_id: string | null;
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
      templateId: rows[0]?.template_id ?? null,
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
  marks: number | null;
  grade: string | null;
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
  const { totalPublished, totalPrograms } = loaderData;
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
    standings_template?: number | null;
    standings_template_id?: string | null;
    custom_standings_templates?: CustomTpl[] | null;
    disabled_standings_templates?: string[] | null;
    standings_layout?: PosterLayoutMap | null;
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
    standingsDefaultTemplate: evRel.standings_template ?? 0,
    standingsDefaultTemplateId: evRel.standings_template_id ?? null,
    customStandingsTemplates: Array.isArray(evRel.custom_standings_templates)
      ? evRel.custom_standings_templates
      : [],
    disabledStandingsTemplates: Array.isArray(
      evRel.disabled_standings_templates,
    )
      ? evRel.disabled_standings_templates
      : [],
    standingsLayout: evRel.standings_layout ?? null,
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
    <div className="font-manrope relative flex min-h-dvh flex-col text-ink-900">
      {/* Our existing flowing wave animation — kept as the page ground */}
      <WaveBackground />

      {/* PWA install nudge — bottom-right toast after a short delay,
          only on the live-results screen. Self-suppresses if already
          installed / dismissed / opened from the installed shortcut. */}
      <InstallPrompt orgName={sector} />

      {/* ── Header — editorial app bar (Sahityotsav Chat design) ── */}
      <header className="sticky top-0 z-20 border-b border-rule-soft bg-white">
        <div className="mx-auto max-w-2xl px-4 sm:px-5 md:max-w-3xl lg:max-w-4xl">
          {/* Brand lockup + standings */}
          <div className="flex items-center justify-between gap-3 pt-3 pb-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <img
                src="/sahityotsav-mark.png"
                alt=""
                aria-hidden
                className="h-9 w-auto shrink-0 select-none"
                draggable={false}
              />
              <span className="flex min-w-0 flex-col leading-none">
                <img
                  src="/sahityotsav-logo.png"
                  alt="Sahityotsav"
                  className="h-[20px] w-auto select-none"
                  draggable={false}
                />
                <span className="font-jet mt-1.5 text-[8px] font-normal uppercase tracking-[0.3em] text-ink-mute">
                  Live Results
                </span>
              </span>
            </div>

            <button
              type="button"
              onClick={() => setStandingsOpen(true)}
              className="font-jet group inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rule bg-cream px-3 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-900 transition-all duration-200 hover:border-yellow hover:bg-yellow/20 active:scale-[0.96]"
            >
              <Trophy
                className="size-3.5 transition-transform duration-200 group-hover:-rotate-12"
                strokeWidth={2.25}
                aria-hidden
              />
              Standings
            </button>
          </div>

          {/* Sector title + live status + count */}
          <div className="flex items-center gap-2.5 pt-2 pb-3">
            <h1 className="font-cormorant min-w-0 truncate text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-ink-900 sm:text-[1.4rem]">
              <Ssf className="text-[0.82em] text-red" />{" "}
              {sector}
            </h1>
            <span className="font-jet inline-flex shrink-0 items-center gap-1.5 rounded-full bg-plum-tint px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-red">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-red animate-live-pulse"
              />
              Live
            </span>
            <span className="font-jet ml-auto shrink-0 text-[11px] font-bold tabular-nums tracking-[0.04em] text-ink-mute">
              {totalPublished} / {totalPrograms}
            </span>
          </div>
        </div>

        {/* Plum → gold brand rule */}
        <div
          aria-hidden
          className="h-[2px] w-full bg-gradient-to-r from-red via-brand-400 to-yellow"
        />
      </header>

      {standingsOpen && (
        <StandingsSheet
          history={standingsHistory}
          posterMeta={posterMeta}
          onClose={() => setStandingsOpen(false)}
        />
      )}

      <main className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-3.5 py-6 sm:px-5 sm:py-8 md:max-w-3xl lg:max-w-4xl">
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
function ApexLanding({ rootDomain }: { rootDomain: string }) {
  const actionData = useActionData() as
    | { ok?: true; message?: string; error?: string }
    | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const sent = actionData?.ok === true;

  const inputCls =
    "w-full rounded-xl border border-ink-200 bg-paper px-3.5 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25";

  return (
    <main className="relative min-h-dvh bg-paper text-ink-900">
      <WaveBackground />
      <div className="relative mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-5 py-8 sm:py-10">
        {/* Hero */}
        <header className="text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-brand-700">
            <Ssf /> · Sahityotsav
          </p>
          <h1 className="mt-2.5 font-display text-[2rem] leading-[1.05] tracking-tight sm:text-4xl">
            Live Sahityotsav results.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink-700">
            Each team that runs Sahityotsav — unit, sector, division or
            district — has its own live address. Winners stream in as
            results are announced.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            <a
              href="#request"
              className="inline-flex items-center gap-2 rounded-full bg-brand-700 px-5 py-2 text-sm font-semibold text-paper shadow-sm hover:bg-brand-800"
            >
              Request a new address ↓
            </a>
            <Link
              to="/admin"
              className="inline-flex items-center gap-2 rounded-full border border-ink-200 px-5 py-2 text-sm font-medium text-ink-800 hover:bg-paper-2"
            >
              Admin sign in
            </Link>
          </div>

          {/* Live examples — real sector sites the visitor can open to
              preview what their own address would look like. */}
          <div className="mt-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-ink-mute">
              See it live
            </p>
            <ul className="mt-2 flex flex-wrap items-center justify-center gap-2">
              {[
                { sub: "pantharangadi", label: "SSF Pantharangadi" },
                { sub: "ssfchemmad", label: "SSF Chemmad" },
              ].map((s) => (
                <li key={s.sub}>
                  <a
                    href={`https://${s.sub}.${rootDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center gap-2 rounded-full border border-ink-200 bg-paper px-3 py-1.5 text-xs text-ink-700 hover:border-brand-600 hover:bg-paper-2 hover:text-ink-900"
                  >
                    <span className="font-mono text-ink-900">
                      {s.sub}.{rootDomain}
                    </span>
                    <span className="text-ink-400">·</span>
                    <span className="font-medium">{s.label}</span>
                    <span
                      aria-hidden
                      className="text-ink-400 transition-transform group-hover:translate-x-0.5"
                    >
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </header>

        {/* Request form — posts to /. Goes into the owner's pending
            access-request list (no mail, no leaving the site). */}
        <section
          id="request"
          className="mt-6 rounded-2xl border border-ink-200 bg-paper-2/60 p-5 shadow-sm sm:p-6"
        >
          <h2 className="font-display text-lg tracking-tight sm:text-xl">
            Request a live results page for your team
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-700">
            Send your details — the owner will set up your address
            (e.g.{" "}
            <span className="font-mono text-ink-900">
              your-name.{rootDomain}
            </span>
            ) and share an admin login.
          </p>

          {sent ? (
            <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <Check
                className="mt-0.5 size-4 shrink-0 text-emerald-600"
                strokeWidth={2.5}
                aria-hidden
              />
              <span>
                {actionData?.message ?? "Request sent — we’ll be in touch."}
              </span>
            </div>
          ) : (
            <Form method="post" className="mt-4 grid gap-2.5 sm:grid-cols-2">
              <label className="space-y-1 sm:col-span-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
                  Your name
                </span>
                <input
                  name="name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="name"
                  placeholder="e.g. Muhammed Shammas"
                  className={inputCls}
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
                  Mobile number
                </span>
                <input
                  name="mobile"
                  type="tel"
                  required
                  minLength={6}
                  maxLength={30}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+91 …"
                  className={inputCls}
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
                  Organisation name
                </span>
                <input
                  name="organization_name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={200}
                  autoComplete="organization"
                  placeholder="e.g. SSF Pantharangadi Sector"
                  className={inputCls}
                />
              </label>
              {actionData?.error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">
                  {actionData.error}
                </p>
              )}
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-paper hover:bg-ink-800 disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send request"}
                </button>
              </div>
            </Form>
          )}
        </section>
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
      {/* A pinch of paper grain riding on top of everything keeps the
          page from feeling like flat CSS. Multiply blend at ~6% — you
          notice it only if you look for it. */}
      <div className="app-grain" />
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
};

type PosterMeta = {
  subdomain: string;
  defaultTemplate: number;
  defaultTemplateId: string | null;
  customTemplates: CustomTpl[];
  disabledTemplates: string[];
  standingsDefaultTemplate: number;
  standingsDefaultTemplateId: string | null;
  customStandingsTemplates: CustomTpl[];
  disabledStandingsTemplates: string[];
  standingsLayout: PosterLayoutMap | null;
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
            wide: true as const,
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
  // Celebration burst — bumped on every result reveal; the changing
  // key remounts <CelebrationBurst> so each call cuts a fresh burst.
  const [burst, setBurst] = useState(0);
  const fireBurst = () => setBurst((n) => n + 1);
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
  // When the user actively picks a level/program we want the resulting
  // bubble in view regardless of scroll position — set this to the
  // bubble id to focus and the next render will scroll to its top.
  const focusIdRef = useRef<string | null>(null);

  const scrollToEnd = () =>
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });

  const scrollToBubble = (id: string) => {
    const el = document.querySelector(
      `[data-bubble-id="${id}"]`,
    ) as HTMLElement | null;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else scrollToEnd();
  };

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
  //
  // Exception: when the user just picked a level/program (focusIdRef
  // set), force a scroll to that bubble's top regardless of position
  // so the tap always brings the answer into view (esp. the tall
  // poster bubble where `block: "end"` would land mid-image).
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return; // initial load — stay at the top, show the lead bubble
    }
    if (focusIdRef.current) {
      const id = focusIdRef.current;
      focusIdRef.current = null;
      scrollToBubble(id);
      return;
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

  function push(b: Bubble, opts?: { focus?: boolean }) {
    if (opts?.focus) focusIdRef.current = b.id;
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
    push(
      {
        id: nextId("u"),
        side: "user",
        node: <span>{levelLabel(level)}</span>,
      },
      { focus: true },
    );
    withTyping(380, () => {
      push(
        {
          id: nextId("b"),
          side: "bot",
          node: <ProgramPickerBubble level={level} onPick={handlePickProgram} onDifferentLevel={handleDifferentLevel} />,
        },
        { focus: true },
      );
    });
  }

  function handlePickProgram(level: Level, program: Program) {
    push(
      {
        id: nextId("u"),
        side: "user",
        node: <span>{programLabel(program)}</span>,
      },
      { focus: true },
    );
    const result = program.result;
    const ranked = result?.winners.filter((w) => w.position >= 1) ?? [];
    withTyping(result ? 480 : 280, () => {
      if (result && ranked.length >= 1) {
        // A result with winners → the poster lands and a celebration
        // burst fires across the screen (fireBurst, just below).
        push(
          {
            id: nextId("b"),
            side: "bot",
            wide: true,
            node: (
              <ResultBubble
                eventName={eventName}
                siteUrl={siteUrl}
                posterMeta={posterMeta}
                level={level}
                program={program}
                winners={result.winners}
                resultNo={result.result_no}
                onAnotherInLevel={() => handleAnotherInLevel(level)}
              />
            ),
          },
          { focus: true },
        );
        fireBurst();
      } else if (result) {
        push(
          {
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
          },
          { focus: true },
        );
      } else {
        push(
          {
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
          },
          { focus: true },
        );
      }
    });
  }

  function handleAnotherInLevel(level: Level) {
    push(
      {
        id: nextId("u"),
        side: "user",
        node: (
          <>
            Another in {levelLabel(level)}
          </>
        ),
      },
      { focus: true },
    );
    withTyping(220, () => {
      push(
        {
          id: nextId("b"),
          side: "bot",
          node: <ProgramPickerBubble level={level} onPick={handlePickProgram} onDifferentLevel={handleDifferentLevel} />,
        },
        { focus: true },
      );
    });
  }

  function handleDifferentLevel() {
    push(
      { id: nextId("u"), side: "user", node: <>Different category</> },
      { focus: true },
    );
    withTyping(220, () => {
      push(
        {
          id: nextId("b"),
          side: "bot",
          node: <LevelPickerBubble levels={levels} onPick={handlePickLevel} />,
        },
        { focus: true },
      );
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
  // no hydration mismatch from the randomised pieces. Fires once per
  // unique final-poster URL per device.
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!finalPosterUrl) return;
    try {
      const key = "ssf:celebrated-final-poster";
      if (localStorage.getItem(key) === finalPosterUrl) return;
      localStorage.setItem(key, finalPosterUrl);
    } catch {
      // localStorage unavailable (private mode, quota) — fall through
      // and celebrate anyway. Better to fire twice than to miss it.
    }
    setCelebrate(true);
  }, [finalPosterUrl]);

  // Render
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="space-y-3.5 pb-2"
    >
      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}
      {burst > 0 && (
        <CelebrationBurst key={burst} onDone={() => setBurst(0)} />
      )}
      {bubbles.map((b) => (
        <BubbleRow key={b.id} id={b.id} side={b.side} wide={b.wide}>
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

      {/* Jump-to-latest — appears only while reading back through history.
          Subtler shadow + fine inner highlight so it floats without
          shouting; the yellow chevron still carries the brand cue. */}
      <button
        type="button"
        onClick={scrollToEnd}
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
        className={`fixed bottom-5 left-1/2 z-30 inline-flex items-center gap-1.5 rounded-full bg-ink-900 text-paper px-4 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_10px_24px_-12px_rgba(11,9,10,0.55)] ring-1 ring-white/10 backdrop-blur-sm transition-all duration-300 ${
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
  id,
  side,
  wide = false,
  children,
}: {
  id?: string;
  side: "bot" | "user";
  wide?: boolean;
  children: ReactNode;
}) {
  const isBot = side === "bot";
  // Each content component carries its own surface (BotCard, WinnersPoster,
  // UserPill…), so the row only does avatar + alignment. scroll-mt clears
  // the sticky header when a focus-scroll lands on this bubble.
  return (
    <div
      data-bubble-id={id}
      className={`animate-bubble-in scroll-mt-36 flex items-start gap-2.5 ${
        isBot ? "justify-start" : "justify-end"
      }`}
    >
      {isBot && <BotAvatar />}
      {isBot ? (
        <div
          className={`min-w-0 ${
            wide ? "w-full md:max-w-[600px]" : "max-w-[85%]"
          }`}
        >
          {children}
        </div>
      ) : (
        <div className="flex min-w-0 max-w-[80%] justify-end">
          <UserPill>{children}</UserPill>
        </div>
      )}
    </div>
  );
}

// The reader's echoed choice — a red bubble. The "tail" is the same
// asymmetric squared corner the chat used before (no triangle).
function UserPill({ children }: { children: ReactNode }) {
  return (
    <div className="font-manrope inline-block max-w-full rounded-[1.25rem] rounded-tr-md bg-red px-4 py-2.5 text-[13.5px] font-semibold leading-snug text-white shadow-[0_6px_14px_-8px_rgba(110,3,2,0.6)]">
      {children}
    </div>
  );
}

// Bot avatar — a deep-red disc with a slowly rotating gold AI spark.
function BotAvatar() {
  return (
    <div
      aria-hidden
      className="relative mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-red sm:size-9"
      style={{
        boxShadow:
          "0 4px 14px -6px rgba(110,3,2,0.55), inset 0 0 0 1px rgba(207,28,25,0.55)",
      }}
    >
      <svg
        viewBox="0 0 36 36"
        className="size-[68%] animate-sparkle-spin text-yellow"
        fill="currentColor"
      >
        <path d="M20 6 C 20 12, 21 17, 30 18 C 21 19, 20 24, 20 30 C 20 24, 19 19, 10 18 C 19 17, 20 12, 20 6 Z" />
        <path
          d="M10.5 8 C 10.5 10, 10.9 10.5, 13 10.5 C 10.9 10.5, 10.5 11, 10.5 13 C 10.5 11, 10.1 10.5, 8 10.5 C 10.1 10.5, 10.5 10, 10.5 8 Z"
          opacity="0.85"
        />
      </svg>
    </div>
  );
}

// Brand monogram — red disc, gold italic "S", gold spark dot.
function Monogram({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center rounded-full bg-red"
      style={{
        width: size,
        height: size,
        boxShadow:
          "0 4px 14px -6px rgba(110,3,2,0.5), inset 0 0 0 1px rgba(207,28,25,0.5)",
      }}
    >
      <span
        className="font-cormorant font-semibold italic leading-none text-yellow"
        style={{ fontSize: size * 0.56, marginTop: -size * 0.03 }}
      >
        S
      </span>
      <span
        className="absolute rounded-full bg-yellow"
        style={{
          top: size * 0.17,
          right: size * 0.17,
          width: size * 0.15,
          height: size * 0.15,
        }}
      />
    </span>
  );
}

function TypingDots() {
  return (
    <div className="relative inline-block">
      <div
        role="status"
        aria-label="Typing"
        className="relative inline-flex items-center gap-1.5 rounded-[18px] rounded-tl-md border border-rule-soft bg-white px-[18px] py-3.5"
        style={{
          boxShadow:
            "0 2px 0 rgba(20,16,10,0.03), 0 12px 28px -16px rgba(40,12,12,0.22)",
        }}
      >
        <span className="typing-dot size-[7px] rounded-full bg-red/65" />
        <span className="typing-dot size-[7px] rounded-full bg-red/65" />
        <span className="typing-dot size-[7px] rounded-full bg-red/65" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bot bubble contents
// ─────────────────────────────────────────────────────────────────────

// White editorial card used by every bot message. Optional eyebrow
// (mono caps), title (bold sans) and body, plus free children.
function BotCard({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className="font-manrope relative rounded-[18px] rounded-tl-md border border-rule-soft bg-white px-4 py-3.5 text-ink-900 sm:px-[18px] sm:py-4"
        style={{
          boxShadow:
            "0 2px 0 rgba(20,16,10,0.03), 0 12px 28px -16px rgba(40,12,12,0.22)",
        }}
      >
        {eyebrow && (
          <div className="font-jet mb-2.5 text-[10px] font-medium uppercase tracking-[0.16em] text-red">
            {eyebrow}
          </div>
        )}
        {title && (
          <div className="text-[1.35rem] font-bold leading-[1.18] tracking-[-0.01em] text-ink-900">
            {title}
          </div>
        )}
        {body && (
          <div
            className={`text-[14px] leading-relaxed text-ink-dim ${
              title ? "mt-2" : ""
            }`}
          >
            {body}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// Roman-numeral rank tiles, shared by the winners poster and the
// standings card. Index 0 → 1st (gold), 1 → 2nd, 2 → 3rd.
const RANK_TILE = [
  "bg-yellow text-ink-900",
  "bg-plum-tint text-red",
  "bg-cream-2 text-ink-dim",
] as const;
const ROMAN = ["I", "II", "III", "IV", "V"] as const;

function GreetingBubble({ sector }: { sector: string }) {
  return (
    <BotCard
      eyebrow="Sahityotsav · Live Results"
      title={
        <>
          Welcome to{" "}
          <span className="font-cormorant font-semibold italic text-red">
            {sector}
          </span>
        </>
      }
      body="Pick a category below to see the winners — new results appear here the moment they're announced."
    />
  );
}

// Animated count-up — eases a number from 0 to `to` once, on mount.
function CountUp({
  to,
  durationMs = 950,
  delayMs = 0,
}: {
  to: number;
  durationMs?: number;
  delayMs?: number;
}) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setN(to);
      return;
    }
    let raf = 0;
    let start = 0;
    const step = (t: number) => {
      if (!start) start = t;
      const elapsed = t - start - delayMs;
      if (elapsed < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      const p = Math.min(1, elapsed / durationMs);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, durationMs, delayMs]);
  return <>{n}</>;
}

// One podium column — a light 3D cylinder that rises from the base,
// the points counting up above it and a rank icon crowning it.
// Index 0 → 1st (gold · crown), 1 → 2nd (medal), 2 → 3rd (award).
const PODIUM_SKIN = [
  {
    // The 90° gradient gives each cylinder its rounded, lit surface.
    body: "linear-gradient(90deg,#E4B03C 0%,#FFE890 34%,#F9D45F 60%,#D9A52C 100%)",
    lid: "#FFEFB6",
    icon: "#D99E00",
  },
  {
    body: "linear-gradient(90deg,#D9786E 0%,#F8BFB7 34%,#ED9D94 61%,#C96A5F 100%)",
    lid: "#FAD2CC",
    icon: "#CB5248",
  },
  {
    body: "linear-gradient(90deg,#D2965E 0%,#F6D5AB 34%,#EAB988 61%,#C58A48 100%)",
    lid: "#F9DEC4",
    icon: "#C2783C",
  },
] as const;

const PODIUM_ICON = [Crown, Medal, Award] as const;

function PodiumColumn({
  points,
  rank,
  height,
  delay,
}: {
  points: number;
  rank: number;
  height: number;
  delay: number;
}) {
  const skin = PODIUM_SKIN[Math.min(rank, 2)];
  const RankIcon = PODIUM_ICON[Math.min(rank, 2)];
  const lid = 15; // cylinder cap ellipse height
  return (
    <div className="relative flex flex-1 basis-0 flex-col items-center justify-end">
      {/* floor contact shadow — grounds the cylinder (no hard base line) */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "-5%",
          right: "-5%",
          bottom: -8,
          height: 19,
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(34,12,6,0.5) 0%, rgba(34,12,6,0.26) 42%, rgba(34,12,6,0) 75%)",
        }}
      />
      {/* rank icon */}
      <div className="flex h-7 items-end justify-center">
        <RankIcon
          className="podium-crown size-5"
          style={{ color: skin.icon, animationDelay: `${delay + 640}ms` }}
          strokeWidth={2}
          aria-hidden
        />
      </div>

      {/* points count-up — cleared well above the cylinder cap */}
      <div className="mb-3 mt-1 flex items-baseline gap-0.5 leading-none">
        <span className="font-manrope text-[18px] font-extrabold tabular-nums tracking-[-0.02em] text-ink-900">
          <CountUp to={points} delayMs={delay} />
        </span>
        <span className="font-jet text-[7px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
          pts
        </span>
      </div>

      {/* 3D cylinder bar */}
      <div
        className="podium-bar relative w-full"
        style={{
          height,
          background: `linear-gradient(180deg,rgba(255,255,255,0.16) 0%,rgba(255,255,255,0) 15%,rgba(40,16,8,0) 64%,rgba(40,16,8,0.42) 100%), ${skin.body}`,
          borderRadius: "5px 5px 50% 50% / 5px 5px 14px 14px",
          animationDelay: `${delay}ms`,
        }}
      >
        {/* lit elliptical cap — the top of the cylinder */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -(lid / 2),
            height: lid,
            background: skin.lid,
            borderRadius: "50%",
            boxShadow: "inset 0 2px 3px rgba(255,255,255,0.65)",
          }}
        />
        {/* gold winner — a slow gleam sweeps the cylinder */}
        {rank === 0 && <span className="podium-shine" aria-hidden />}
      </div>
    </div>
  );
}

// Opening chat card — the live top three as an animated 3D podium:
// bars rise from the base, points count up, the winner is crowned.
function StandingsBubble({
  standings,
  onOpenFull,
}: {
  standings: Standings;
  onOpenFull: () => void;
}) {
  const top = standings.rows.slice(0, 3);
  const maxPoints = Math.max(1, ...top.map((t) => t.points));
  const barHeight = (pts: number) =>
    Math.round(58 + (pts / maxPoints) * 70);

  // Display order — 2nd · 1st · 3rd, so the winner stands centre.
  const order =
    top.length === 3
      ? [
          { row: top[1], rank: 1 },
          { row: top[0], rank: 0 },
          { row: top[2], rank: 2 },
        ]
      : top.map((row, i) => ({ row, rank: i }));
  // Bars land 2nd → 3rd → 1st, so the champion settles last.
  const riseDelay = [240, 40, 130];

  return (
    <BotCard
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <Trophy className="size-3.5" strokeWidth={2.5} aria-hidden />
          Team standings
        </span>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-dim">
        Current top three after{" "}
        <span className="font-semibold text-ink-900">
          {standings.afterN} {standings.afterN === 1 ? "result" : "results"}
        </span>
        .
      </p>

      {/* Animated 3D podium */}
      <div className="mt-3 pt-5">
        <div className="flex items-end justify-center gap-2.5">
          {order.map(({ row, rank }) => (
            <PodiumColumn
              key={`${rank}-${row.name}`}
              points={row.points}
              rank={rank}
              height={barHeight(row.points)}
              delay={riseDelay[rank] ?? 0}
            />
          ))}
        </div>
        {/* team names */}
        <div className="flex justify-center gap-2.5 pt-3.5">
          {order.map(({ row, rank }) => (
            <p
              key={`n-${rank}-${row.name}`}
              className="line-clamp-2 flex-1 basis-0 text-center text-[11.5px] font-bold leading-tight text-ink-900"
            >
              {row.name}
            </p>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenFull}
        className="group mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-ink-900 ring-1 ring-inset ring-rule transition-all duration-200 hover:bg-yellow/15 hover:ring-yellow active:scale-[0.97]"
      >
        Full standings &amp; history
        <ChevronRight
          className="size-3.5 text-ink-mute transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-red"
          strokeWidth={2.5}
          aria-hidden
        />
      </button>
    </BotCard>
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
      <div
        className="overflow-hidden rounded-[18px] rounded-tl-md border border-rule-soft bg-white"
        style={{
          boxShadow:
            "0 4px 0 rgba(20,16,10,0.02), 0 22px 50px -22px rgba(40,12,12,0.3)",
        }}
      >
        <div className="font-jet flex items-center gap-1.5 border-b border-rule-soft bg-plum-wash px-4 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-red">
          <Trophy className="size-3.5" strokeWidth={2.5} aria-hidden />
          Final standings
        </div>
        <button
          type="button"
          onClick={() => setZoom(true)}
          aria-label="View final standings poster full size"
          style={{ touchAction: "manipulation" }}
          className="block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-yellow"
        >
          <img
            src={url}
            alt="Final team standings"
            className="block h-auto w-full select-none"
            draggable={false}
          />
        </button>
      </div>

      <div className="mt-2.5 flex gap-2">
        <PosterActionBtn
          primary
          disabled={busy !== null}
          onClick={onShare}
          icon={
            busy === "share" ? (
              <Spinner />
            ) : (
              <Share2 className="size-4" strokeWidth={2.5} aria-hidden />
            )
          }
          label="Share"
        />
        <PosterActionBtn
          disabled={busy !== null}
          onClick={onDownload}
          icon={
            busy === "download" ? (
              <Spinner />
            ) : (
              <Download className="size-4" strokeWidth={2.5} aria-hidden />
            )
          }
          label="Save"
        />
      </div>

      {zoom && (
        <FinalPosterZoomModal url={url} onClose={() => setZoom(false)} />
      )}
    </div>
  );
}

/** Fullscreen zoom for the published final-standings image. Mirrors
 *  PosterZoomModal: portals to <body> (so a transformed/animated
 *  ancestor like the chat bubble can't trap our `fixed inset-0`),
 *  locks body scroll, dismisses on backdrop tap / Escape / Close. */
function FinalPosterZoomModal({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
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

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Final standings poster"
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 size-10 grid place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white"
      >
        <X className="size-5" aria-hidden />
      </button>
      <img
        src={url}
        alt="Final team standings"
        className="max-h-[92vh] max-w-full w-auto shadow-2xl"
        // Stop the click on the image from bubbling to the backdrop
        // and dismissing the modal — backdrop tap still closes.
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>,
    document.body,
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
    <BotCard
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red/70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-red" />
          </span>
          Just announced
        </span>
      }
    >
      <p className="text-[15px] font-bold text-ink-900">
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
            className="group flex items-center justify-between gap-3 rounded-[14px] border border-rule-soft bg-cream-3 px-3.5 py-2.5 text-left transition-all duration-200 hover:border-yellow hover:bg-yellow/15 active:scale-[0.99]"
          >
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-bold text-ink-900">
                {programLabel(program)}
              </span>
              <span className="block truncate text-[11px] text-ink-dim">
                {levelLabel(level)}
              </span>
            </span>
            <ChevronRight
              className="size-4 shrink-0 text-ink-mute transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-red"
              strokeWidth={2.5}
              aria-hidden
            />
          </button>
        ))}
        {items.length > shown.length && (
          <span className="px-1 pt-0.5 text-[11px] text-ink-dim">
            +{items.length - shown.length} more — pick a category to see all
          </span>
        )}
      </div>
    </BotCard>
  );
}

// ─── Chips — the category / program pickers ───────────────────────────
function Chip({
  label,
  code,
  muted = false,
  onClick,
}: {
  label: ReactNode;
  code?: string | null;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex max-w-full items-center gap-2 rounded-2xl bg-white px-3.5 py-2.5 text-left text-[14px] font-semibold leading-snug tracking-[-0.01em] text-ink-900 ring-1 ring-inset ring-rule transition-all duration-150 hover:bg-yellow/10 hover:ring-yellow active:scale-[0.97] ${
        muted ? "opacity-65" : ""
      }`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          muted ? "bg-ink-mute" : "bg-red"
        }`}
      />
      <span className="min-w-0">{label}</span>
      {code && (
        <span className="font-jet shrink-0 whitespace-nowrap rounded-full bg-plum-tint px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-red">
          {code}
        </span>
      )}
    </button>
  );
}

function ChipGroup({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      {title && (
        <div className="mb-3.5 text-[15px] font-bold tracking-[-0.01em] text-ink-900">
          {title}
        </div>
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
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
    <BotCard>
      <ChipGroup title="Which category?">
        {levels.map((l) => (
          <Chip
            key={l.id}
            label={levelLabel(l)}
            muted={l.published === 0}
            onClick={() => onPick(l)}
          />
        ))}
      </ChipGroup>
    </BotCard>
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
    <BotCard>
      <ChipGroup
        title={
          <>
            Programs in{" "}
            <span className="font-cormorant text-[1.1em] font-semibold italic text-red">
              {levelLabel(level)}
            </span>
          </>
        }
      >
        {ready.length > 0 ? (
          ready.map((p) => (
            <Chip
              key={p.id}
              label={programLabel(p)}
              code={p.code}
              onClick={() => onPick(level, p)}
            />
          ))
        ) : (
          <p className="text-[13px] text-ink-mute">
            No results announced in this category yet.
          </p>
        )}
      </ChipGroup>

      {pending.length > 0 && (
        <details className="group mt-3.5">
          <summary className="font-jet inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium uppercase tracking-[0.1em] text-ink-mute transition-colors hover:text-ink-dim">
            <ChevronDown
              className="size-3 transition-transform duration-200 group-open:rotate-180"
              strokeWidth={3}
              aria-hidden
            />
            Awaiting results
          </summary>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {pending.map((p) => (
              <Chip
                key={p.id}
                label={programLabel(p)}
                muted
                onClick={() => onPick(level, p)}
              />
            ))}
          </div>
        </details>
      )}

      <ChoiceRow>
        <ChoiceButton onClick={onDifferentLevel}>Different category</ChoiceButton>
      </ChoiceRow>
    </BotCard>
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
    <BotCard eyebrow="Not yet announced">
      <p className="text-[14px] leading-relaxed text-ink-dim">
        <span className="font-bold text-ink-900">{programLabel(program)}</span>{" "}
        hasn't been announced yet — results come in fast, so try another.
      </p>
      <ChoiceRow>
        <ChoiceButton onClick={onAnotherInLevel}>
          Another in {levelLabel(level)}
        </ChoiceButton>
        <ChoiceButton onClick={onDifferentLevel}>Different category</ChoiceButton>
      </ChoiceRow>
    </BotCard>
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
  return (
    <BotCard eyebrow={levelLabel(level)}>
      <p className="font-cormorant text-[1.3rem] font-semibold italic leading-tight text-ink-900">
        {programLabel(program)}
      </p>
      {ranked.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-ink-dim">Result published.</p>
      ) : (
        <ol className="mt-2.5 flex flex-col gap-1.5">
          {ranked.map((w, i) => (
            <li
              key={i}
              className="flex items-center gap-3 rounded-[12px] border border-rule-soft bg-cream-3 px-3 py-2"
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-[9px] font-cormorant text-[13px] font-bold italic ${
                  RANK_TILE[Math.min(w.position - 1, 2)]
                }`}
              >
                {ROMAN[Math.min(Math.max(w.position, 1), 5) - 1] ?? w.position}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-bold text-ink-900">
                  {w.name_en ?? w.name_ml}
                </span>
                {w.unit_ml && (
                  <span className="block truncate text-[11px] text-ink-dim">
                    {w.unit_ml}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-mute">
        A small program — no poster for this one; the points are in the team
        standings.
      </p>
      <ChoiceRow>
        <ChoiceButton onClick={onAnotherInLevel}>
          Another in {levelLabel(level)}
        </ChoiceButton>
        <ChoiceButton onClick={onDifferentLevel}>Different category</ChoiceButton>
      </ChoiceRow>
    </BotCard>
  );
}

// Short, human date for the poster footer. Result bubbles only render
// after a user interaction (client-side), so locale formatting here
// can't trigger a hydration mismatch.
function fmtStamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// One slot in a poster action row — full-width, primary (dark) or plain.
function PosterActionBtn({
  icon,
  label,
  iconOnly = false,
  primary = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  iconOnly?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[12.5px] font-bold tracking-[-0.01em] transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 ${
        iconOnly ? "shrink-0 px-3" : "min-w-0 flex-1 px-2"
      } ${
        primary
          ? "bg-ink-900 text-white shadow-[0_8px_18px_-10px_rgba(0,0,0,0.45)]"
          : "border border-rule bg-white text-ink-900 hover:border-yellow"
      }`}
    >
      {icon}
      {!iconOnly && <span className="truncate">{label}</span>}
    </button>
  );
}

// The poster display section — a winners card in the chat design
// system. Brand band, roman-numeral rank tiles and footer mirror the
// festival poster; real winner data (name, unit, marks, grade) fills
// it. The full Konva festival poster is one tap away.
function WinnersPoster({
  programName,
  levelName,
  code,
  winners,
  publishedAt,
  zoomable = false,
}: {
  programName: string;
  levelName: string;
  code: string | null;
  winners: Winner[];
  publishedAt: string | null;
  zoomable?: boolean;
}) {
  return (
    <div
      className="overflow-hidden rounded-[18px] rounded-tl-md border border-rule-soft bg-white"
      style={{
        boxShadow:
          "0 4px 0 rgba(20,16,10,0.02), 0 22px 50px -22px rgba(40,12,12,0.3)",
      }}
    >
      {/* Brand band */}
      <div className="relative overflow-hidden bg-gradient-to-br from-brand-800 to-red px-4 py-4 text-white">
        <span
          aria-hidden
          className="absolute -right-14 -top-14 size-36 rounded-full bg-yellow/10 blur-lg"
        />
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-jet text-[10px] font-medium uppercase tracking-[0.16em] text-yellow">
              Result{code ? ` · ${code}` : ""}
            </div>
            <div className="font-cormorant mt-1.5 truncate text-[1.6rem] font-semibold italic leading-[1.1]">
              {programName}
            </div>
            <div className="mt-1 truncate text-[11px] text-white/70">
              {levelName}
            </div>
          </div>
          <Monogram size={36} />
        </div>
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-yellow via-gold-200 to-transparent"
        />
      </div>

      {/* Winner rows */}
      <div className="px-4">
        {winners.map((w, i) => (
          <div
            key={i}
            className="grid grid-cols-[44px_1fr_auto] items-center gap-3.5 border-t border-rule-soft py-3.5"
          >
            <span
              className={`grid size-11 place-items-center rounded-[14px] font-cormorant text-[17px] font-bold italic ${
                RANK_TILE[Math.min(i, 2)]
              }`}
            >
              {ROMAN[Math.min(i, 4)]}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-bold leading-tight text-ink-900">
                {w.name_en ?? w.name_ml}
              </div>
              {w.unit_ml && (
                <div className="mt-0.5 truncate text-[11.5px] text-ink-dim">
                  {w.unit_ml}
                </div>
              )}
            </div>
            {(w.marks != null || w.grade) && (
              <div className="text-right">
                {w.marks != null && (
                  <div className="font-jet text-[13px] tracking-[0.02em] text-ink-900">
                    {w.marks}
                  </div>
                )}
                {w.grade && (
                  <div className="font-jet mt-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
                    {w.grade}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="font-jet flex items-center justify-between border-t border-rule-soft bg-plum-wash px-4 py-2.5 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
        <span>{publishedAt ?? "Live result"}</span>
        <span className="font-semibold text-red">
          {zoomable ? "Tap to open poster" : "#Sahityotsav"}
        </span>
      </div>
    </div>
  );
}

// Celebration burst — a one-shot particle burst that fires the moment a
// result poster lands. 28 pieces (dots, squares, 2px "lines") explode
// from a single origin point near the top of the screen, arc up ~120px
// then fall ~320px past the viewport while spinning. Ported from the
// design's CelebrationBurst + burstUp keyframe (CSS in app.css).
function CelebrationBurst({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // Outlast the slowest piece (2.5s flight + 0.5s delay) before unmount.
    const t = window.setTimeout(onDone, reduce ? 0 : 3200);
    return () => window.clearTimeout(t);
  }, [onDone]);

  // Deterministic seeded RNG — organic-looking but stable across renders.
  const pieces = useMemo<CSSProperties[]>(() => {
    const seed = (n: number) => ((n * 9301 + 49297) % 233280) / 233280;
    const colors = ["#BF0603", "#FFCE05", "#CF1C19", "#FFE072", "#0B090A"];
    return Array.from({ length: 28 }, (_, i) => {
      const shape = i % 3; // 0 dot · 1 square · 2 line
      const size = 5 + Math.floor(seed(i + 13) * 6);
      return {
        "--bx": `${((seed(i + 1) - 0.5) * 380).toFixed(1)}px`,
        "--delay": `${(seed(i + 5) * 0.5).toFixed(2)}s`,
        "--dur": `${(1.6 + seed(i + 9) * 0.9).toFixed(2)}s`,
        "--size": `${size}px`,
        "--h": `${shape === 2 ? 2 : size}px`,
        "--r": shape === 0 ? "999px" : "1px",
        "--c": colors[i % colors.length],
      } as CSSProperties;
    });
  }, []);

  // Portal to <body> — the chat <main> has its own stacking context
  // (relative + z-10) that the sticky header sits above, so a fixed
  // child can't escape it without portalling out.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-[32%] z-[60]"
    >
      {pieces.map((s, i) => (
        <span key={i} className="cb-piece" style={s} />
      ))}
    </div>,
    document.body,
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
  onAnotherInLevel,
}: {
  eventName: string;
  siteUrl: string;
  posterMeta: PosterMeta;
  level: Level;
  program: Program;
  winners: Winner[];
  resultNo: string | null;
  onAnotherInLevel: () => void;
}) {
  const sorted = [...winners].sort((a, b) => a.position - b.position);
  const ranked = sorted.filter((w) => w.position >= 1);
  const stageRef = useRef<Konva.Stage | null>(null);
  const [busy, setBusy] = useState<null | "share">(null);
  const [zoom, setZoom] = useState(false);
  // "Change poster" steps through the tenant's allowed templates.
  const [tmpl, setTmpl] = useState(0);
  const tplChoices = usableTemplates(
    eventTemplateList(posterMeta.subdomain, posterMeta.customTemplates),
    posterMeta.disabledTemplates,
  );
  // Each result starts on a template deterministically picked by its
  // result number; "Change poster" steps on from there.
  const tpl =
    pickFromList(
      tplChoices,
      posterMeta.defaultTemplate,
      posterMeta.defaultTemplateId,
      rotationOffset(resultNo, program.code) + tmpl,
    ) ?? tplChoices[0];
  // The HTML winners card always renders; only the Konva festival
  // poster (share / zoom) needs an enabled template.
  const hasPoster = !!tpl;
  // One or two winners → lead with the design-system winners card;
  // three or more → show the festival poster directly in the chat.
  const showCard = ranked.length <= 2;

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
    winners: sorted.map((w) => ({
      position: w.position,
      name: w.name_en ?? w.name_ml,
      unit: w.unit_ml,
    })),
  };

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
      {/* Off-screen Konva stage — the card variant needs it for the
          share / zoom exports (the direct variant mounts its own). */}
      {showCard && tpl && (
        <div
          aria-hidden
          className="pointer-events-none fixed left-[-200vw] top-0 -z-10 opacity-0"
        >
          <PosterCanvas
            data={posterData}
            templateIndex={tpl.builtinIndex ?? 0}
            customSrc={tpl.src ?? undefined}
            stageRef={stageRef}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => hasPoster && setZoom(true)}
        disabled={!hasPoster}
        aria-label="View the full festival poster"
        style={{ touchAction: "manipulation" }}
        className="block w-full rounded-[18px] rounded-tl-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow disabled:cursor-default"
      >
        {showCard || !tpl ? (
          <WinnersPoster
            programName={posterProgramName(program, posterMeta.lang)}
            levelName={posterLevelName(level, posterMeta.lang)}
            code={program.code}
            winners={ranked}
            publishedAt={fmtStamp(program.result?.published_at ?? null)}
            zoomable={hasPoster}
          />
        ) : (
          <div className="overflow-hidden rounded-[18px] rounded-tl-md">
            <PosterCanvas
              data={posterData}
              templateIndex={tpl.builtinIndex ?? 0}
              customSrc={tpl.src ?? undefined}
              stageRef={stageRef}
            />
          </div>
        )}
      </button>

      <div className="mt-2.5 flex gap-2">
        <PosterActionBtn
          primary
          disabled={!hasPoster || busy !== null}
          onClick={onShare}
          icon={
            busy === "share" ? (
              <Spinner />
            ) : (
              <Share2 className="size-4" strokeWidth={2.5} aria-hidden />
            )
          }
          label="Share"
        />
        {!showCard && tpl && tplChoices.length > 1 && (
          <PosterActionBtn
            iconOnly
            onClick={() => setTmpl((t) => t + 1)}
            icon={
              <ArrowLeftRight className="size-4" strokeWidth={2.5} aria-hidden />
            }
            label="Change poster"
          />
        )}
        <PosterActionBtn
          onClick={onAnotherInLevel}
          icon={<RotateCcw className="size-4" strokeWidth={2.5} aria-hidden />}
          label="Different"
        />
      </div>

      {!hasPoster && (
        <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-ink-mute">
          The poster image isn't available — every poster template has been
          turned off by the organisers.
        </p>
      )}

      {zoom && tpl && (
        <PosterZoomModal
          data={posterData}
          templateIndex={tpl.builtinIndex ?? 0}
          customSrc={tpl.src ?? undefined}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  );
}


function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 animate-spin rounded-full border-2 border-current/30 border-t-current"
    />
  );
}

// Hairline-divided row of secondary choices under a bot message.
function ChoiceRow({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3.5 flex flex-wrap gap-2 border-t border-rule-soft pt-3.5">
      {children}
    </div>
  );
}

function ChoiceButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-ink-900 ring-1 ring-inset ring-rule transition-all duration-150 hover:bg-yellow/15 hover:ring-yellow active:scale-[0.97]"
    >
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
        {/* Refined coming-soon chip — gold gradient + a Lucide Clock,
            with a thin inner ring so the chip doesn't sit flat. The
            small black ping behind the clock body animates the "still
            preparing" beat without flooding the chip with bounce. */}
        <span className="relative inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-[#FFE072] to-[#FFCE05] text-black text-[11px] font-bold tracking-[0.18em] uppercase px-3.5 py-1.5 ring-1 ring-inset ring-black/10 shadow-[0_4px_12px_-6px_rgba(11,9,10,0.35)]">
          <span className="relative flex size-1.5 items-center justify-center">
            <span
              aria-hidden
              className="absolute inline-flex size-full animate-ping rounded-full bg-black/50"
            />
            <span className="relative size-1.5 rounded-full bg-black" />
          </span>
          <Clock className="size-3" strokeWidth={2.5} aria-hidden />
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
