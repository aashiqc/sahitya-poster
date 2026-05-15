import { Link, data } from "react-router";
import type { Route } from "./+types/result.$programCode";
import { createSupabaseServerClient, loadEvent } from "~/lib/supabase.server";
import {
  CornerLeaf,
  Diamond,
  DotMesh,
  Rule,
  Selvage,
} from "~/components/ornaments";

export function meta({ data }: Route.MetaArgs) {
  if (!data?.program) return [{ title: "Result not found" }];
  const eventName = (data.event as { name_ml?: string; name?: string } | null)?.name_ml ??
    (data.event as { name?: string } | null)?.name ?? "Sahityotsav";
  const programName = (data.program as { name_ml?: string } | null)?.name_ml ?? "";
  const levelName = (data.level as { name_ml?: string } | null)?.name_ml ?? "";
  const title = `${programName} · ${levelName}`;
  const top = (data.winners as { position: number; name_ml: string }[] | undefined)?.find(
    (w) => w.position === 1,
  )?.name_ml;
  const description = top ? `1st: ${top}` : `${title} · ${eventName}`;
  return [
    { title: `${title} · ${eventName}` },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "article" },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const event = await loadEvent(supabase);
  if (event.status !== "published") throw new Response("Not found", { status: 404 });

  const { data: program } = await supabase
    .from("programs")
    .select("id, code, name_ml, name_en, levels(id, code, name_ml)")
    .eq("event_id", event.id)
    .eq("code", params.programCode)
    .maybeSingle();
  if (!program) throw new Response("Program not found", { status: 404 });
  const level = program.levels as unknown as { id: string; code: string; name_ml: string } | null;
  if (!level) throw new Response("Program has no level", { status: 500 });

  const { data: result } = await supabase
    .from("results")
    .select("id, result_no, is_tie, status, published_at")
    .eq("event_id", event.id)
    .eq("program_id", program.id)
    .eq("status", "published")
    .maybeSingle();
  if (!result) throw new Response("Result not yet published", { status: 404 });

  const { data: winners } = await supabase
    .from("result_winners")
    .select("position, name_ml, name_en, unit_ml, marks")
    .eq("result_id", result.id)
    .order("position");

  return data(
    {
      event,
      program,
      level,
      result,
      winners: winners ?? [],
    },
    {
      headers: {
        ...Object.fromEntries(headers),
        "Cache-Control": "public, max-age=60, s-maxage=300",
      },
    },
  );
}

const POSITIONS: Record<
  number,
  { roman: string; label: string; tone: string; glow: string }
> = {
  1: {
    roman: "I",
    label: "First",
    tone: "text-gold-700 border-gold-400 bg-gradient-to-br from-gold-50 to-paper",
    glow: "ring-2 ring-gold-300/70",
  },
  2: {
    roman: "II",
    label: "Second",
    tone: "text-ink-700 border-paper-3 bg-paper",
    glow: "",
  },
  3: {
    roman: "III",
    label: "Third",
    tone: "text-saffron-600 border-saffron-500/30 bg-gradient-to-br from-amber-50 to-paper",
    glow: "",
  },
};

export default function PublicResult({ loaderData }: Route.ComponentProps) {
  const { event, program, level, result, winners } = loaderData;
  const org = (event.organizations as { name?: string } | null)?.name;
  const eventName = event.name_ml ?? event.name;

  return (
    <div className="min-h-dvh">
      {/* ───── Festive header ───── */}
      <header className="relative overflow-hidden text-paper">
        <div
          className="absolute inset-0 bg-gradient-to-br from-night-400 via-night-600 to-night-800"
          aria-hidden
        />
        <DotMesh opacity={0.14} size={24} className="text-gold-200" />
        <CornerLeaf
          className="absolute -top-2 -left-3 size-24 text-gold-200/40"
          rotate={0}
        />
        <CornerLeaf
          className="absolute -bottom-3 -right-3 size-24 text-gold-200/40"
          rotate={180}
        />

        <div className="relative max-w-2xl mx-auto px-5 pt-6 pb-12">
          <div className="flex items-center justify-between gap-3 text-gold-200">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm hover:text-paper transition"
            >
              <span aria-hidden>←</span>
              <span>All results</span>
            </Link>
            {result.result_no && (
              <span className="font-display text-[11px] font-bold tracking-[0.25em] uppercase tabular-nums">
                № {result.result_no}
              </span>
            )}
          </div>

          <div className="mt-7">
            {org && (
              <p className="font-display text-[10px] font-bold tracking-[0.3em] uppercase text-gold-200/90">
                {org}
              </p>
            )}
            <p
              lang="ml"
              className="text-xs text-gold-200/80 mt-1 tracking-wide"
            >
              {eventName} · {level.name_ml}
            </p>
          </div>

          <h1
            lang="ml"
            className="text-3xl sm:text-5xl font-semibold tracking-tight mt-3 leading-tight text-paper"
          >
            {program.name_ml}
          </h1>

          {program.name_en && (
            <p className="font-display text-sm italic text-gold-200/80 mt-2">
              {program.name_en}
            </p>
          )}

          <div className="mt-5">
            <Rule tone="gold" className="text-gold-200/80 max-w-xs" />
          </div>

          {result.is_tie && (
            <span className="stamp mt-4">Tie</span>
          )}
        </div>

        <Selvage />
      </header>

      {/* ───── Winners ───── */}
      <main className="max-w-2xl mx-auto px-5 pt-10 pb-12">
        <Rule tone="gold" label="Winners" className="mb-7" />

        <ol className="space-y-4">
          {winners.map((w) => {
            const meta = POSITIONS[w.position] ?? POSITIONS[3];
            return (
              <li
                key={w.position}
                className={`relative card-festive ${meta.glow} p-5 sm:p-6 flex items-start gap-5`}
              >
                {/* Medallion */}
                <div
                  className={`size-16 shrink-0 relative grid place-items-center rounded-full border-2 ${meta.tone}`}
                >
                  <Diamond className="absolute size-14 text-current opacity-15" />
                  <span className="font-display text-2xl font-bold tracking-tight">
                    {meta.roman}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <p className="font-display text-[10px] font-bold tracking-[0.25em] uppercase text-ink-400">
                    {meta.label} place
                  </p>
                  <p
                    lang="ml"
                    className="text-xl sm:text-2xl font-semibold leading-tight mt-1 break-words text-ink-900"
                  >
                    {w.name_ml}
                  </p>
                  {w.unit_ml && (
                    <p
                      lang="ml"
                      className="text-sm text-ink-700 mt-1 break-words"
                    >
                      {w.unit_ml}
                    </p>
                  )}
                  {w.name_en && (
                    <p className="font-display text-xs italic text-ink-400 mt-1">
                      {w.name_en}
                    </p>
                  )}
                </div>

                {w.marks !== null && w.marks !== undefined && (
                  <div className="shrink-0 text-right">
                    <p className="font-display text-[9px] font-bold tracking-[0.25em] uppercase text-ink-400">
                      Marks
                    </p>
                    <p className="font-display text-2xl tabular-nums text-ink-900 mt-0.5">
                      {w.marks}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {org && (
          <div className="mt-12">
            <Rule tone="ink" className="opacity-50" />
            <p className="text-center font-display text-[11px] tracking-[0.3em] uppercase text-ink-400 mt-4">
              {org}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
