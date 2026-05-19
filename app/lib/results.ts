// Generic scoring + standings helpers — tenant-agnostic. Replaces the old
// hardcoded teams.ts. A team/unit is now just the raw `unit_ml` string
// stored on result_winners (as it appears in the imported CSV / typed in
// the result modal); there is no per-tenant slug table.

export const GRADE_DEFAULT_MARKS: Record<"A" | "B" | "C", number> = {
  A: 10,
  B: 5,
  C: 1,
};

export type Grade = "A" | "B" | "C";

/** Points for a single winner: explicit marks if present, otherwise the
 *  grade-default table, otherwise 0. */
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

/** Total published results bucketed down to the nearest 5. */
export function snapshotBucket(totalPublished: number): number {
  return Math.max(0, Math.floor(totalPublished / 5) * 5);
}

export type StandingRow = { team: string; points: number };

/** Aggregate points per unit across a winner list, keyed by the raw
 *  (trimmed) unit_ml string. Works for any tenant — no fixed team list,
 *  units are whatever the data contains. */
export function computeStandings(
  winners: ReadonlyArray<{
    unit_ml: string | null;
    marks: number | null;
    grade: string | null;
  }>,
): StandingRow[] {
  const points = new Map<string, number>();
  for (const w of winners) {
    const team = w.unit_ml?.trim();
    if (!team) continue;
    points.set(
      team,
      (points.get(team) ?? 0) + winnerPoints({ marks: w.marks, grade: w.grade }),
    );
  }
  return [...points.entries()]
    .map(([team, pts]) => ({ team, points: pts }))
    .sort((a, b) => b.points - a.points);
}
