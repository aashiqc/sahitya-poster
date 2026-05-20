import { useCallback } from "react";
import { useNavigation } from "react-router";

/** Lookup of form-data discriminators (string keys → expected string
 *  values). The values are compared as strings after coercion, so
 *  numeric ids passed through hidden inputs match correctly. */
export type BusyMatch = Record<string, string | number | null | undefined>;

/** A page-scoped check that returns true ONLY while the active
 *  navigation submission is the one identified by `intent` (and any
 *  extra discriminator field/value pairs in `match`).
 *
 *  Why this exists:
 *    `useNavigation().state !== "idle"` flips to true for ANY in-flight
 *    submission on the page. Wiring every button's `disabled` and
 *    label text to that global flag means clicking one button disables
 *    every button and shows "Saving…" everywhere — even on totally
 *    unrelated forms. Scoping to the submission's `intent` (and a
 *    per-row discriminator like `user_id` or `template_id` where the
 *    same intent fires from multiple rows) keeps the spinner local to
 *    the row the user actually clicked.
 *
 *  Each call site reads it like:
 *      const busyFor = useBusyFor();
 *      …
 *      <button disabled={busyFor("save_poster_layout")} />
 *      …
 *      <button disabled={busyFor("reset_admin_password", { user_id: t.id })} />
 */
export function useBusyFor() {
  const navigation = useNavigation();
  return useCallback(
    (intent: string, match?: BusyMatch): boolean => {
      if (navigation.state === "idle" || !navigation.formData) return false;
      if (navigation.formData.get("intent") !== intent) return false;
      if (match) {
        for (const [k, v] of Object.entries(match)) {
          if (v == null) continue;
          const got = navigation.formData.get(k);
          if (String(got ?? "") !== String(v)) return false;
        }
      }
      return true;
    },
    [navigation],
  );
}
