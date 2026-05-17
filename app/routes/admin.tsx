import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useActionData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  LayoutGrid,
  Menu,
  RefreshCw,
  Search,
  Share2,
  Shuffle,
  Trophy,
  X,
} from "lucide-react";
import type Konva from "konva";
import type { Route } from "./+types/admin";
import { loadEvent, requireAdmin } from "~/lib/supabase.server";
import { TEAM_BY_SLUG, TEAMS } from "~/lib/teams";
import {
  POSTER_TEMPLATE_COUNT,
  PosterCanvas,
  exportPosterPng,
  sharePoster,
  type PosterData,
} from "~/components/poster-canvas";
import {
  STANDINGS_TEMPLATE_NAMES,
  StandingsPosterCanvas,
  exportStandingsPng,
  shareStandings,
} from "~/components/standings-poster";

export function meta() {
  return [{ title: "Admin · Sahityotsav" }];
}

// Normalize a candidate name to Title Case (first letter of each word
// upper, rest lower) so stored names are consistent regardless of how
// the admin typed them. Mirrors Postgres initcap(); Unicode-aware so
// Malayalam (no case) passes through unchanged.
function titleCaseName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

// ── Standings CSV parsing (header: Rank,Team Name,Points) ────────────
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseStandingsCsv(
  text: string,
): { rank: number; team_name: string; points: number }[] {
  const rows: { rank: number; team_name: string; points: number }[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const c = csvCells(line);
    if (c.length < 2) continue;
    const rank = parseInt(c[0], 10);
    if (!Number.isFinite(rank)) continue; // skips the header row
    const name = (c[1] ?? "").replace(/\s*\bunit\b\s*$/i, "").trim();
    if (!name) continue;
    const points = Number(c[2] ?? "");
    rows.push({ rank, team_name: name, points: Number.isFinite(points) ? points : 0 });
  }
  return rows;
}

// ============================================================================
// Loader
// ============================================================================
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers, user, profile } = await requireAdmin(request);
  const event = await loadEvent(supabase);

  const [levelsRes, programsRes, resultsRes, standingsRes] = await Promise.all([
    supabase
      .from("levels")
      .select("id, code, name_ml, sort_order")
      .eq("event_id", event.id)
      .order("sort_order"),
    supabase
      .from("programs")
      .select("id, code, name_ml, name_en, sort_order, level_id, is_active")
      .eq("event_id", event.id)
      .order("sort_order")
      .order("code"),
    supabase
      .from("results")
      .select(
        `id, program_id, status, result_no, result_winners(position, name_ml, name_en, unit_ml, marks, grade)`,
      )
      .eq("event_id", event.id),
    supabase
      .from("team_standings")
      .select("after_n, rank, team_name, points, template")
      .eq("event_id", event.id)
      .order("after_n", { ascending: true })
      .order("rank", { ascending: true }),
  ]);

  const levels = levelsRes.data ?? [];
  const programs = programsRes.data ?? [];
  const results = resultsRes.data ?? [];

  // Map programId → result summary (incl. full winners so the edit modal
  // opens instantly from already-loaded data — no extra round trip).
  type WinnerRow = {
    position: number;
    name_ml: string;
    name_en: string | null;
    unit_ml: string | null;
    marks: number | null;
    grade: string | null;
  };
  const resultByProgram = new Map<
    string,
    {
      id: string;
      status: string;
      result_no: string | null;
      topName: string | null;
      winners: WinnerRow[];
    }
  >();
  const publishedWinners: WinnerRow[] = [];
  for (const r of results) {
    const winners = ((r.result_winners as WinnerRow[]) ?? [])
      .map((w) => ({
        position: w.position,
        name_ml: w.name_ml,
        name_en: w.name_en ?? null,
        unit_ml: w.unit_ml,
        marks: w.marks !== null && w.marks !== undefined ? Number(w.marks) : null,
        grade: w.grade ?? null,
      }))
      .sort((a, b) => a.position - b.position);
    const first = winners.find((w) => w.position === 1);
    resultByProgram.set(r.program_id, {
      id: r.id,
      status: r.status,
      result_no: r.result_no,
      topName: first?.name_en ?? first?.name_ml ?? null,
      winners,
    });
    if (r.status === "published") publishedWinners.push(...winners);
  }

  // Enrich levels with their programs (and each program's result status)
  const enrichedLevels = levels.map((l) => {
    const lps = programs
      .filter((p) => p.level_id === l.id)
      .map((p) => ({ ...p, result: resultByProgram.get(p.id) ?? null }));
    const active = lps.filter((p) => p.is_active);
    return {
      ...l,
      programs: lps,
      total: active.length,
      published: active.filter((p) => p.result?.status === "published").length,
      drafts: active.filter((p) => p.result?.status === "draft").length,
      pending: active.filter((p) => !p.result).length,
      inactive: lps.filter((p) => !p.is_active).length,
    };
  });

  const activePrograms = programs.filter((p) => p.is_active);
  const totalPublished = activePrograms.filter(
    (p) => resultByProgram.get(p.id)?.status === "published",
  ).length;
  const totalDrafts = activePrograms.filter(
    (p) => resultByProgram.get(p.id)?.status === "draft",
  ).length;
  const totalPending = activePrograms.filter((p) => !resultByProgram.get(p.id)).length;
  const totalInactive = programs.length - activePrograms.length;

  // Group uploaded standings rows into per-after_n snapshots, each
  // carrying its own poster template.
  type SRow = {
    after_n: number;
    rank: number;
    team_name: string;
    points: number;
    template: number | null;
  };
  const standingsMap = new Map<
    number,
    { template: number; rows: { rank: number; team_name: string; points: number }[] }
  >();
  for (const r of (standingsRes.data ?? []) as SRow[]) {
    const g = standingsMap.get(r.after_n) ?? {
      template: r.template ?? 0,
      rows: [],
    };
    g.template = r.template ?? 0;
    g.rows.push({
      rank: r.rank,
      team_name: r.team_name,
      points: Number(r.points),
    });
    standingsMap.set(r.after_n, g);
  }
  const standings = [...standingsMap.entries()]
    .map(([afterN, g]) => ({
      afterN,
      template: g.template,
      rows: g.rows.sort((a, b) => a.rank - b.rank),
    }))
    .sort((a, b) => a.afterN - b.afterN);

  return data(
    {
      user: { email: user.email ?? "" },
      profile,
      event,
      levels: enrichedLevels,
      stats: {
        totalPrograms: activePrograms.length,
        totalPublished,
        totalDrafts,
        totalPending,
        totalInactive,
      },
      publishedWinners,
      standings,
      standingsTemplate:
        (event as { standings_template?: number }).standings_template ?? 0,
    },
    { headers: Object.fromEntries(headers) },
  );
}

// ============================================================================
// Action
// ============================================================================
export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers, user } = await requireAdmin(request);
  const event = await loadEvent(supabase);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent === "logout") {
    await supabase.auth.signOut();
    return redirect("/admin/login", { headers: Object.fromEntries(headers) });
  }

  if (intent === "toggle_publish") {
    const next = event.status === "published" ? "draft" : "published";
    const { error } = await supabase.from("events").update({ status: next }).eq("id", event.id);
    if (error) return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data({ ok: true }, { headers: Object.fromEntries(headers) });
  }


  if (intent === "delete_standings") {
    const afterN = parseInt(String(fd.get("after_n") ?? ""), 10);
    if (!Number.isFinite(afterN)) {
      return data({ error: "Invalid snapshot." }, { headers: Object.fromEntries(headers) });
    }
    const { error } = await supabase
      .from("team_standings")
      .delete()
      .eq("event_id", event.id)
      .eq("after_n", afterN);
    if (error) return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data({ ok: true }, { headers: Object.fromEntries(headers) });
  }

  if (intent === "upload_standings") {
    const afterN = parseInt(String(fd.get("after_n") ?? "").trim(), 10);
    if (!Number.isFinite(afterN) || afterN < 0) {
      return data(
        { error: "Enter a valid 'after N results' number." },
        { headers: Object.fromEntries(headers) },
      );
    }
    const tRaw = parseInt(String(fd.get("template") ?? "0"), 10);
    const template =
      Number.isFinite(tRaw) && tRaw >= 0 && tRaw < STANDINGS_TEMPLATE_NAMES.length
        ? tRaw
        : 0;
    const csv = String(fd.get("csv") ?? "");
    const parsed = parseStandingsCsv(csv);
    if (parsed.length === 0) {
      return data(
        { error: "No valid rows found. Expected: Rank,Team Name,Points" },
        { headers: Object.fromEntries(headers) },
      );
    }
    // Replace this snapshot atomically-ish: delete then insert.
    const del = await supabase
      .from("team_standings")
      .delete()
      .eq("event_id", event.id)
      .eq("after_n", afterN);
    if (del.error) {
      return data({ error: del.error.message }, { headers: Object.fromEntries(headers) });
    }
    const { error: insErr } = await supabase.from("team_standings").insert(
      parsed.map((r) => ({
        event_id: event.id,
        after_n: afterN,
        rank: r.rank,
        team_name: r.team_name,
        points: r.points,
        template,
      })),
    );
    if (insErr) return data({ error: insErr.message }, { headers: Object.fromEntries(headers) });
    // Remember this as the default template for the next upload.
    await supabase
      .from("events")
      .update({ standings_template: template })
      .eq("id", event.id);
    return data(
      {
        ok: true,
        message: `Saved ${parsed.length} teams · after ${afterN} · ${STANDINGS_TEMPLATE_NAMES[template]}`,
      },
      { headers: Object.fromEntries(headers) },
    );
  }

  if (intent === "set_snapshot_template") {
    const afterN = parseInt(String(fd.get("after_n") ?? ""), 10);
    const t = parseInt(String(fd.get("template") ?? ""), 10);
    if (!Number.isFinite(afterN)) {
      return data({ error: "Invalid snapshot." }, { headers: Object.fromEntries(headers) });
    }
    if (!Number.isFinite(t) || t < 0 || t >= STANDINGS_TEMPLATE_NAMES.length) {
      return data({ error: "Invalid template." }, { headers: Object.fromEntries(headers) });
    }
    const { error } = await supabase
      .from("team_standings")
      .update({ template: t })
      .eq("event_id", event.id)
      .eq("after_n", afterN);
    if (error) return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data(
      {
        ok: true,
        message: `after ${afterN}: ${STANDINGS_TEMPLATE_NAMES[t]} template`,
      },
      { headers: Object.fromEntries(headers) },
    );
  }

  if (intent === "upload_final_poster") {
    const file = fd.get("final_poster");
    if (!(file instanceof File) || file.size === 0) {
      return data(
        { error: "Choose an image file to upload." },
        { headers: Object.fromEntries(headers) },
      );
    }
    if (!file.type.startsWith("image/")) {
      return data(
        { error: "That's not an image. Upload a PNG or JPG poster." },
        { headers: Object.fromEntries(headers) },
      );
    }
    if (file.size > 4 * 1024 * 1024) {
      return data(
        {
          error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — keep it under 4 MB (compress or export at a lower scale).`,
        },
        { headers: Object.fromEntries(headers) },
      );
    }
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/jpeg"
        ? "jpg"
        : file.type === "image/webp"
        ? "webp"
        : (file.name.split(".").pop() || "png").toLowerCase();
    const path = `final/${event.id}.${ext}`;
    const up = await supabase.storage
      .from("posters")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) {
      return data(
        { error: `Upload failed: ${up.error.message}` },
        { headers: Object.fromEntries(headers) },
      );
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from("posters").getPublicUrl(path);
    // Cache-bust: the path is stable (upsert), so version the URL.
    const versioned = `${publicUrl}?v=${Date.now()}`;
    const { error: updErr } = await supabase
      .from("events")
      .update({ final_poster_url: versioned })
      .eq("id", event.id);
    if (updErr) {
      return data({ error: updErr.message }, { headers: Object.fromEntries(headers) });
    }
    return data(
      { ok: true, message: "Final poster published — it now leads the public chat." },
      { headers: Object.fromEntries(headers) },
    );
  }

  if (intent === "clear_final_poster") {
    const { error } = await supabase
      .from("events")
      .update({ final_poster_url: null })
      .eq("id", event.id);
    if (error) return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data(
      { ok: true, message: "Final poster removed." },
      { headers: Object.fromEntries(headers) },
    );
  }

  // Result-scoped intents need program_code
  const programCode = String(fd.get("program_code") ?? "");
  if (!programCode) {
    return data({ error: "Missing program code." }, { headers: Object.fromEntries(headers) });
  }
  const { data: program } = await supabase
    .from("programs")
    .select("id, code, level_id")
    .eq("event_id", event.id)
    .eq("code", programCode)
    .maybeSingle();
  if (!program || !program.level_id) {
    return data({ error: "Program not found." }, { headers: Object.fromEntries(headers) });
  }

  if (intent === "delete_result") {
    const { data: existing } = await supabase
      .from("results")
      .select("id")
      .eq("event_id", event.id)
      .eq("program_id", program.id)
      .maybeSingle();
    if (existing) await supabase.from("results").delete().eq("id", existing.id);
    return redirect("/admin", { headers: Object.fromEntries(headers) });
  }

  if (intent === "toggle_active") {
    // Read current state, flip it.
    const { data: cur } = await supabase
      .from("programs")
      .select("is_active")
      .eq("id", program.id)
      .single();
    const next = !(cur?.is_active ?? true);
    const { error } = await supabase
      .from("programs")
      .update({ is_active: next })
      .eq("id", program.id);
    if (error) return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    // If deactivating, also drop any result so it can't be served publicly.
    if (next === false) {
      await supabase.from("results").delete().eq("program_id", program.id);
    }
    return data({ ok: true }, { headers: Object.fromEntries(headers) });
  }

  if (intent === "save_draft" || intent === "save_publish") {
    const result_no = String(fd.get("result_no") ?? "").trim() || null;
    const publish = intent !== "save_draft";

    // Only 1st/2nd/3rd, name + team. Team points come from the
    // separate standings CSV, so no marks/grade are collected here.
    const winners: {
      position: number;
      name_ml: string;
      name_en: string | null;
      unit_ml: string | null;
      marks: number | null;
      grade: string | null;
    }[] = [];
    for (const pos of [1, 2, 3]) {
      const raw = String(fd.get(`winner_${pos}_name_en`) ?? "").trim();
      if (!raw) continue;
      const name = titleCaseName(raw);
      winners.push({
        position: pos,
        // name_ml is NOT NULL in the DB; English name backs both columns.
        name_ml: name,
        name_en: name,
        unit_ml: String(fd.get(`winner_${pos}_unit_ml`) ?? "").trim() || null,
        marks: null,
        grade: null,
      });
    }

    if (winners.length === 0) {
      return data(
        { error: "Enter at least the first-place winner's name." },
        { headers: Object.fromEntries(headers) },
      );
    }

    const { data: existing } = await supabase
      .from("results")
      .select("id")
      .eq("event_id", event.id)
      .eq("program_id", program.id)
      .maybeSingle();

    const baseFields = {
      event_id: event.id,
      program_id: program.id,
      level_id: program.level_id,
      result_no,
      is_tie: false,
      status: publish ? "published" : "draft",
      published_at: publish ? new Date().toISOString() : null,
    };

    let resultId: string;
    if (existing) {
      const { error: uErr } = await supabase
        .from("results")
        .update(baseFields)
        .eq("id", existing.id);
      if (uErr) return data({ error: uErr.message }, { headers: Object.fromEntries(headers) });
      resultId = existing.id;
      await supabase.from("result_winners").delete().eq("result_id", resultId);
    } else {
      const { data: created, error: iErr } = await supabase
        .from("results")
        .insert({ ...baseFields, created_by: user.id })
        .select("id")
        .single();
      if (iErr || !created)
        return data(
          { error: iErr?.message ?? "Insert failed" },
          { headers: Object.fromEntries(headers) },
        );
      resultId = created.id;
    }

    const { error: wErr } = await supabase
      .from("result_winners")
      .insert(winners.map((w) => ({ result_id: resultId, ...w })));
    if (wErr) return data({ error: wErr.message }, { headers: Object.fromEntries(headers) });

    // Stay on the modal and show success — no redirect.
    return data({ ok: true }, { headers: Object.fromEntries(headers) });
  }

  return data({ error: `Unknown intent: ${intent}` }, { headers: Object.fromEntries(headers) });
}

// The loader no longer reads any query param — the edit modal is built
// client-side from already-loaded data. So opening/closing the modal or
// switching views needs zero network. Only revalidate after a form submit
// or a real path change.
export function shouldRevalidate({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }: {
  formMethod?: string;
  currentUrl: URL;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
}) {
  if (formMethod) return true; // after action — refresh data
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  return false; // same path, only query changed — pure client state
}

// ============================================================================
// Component
// ============================================================================
export default function Admin({ loaderData }: Route.ComponentProps) {
  const {
    user,
    profile,
    event,
    levels,
    stats,
    publishedWinners,
    standings,
    standingsTemplate,
  } = loaderData;
  const orgName = (profile.organizations as { name?: string } | null)?.name ?? "";
  const eventName = event.name_ml ?? event.name;
  const isPublished = event.status === "published";

  const [searchParams] = useSearchParams();
  const view = (searchParams.get("view") ?? "dashboard") as
    | "dashboard"
    | "standings"
    | "share";

  const editCode = searchParams.get("edit");
  const editData = useMemo(
    () => buildEditData(editCode, levels as LevelRow[]),
    [editCode, levels],
  );

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "published" | "pending" | "draft" | "inactive"
  >("all");
  const [showInactive, setShowInactive] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // Match programs across all categories.
  const q = query.trim().toLowerCase();
  function programVisible(p: ProgramRow): boolean {
    if (!showInactive && !p.is_active) return false;
    if (statusFilter === "published" && p.result?.status !== "published") return false;
    if (statusFilter === "draft" && p.result?.status !== "draft") return false;
    if (statusFilter === "pending" && p.result) return false;
    if (statusFilter === "inactive" && p.is_active) return false;
    if (q) {
      const hay = `${p.code} ${p.name_ml} ${p.name_en ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const filteredLevels = levels
    .map((l) => ({ ...l, programs: l.programs.filter(programVisible) }))
    .filter((l) => l.programs.length > 0 || statusFilter === "all");

  const matchCount = filteredLevels.reduce((n, l) => n + l.programs.length, 0);

  return (
    <div className="min-h-dvh flex bg-stone-50 text-black">
      {/* ============= Sidebar ============= */}
      <aside
        className={`fixed lg:sticky top-0 left-0 z-30 h-dvh w-64 shrink-0 bg-black text-white flex flex-col transition-transform ${
          navOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="px-5 py-4 border-b border-white/10">
          <p className="text-[10px] font-bold tracking-[0.25em] uppercase text-yellow leading-none">
            Sahityotsav
          </p>
          <p className="text-sm font-medium mt-1.5 truncate">{orgName}</p>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          <NavItem
            active={view === "dashboard"}
            label="Dashboard"
            icon={<LayoutGrid className="size-4" />}
            to="/admin"
          />
          <NavItem
            active={view === "standings"}
            label="Team standings"
            icon={<Trophy className="size-4" />}
            to="/admin?view=standings"
          />
          <NavItem
            active={view === "share"}
            label="Share posters"
            icon={<Share2 className="size-4" />}
            to="/admin?view=share"
          />
          <NavItem
            label="Public site"
            icon={<ExternalLink className="size-4" />}
            href="/"
            external
          />
        </nav>

        <div className="p-3 border-t border-white/10 space-y-2">
          <div className="px-3 py-2 rounded-lg bg-white/5">
            <p className="text-[10px] uppercase tracking-widest text-yellow/80">
              Event
            </p>
            <p lang="ml" className="text-sm font-semibold mt-0.5 truncate">
              {eventName}
            </p>
            <Form method="post" className="mt-2">
              <button
                type="submit"
                name="intent"
                value="toggle_publish"
                className={`w-full rounded-md text-[11px] font-semibold px-2.5 py-1.5 ${
                  isPublished
                    ? "bg-white/10 hover:bg-white/15 text-white"
                    : "bg-yellow text-black hover:bg-yellow/90"
                }`}
              >
                {isPublished ? "● Live — unpublish" : "Publish event"}
              </button>
            </Form>
          </div>
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value="logout"
              className="w-full text-left px-3 py-2 rounded-lg text-xs text-white/60 hover:bg-white/10 hover:text-white"
              title={user.email}
            >
              Sign out · {user.email}
            </button>
          </Form>
        </div>
      </aside>

      {/* Backdrop for mobile drawer */}
      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
        />
      )}

      {/* ============= Main column ============= */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-stone-200">
          <div className="px-4 lg:px-8 py-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="lg:hidden size-9 grid place-items-center rounded-lg border border-stone-300"
            >
              <Menu className="size-4" />
            </button>
            <h1 className="text-base font-semibold tracking-tight">
              {view === "standings"
                ? "Team standings"
                : view === "share"
                ? "Share posters"
                : "Dashboard"}
            </h1>

            {view === "dashboard" && (
              <div className="flex-1 max-w-md ml-auto">
                <SearchInput value={query} onChange={setQuery} />
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 px-4 lg:px-8 py-6 space-y-6">
          {view === "standings" && (
            <StandingsView
              snapshots={standings}
              defaultTemplate={standingsTemplate}
              finalPosterUrl={
                (event as { final_poster_url?: string | null })
                  .final_poster_url ?? null
              }
            />
          )}
          {view === "share" && (
            <SharePostersView
              levels={levels as LevelRow[]}
              eventName={event.name ?? event.name_ml ?? "Sahityotsav"}
            />
          )}
          {view === "dashboard" && (
            <DashboardView
              levels={levels}
              filteredLevels={filteredLevels}
              matchCount={matchCount}
              query={query}
              setQuery={setQuery}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              showInactive={showInactive}
              setShowInactive={setShowInactive}
              stats={stats}
              isPublished={isPublished}
            />
          )}
        </main>
      </div>

      {editData && <ResultModal editData={editData} />}
    </div>
  );
}

// Dashboard view extracted so admin shell can swap to other views cleanly.
function DashboardView({
  filteredLevels,
  matchCount,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  showInactive,
  setShowInactive,
  stats,
  isPublished,
}: {
  levels: LevelRow[];
  filteredLevels: LevelRow[];
  matchCount: number;
  query: string;
  setQuery: (v: string) => void;
  statusFilter: "all" | "published" | "pending" | "draft" | "inactive";
  setStatusFilter: (v: "all" | "published" | "pending" | "draft" | "inactive") => void;
  showInactive: boolean;
  setShowInactive: (v: boolean) => void;
  stats: {
    totalPrograms: number;
    totalPublished: number;
    totalDrafts: number;
    totalPending: number;
    totalInactive: number;
  };
  isPublished: boolean;
}) {
  return (
    <>
      {/* Stats row */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Programs" value={stats.totalPrograms} tone="black" icon={<LayoutGrid className="size-4" />} />
        <StatCard label="Published" value={stats.totalPublished} tone="yellow" icon={<Check className="size-4" />} />
        <StatCard label="Pending" value={stats.totalPending} tone="muted" icon={<Clock className="size-4" />} />
        <StatCard label="Inactive" value={stats.totalInactive} tone="red" icon={<Ban className="size-4" />} />
      </section>

      {/* Filters bar */}
      <section className="flex flex-wrap items-center gap-2 -mx-1">
        <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>All</FilterChip>
        <FilterChip active={statusFilter === "published"} onClick={() => setStatusFilter("published")}>
          Published · {stats.totalPublished}
        </FilterChip>
        <FilterChip active={statusFilter === "pending"} onClick={() => setStatusFilter("pending")}>
          Pending · {stats.totalPending}
        </FilterChip>
        <FilterChip active={statusFilter === "draft"} onClick={() => setStatusFilter("draft")}>
          Drafts · {stats.totalDrafts}
        </FilterChip>
        <FilterChip
          active={statusFilter === "inactive"}
          onClick={() => {
            setStatusFilter("inactive");
            setShowInactive(true);
          }}
        >
          Inactive · {stats.totalInactive}
        </FilterChip>

        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-yellow cursor-pointer"
            />
            <span className="text-stone-700">Show inactive</span>
          </label>
          {query && (
            <span className="text-stone-500">
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </span>
          )}
        </div>
      </section>

      {/* Categories grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredLevels.map((l) => (
          <CategoryCard key={l.id} level={l} />
        ))}
        {filteredLevels.length === 0 && (
          <div className="col-span-full rounded-xl border border-stone-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-stone-600">No programs match your filter.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
              className="mt-3 text-xs font-medium text-black underline cursor-pointer"
            >
              Clear search
            </button>
          </div>
        )}
      </section>

      {!isPublished && (
        <p className="text-xs text-stone-500">
          The event is in draft — public results are hidden until you publish.
        </p>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Standings view — full leaderboard + per-team breakdown
// ─────────────────────────────────────────────────────────────────────
type StandingsSnapshot = {
  afterN: number;
  template: number;
  rows: { rank: number; team_name: string; points: number }[];
};

// One snapshot's standings poster + Download / Share, using the
// currently-selected template.
function StandingsShareCard({
  snapshot,
  templateIndex,
}: {
  snapshot: StandingsSnapshot;
  templateIndex: number;
}) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [busy, setBusy] = useState<null | "download" | "share">(null);

  async function onDownload() {
    setBusy("download");
    try {
      await exportStandingsPng(
        stageRef.current,
        `standings_after_${snapshot.afterN}.png`,
      );
    } finally {
      setBusy(null);
    }
  }
  async function onShare() {
    setBusy("share");
    try {
      await shareStandings(stageRef.current, snapshot.afterN);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-stone-200 p-4">
      <div className="mx-auto max-w-xs overflow-hidden rounded-lg ring-1 ring-stone-200">
        <StandingsPosterCanvas
          data={{
            afterN: snapshot.afterN,
            rows: snapshot.rows.map((r) => ({
              name: r.team_name,
              points: r.points,
            })),
          }}
          templateIndex={templateIndex}
          stageRef={stageRef}
        />
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 disabled:opacity-50 hover:bg-stone-50"
        >
          <Download className="size-4" />
          {busy === "download" ? "…" : "Download"}
        </button>
        <button
          type="button"
          onClick={onShare}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-stone-800"
        >
          <Share2 className="size-4" />
          {busy === "share" ? "…" : "Share"}
        </button>
      </div>
    </div>
  );
}

function StandingsView({
  snapshots,
  defaultTemplate,
  finalPosterUrl,
}: {
  snapshots: StandingsSnapshot[];
  defaultTemplate: number;
  finalPosterUrl: string | null;
}) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [csv, setCsv] = useState("");
  const [finalName, setFinalName] = useState("");

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Final standings poster — a finished image with real data,
          uploaded as-is (no template). It leads the public chat with
          a celebration the moment it's published. */}
      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Final standings poster
        </h2>
        <p className="text-xs text-stone-500 mt-1">
          Upload the finished poster image (PNG/JPG, real data baked in —
          no template). It appears first in the public chat with a
          party-popper. Re-upload anytime to replace it. Keep under 4 MB.
        </p>

        {finalPosterUrl && (
          <div className="mt-4 flex flex-wrap items-start gap-4">
            <img
              src={finalPosterUrl}
              alt="Current final poster"
              className="w-40 rounded-lg border border-stone-200 shadow-sm"
            />
            <div className="space-y-2">
              <p className="text-xs font-medium text-emerald-700">
                ● Live on the public site
              </p>
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="clear_final_poster"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Remove final poster
                </button>
              </Form>
            </div>
          </div>
        )}

        <Form
          method="post"
          encType="multipart/form-data"
          className="mt-4 space-y-3"
        >
          <input type="hidden" name="intent" value="upload_final_poster" />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer">
              <input
                type="file"
                name="final_poster"
                accept="image/png,image/jpeg,image/webp"
                required
                onChange={(e) =>
                  setFinalName(e.target.files?.[0]?.name ?? "")
                }
                className="sr-only"
              />
              Choose poster image
            </label>
            <span className="text-[11px] text-stone-500 truncate max-w-[16rem]">
              {finalName || "No file chosen"}
            </span>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-stone-800"
          >
            {busy ? "Publishing…" : finalPosterUrl ? "Replace poster" : "Publish final poster"}
          </button>
        </Form>
      </section>

      {/* Upload */}
      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Upload team standings
        </h2>
        <p className="text-xs text-stone-500 mt-1">
          Standings are taken straight from your CSV — not computed from
          results. Paste the official sheet for a checkpoint. Format:
          <code className="mx-1 rounded bg-stone-100 px-1.5 py-0.5">
            Rank,Team Name,Points
          </code>
          (a header row is fine). Uploading replaces the snapshot for that N.
        </p>

        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="upload_standings" />
          <div className="flex items-center gap-2">
            <label htmlFor="after_n" className="text-sm font-medium">
              After
            </label>
            <input
              id="after_n"
              name="after_n"
              type="number"
              min={0}
              required
              placeholder="10"
              className="w-24 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm tabular-nums focus:outline-none focus:border-stone-400"
            />
            <span className="text-sm text-stone-600">results</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium mr-1">Template</span>
            {STANDINGS_TEMPLATE_NAMES.map((nm, i) => (
              <label
                key={nm}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 cursor-pointer has-[:checked]:border-stone-900 has-[:checked]:bg-stone-900 has-[:checked]:text-white"
              >
                <input
                  type="radio"
                  name="template"
                  value={i}
                  defaultChecked={i === defaultTemplate}
                  className="sr-only"
                />
                {nm}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={onPickFile}
                className="sr-only"
              />
              Choose .csv file
            </label>
            <span className="text-[11px] text-stone-400">
              or paste below — the file fills the box; you can still edit it.
            </span>
          </div>
          <textarea
            name="csv"
            required
            rows={9}
            spellCheck={false}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={
              "Rank,Team Name,Points\n1,Anithara Unit,143\n2,Vidya Nagar Unit,100\n3,Cheerpingal Unit,59"
            }
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed focus:outline-none focus:border-stone-400"
          />
          {actionData && "error" in actionData && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {actionData.error}
            </p>
          )}
          {actionData && "ok" in actionData && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
              ✓ {"message" in actionData ? String(actionData.message) : "Saved"}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-stone-800"
          >
            {busy ? "Saving…" : "Upload standings"}
          </button>
        </Form>
      </section>

      {/* Existing snapshots */}
      {snapshots.length === 0 ? (
        <section className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
          No standings uploaded yet. The public standings poster appears once
          you upload at least one snapshot.
        </section>
      ) : (
        snapshots
          .slice()
          .sort((a, b) => b.afterN - a.afterN)
          .map((s) => (
            <section
              key={s.afterN}
              className="rounded-xl border border-stone-200 bg-white overflow-hidden"
            >
              <header className="px-5 py-3 border-b border-stone-200 bg-stone-50 flex items-center gap-3">
                <Trophy className="size-4 text-yellow" strokeWidth={2.5} />
                <h3 className="text-sm font-semibold">After {s.afterN} results</h3>
                <span className="text-[11px] text-stone-500">
                  {s.rows.length} teams
                </span>
                <Form method="post" className="ml-auto">
                  <input type="hidden" name="intent" value="delete_standings" />
                  <input type="hidden" name="after_n" value={s.afterN} />
                  <button
                    type="submit"
                    disabled={busy}
                    onClick={(e) => {
                      if (!confirm(`Delete the "after ${s.afterN}" snapshot?`))
                        e.preventDefault();
                    }}
                    className="text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
                  >
                    Delete
                  </button>
                </Form>
              </header>
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-stone-500">
                  <tr className="border-b border-stone-200">
                    <th className="text-left px-5 py-2 font-medium w-16">Rank</th>
                    <th className="text-left px-5 py-2 font-medium">Team</th>
                    <th className="text-right px-5 py-2 font-medium w-24">
                      Points
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr
                      key={`${r.rank}-${r.team_name}`}
                      className="border-b border-stone-100 last:border-0"
                    >
                      <td className="px-5 py-2.5 tabular-nums text-stone-600">
                        {r.rank}
                      </td>
                      <td className="px-5 py-2.5 font-medium">{r.team_name}</td>
                      <td className="px-5 py-2.5 text-right font-semibold tabular-nums">
                        {r.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 px-5 py-3">
                <span className="text-xs font-medium text-stone-600 mr-1">
                  Template
                </span>
                {STANDINGS_TEMPLATE_NAMES.map((nm, i) => (
                  <Form method="post" key={nm}>
                    <input
                      type="hidden"
                      name="intent"
                      value="set_snapshot_template"
                    />
                    <input type="hidden" name="after_n" value={s.afterN} />
                    <input type="hidden" name="template" value={i} />
                    <button
                      type="submit"
                      disabled={busy}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                        i === s.template
                          ? "border-stone-900 bg-stone-900 text-white"
                          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      {i === s.template ? "✓ " : ""}
                      {nm}
                    </button>
                  </Form>
                ))}
              </div>
              <StandingsShareCard
                key={`poster-${s.afterN}-${s.template}`}
                snapshot={s}
                templateIndex={s.template}
              />
            </section>
          ))
      )}
    </div>
  );
}

// ============================================================================
// Result entry modal
// ============================================================================
function ResultModal({
  editData,
}: {
  editData: EditData;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const busy = navigation.state !== "idle";

  const close = () => navigate("/admin", { preventScrollReset: true });

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock body scroll while modal open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const { program, level, result, winners, neighbors } = editData;
  const status = result?.status ?? "none";
  const winnersByPos = new Map<number, typeof winners[number]>();
  for (const w of winners) winnersByPos.set(w.position, w);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="result-modal-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        onClick={close}
        className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm"
        aria-label="Close"
      />

      {/* Panel — compact, centered, laptop-first */}
      <div className="relative w-full max-w-2xl max-h-[88dvh] bg-white rounded-xl shadow-2xl ring-1 ring-stone-200 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-stone-200 flex items-center gap-3">
          <span className="text-[10px] font-mono tracking-widest text-stone-400 shrink-0">
            {program.code}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="result-modal-title"
              className="text-base font-semibold tracking-tight truncate"
            >
              {program.name_en ?? program.name_ml}
            </h2>
          </div>
          <span
            lang="ml"
            className="hidden sm:inline text-[11px] text-stone-500 bg-stone-100 rounded px-2 py-0.5 shrink-0"
          >
            {level.name_ml}
          </span>
          <ProgramStatus status={status} />
          <button
            type="button"
            onClick={close}
            className="inline-flex items-center justify-center size-10 rounded-lg text-stone-500 hover:text-stone-800 hover:bg-stone-100 shrink-0"
            aria-label="Close"
          >
            <X className="size-6" strokeWidth={2.25} />
          </button>
        </div>

        {/* Single Form wraps body + footer so all inputs submit together */}
        <Form
          method="post"
          key={program.code}
          className="flex-1 min-h-0 flex flex-col"
        >
          <input type="hidden" name="program_code" value={program.code} />

          {/* Scrollable body */}
          <div className="flex-1 overflow-auto px-4 py-3 space-y-2.5">
            {/* Result number */}
            <div className="flex items-center gap-2.5">
              <label
                htmlFor="result_no"
                className="text-xs font-medium text-stone-600 shrink-0"
              >
                Result #
              </label>
              <input
                id="result_no"
                name="result_no"
                defaultValue={result?.result_no ?? ""}
                placeholder="030"
                inputMode="numeric"
                className="w-20 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm tabular-nums focus:outline-none focus:border-stone-400"
              />
            </div>

            {/* Column headers (laptop) */}
            <div className="hidden md:grid grid-cols-[3.25rem_minmax(0,1fr)_13rem] gap-2 px-1 text-[10px] font-medium uppercase tracking-wider text-stone-400">
              <span>Place</span>
              <span>Name</span>
              <span>Team</span>
            </div>

            {[1, 2, 3].map((pos) => {
              const w = winnersByPos.get(pos);
              const meta = POSITION_META[pos];
              const isFirst = pos === 1;
              return (
                <div
                  key={pos}
                  className={`grid items-center gap-2 grid-cols-1 md:grid-cols-[3.25rem_minmax(0,1fr)_13rem] rounded-lg border px-2.5 py-2 ${
                    isFirst
                      ? "border-amber-300 bg-amber-50/40"
                      : "border-stone-200"
                  }`}
                >
                  <span
                    className={`inline-flex items-center justify-center rounded-full text-[11px] font-semibold w-12 h-6 ${meta.tone}`}
                  >
                    {meta.ordinal}
                  </span>
                  <input
                    name={`winner_${pos}_name_en`}
                    required={isFirst}
                    autoFocus={isFirst && !winnersByPos.get(1)}
                    defaultValue={w?.name_en ?? w?.name_ml ?? ""}
                    placeholder={isFirst ? "Winner name" : "Name (optional)"}
                    className="w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:border-stone-400"
                  />
                  <select
                    name={`winner_${pos}_unit_ml`}
                    defaultValue={(w?.unit_ml ?? "").toLowerCase()}
                    className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:border-stone-400"
                  >
                    <option value="">Team —</option>
                    {TEAMS.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}

            {actionData && "error" in actionData && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {actionData.error}
              </p>
            )}
            {actionData && "ok" in actionData && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                ✓ Saved
              </p>
            )}

            {result && (
              <button
                type="submit"
                name="intent"
                value="delete_result"
                disabled={busy}
                onClick={(e) => {
                  if (!confirm("Delete this result? Winners will also be removed.")) {
                    e.preventDefault();
                  }
                }}
                className="text-xs text-red-600 hover:text-red-700 hover:underline"
              >
                Delete result
              </button>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-stone-200 px-4 py-2.5 flex items-center gap-2 bg-stone-50/60">
            {neighbors.prev ? (
              <Link
                to={`/admin?edit=${neighbors.prev.code}`}
                preventScrollReset
                className="text-xs text-stone-500 hover:text-stone-900"
              >
                ← {neighbors.prev.code}
              </Link>
            ) : (
              <span />
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="submit"
                name="intent"
                value="save_draft"
                disabled={busy}
                className="rounded-md border border-stone-300 hover:bg-white text-stone-700 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                Save draft
              </button>
              <button
                type="submit"
                name="intent"
                value="save_publish"
                disabled={busy}
                className="rounded-md bg-brand-700 hover:bg-brand-800 text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                {busy ? "…" : "Publish"}
              </button>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}

// ============================================================================
// Small subcomponents
// ============================================================================
const POSITION_META: Record<
  number,
  { label: string; ordinal: string; tone: string }
> = {
  1: { label: "First", ordinal: "1st", tone: "bg-amber-100 text-amber-800" },
  2: { label: "Second", ordinal: "2nd", tone: "bg-stone-200 text-stone-700" },
  3: { label: "Third", ordinal: "3rd", tone: "bg-orange-100 text-orange-800" },
};

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "brand" | "amber";
}) {
  const accentClass =
    accent === "brand"
      ? "text-brand-700"
      : accent === "amber"
      ? "text-amber-700"
      : "text-stone-900";
  return (
    <div className="rounded-xl bg-stone-50 px-3 py-2.5">
      <p className="text-[11px] tracking-widest text-stone-400 uppercase">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-0.5 ${accentClass}`}>{value}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// New dashboard primitives
// ─────────────────────────────────────────────────────────────────────

type EditWinner = {
  position: number;
  name_ml: string;
  name_en: string | null;
  unit_ml: string | null;
  marks: number | null;
  grade: string | null;
};

type EditData = {
  program: { code: string; name_ml: string; name_en: string | null };
  level: { code: string; name_ml: string };
  result: { id: string; status: string; result_no: string | null } | null;
  winners: EditWinner[];
  neighbors: {
    prev: { code: string; name_ml: string } | null;
    next: { code: string; name_ml: string } | null;
  };
};

type ProgramRow = {
  id: string;
  code: string;
  name_ml: string;
  name_en: string | null;
  level_id: string | null;
  sort_order: number;
  is_active: boolean;
  result: {
    id: string;
    status: string;
    result_no: string | null;
    topName: string | null;
    winners: EditWinner[];
  } | null;
};

/** Derive the edit-modal payload purely from already-loaded dashboard
 *  data — no network. Runs in a useMemo so opening the modal is instant. */
function buildEditData(
  code: string | null,
  levels: LevelRow[],
): EditData | null {
  if (!code) return null;
  let program: ProgramRow | undefined;
  let level: LevelRow | undefined;
  for (const l of levels) {
    const p = l.programs.find((pr) => pr.code === code);
    if (p) {
      program = p;
      level = l;
      break;
    }
  }
  if (!program || !level) return null;

  const r = program.result;

  const siblings = level.programs
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
  const idx = siblings.findIndex((s) => s.code === code);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next =
    idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;

  return {
    program: {
      code: program.code,
      name_ml: program.name_ml,
      name_en: program.name_en,
    },
    level: { code: level.code, name_ml: level.name_ml },
    result: r
      ? { id: r.id, status: r.status, result_no: r.result_no }
      : null,
    winners: r?.winners ?? [],
    neighbors: {
      prev: prev ? { code: prev.code, name_ml: prev.name_ml } : null,
      next: next ? { code: next.code, name_ml: next.name_ml } : null,
    },
  };
}
type LevelRow = {
  id: string;
  code: string;
  name_ml: string;
  sort_order: number;
  programs: ProgramRow[];
  total: number;
  published: number;
  drafts: number;
  pending: number;
  inactive: number;
};

// ============================================================================
// Share posters — guided stepper. Published results in result-number
// order; a team-standings snapshot is injected after every 5th result.
// ============================================================================
function levelLabelFromCode(code: string, fallback: string): string {
  if (!code) return fallback;
  return code
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

type ShareItem = {
  key: string;
  code: string;
  programName: string;
  data: PosterData;
};

function SharePostersView({
  levels,
  eventName,
}: {
  levels: LevelRow[];
  eventName: string;
}) {
  const items = useMemo<ShareItem[]>(() => {
    const pubs: { level: LevelRow; program: ProgramRow }[] = [];
    for (const l of levels) {
      for (const p of l.programs) {
        if (p.result?.status === "published") pubs.push({ level: l, program: p });
      }
    }
    const num = (s: string | null | undefined) => {
      const n = parseInt(String(s ?? "").trim(), 10);
      return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    pubs.sort(
      (a, b) =>
        num(a.program.result?.result_no) - num(b.program.result?.result_no) ||
        a.program.code.localeCompare(b.program.code),
    );

    const out: ShareItem[] = [];
    pubs.forEach(({ level, program }) => {
      const r = program.result!;
      const winners = [...r.winners]
        .filter((w) => w.position >= 1)
        .sort((a, b) => a.position - b.position)
        .map((w) => {
          const slug = w.unit_ml?.toLowerCase() ?? null;
          const unit = slug ? TEAM_BY_SLUG[slug]?.name ?? w.unit_ml : w.unit_ml;
          return { position: w.position, name: w.name_en ?? w.name_ml, unit };
        });
      // Skip the poster for <2-winner results — still published, they
      // count via the uploaded standings, just no poster.
      if (winners.length < 2) return;
      const programName = program.name_en ?? program.code;
      out.push({
        key: `r-${r.id}`,
        code: program.code,
        programName,
        data: {
          eventName,
          levelName: levelLabelFromCode(level.code, level.name_ml),
          programName,
          programCode: program.code,
          resultNo: r.result_no,
          winners,
        },
      });
    });
    return out;
  }, [levels, eventName]);

  const [idx, setIdx] = useState(0);
  const [tmplShift, setTmplShift] = useState(0);
  const [busy, setBusy] = useState<null | "download" | "share">(null);
  const stageRef = useRef<Konva.Stage | null>(null);

  const total = items.length;
  const clampedIdx = Math.min(idx, Math.max(total - 1, 0));
  const item = items[clampedIdx];

  const go = (d: number) => {
    setBusy(null);
    setIdx((i) => Math.min(Math.max(i + d, 0), total - 1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  if (total === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-10 text-center">
        <p className="text-sm text-stone-500">
          No shareable result posters yet. Publish results (2+ winners) to
          share their posters. Team-standings posters live in the Team
          standings tab.
        </p>
      </div>
    );
  }

  async function onDownload() {
    if (!item) return;
    setBusy("download");
    try {
      await exportPosterPng(stageRef.current, `${item.code}_poster.png`);
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    if (!item) return;
    setBusy("share");
    try {
      await sharePoster(stageRef.current, item.data);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      {/* Status */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-[11px] font-mono uppercase tracking-widest text-stone-400">
            {item?.code}
            {item?.data.resultNo ? ` · Result #${item.data.resultNo}` : ""} ·{" "}
            {clampedIdx + 1} of {total}
          </p>
          <p className="text-sm font-semibold truncate">
            {item?.programName}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-stone-400">
          {clampedIdx + 1} / {total}
        </span>
      </div>

      {/* Poster */}
      <div className="overflow-hidden rounded-xl ring-1 ring-stone-200 shadow-sm bg-white">
        {item && (
          <PosterCanvas
            key={item.key}
            data={item.data}
            templateIndex={(clampedIdx + tmplShift) % POSTER_TEMPLATE_COUNT}
            stageRef={stageRef}
          />
        )}
      </div>

      {/* Controls */}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={clampedIdx === 0}
          className="inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 disabled:opacity-40 hover:bg-stone-50"
        >
          <ChevronLeft className="size-4" /> Prev
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={clampedIdx >= total - 1}
          className="inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 disabled:opacity-40 hover:bg-stone-50"
        >
          Next <ChevronRight className="size-4" />
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTmplShift((s) => s + 1)}
            aria-label="Shuffle template"
            title="Shuffle template"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
          >
            <Shuffle className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 disabled:opacity-50 hover:bg-stone-50"
          >
            <Download className="size-4" />
            {busy === "download" ? "…" : "Download"}
          </button>
          <button
            type="button"
            onClick={onShare}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 hover:bg-stone-800"
          >
            <Share2 className="size-4" />
            {busy === "share" ? "…" : "Share"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-stone-400">
        Result posters only, in result-number order. Use ← → keys to move.
        Team-standings posters are in the Team standings tab.
      </p>
    </div>
  );
}

function NavItem({
  active = false,
  label,
  icon,
  href,
  to,
  external,
}: {
  active?: boolean;
  label: string;
  icon: ReactNode;
  href?: string;
  to?: string;
  external?: boolean;
}) {
  const cls = `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
    active
      ? "bg-yellow text-black"
      : "text-white/80 hover:bg-white/10 hover:text-white"
  }`;
  if (to) {
    return (
      <Link to={to} className={cls}>
        <span className="size-4 shrink-0">{icon}</span>
        <span className="flex-1">{label}</span>
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target={external ? "_blank" : undefined} rel="noreferrer" className={cls}>
        <span className="size-4 shrink-0">{icon}</span>
        <span className="flex-1">{label}</span>
        {external && <ExternalLink className="size-3 text-white/50" aria-hidden />}
      </a>
    );
  }
  return (
    <div className={cls}>
      <span className="size-4 shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-stone-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search programs by code or name…"
        className="w-full rounded-lg border border-stone-300 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow focus:border-yellow"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "black" | "yellow" | "muted" | "red";
  icon: ReactNode;
}) {
  const toneCls =
    tone === "black"
      ? "border-black bg-black text-white"
      : tone === "yellow"
      ? "border-yellow bg-yellow text-black"
      : tone === "red"
      ? "border-red-200 bg-red-50 text-red-900"
      : "border-stone-200 bg-white text-black";
  const iconWrap =
    tone === "black"
      ? "bg-white/15 text-white"
      : tone === "yellow"
      ? "bg-black/10 text-black"
      : tone === "red"
      ? "bg-red-100 text-red-700"
      : "bg-stone-100 text-stone-600";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneCls}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wider uppercase opacity-80">
          {label}
        </p>
        <span className={`size-7 grid place-items-center rounded-md ${iconWrap}`}>
          <span className="size-4">{icon}</span>
        </span>
      </div>
      <p className="text-3xl font-semibold tabular-nums mt-1.5 leading-none">
        {value}
      </p>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium border transition ${
        active
          ? "bg-black text-white border-black"
          : "bg-white text-stone-700 border-stone-300 hover:border-black"
      }`}
    >
      {children}
    </button>
  );
}

function CategoryCard({ level }: { level: LevelRow }) {
  const pct = level.total === 0 ? 0 : Math.round((level.published / level.total) * 100);
  return (
    <article className="rounded-xl border border-stone-200 bg-white overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-stone-100 bg-stone-50">
        <div className="flex items-center justify-between gap-2">
          <p lang="ml" className="font-semibold text-sm truncate">
            {level.name_ml}
          </p>
          <span className="text-[10px] tabular-nums text-stone-500 shrink-0">
            {level.published}/{level.total}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-stone-200 overflow-hidden">
          <div className="h-full bg-yellow transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-stone-500">
          {level.drafts > 0 && <span>{level.drafts} draft</span>}
          {level.pending > 0 && <span>{level.pending} pending</span>}
          {level.inactive > 0 && <span className="text-red-700">{level.inactive} inactive</span>}
        </div>
      </header>

      <ul className="divide-y divide-stone-100 max-h-[420px] overflow-y-auto">
        {level.programs.map((p) => (
          <li key={p.id} className="group">
            <ProgramListItem program={p} />
          </li>
        ))}
      </ul>
    </article>
  );
}

function ProgramListItem({ program: p }: { program: ProgramRow }) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 hover:bg-yellow/10 ${p.is_active ? "" : "opacity-60"}`}>
      <Link
        to={`/admin?edit=${p.code}`}
        preventScrollReset
        className="flex items-center gap-3 min-w-0 flex-1"
      >
        <span className="text-[10px] font-mono text-stone-400 tabular-nums w-10 shrink-0">
          {p.code}
        </span>
        <div className="min-w-0 flex-1">
          <p lang="ml" className="text-sm font-medium truncate">
            {p.name_ml}
          </p>
          {p.result?.topName && p.result.status === "published" && (
            <p lang="ml" className="text-[11px] text-stone-500 truncate">
              🥇 {p.result.topName}
            </p>
          )}
        </div>
        <ProgramStatus status={p.is_active ? p.result?.status ?? "none" : "inactive"} />
      </Link>
      <Form method="post" className="shrink-0">
        <input type="hidden" name="program_code" value={p.code} />
        <button
          type="submit"
          name="intent"
          value="toggle_active"
          title={p.is_active ? "Deactivate program" : "Activate program"}
          aria-label={p.is_active ? "Deactivate program" : "Activate program"}
          className={`cursor-pointer size-7 grid place-items-center rounded-md border transition ${
            p.is_active
              ? "border-stone-300 text-stone-500 hover:border-red-500 hover:bg-red-50 hover:text-red-700"
              : "border-yellow bg-yellow text-black hover:bg-yellow/80"
          }`}
          onClick={(e) => {
            if (
              p.is_active &&
              !confirm(
                `Deactivate "${p.name_ml}"? This program (and any result) will be hidden from public results.`,
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          {p.is_active ? (
            <Ban className="size-4" strokeWidth={2.25} />
          ) : (
            <Check className="size-4" strokeWidth={2.5} />
          )}
        </button>
      </Form>
    </div>
  );
}


function StatusBadge({ published }: { published: boolean }) {
  return published ? (
    <span className="inline-flex items-center gap-1.5 text-emerald-700">
      <span className="size-1.5 rounded-full bg-emerald-600" /> Published
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-amber-700">
      <span className="size-1.5 rounded-full bg-amber-500" /> Draft
    </span>
  );
}

function ProgramStatus({ status }: { status: string }) {
  if (status === "published") {
    return (
      <span className="text-[10px] font-semibold tracking-wider uppercase text-black bg-yellow rounded-full px-2 py-0.5">
        Live
      </span>
    );
  }
  if (status === "draft") {
    return (
      <span className="text-[10px] font-semibold tracking-wider uppercase text-yellow bg-black rounded-full px-2 py-0.5">
        Draft
      </span>
    );
  }
  if (status === "inactive") {
    return (
      <span className="text-[10px] font-semibold tracking-wider uppercase text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
        Inactive
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold tracking-wider uppercase text-stone-600 bg-stone-100 border border-stone-200 rounded-full px-2 py-0.5">
      + Add
    </span>
  );
}
