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
  Images,
  Shuffle,
  Trophy,
  Upload,
  X,
} from "lucide-react";
import type Konva from "konva";
import type { Route } from "./+types/admin";
import {
  loadTenantEvent,
  requireAdmin,
  siteUrlFromRequest,
} from "~/lib/supabase.server";
import {
  POSTER_FONTS_EN,
  POSTER_FONTS_ML,
  PosterCanvas,
  eventTemplateList,
  exportPosterPng,
  pickFromList,
  posterFontStack,
  sharePoster,
  type CustomTpl,
  type ElOverride,
  type LayoutEl,
  type PosterData,
  type PosterLayoutMap,
  type TemplateChoice,
  type TemplateOverride,
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

// ── Results CSV parsing ──────────────────────────────────────────────
// Header: Competition,Category,Rank,Chest Number,Participant,Team,Points,Grade
// One file may hold one program or many; rows are grouped downstream by
// (Competition, Category). Column order is read from the header row
// (case-insensitive); falls back to the documented order if absent.
export type ResultsCsvRow = {
  competition: string;
  category: string;
  rank: number;
  participant: string;
  team: string | null;
  points: number | null;
  grade: string | null;
};

const RESULTS_HEADER_KEYS = [
  "competition",
  "category",
  "rank",
  "chest number",
  "participant",
  "team",
  "points",
  "grade",
] as const;

export function parseResultsCsv(text: string): {
  rows: ResultsCsvRow[];
  skipped: string[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { rows: [], skipped: [] };

  let idx: Record<string, number> = {
    competition: 0,
    category: 1,
    rank: 2,
    "chest number": 3,
    participant: 4,
    team: 5,
    points: 6,
    grade: 7,
  };
  let start = 0;
  const head = csvCells(lines[0]).map((c) => c.toLowerCase());
  if (head.some((c) => c === "competition" || c === "rank" || c === "participant")) {
    const m: Record<string, number> = {};
    head.forEach((c, i) => {
      if ((RESULTS_HEADER_KEYS as readonly string[]).includes(c)) m[c] = i;
    });
    if (m.competition !== undefined && m.rank !== undefined && m.participant !== undefined) {
      idx = { ...idx, ...m };
    }
    start = 1;
  }

  const rows: ResultsCsvRow[] = [];
  const skipped: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = csvCells(lines[i]);
    const competition = (c[idx.competition] ?? "").trim();
    const category = (c[idx.category] ?? "").trim();
    const participant = (c[idx.participant] ?? "").trim();
    const rank = parseInt((c[idx.rank] ?? "").trim(), 10);
    if (!competition || !participant || !Number.isFinite(rank)) {
      // A non-blank data line we couldn't parse — never silently drop
      // it; surface it so the operator sees exactly what was ignored.
      skipped.push(lines[i]);
      continue;
    }
    const pointsCell = (c[idx.points] ?? "").trim();
    const pointsNum = Number(pointsCell);
    rows.push({
      competition,
      category,
      rank,
      participant,
      team: (c[idx.team] ?? "").trim() || null,
      points: pointsCell !== "" && Number.isFinite(pointsNum) ? pointsNum : null,
      grade: (c[idx.grade] ?? "").trim().toUpperCase() || null,
    });
  }
  return { rows, skipped };
}

/** Match key: case/whitespace-insensitive; keeps the "(girls)" qualifier
 *  so girls variants stay distinct (see project girls-category note). */
function normMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Category text → level.code slug, e.g. "Higher Secondary" →
 *  "higher-secondary" (level codes are the English slugs). */
function categorySlug(s: string): string {
  return s.toLowerCase().trim().replace(/[\s_]+/g, "-");
}

// ============================================================================
// Loader
// ============================================================================
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers, user, profile } = await requireAdmin(request);
  const event = await loadTenantEvent(request, supabase);
  // Defense in depth: RLS already isolates orgs, but make the
  // signed-in admin's org match the tenant resolved from the host so a
  // pantharangadi admin can't drive another sector's subdomain.
  if (profile.organization_id !== event.organization_id) {
    throw new Response(
      "Your admin account belongs to a different sector. Sign in on your own sector’s address.",
      { status: 403, headers: Object.fromEntries(headers) },
    );
  }
  const siteUrl = siteUrlFromRequest(request);

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
      siteUrl,
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
  const { supabase, headers, user, profile } = await requireAdmin(request);
  const event = await loadTenantEvent(request, supabase);
  if (profile.organization_id !== event.organization_id) {
    throw new Response(
      "Your admin account belongs to a different sector.",
      { status: 403, headers: Object.fromEntries(headers) },
    );
  }
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

  if (intent === "save_poster_settings") {
    const tplRaw = parseInt(String(fd.get("result_template") ?? "0"), 10);
    const result_template =
      Number.isFinite(tplRaw) && tplRaw >= 0 ? tplRaw : 0;
    const txt = (k: string) => {
      const v = String(fd.get(k) ?? "").trim();
      return v.length ? v : null;
    };
    const poster_lang =
      String(fd.get("poster_lang") ?? "") === "ml" ? "ml" : "en";
    const pickFont = (k: string, list: readonly string[]) => {
      const v = String(fd.get(k) ?? "");
      return list.includes(v) ? v : null;
    };
    const { error } = await supabase
      .from("events")
      .update({
        result_template,
        result_template_id: txt("result_template_id"),
        poster_lang,
        poster_font_en: pickFont("poster_font_en", POSTER_FONTS_EN),
        poster_font_ml: pickFont("poster_font_ml", POSTER_FONTS_ML),
        poster_name: txt("poster_name"),
        poster_date: txt("poster_date"),
        poster_time: txt("poster_time"),
        poster_place: txt("poster_place"),
      })
      .eq("id", event.id);
    if (error)
      return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data(
      { ok: true, message: "Poster settings saved." },
      { headers: Object.fromEntries(headers) },
    );
  }

  if (intent === "save_poster_layout") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(fd.get("poster_layout") ?? "null"));
    } catch {
      return data(
        { error: "Invalid layout payload." },
        { headers: Object.fromEntries(headers) },
      );
    }
    const layout =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    const { error } = await supabase
      .from("events")
      .update({ poster_layout: layout })
      .eq("id", event.id);
    if (error)
      return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data(
      { ok: true, message: "Poster layout saved." },
      { headers: Object.fromEntries(headers) },
    );
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

  if (intent === "upload_results") {
    const publish = String(fd.get("publish") ?? "") === "on";
    const { rows, skipped } = parseResultsCsv(String(fd.get("csv") ?? ""));
    if (rows.length === 0) {
      return data(
        {
          error:
            "No valid rows. Expected: Competition,Category,Rank,Chest Number,Participant,Team,Points,Grade",
          report: skipped.map((l) => `✗ unparseable row: ${l}`),
        },
        { headers: Object.fromEntries(headers) },
      );
    }

    const [{ data: levelsData }, { data: programsData }] = await Promise.all([
      supabase.from("levels").select("id, code, name_ml").eq("event_id", event.id),
      supabase
        .from("programs")
        .select("id, code, name_en, name_ml, level_id")
        .eq("event_id", event.id),
    ]);

    const levelByKey = new Map<string, string>();
    for (const l of levelsData ?? []) {
      levelByKey.set(categorySlug(l.code), l.id);
      if (l.name_ml) levelByKey.set(normMatch(l.name_ml), l.id);
    }
    // (normalized name | level_id) → matching program(s)
    const progByKey = new Map<
      string,
      { id: string; code: string; level_id: string }[]
    >();
    for (const p of programsData ?? []) {
      if (!p.level_id) continue;
      const rec = { id: p.id, code: p.code, level_id: p.level_id };
      for (const nm of [p.name_en, p.name_ml]) {
        if (!nm) continue;
        const k = `${normMatch(nm)}|${p.level_id}`;
        progByKey.set(k, [...(progByKey.get(k) ?? []), rec]);
      }
    }

    type Group = { competition: string; category: string; rows: ResultsCsvRow[] };
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const key = `${normMatch(r.competition)}␟${normMatch(r.category)}`;
      const g =
        groups.get(key) ??
        (groups
          .set(key, { competition: r.competition, category: r.category, rows: [] })
          .get(key) as Group);
      g.rows.push(r);
    }

    // Surface unparseable rows up front — never silently dropped.
    const report: string[] = skipped.map((l) => `✗ unparseable row: ${l}`);
    let okCount = 0;
    let winnerCount = 0;

    for (const g of groups.values()) {
      const tag = `${g.competition} · ${g.category}`;
      const levelId =
        levelByKey.get(categorySlug(g.category)) ??
        levelByKey.get(normMatch(g.category));
      if (!levelId) {
        report.push(`✗ ${tag}: unknown category (no matching level)`);
        continue;
      }
      const cands = progByKey.get(`${normMatch(g.competition)}|${levelId}`) ?? [];
      if (cands.length === 0) {
        report.push(`✗ ${tag}: no program “${g.competition}” in that category`);
        continue;
      }
      if (cands.length > 1) {
        report.push(`✗ ${tag}: ambiguous — ${cands.length} programs match`);
        continue;
      }
      const program = cands[0];

      // Rank 1-3 → podium position; rank ≥4 with points → position 0
      // (extra team-points, never publicly shown). Rest skipped.
      const winners = g.rows
        .map((r) => {
          let position: number | null = null;
          if (r.rank >= 1 && r.rank <= 3) position = r.rank;
          else if (r.rank >= 4 && (r.points ?? 0) > 0) position = 0;
          if (position === null) return null;
          const name = titleCaseName(r.participant);
          return {
            position,
            name_ml: name,
            name_en: name,
            unit_ml: r.team,
            marks: r.points,
            grade: r.grade,
            sort_order: r.rank,
          };
        })
        .filter((w): w is NonNullable<typeof w> => w !== null);

      if (winners.length === 0) {
        report.push(`✗ ${tag}: no usable rows (need rank 1-3, or rank ≥4 with points)`);
        continue;
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
        result_no: null as string | null,
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
        if (uErr) {
          report.push(`✗ ${tag}: ${uErr.message}`);
          continue;
        }
        resultId = existing.id;
        await supabase.from("result_winners").delete().eq("result_id", resultId);
      } else {
        const { data: created, error: iErr } = await supabase
          .from("results")
          .insert({ ...baseFields, created_by: user.id })
          .select("id")
          .single();
        if (iErr || !created) {
          report.push(`✗ ${tag}: ${iErr?.message ?? "insert failed"}`);
          continue;
        }
        resultId = created.id;
      }
      const { error: wErr } = await supabase
        .from("result_winners")
        .insert(winners.map((w) => ({ result_id: resultId, ...w })));
      if (wErr) {
        report.push(`✗ ${tag}: ${wErr.message}`);
        continue;
      }

      okCount++;
      winnerCount += winners.length;
      report.push(`✓ ${program.code} ${tag}: ${winners.length} winners`);
    }

    const issues = report.filter((r) => r.startsWith("✗")).length;
    const message = `Imported ${okCount} result${okCount === 1 ? "" : "s"} (${winnerCount} winners)${
      issues ? ` · ${issues} issue${issues === 1 ? "" : "s"} (see below)` : ""
    } · ${publish ? "published" : "saved as draft"}`;
    return data(
      okCount === 0 ? { error: message, report } : { ok: true, message, report },
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
    if (file.size > 1024 * 1024) {
      return data(
        {
          error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — keep it under 1 MB (compress or export at a lower scale).`,
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

  if (intent === "upload_template") {
    const file = fd.get("template_file");
    const name = String(fd.get("template_name") ?? "").trim() || "Custom";
    if (!(file instanceof File) || file.size === 0) {
      return data(
        { error: "Choose an image file to upload." },
        { headers: Object.fromEntries(headers) },
      );
    }
    if (!file.type.startsWith("image/")) {
      return data(
        { error: "That's not an image — upload a PNG, JPG or WebP." },
        { headers: Object.fromEntries(headers) },
      );
    }
    if (file.size > 1024 * 1024) {
      return data(
        {
          error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — keep custom templates under 1 MB.`,
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
    const id = crypto.randomUUID();
    const path = `templates/${event.id}/${id}.${ext}`;
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
    const src = `${publicUrl}?v=${Date.now()}`;
    const ev = event as { custom_templates?: CustomTpl[] | null };
    const existing = Array.isArray(ev.custom_templates)
      ? ev.custom_templates
      : [];
    const { error: updErr } = await supabase
      .from("events")
      .update({ custom_templates: [...existing, { id, name, src }] })
      .eq("id", event.id);
    if (updErr)
      return data({ error: updErr.message }, { headers: Object.fromEntries(headers) });
    return data(
      {
        ok: true,
        message: `Template "${name}" uploaded — position the text in the editor below, then Save layout.`,
      },
      { headers: Object.fromEntries(headers) },
    );
  }

  if (intent === "delete_template") {
    const id = String(fd.get("template_id") ?? "");
    const ev = event as {
      custom_templates?: CustomTpl[] | null;
      result_template_id?: string | null;
    };
    const existing = Array.isArray(ev.custom_templates)
      ? ev.custom_templates
      : [];
    const target = existing.find((t) => t.id === id);
    if (target?.src) {
      try {
        const p = new URL(target.src).pathname;
        const m = "/object/public/posters/";
        const i = p.indexOf(m);
        if (i >= 0)
          await supabase.storage
            .from("posters")
            .remove([decodeURIComponent(p.slice(i + m.length))]);
      } catch {
        /* best-effort; metadata removal below is what matters */
      }
    }
    const patch: Record<string, unknown> = {
      custom_templates: existing.filter((t) => t.id !== id),
    };
    if (ev.result_template_id === id) patch.result_template_id = null;
    const { error } = await supabase
      .from("events")
      .update(patch)
      .eq("id", event.id);
    if (error)
      return data({ error: error.message }, { headers: Object.fromEntries(headers) });
    return data(
      { ok: true, message: "Template deleted." },
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
    siteUrl,
    levels,
    stats,
    publishedWinners,
    standings,
    standingsTemplate,
  } = loaderData;
  const orgName = (profile.organizations as { name?: string } | null)?.name ?? "";
  const eventName = event.name_ml ?? event.name;
  const evRel = event as {
    result_template?: number;
    result_template_id?: string | null;
    custom_templates?: CustomTpl[] | null;
    poster_lang?: string | null;
    poster_name?: string | null;
    poster_font_en?: string | null;
    poster_font_ml?: string | null;
    poster_layout?: PosterLayoutMap | null;
    poster_date?: string | null;
    poster_time?: string | null;
    poster_place?: string | null;
    organizations?: { name?: string; subdomain?: string } | null;
  };
  const posterMeta: PosterMeta = {
    subdomain: evRel.organizations?.subdomain ?? "",
    defaultTemplate: evRel.result_template ?? 0,
    defaultTemplateId: evRel.result_template_id ?? null,
    customTemplates: Array.isArray(evRel.custom_templates)
      ? evRel.custom_templates
      : [],
    lang: evRel.poster_lang === "ml" ? "ml" : "en",
    fontEn: evRel.poster_font_en ?? null,
    fontMl: evRel.poster_font_ml ?? null,
    layout: evRel.poster_layout ?? null,
    orgName: evRel.poster_name?.trim() || evRel.organizations?.name || "",
    posterDate: evRel.poster_date ?? null,
    posterTime: evRel.poster_time ?? null,
    posterPlace: evRel.poster_place ?? null,
  };
  // Units already seen this event — powers the result-modal datalist so
  // admins reuse exact names instead of typo-splitting standings.
  const knownUnits = useMemo(
    () =>
      [
        ...new Set(
          publishedWinners
            .map((w) => w.unit_ml?.trim())
            .filter((u): u is string => !!u),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [publishedWinners],
  );
  const isPublished = event.status === "published";

  const [searchParams] = useSearchParams();
  const view = (searchParams.get("view") ?? "dashboard") as
    | "dashboard"
    | "standings"
    | "share"
    | "import"
    | "templates";

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
        {/* Identity + the highest-stakes control: event status */}
        <div className="px-5 pt-5 pb-4 border-b border-white/10">
          <p className="text-[10px] font-bold tracking-[0.3em] uppercase text-yellow leading-none">
            Sahityotsav
          </p>
          <p className="font-[Fraunces,serif] text-lg leading-tight mt-2 truncate">
            {orgName}
          </p>
          <p lang="ml" className="text-xs text-white/55 mt-0.5 truncate">
            {eventName}
          </p>
          <Form method="post" className="mt-3">
            <button
              type="submit"
              name="intent"
              value="toggle_publish"
              className={`w-full flex items-center justify-center gap-2 rounded-lg text-xs font-semibold px-3 py-2 transition ${
                isPublished
                  ? "bg-white/10 text-white hover:bg-white/15"
                  : "bg-yellow text-black hover:bg-yellow/90"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  isPublished ? "bg-yellow" : "bg-black"
                }`}
              />
              {isPublished ? "Live — tap to unpublish" : "Publish event"}
            </button>
          </Form>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          <div className="space-y-1">
            <p className="px-3 pb-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-white/35">
              Manage
            </p>
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
              active={view === "import"}
              label="Import results"
              icon={<Upload className="size-4" />}
              to="/admin?view=import"
            />
          </div>
          <div className="space-y-1">
            <p className="px-3 pb-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-white/35">
              Posters
            </p>
            <NavItem
              active={view === "templates"}
              label="Poster templates"
              icon={<Images className="size-4" />}
              to="/admin?view=templates"
            />
            <NavItem
              active={view === "share"}
              label="Share posters"
              icon={<Share2 className="size-4" />}
              to="/admin?view=share"
            />
          </div>
          <NavItem
            label="Public site"
            icon={<ExternalLink className="size-4" />}
            href="/"
            external
          />
        </nav>

        <div className="p-3 border-t border-white/10">
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value="logout"
              className="w-full text-left px-3 py-2 rounded-lg text-xs text-white/55 hover:bg-white/10 hover:text-white truncate"
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
            <div className="min-w-0">
              <h1 className="font-[Fraunces,serif] text-xl leading-none tracking-tight truncate">
                {view === "standings"
                  ? "Team standings"
                  : view === "share"
                  ? "Share posters"
                  : view === "import"
                  ? "Import results"
                  : view === "templates"
                  ? "Poster templates"
                  : "Dashboard"}
              </h1>
              <p className="text-[11px] text-stone-500 mt-1 truncate">
                <span lang="ml">{eventName}</span>{" "}
                ·{" "}
                {isPublished ? (
                  <span className="font-medium text-emerald-700">Live</span>
                ) : (
                  <span className="font-medium text-amber-700">Draft</span>
                )}{" "}
                · {stats.totalPrograms} programs
                {view === "dashboard" && query
                  ? ` · ${matchCount} match${matchCount === 1 ? "" : "es"}`
                  : ""}
              </p>
            </div>

            {view === "dashboard" && (
              <div className="flex-1 max-w-sm ml-auto">
                <SearchInput value={query} onChange={setQuery} />
              </div>
            )}
          </div>
          {!isPublished && (
            <div className="px-4 lg:px-8 py-1.5 bg-amber-50 border-t border-amber-100 text-[11px] text-amber-800">
              Draft mode — public results stay hidden until you publish the
              event.
            </div>
          )}
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
              siteUrl={siteUrl}
              posterMeta={posterMeta}
            />
          )}
          {view === "import" && <ImportResultsView />}
          {view === "templates" && (
            <TemplateStudioView
              // Remount (re-seed all editor state + previews) only when the
              // persisted poster settings actually change — i.e. after a
              // successful save + loader revalidation. Typing/dragging
              // (no save) keeps the key stable, so edits aren't lost.
              key={JSON.stringify({
                d: posterMeta.defaultTemplate,
                l: posterMeta.lang,
                fe: posterMeta.fontEn,
                fm: posterMeta.fontMl,
                n: posterMeta.orgName,
                dt: posterMeta.posterDate,
                p: posterMeta.posterPlace,
                ly: posterMeta.layout,
              })}
              posterMeta={posterMeta}
              siteUrl={siteUrl}
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
            />
          )}
        </main>
      </div>

      {editData && (
        <ResultModal
          key={editData.program.code}
          editData={editData}
          knownUnits={knownUnits}
          levels={levels as LevelRow[]}
        />
      )}
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
}) {
  return (
    <>
      {/* Metric strip — also the primary filter */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Programs"
          value={stats.totalPrograms}
          accent="ink"
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        />
        <StatCard
          label="Published"
          value={stats.totalPublished}
          accent="live"
          active={statusFilter === "published"}
          onClick={() => setStatusFilter("published")}
        />
        <StatCard
          label="Pending"
          value={stats.totalPending}
          accent="muted"
          active={statusFilter === "pending"}
          onClick={() => setStatusFilter("pending")}
        />
        <StatCard
          label="Inactive"
          value={stats.totalInactive}
          accent="alert"
          active={statusFilter === "inactive"}
          onClick={() => {
            setStatusFilter("inactive");
            setShowInactive(true);
          }}
        />
      </section>

      {/* Secondary filters — drafts + inactive visibility */}
      <section className="flex flex-wrap items-center gap-2">
        <FilterChip
          active={statusFilter === "draft"}
          onClick={() => setStatusFilter("draft")}
        >
          Drafts · {stats.totalDrafts}
        </FilterChip>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-yellow cursor-pointer"
          />
          Show inactive
        </label>
      </section>

      {/* Level sections — single scroll, collapsible, no nested panes */}
      <section className="space-y-3">
        {filteredLevels.map((l) => (
          <CategoryCard key={l.id} level={l} />
        ))}
        {filteredLevels.length === 0 && (
          <div className="rounded-xl border border-stone-200 bg-white px-6 py-14 text-center">
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

function ImportResultsView() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [csv, setCsv] = useState("");

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const report =
    actionData && "report" in actionData
      ? (actionData.report as string[])
      : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Import results from CSV
        </h2>
        <p className="text-xs text-stone-500 mt-1">
          Paste or upload the official export. Header:
          <code className="mx-1 rounded bg-stone-100 px-1.5 py-0.5">
            Competition,Category,Rank,Chest Number,Participant,Team,Points,Grade
          </code>
          One file may hold one program or many — rows are grouped by
          Competition + Category. Competition is matched to a program by
          its English name within the matching category; ranks 1-3 become
          the podium, rank&nbsp;≥4 with points are stored as hidden
          team-points. Re-importing a competition replaces its result.
          Unmatched rows are reported, never silently dropped.
        </p>

        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="upload_results" />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={onPickFile}
                className="sr-only"
              />
              Choose .csv file
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                name="publish"
                className="size-4 rounded border-stone-300"
              />
              Publish immediately (otherwise saved as draft)
            </label>
          </div>
          <textarea
            name="csv"
            required
            rows={10}
            spellCheck={false}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={
              "Competition,Category,Rank,Chest Number,Participant,Team,Points,Grade\nElocution,Senior,1,A-12,Ayisha,Anithara,18,A\nElocution,Senior,2,B-07,Hana,Cheerpingal,15,A"
            }
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed focus:outline-none focus:border-stone-400"
          />
          {actionData && "error" in actionData && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {actionData.error}
            </p>
          )}
          {actionData && "ok" in actionData && "message" in actionData && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
              {actionData.message as string}
            </p>
          )}
          {report && report.length > 0 && (
            <ul className="mt-1 max-h-72 overflow-y-auto rounded-md border border-stone-200 bg-stone-50 p-3 space-y-1 font-mono text-[11px] leading-relaxed">
              {report.map((line, i) => (
                <li
                  key={i}
                  className={
                    line.startsWith("✗") ? "text-red-700" : "text-emerald-700"
                  }
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {busy ? "Importing…" : "Import results"}
          </button>
        </Form>
      </section>
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
  knownUnits = [],
  levels,
}: {
  editData: EditData;
  knownUnits?: string[];
  levels: LevelRow[];
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

  const { program, level, result, winners, nextResultNo } = editData;
  const status = result?.status ?? "none";
  const byPos = new Map<number, EditWinner>();
  for (const w of winners) byPos.set(w.position, w);
  const seed = (pos: number) => {
    const w = byPos.get(pos);
    return { name: w?.name_en ?? w?.name_ml ?? "", unit: w?.unit_ml ?? "" };
  };

  const [w1, setW1] = useState(() => seed(1));
  const [w2, setW2] = useState(() => seed(2));
  const [w3, setW3] = useState(() => seed(3));
  const setters = { 1: setW1, 2: setW2, 3: setW3 };
  const values = { 1: w1, 2: w2, 3: w3 };
  const [resultNo, setResultNo] = useState(
    result?.result_no ?? String(nextResultNo),
  );

  const [csvOpen, setCsvOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [csvNote, setCsvNote] = useState<string | null>(null);
  function fillFrom(text: string) {
    const { rows } = parseResultsCsv(text);
    let filled = 0;
    for (const pos of [1, 2, 3] as const) {
      const r = rows.find((x) => x.rank === pos);
      if (r) {
        setters[pos]({ name: titleCaseName(r.participant), unit: r.team ?? "" });
        filled++;
      }
    }
    setCsvNote(
      filled
        ? `Filled ${filled} winner${filled === 1 ? "" : "s"} — review, then save.`
        : "No rank 1–3 rows found in that CSV.",
    );
  }
  const onPickCsvFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const t = String(reader.result ?? "");
      setCsv(t);
      fillFrom(t);
      setCsvOpen(true);
    };
    reader.readAsText(f);
  };

  // Program / level navigator — jump anywhere without closing.
  const sortProg = (a: ProgramRow, b: ProgramRow) =>
    a.sort_order - b.sort_order || a.code.localeCompare(b.code);
  const curLevel = levels.find((l) => l.code === level.code) ?? null;
  const levelPrograms = (curLevel?.programs ?? []).slice().sort(sortProg);
  const goTo = (code: string) =>
    navigate(`/admin?edit=${code}`, { preventScrollReset: true });
  const onLevelChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const l = levels.find((x) => x.code === e.target.value);
    const first = l?.programs.slice().sort(sortProg)[0];
    if (first) goTo(first.code);
  };

  const inputCls =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-[15px] text-stone-900 placeholder:text-stone-400 transition focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="result-modal-title"
    >
      <button
        type="button"
        onClick={close}
        className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm"
        aria-label="Close"
      />

      <div className="relative w-full max-w-2xl max-h-[90dvh] bg-white rounded-2xl shadow-2xl ring-1 ring-stone-200 overflow-hidden flex flex-col">
        {/* Header — context + level/program selectors (jump anywhere) */}
        <div className="px-5 py-4 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tracking-widest text-stone-400">
              {program.code}
            </span>
            <ProgramStatus status={status} />
            <button
              type="button"
              onClick={close}
              className="ml-auto size-9 grid place-items-center rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100"
              aria-label="Close"
            >
              <X className="size-5" strokeWidth={2.25} />
            </button>
          </div>
          <h2
            id="result-modal-title"
            className="font-[Fraunces,serif] text-2xl leading-tight tracking-tight mt-2 truncate"
          >
            {program.name_en ?? program.name_ml}
          </h2>
          <p lang="ml" className="text-sm text-stone-500 truncate">
            {program.name_ml}
          </p>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Category / level
              </span>
              <select
                value={level.code}
                onChange={onLevelChange}
                lang="ml"
                className={`${inputCls} py-2`}
              >
                {levels.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name_ml}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Program
              </span>
              <select
                value={program.code}
                onChange={(e) => goTo(e.target.value)}
                lang="ml"
                className={`${inputCls} py-2`}
              >
                {levelPrograms.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {p.name_ml}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <Form method="post" className="flex-1 min-h-0 flex flex-col">
          <input type="hidden" name="program_code" value={program.code} />

          <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
            {/* Winners — primary section. Result # is a compact inline
                field in the header, not a wasted standalone row. */}
            <section className="rounded-xl border border-stone-200">
              <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-3 py-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  Winners
                </h3>
                <label className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-stone-500">
                    Result&nbsp;#
                  </span>
                  <input
                    id="result_no"
                    name="result_no"
                    value={resultNo}
                    onChange={(e) => setResultNo(e.target.value)}
                    placeholder="30"
                    inputMode="numeric"
                    className="w-14 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm tabular-nums text-center focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25"
                  />
                  {!result && (
                    <span className="text-[10px] text-stone-400">auto</span>
                  )}
                </label>
              </div>
              <div className="p-3 space-y-2.5">
                <div className="hidden sm:grid grid-cols-[3rem_minmax(0,1fr)_12rem] gap-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                  <span>Place</span>
                  <span>Name</span>
                  <span>Team / unit</span>
                </div>
              {[1, 2, 3].map((pos) => {
                const meta = POSITION_META[pos];
                const v = values[pos as 1 | 2 | 3];
                const set = setters[pos as 1 | 2 | 3];
                const isFirst = pos === 1;
                return (
                  <div
                    key={pos}
                    className="grid grid-cols-1 sm:grid-cols-[3rem_minmax(0,1fr)_12rem] sm:items-center gap-2"
                  >
                    <span
                      className={`inline-flex items-center justify-center rounded-full text-[11px] font-semibold w-12 h-6 ${meta.tone}`}
                    >
                      {meta.ordinal}
                    </span>
                    <input
                      name={`winner_${pos}_name_en`}
                      required={isFirst}
                      autoFocus={isFirst && !byPos.get(1)}
                      value={v.name}
                      onChange={(e) =>
                        set((s) => ({ ...s, name: e.target.value }))
                      }
                      placeholder={isFirst ? "Winner name" : "Name (optional)"}
                      className={inputCls}
                    />
                    <input
                      name={`winner_${pos}_unit_ml`}
                      value={v.unit}
                      onChange={(e) =>
                        set((s) => ({ ...s, unit: e.target.value }))
                      }
                      list="known-units"
                      placeholder="Team / unit"
                      className={inputCls}
                    />
                  </div>
                );
              })}
              <datalist id="known-units">
                {knownUnits.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
              </div>
            </section>

            {/* Import from CSV — fills the winners above for review */}
            <div className="rounded-lg border border-stone-200">
              <button
                type="button"
                onClick={() => setCsvOpen((o) => !o)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-stone-700"
              >
                <span className="flex items-center gap-2">
                  <Upload className="size-4 text-stone-400" />
                  Import from CSV
                </span>
                <ChevronRight
                  className={`size-4 text-stone-400 transition-transform ${
                    csvOpen ? "rotate-90" : ""
                  }`}
                />
              </button>
              {csvOpen && (
                <div className="border-t border-stone-200 p-3 space-y-2">
                  <p className="text-[11px] text-stone-500">
                    Paste rows for this program — columns{" "}
                    <code className="rounded bg-stone-100 px-1 font-mono">
                      Competition,Category,Rank,Chest Number,Participant,Team,Points,Grade
                    </code>
                    . Ranks 1–3 fill the winners above.
                  </p>
                  <label className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer">
                    <Upload className="size-3.5 text-stone-400" />
                    Upload .csv file
                    <input
                      type="file"
                      accept=".csv,text/csv,text/plain"
                      onChange={onPickCsvFile}
                      className="sr-only"
                    />
                  </label>
                  <textarea
                    value={csv}
                    onChange={(e) => setCsv(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    placeholder={
                      "…or paste:\nElocution,Senior,1,A-12,Ayisha,Anithara,18,A\nElocution,Senior,2,B-07,Hana,Cheerpingal,15,A"
                    }
                    className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25"
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => fillFrom(csv)}
                      className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
                    >
                      Fill winners
                    </button>
                    {csvNote && (
                      <span className="text-[11px] text-stone-500">
                        {csvNote}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

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
                  if (
                    !confirm("Delete this result? Winners will also be removed.")
                  ) {
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
          <div className="border-t border-stone-200 px-5 py-3 flex items-center gap-2 bg-stone-50/60">
            <span className="text-[11px] text-stone-400">
              Save, then pick the next program above · Esc to close
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="submit"
                name="intent"
                value="save_draft"
                disabled={busy}
                className="rounded-lg border border-stone-300 hover:bg-white text-stone-700 px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                Save draft
              </button>
              <button
                type="submit"
                name="intent"
                value="save_publish"
                disabled={busy}
                className="rounded-lg bg-brand-700 hover:bg-brand-800 text-white px-5 py-2 text-sm font-semibold disabled:opacity-50"
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
  /** Auto-suggested result number for a NEW result = highest existing
   *  numeric result_no across the event + 1. */
  nextResultNo: number;
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

  // Highest numeric result number already used across the event → the
  // next new result auto-fills with maxNo + 1.
  let maxNo = 0;
  for (const lv of levels)
    for (const pr of lv.programs) {
      const n = parseInt(String(pr.result?.result_no ?? "").trim(), 10);
      if (Number.isFinite(n) && n > maxNo) maxNo = n;
    }

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
    nextResultNo: maxNo + 1,
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

type PosterMeta = {
  subdomain: string;
  defaultTemplate: number;
  defaultTemplateId: string | null;
  customTemplates: CustomTpl[];
  lang: "ml" | "en";
  fontEn: string | null;
  fontMl: string | null;
  layout: PosterLayoutMap | null;
  orgName: string;
  posterDate: string | null;
  posterTime: string | null;
  posterPlace: string | null;
};

function TemplateStudioView({
  posterMeta,
  siteUrl,
}: {
  posterMeta: PosterMeta;
  siteUrl: string;
}) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const choices: TemplateChoice[] = eventTemplateList(
    posterMeta.subdomain,
    posterMeta.customTemplates,
  );
  const savedChoice = pickFromList(
    choices,
    posterMeta.defaultTemplate,
    posterMeta.defaultTemplateId,
    0,
  );
  const savedPos = savedChoice
    ? Math.max(
        0,
        choices.findIndex((c) => c.key === savedChoice.key),
      )
    : 0;
  const [pick, setPick] = useState(savedPos);
  const cur = choices[pick] ?? choices[0];
  const tplKey = cur?.key ?? "0";
  const builtinPos = Math.max(
    0,
    choices.filter((c) => c.builtinIndex !== null).findIndex((c) => c.key === tplKey),
  );
  const [layoutMap, setLayoutMap] = useState<PosterLayoutMap>(
    posterMeta.layout ?? {},
  );
  const ov: TemplateOverride = layoutMap[tplKey] ?? {};
  const patchEl = (el: LayoutEl, patch: ElOverride): void =>
    setLayoutMap((m) => {
      const tpl: TemplateOverride = m[tplKey] ?? {};
      const cur: ElOverride = tpl[el] ?? {};
      return { ...m, [tplKey]: { ...tpl, [el]: { ...cur, ...patch } } };
    });
  const moveEl = (el: LayoutEl, x: number, y: number) =>
    patchEl(el, { x, y });
  const sizeEl = (el: LayoutEl, d: number) => {
    const cur: ElOverride = layoutMap[tplKey]?.[el] ?? {};
    patchEl(el, {
      s: Math.min(1.8, Math.max(0.5, (cur.s ?? 1) + d)),
    });
  };
  const resetTpl = () =>
    setLayoutMap((m) => {
      const next = { ...m };
      delete next[tplKey];
      return next;
    });
  const [meta, setMeta] = useState({
    name: posterMeta.orgName ?? "",
    lang: posterMeta.lang,
    fontEn: posterMeta.fontEn ?? POSTER_FONTS_EN[0],
    fontMl: posterMeta.fontMl ?? POSTER_FONTS_ML[0],
    date: posterMeta.posterDate ?? "",
    time: posterMeta.posterTime ?? "",
    place: posterMeta.posterPlace ?? "",
  });

  const sample = (): PosterData => ({
    eventName: meta.name || "Sahityotsav",
    siteUrl,
    fontFamily: posterFontStack(meta.fontEn, meta.fontMl),
    orgName: meta.name || undefined,
    posterDate: meta.date || undefined,
    posterTime: meta.time || undefined,
    posterPlace: meta.place || undefined,
    levelName: meta.lang === "ml" ? "സീനിയർ" : "Senior",
    programName: meta.lang === "ml" ? "പ്രസംഗം" : "Elocution",
    programCode: "P-001",
    resultNo: "12",
    winners: [
      { position: 1, name: "Ayisha Rahman", unit: "Anithara" },
      { position: 2, name: "Hana Fathima", unit: "Cheerpingal" },
      { position: 3, name: "Sara Mariyam", unit: "Vidyanagar" },
    ],
  });

  const field =
    "w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-stone-400";
  const lbl =
    "block text-[11px] font-semibold uppercase tracking-wide text-stone-500";

  return (
    <div className="max-w-5xl space-y-6">
      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-lg font-semibold tracking-tight">
          Poster details
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          These appear on every result poster for{" "}
          <span className="font-medium text-stone-700">
            {posterMeta.orgName || "this organization"}
          </span>{" "}
          — type them once, preview live below. Free text, so format them
          exactly as you want them printed.
        </p>
        <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="intent" value="save_poster_settings" />
          <input type="hidden" name="result_template" value={builtinPos} />
          <input type="hidden" name="result_template_id" value={tplKey} />
          <label className="space-y-1 sm:col-span-2">
            <span className={lbl}>Display / event name</span>
            <input
              name="poster_name"
              value={meta.name}
              onChange={(e) =>
                setMeta((m) => ({ ...m, name: e.target.value }))
              }
              className={field}
              placeholder="SSF Cheerpingal Unit · Sahityotsav"
            />
          </label>
          <label className="space-y-1">
            <span className={lbl}>Poster language</span>
            <select
              name="poster_lang"
              value={meta.lang}
              onChange={(e) =>
                setMeta((m) => ({
                  ...m,
                  lang: e.target.value === "ml" ? "ml" : "en",
                }))
              }
              className={field}
            >
              <option value="en">English</option>
              <option value="ml">Malayalam</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className={lbl}>English font</span>
            <select
              name="poster_font_en"
              value={meta.fontEn}
              onChange={(e) =>
                setMeta((m) => ({ ...m, fontEn: e.target.value }))
              }
              className={field}
            >
              {POSTER_FONTS_EN.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className={lbl}>Malayalam font</span>
            <select
              name="poster_font_ml"
              value={meta.fontMl}
              onChange={(e) =>
                setMeta((m) => ({ ...m, fontMl: e.target.value }))
              }
              className={field}
            >
              {POSTER_FONTS_ML.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className={lbl}>Date</span>
            <input
              name="poster_date"
              value={meta.date}
              onChange={(e) =>
                setMeta((m) => ({ ...m, date: e.target.value }))
              }
              className={field}
              placeholder="28–31 January 2027"
            />
          </label>
          <label className="space-y-1">
            <span className={lbl}>Place / venue</span>
            <input
              name="poster_place"
              value={meta.place}
              onChange={(e) =>
                setMeta((m) => ({ ...m, place: e.target.value }))
              }
              className={field}
              placeholder="Vadi Hussain, Malappuram"
            />
          </label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save poster settings"}
            </button>
            <span className="text-xs text-stone-400">
              Default:{" "}
              <span className="font-medium text-stone-600">
                {cur?.name ?? "—"}
              </span>
            </span>
            {actionData && "error" in actionData && (
              <span className="text-xs font-medium text-red-700">
                {actionData.error}
              </span>
            )}
            {actionData &&
              "ok" in actionData &&
              "message" in actionData && (
                <span className="text-xs font-medium text-emerald-700">
                  ✓ {actionData.message as string}
                </span>
              )}
          </div>
        </Form>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Templates</h2>
          <span className="text-xs text-stone-400">
            {choices.length} available
          </span>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Live preview at the poster's true 4:5 ratio. Set one as the
          default; it's used on the public site and shares (viewers can
          still shuffle). Save to apply.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {choices.map((c, pos) => {
            const selected = pos === pick;
            const isCustom = c.builtinIndex === null;
            return (
              <div
                key={c.key}
                className={`overflow-hidden rounded-lg border-2 ${
                  selected ? "border-brand-600" : "border-stone-200"
                }`}
              >
                <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2">
                  <span className="min-w-0 truncate text-xs font-medium text-stone-800">
                    {isCustom ? c.name : `Template ${pos + 1}`}
                    {selected && (
                      <span className="ml-1.5 text-[10px] font-semibold text-brand-700">
                        ● Default
                      </span>
                    )}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isCustom && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="delete_template"
                        />
                        <input
                          type="hidden"
                          name="template_id"
                          value={c.key}
                        />
                        <button
                          type="submit"
                          title="Delete template"
                          aria-label="Delete template"
                          onClick={(e) => {
                            if (!confirm(`Delete template "${c.name}"?`))
                              e.preventDefault();
                          }}
                          className="grid size-6 place-items-center rounded text-stone-400 hover:bg-red-50 hover:text-red-700"
                        >
                          <X className="size-3.5" />
                        </button>
                      </Form>
                    )}
                    <button
                      type="button"
                      onClick={() => setPick(pos)}
                      disabled={selected}
                      className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                        selected
                          ? "bg-brand-50 text-brand-700"
                          : "border border-stone-300 text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      {selected ? "Default" : "Set default"}
                    </button>
                  </div>
                </div>
                <div className="bg-stone-100 p-2">
                  <PosterCanvas
                    data={{ ...sample(), overrides: layoutMap[c.key] }}
                    templateIndex={c.builtinIndex ?? 0}
                    customSrc={c.src ?? undefined}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Upload a custom template */}
        <Form
          method="post"
          encType="multipart/form-data"
          className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4"
        >
          <input type="hidden" name="intent" value="upload_template" />
          <label className="space-y-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              Template name
            </span>
            <input
              name="template_name"
              required
              placeholder="e.g. Sector blue"
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25"
            />
          </label>
          <label className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 cursor-pointer">
            <Upload className="size-4 text-stone-400" />
            Choose image
            <input
              type="file"
              name="template_file"
              accept="image/png,image/jpeg,image/webp"
              required
              className="sr-only"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload template"}
          </button>
          <p className="w-full text-[11px] text-stone-400">
            PNG/JPG/WebP, ideally 1080×1350 (4:5), under 1 MB. After
            uploading, position the text with the editor below and Save.
          </p>
        </Form>
      </section>

      <section className="rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">
            Layout editor
          </h2>
          <span className="text-xs text-stone-400 truncate max-w-[12rem]">
            {cur?.name ?? "—"}
          </span>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Drag any block to reposition it; use −/＋ to resize. Saved
          per&nbsp;template, so every generated poster is consistent.
          Reset reverts this template to its built-in layout.
        </p>
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
          <div className="rounded-lg bg-stone-100 p-2">
            <PosterCanvas
              key={`edit-${tplKey}`}
              data={{ ...sample(), overrides: ov }}
              templateIndex={cur?.builtinIndex ?? 0}
              customSrc={cur?.src ?? undefined}
              editable
              onMove={moveEl}
            />
          </div>
          <div className="space-y-3">
            <div className="space-y-2">
              {(
                [
                  ["meta", "Name / date / place"],
                  ["content", "Category + program"],
                  ["winners", "Winners list"],
                  ["resultNo", "Result number"],
                ] as [LayoutEl, string][]
              ).map(([el, label]) => (
                <div
                  key={el}
                  className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2"
                >
                  <span className="text-sm text-stone-700">{label}</span>
                  <div className="flex items-center gap-2">
                    <span className="w-10 text-right text-[11px] tabular-nums text-stone-400">
                      {Math.round((ov[el]?.s ?? 1) * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => sizeEl(el, -0.05)}
                      className="size-6 rounded border border-stone-300 text-sm leading-none hover:bg-stone-50"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => sizeEl(el, 0.05)}
                      className="size-6 rounded border border-stone-300 text-sm leading-none hover:bg-stone-50"
                    >
                      ＋
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Form method="post" className="flex items-center gap-3 pt-1">
              <input
                type="hidden"
                name="intent"
                value="save_poster_layout"
              />
              <input
                type="hidden"
                name="poster_layout"
                value={JSON.stringify(layoutMap)}
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save layout"}
              </button>
              <button
                type="button"
                onClick={resetTpl}
                className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
              >
                Reset template
              </button>
            </Form>
          </div>
        </div>
      </section>
    </div>
  );
}

function SharePostersView({
  levels,
  eventName,
  siteUrl,
  posterMeta,
}: {
  levels: LevelRow[];
  eventName: string;
  siteUrl: string;
  posterMeta: PosterMeta;
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
        .map((w) => ({
          position: w.position,
          name: w.name_en ?? w.name_ml,
          unit: w.unit_ml,
        }));
      // Skip the poster for <2-winner results — still published, they
      // count via the uploaded standings, just no poster.
      if (winners.length < 2) return;
      const ml = posterMeta.lang === "ml";
      const programName = ml
        ? program.name_ml?.trim() || program.name_en?.trim() || program.code
        : program.name_en?.trim() || program.name_ml?.trim() || program.code;
      const levelName = ml
        ? level.name_ml?.trim() ||
          levelLabelFromCode(level.code, level.name_ml)
        : levelLabelFromCode(level.code, level.name_ml);
      out.push({
        key: `r-${r.id}`,
        code: program.code,
        programName,
        data: {
          eventName,
          siteUrl,
          fontFamily: posterFontStack(posterMeta.fontEn, posterMeta.fontMl),
          orgName: posterMeta.orgName,
          posterDate: posterMeta.posterDate ?? undefined,
          posterTime: posterMeta.posterTime ?? undefined,
          posterPlace: posterMeta.posterPlace ?? undefined,
          levelName,
          programName,
          programCode: program.code,
          resultNo: r.result_no,
          winners,
        },
      });
    });
    return out;
  }, [levels, eventName, siteUrl, posterMeta]);

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
        {item &&
          (() => {
            const choices = eventTemplateList(
              posterMeta.subdomain,
              posterMeta.customTemplates,
            );
            const tpl =
              pickFromList(
                choices,
                posterMeta.defaultTemplate,
                posterMeta.defaultTemplateId,
                tmplShift,
              ) ?? choices[0];
            return (
              <PosterCanvas
                key={item.key}
                data={{
                  ...item.data,
                  overrides: tpl ? posterMeta.layout?.[tpl.key] : undefined,
                }}
                templateIndex={tpl?.builtinIndex ?? 0}
                customSrc={tpl?.src ?? undefined}
                stageRef={stageRef}
              />
            );
          })()}
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
  const cls = `relative flex items-center gap-3 pl-4 pr-3 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
    active
      ? "bg-white/10 text-white before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-full before:bg-yellow"
      : "text-white/60 hover:bg-white/5 hover:text-white"
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

// Unified metric card that doubles as the dashboard filter. Same
// palette — the accent is a small dot (black / yellow=live / red),
// kept calm so the Fraunces numeral leads.
function StatCard({
  label,
  value,
  accent,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  accent: "ink" | "live" | "muted" | "alert";
  active?: boolean;
  onClick?: () => void;
}) {
  const dot =
    accent === "live"
      ? "bg-yellow"
      : accent === "alert"
      ? "bg-red-500"
      : accent === "ink"
      ? "bg-black"
      : "bg-stone-400";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-left rounded-xl border bg-white px-4 py-3 transition ${
        active
          ? "border-black ring-1 ring-black"
          : "border-stone-200 hover:border-stone-400"
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${dot}`} />
        <span className="text-[11px] font-semibold tracking-wider uppercase text-stone-500">
          {label}
        </span>
      </span>
      <span className="block font-[Fraunces,serif] text-[2rem] tabular-nums mt-1.5 leading-none text-stone-900">
        {value}
      </span>
    </button>
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
  const pct =
    level.total === 0 ? 0 : Math.round((level.published / level.total) * 100);
  return (
    <details
      open
      className="group rounded-xl border border-stone-200 bg-white overflow-hidden"
    >
      <summary className="cursor-pointer list-none select-none flex items-center gap-3 px-4 py-3 bg-stone-50 hover:bg-stone-100/70 transition [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-stone-400 transition-transform group-open:rotate-90" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p lang="ml" className="font-semibold text-sm truncate">
              {level.name_ml}
            </p>
            <span className="shrink-0 font-[Fraunces,serif] text-base tabular-nums text-stone-500">
              {level.published}
              <span className="text-stone-300">/{level.total}</span>
            </span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-stone-200 overflow-hidden">
            <div
              className="h-full bg-yellow transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[10px] tabular-nums text-stone-500 shrink-0">
          {level.pending > 0 && <span>{level.pending} pending</span>}
          {level.drafts > 0 && <span>{level.drafts} draft</span>}
          {level.inactive > 0 && (
            <span className="text-red-700">{level.inactive} off</span>
          )}
        </div>
      </summary>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 border-t border-stone-100">
        {level.programs.map((p) => (
          <ProgramListItem key={p.id} program={p} />
        ))}
      </div>
    </details>
  );
}

function ProgramListItem({ program: p }: { program: ProgramRow }) {
  const status = p.is_active ? p.result?.status ?? "none" : "inactive";
  return (
    <div
      className={`group/row relative border-b border-stone-100 ${
        p.is_active ? "" : "bg-stone-50/60"
      }`}
    >
      {/* Whole row is the single primary action — open the result modal */}
      <Link
        to={`/admin?edit=${p.code}`}
        preventScrollReset
        className={`flex items-center gap-3 py-2.5 pl-4 pr-11 transition hover:bg-yellow/10 ${
          p.is_active ? "" : "opacity-60"
        }`}
      >
        <span className="font-mono text-[10px] tabular-nums text-stone-400 w-9 shrink-0">
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
        <ProgramStatus status={status} />
      </Link>
      {/* Deactivate — demoted: revealed on row hover/focus (always shown
          when inactive so it can be turned back on). */}
      <Form
        method="post"
        className="absolute right-1.5 top-1/2 -translate-y-1/2"
      >
        <input type="hidden" name="program_code" value={p.code} />
        <button
          type="submit"
          name="intent"
          value="toggle_active"
          title={p.is_active ? "Deactivate program" : "Activate program"}
          aria-label={p.is_active ? "Deactivate program" : "Activate program"}
          className={`size-7 grid place-items-center rounded-md border transition focus-visible:opacity-100 ${
            p.is_active
              ? "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 border-stone-300 text-stone-400 hover:border-red-500 hover:bg-red-50 hover:text-red-700"
              : "opacity-100 border-yellow bg-yellow text-black hover:bg-yellow/80"
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
    <span className="font-sans text-[10px] font-semibold tracking-wider uppercase text-stone-500 bg-white border border-stone-300 rounded-full px-2 py-0.5 transition group-hover/row:border-stone-900 group-hover/row:text-stone-900">
      + Add result
    </span>
  );
}
