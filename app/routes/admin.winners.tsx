// Print-friendly winners export. Opens in a new tab from the admin
// sidebar; the admin picks "Save as PDF" in the browser's print dialog
// to produce a clean, vector-text PDF. No PDF library is bundled — the
// browser's print engine handles Malayalam fonts natively.
//
// Layout intent: a single tight table per event, grouped by level. We
// rely on the browser's native `<table>` row-break behaviour (with
// `thead` repeating on each printed page) rather than wrapping `<div>`
// blocks with `break-inside: avoid-page` — the latter can push entire
// sections to the next page and silently swallow content.

import { Fragment } from "react";
import { Link, data, useSearchParams } from "react-router";
import { ArrowLeft, Printer } from "lucide-react";
import type { Route } from "./+types/admin.winners";
import {
  loadTenantEvent,
  requireAdmin,
  resolveTenant,
} from "~/lib/supabase.server";

export function meta() {
  return [{ title: "Winners — Print / PDF · Sahityotsav" }];
}

type WinnerRow = {
  position: number;
  name_ml: string;
  name_en: string | null;
  unit_ml: string | null;
  marks: number | null;
  grade: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  // Apex / reserved hosts have no tenant — bounce to the admin entry,
  // which routes the visitor to their own sector.
  if (!resolveTenant(request)) {
    throw new Response(null, {
      status: 302,
      headers: { Location: "/admin" },
    });
  }
  const { supabase, headers, profile } = await requireAdmin(request);
  const event = await loadTenantEvent(request, supabase);
  // Same cross-tenant guard the dashboard uses on top of RLS — an
  // admin can only export their own sector's winners.
  if (profile.organization_id !== event.organization_id) {
    throw new Response(
      "Your admin account belongs to a different organisation.",
      { status: 403, headers: Object.fromEntries(headers) },
    );
  }

  const url = new URL(request.url);
  const includeDrafts = url.searchParams.get("drafts") === "1";
  // Which positions to print, one-of-three:
  //  - "first"  → only position 1 (the first-place winner per program)
  //  - "podium" → positions 1, 2, 3 (default — matches public poster)
  //  - "all"    → position 0 too, the team-points-only "extra marks"
  //               contributors (rank ≥ 4) stored by the import pipeline.
  const posModeRaw = url.searchParams.get("pos") ?? "";
  const posMode: "first" | "podium" | "all" =
    posModeRaw === "first" || posModeRaw === "all" ? posModeRaw : "podium";

  const [levelsRes, programsRes, resultsRes] = await Promise.all([
    supabase
      .from("levels")
      .select("id, code, name_ml, sort_order")
      .eq("event_id", event.id)
      .order("sort_order"),
    supabase
      .from("programs")
      .select("id, code, name_ml, name_en, sort_order, level_id, is_active")
      .eq("event_id", event.id)
      .eq("is_active", true)
      .order("sort_order")
      .order("code"),
    supabase
      .from("results")
      .select(
        `id, program_id, status, result_no,
         result_winners(position, name_ml, name_en, unit_ml, marks, grade)`,
      )
      .eq("event_id", event.id),
  ]);

  const levels = levelsRes.data ?? [];
  const programs = programsRes.data ?? [];
  const results = resultsRes.data ?? [];

  // Position predicate per mode. `first` is the tightest set (1 only);
  // `podium` is 1..3; `all` is everything ≥ 0 (incl. extras).
  const inSelectedPositions = (p: number): boolean => {
    if (posMode === "first") return p === 1;
    if (posMode === "all") return p >= 0;
    return p >= 1 && p <= 3;
  };

  const resultByProgram = new Map<
    string,
    {
      id: string;
      status: string;
      result_no: string | null;
      winners: WinnerRow[];
    }
  >();
  for (const r of results) {
    const include =
      r.status === "published" || (includeDrafts && r.status === "draft");
    if (!include) continue;
    const winners = ((r.result_winners as WinnerRow[]) ?? [])
      .filter((w) => inSelectedPositions(w.position))
      .map((w) => ({
        ...w,
        marks:
          w.marks !== null && w.marks !== undefined ? Number(w.marks) : null,
      }))
      // Podium first (1, 2, 3) then position-0 extras grouped at the
      // bottom of each program, sorted by unit for stability.
      .sort((a, b) => {
        const ak = a.position === 0 ? 999 : a.position;
        const bk = b.position === 0 ? 999 : b.position;
        if (ak !== bk) return ak - bk;
        return (a.unit_ml ?? "").localeCompare(b.unit_ml ?? "");
      });
    if (winners.length === 0) continue;
    resultByProgram.set(r.program_id, {
      id: r.id,
      status: r.status,
      result_no: r.result_no,
      winners,
    });
  }

  const enrichedLevels = levels
    .map((l) => ({
      id: l.id,
      code: l.code,
      name_ml: l.name_ml,
      programs: programs
        .filter((p) => p.level_id === l.id && resultByProgram.has(p.id))
        .map((p) => ({
          id: p.id,
          code: p.code,
          name_ml: p.name_ml,
          name_en: p.name_en,
          result: resultByProgram.get(p.id)!,
        })),
    }))
    .filter((l) => l.programs.length > 0);

  const totals = {
    programs: enrichedLevels.reduce((n, l) => n + l.programs.length, 0),
    winners: enrichedLevels.reduce(
      (n, l) =>
        n + l.programs.reduce((m, p) => m + p.result.winners.length, 0),
      0,
    ),
    drafts: enrichedLevels.reduce(
      (n, l) =>
        n + l.programs.filter((p) => p.result.status === "draft").length,
      0,
    ),
  };

  return data(
    {
      event,
      orgName:
        (event as { organizations?: { name?: string } | null }).organizations
          ?.name ?? "",
      levels: enrichedLevels,
      includeDrafts,
      posMode,
      totals,
    },
    {
      headers: {
        ...Object.fromEntries(headers),
        // Admin-only and dynamic per the two toggle params; never cache.
        "Cache-Control": "private, no-store",
      },
    },
  );
}

const POS_LABEL: Record<number, string> = { 1: "I", 2: "II", 3: "III" };
function posLabel(p: number): string {
  if (p in POS_LABEL) return POS_LABEL[p];
  // Position 0 is the team-points-only extras row — render it as a
  // neutral mark in the table so it doesn't read as "0th place".
  return p === 0 ? "—" : String(p);
}

export default function WinnersPrint({ loaderData }: Route.ComponentProps) {
  const { event, orgName, levels, includeDrafts, posMode, totals } =
    loaderData;
  const eventName =
    (event as { name_ml?: string | null; name?: string | null }).name_ml ??
    (event as { name?: string | null }).name ??
    "";
  const [searchParams, setSearchParams] = useSearchParams();

  function toggle(key: string, on: boolean) {
    const next = new URLSearchParams(searchParams);
    if (on) next.set(key, "1");
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function setPosMode(mode: "first" | "podium" | "all") {
    const next = new URLSearchParams(searchParams);
    // Drop the param entirely on the default so the URL stays clean.
    if (mode === "podium") next.delete("pos");
    else next.set("pos", mode);
    setSearchParams(next, { replace: true });
  }

  const posLabelText =
    posMode === "first"
      ? "1st place only"
      : posMode === "all"
      ? "all positions"
      : "1st / 2nd / 3rd only";

  return (
    <>
      {/* All page + table styling lives in this inline stylesheet so
          the print rules don't depend on Tailwind's print: variants
          being compiled, and so an A4 layout is guaranteed. */}
      <style>{`
        @page { size: A4; margin: 14mm 12mm 16mm 12mm; }
        :root { color-scheme: light; }
        body { background: #fff; }

        .winners-page {
          font-family: "Plus Jakarta Sans", "Inter", system-ui, sans-serif;
          color: #18181b;
          font-size: 13px;
          line-height: 1.35;
        }
        .winners-page .ml,
        .winners-page [lang="ml"] {
          font-family: "Anek Malayalam", "Manjari", sans-serif;
        }
        .winners-page h1, .winners-page h2 {
          font-family: "Fraunces", "Iowan Old Style", serif;
        }

        table.winners {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          /* Native table row breaks — far more reliable than wrapping
             div sections with break-inside: avoid-page. */
          break-inside: auto;
        }
        table.winners thead { display: table-header-group; }
        table.winners tr { break-inside: avoid; }
        table.winners tr.level-head { break-after: avoid; }

        table.winners th,
        table.winners td {
          padding: 5px 8px;
          border-bottom: 1px solid #e7e5e4;
          vertical-align: top;
          text-align: left;
        }
        table.winners thead th {
          font-size: 9.5px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #57534e;
          background: #fafaf9;
          border-bottom: 1.5px solid #18181b;
          font-weight: 700;
        }
        table.winners tr.level-head th {
          background: #18181b;
          color: #fafaf9;
          font-size: 13px;
          font-weight: 700;
          font-family: "Anek Malayalam", "Manjari", sans-serif;
          padding: 7px 10px;
          text-align: left;
        }

        table.winners td.resno,
        table.winners td.code {
          font-family: ui-monospace, Menlo, Consolas, monospace;
          font-size: 11px;
          color: #57534e;
          white-space: nowrap;
        }
        table.winners td.resno { width: 4ch; text-align: right; }
        table.winners td.code  { width: 5ch; }
        table.winners td.prog  { font-weight: 600; }
        table.winners td.prog .prog-ml { display: block; }
        table.winners td.prog .prog-en {
          display: block;
          font-weight: 400;
          font-size: 0.86em;
          color: #57534e;
          font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
          margin-top: 1px;
        }
        table.winners td.prog .prog-girls {
          color: #be185d;
          font-weight: 600;
        }
        table.winners td.pos   {
          font-family: "Fraunces", serif;
          font-weight: 700;
          width: 3ch;
          text-align: center;
        }
        table.winners td.unit  { color: #57534e; }
        table.winners td.marks {
          text-align: right;
          font-variant-numeric: tabular-nums;
          color: #57534e;
          font-size: 11.5px;
          white-space: nowrap;
          width: 7ch;
        }
        /* Mark drafts in-table with a tiny inline pill so the admin
           knows which rows aren't live yet. Only the first row of a
           program carries .prog, so the pill renders once per program. */
        tr.draft-row td.prog .prog-ml::after {
          content: "draft";
          font-size: 9.5px;
          font-weight: 600;
          color: #92400e;
          background: #fef3c7;
          padding: 1px 5px;
          margin-left: 6px;
          border-radius: 3px;
          vertical-align: 1px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        /* Extras (position 0) are visually dimmer — they don't claim
           a podium spot, they're points-only contributors. */
        tr.extra-row td {
          color: #78716c;
          font-style: italic;
        }
        tr.extra-row td.pos {
          font-style: normal;
        }

        @media print {
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
          .winners-page {
            font-size: 9.5pt;
            max-width: none;
            padding: 0;
            margin: 0;
          }
          .winners-page h1 { font-size: 16pt; }
          .winners-page header.doc { margin-bottom: 4mm; padding-bottom: 2.5mm; }
          table.winners { font-size: 8.8pt; }
          table.winners th, table.winners td { padding: 2.4pt 4pt; }
          table.winners thead th { font-size: 7pt; }
          table.winners tr.level-head th { font-size: 10pt; padding: 3.5pt 5pt; }
          table.winners td.resno,
          table.winners td.code,
          table.winners td.marks { font-size: 7.5pt; }
          tr.draft-row td.prog .prog-ml::after { font-size: 7pt; padding: 0.5pt 3pt; }
          table.winners td.prog .prog-en { font-size: 7.5pt; }
          a { color: inherit; text-decoration: none; }
        }
      `}</style>

      {/* Screen-only toolbar */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-stone-200">
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center gap-3 flex-wrap">
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 text-sm text-stone-600 hover:text-black"
          >
            <ArrowLeft className="size-4" /> Back
          </Link>
          <span className="text-stone-300">·</span>
          <span className="text-sm font-medium">
            Winners — Print / Save as PDF
          </span>

          <div className="ml-auto flex items-center gap-4 flex-wrap">
            {/* Segmented control — pick one of three position scopes.
                Mutually exclusive, so radio semantics; styled as pills. */}
            <div
              role="radiogroup"
              aria-label="Positions to include"
              className="inline-flex items-center rounded-lg border border-stone-300 bg-white p-0.5 text-xs"
            >
              {(
                [
                  { value: "first" as const, label: "1st only" },
                  { value: "podium" as const, label: "I / II / III" },
                  { value: "all" as const, label: "All" },
                ]
              ).map((o) => {
                const active = posMode === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setPosMode(o.value)}
                    className={`px-2.5 py-1 rounded-md font-medium cursor-pointer transition ${
                      active
                        ? "bg-black text-white"
                        : "text-stone-600 hover:bg-stone-100"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs text-stone-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeDrafts}
                onChange={(e) => toggle("drafts", e.target.checked)}
                className="accent-yellow cursor-pointer"
              />
              Include drafts
              {includeDrafts && totals.drafts > 0 && (
                <span className="text-amber-700 font-medium">
                  · {totals.drafts}
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-black text-white text-xs font-semibold px-3 py-2 hover:bg-black/85 cursor-pointer"
            >
              <Printer className="size-4" /> Print / Save as PDF
            </button>
          </div>
        </div>
        <p className="max-w-5xl mx-auto px-5 pb-3 text-[11px] text-stone-500">
          In the print dialog choose{" "}
          <span className="font-medium text-stone-700">Save as PDF</span> · A4,
          default margins.
        </p>
      </div>

      <main className="winners-page max-w-5xl mx-auto px-5 sm:px-6 py-6">
        {/* Document header */}
        <header className="doc mb-5 pb-3 border-b-2 border-black">
          <p className="text-[10px] font-bold tracking-[0.3em] uppercase text-stone-500">
            Sahityotsav · Results
          </p>
          <h1 className="text-2xl font-semibold mt-1 leading-tight">
            {orgName || "Sahityotsav"}
          </h1>
          {eventName && (
            <p lang="ml" className="ml text-sm text-stone-700 mt-0.5">
              {eventName}
            </p>
          )}
          <p className="text-[10.5px] text-stone-500 mt-2">
            {totals.programs} program{totals.programs === 1 ? "" : "s"} ·{" "}
            {totals.winners} winner{totals.winners === 1 ? "" : "s"}
            {includeDrafts && totals.drafts > 0
              ? ` · ${totals.drafts} from drafts`
              : ""}
            {" · "}
            {posLabelText}
            {" · "}
            {new Date().toLocaleDateString("en-IN", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
        </header>

        {levels.length === 0 ? (
          <p className="text-sm text-stone-500 py-8 text-center">
            No {includeDrafts ? "" : "published "}results to print yet.
            {!includeDrafts && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => toggle("drafts", true)}
                  className="underline cursor-pointer no-print"
                >
                  Try including drafts.
                </button>
              </>
            )}
          </p>
        ) : (
          <table className="winners">
            <thead>
              <tr>
                <th className="resno">№</th>
                <th className="code">Code</th>
                <th className="prog">Program</th>
                {/* Pos column is meaningless in "1st only" mode — every
                    row would say "I". Drop it for a tighter table. */}
                {posMode !== "first" && <th className="pos">Pos</th>}
                <th>Winner</th>
                <th>Unit</th>
                <th className="marks">Marks</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <Fragment key={l.id}>
                  <tr className="level-head">
                    <th
                      colSpan={posMode === "first" ? 6 : 7}
                      lang="ml"
                      className="ml"
                    >
                      {l.name_ml}
                    </th>
                  </tr>
                  {l.programs.map((p) =>
                    p.result.winners.map((w, wIdx) => {
                      const span = p.result.winners.length;
                      const isFirstRow = wIdx === 0;
                      const isDraft = p.result.status === "draft";
                      const isExtra = w.position === 0;
                      const cls = [
                        isDraft ? "draft-row" : "",
                        isExtra ? "extra-row" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined;
                      return (
                        <tr key={`${p.id}-${wIdx}`} className={cls}>
                          {isFirstRow && (
                            <td className="resno" rowSpan={span}>
                              {p.result.result_no ?? ""}
                            </td>
                          )}
                          {isFirstRow && (
                            <td className="code" rowSpan={span}>
                              {p.code}
                            </td>
                          )}
                          {isFirstRow && (
                            <td className="prog" rowSpan={span}>
                              <span lang="ml" className="prog-ml">
                                {p.name_ml}
                              </span>
                              {p.name_en && (
                                <span className="prog-en">
                                  {p.name_en
                                    .replace(
                                      /\s*\(\s*Girls Only\s*\)\s*/i,
                                      "",
                                    )
                                    .trim()}
                                  {/\(\s*girls only\s*\)/i.test(p.name_en) && (
                                    <span className="prog-girls"> · Girls</span>
                                  )}
                                </span>
                              )}
                            </td>
                          )}
                          {posMode !== "first" && (
                            <td className="pos">{posLabel(w.position)}</td>
                          )}
                          <td className="ml" lang="ml">
                            {w.name_ml}
                          </td>
                          <td className="unit ml" lang="ml">
                            {w.unit_ml ?? ""}
                          </td>
                          <td className="marks">
                            {w.marks !== null && w.marks !== undefined
                              ? w.marks
                              : w.grade
                              ? `Gr ${w.grade}`
                              : ""}
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}

        <footer className="mt-6 pt-2 border-t border-stone-200 text-[9.5px] text-stone-400 tracking-[0.2em] uppercase text-center">
          {orgName || "Sahityotsav"}
          {eventName ? (
            <>
              {" "}
              ·{" "}
              <span lang="ml" className="ml normal-case tracking-normal">
                {eventName}
              </span>
            </>
          ) : null}
        </footer>
      </main>
    </>
  );
}
