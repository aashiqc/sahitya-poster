// Hardcoded list of 8 teams (units) for Sahityotsav. These map 1:1 onto
// the `unit_ml` value stored on result_winners. We treat the slug as the
// stable identifier; name_ml is what's shown in the poster and UI.

export type Team = {
  /** Stable lowercase id used in `unit_ml`. */
  slug: string;
  /** Display name (Latin script for now; replace name_ml when supplied). */
  name: string;
};

export const TEAMS: readonly Team[] = [
  { slug: "cheerpingal", name: "Cheerpingal" },
  { slug: "kariparampu", name: "Kariparampu" },
  { slug: "vidyanagar", name: "Vidyanagar" },
  { slug: "vadakkemamburam", name: "Vadakkemamburam" },
  { slug: "parappuram", name: "Parappuram" },
  { slug: "pallippadi", name: "Pallippadi" },
  { slug: "pathinarungal", name: "Pathinarungal" },
  { slug: "anithara", name: "Anithara" },
] as const;

export const TEAM_BY_SLUG: Record<string, Team> = Object.fromEntries(
  TEAMS.map((t) => [t.slug, t]),
);

// ─────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────

export const GRADE_DEFAULT_MARKS: Record<"A" | "B" | "C", number> = {
  A: 10,
  B: 5,
  C: 1,
};

export type Grade = "A" | "B" | "C";

/** Points awarded to a single winner. If marks are explicit use them,
 *  otherwise fall back to the grade-default table. Returns 0 when neither
 *  is set. */
export function winnerPoints(opts: {
  marks: number | null | undefined;
  grade: string | null | undefined;
}): number {
  if (typeof opts.marks === "number" && Number.isFinite(opts.marks)) {
    return opts.marks;
  }
  if (opts.grade && opts.grade in GRADE_DEFAULT_MARKS) {
    return GRADE_DEFAULT_MARKS[opts.grade as Grade];
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────
// Standings snapshot — published at multiples of 5
// ─────────────────────────────────────────────────────────────────────

export type StandingRow = { team: Team; points: number };

/** Total published results bucketed down to the nearest 5. */
export function snapshotBucket(totalPublished: number): number {
  return Math.max(0, Math.floor(totalPublished / 5) * 5);
}

/** Aggregate points per team across an arbitrary winner list. Unknown
 *  unit_ml values are ignored. */
export function computeStandings(
  winners: ReadonlyArray<{
    unit_ml: string | null;
    marks: number | null;
    grade: string | null;
  }>,
): StandingRow[] {
  const points: Record<string, number> = {};
  for (const t of TEAMS) points[t.slug] = 0;

  for (const w of winners) {
    if (!w.unit_ml) continue;
    const slug = w.unit_ml.toLowerCase();
    if (!(slug in points)) continue;
    points[slug] += winnerPoints({ marks: w.marks, grade: w.grade });
  }

  return TEAMS.map((t) => ({ team: t, points: points[t.slug] })).sort(
    (a, b) => b.points - a.points,
  );
}
