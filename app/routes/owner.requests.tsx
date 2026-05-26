import { Form, Link, data, useActionData } from "react-router";
import type { Route } from "./+types/owner.requests";
import { useBusyFor } from "~/lib/use-busy";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import {
  createServiceRoleClient,
  requireOwner,
} from "~/lib/supabase.owner.server";

export function meta() {
  return [{ title: "Request history · Owner console" }];
}

// Compose a `wa.me` link from a free-text mobile number — strips
// spaces, dashes and a leading "+" so country-coded numbers like
// "+91 98765 43210" still produce a valid WhatsApp deeplink.
function waUrl(mobile: string): string {
  const digits = mobile.replace(/\D+/g, "");
  return `https://wa.me/${digits}`;
}

async function userEmail(request: Request): Promise<string | null> {
  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ?? null;
}

type ProcessedRequest = {
  id: string;
  name: string;
  mobile: string;
  organization_name: string;
  created_at: string;
  status: "approved" | "rejected";
};

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireOwner(request, context, () => userEmail(request));
  const svc = createServiceRoleClient(context);

  const url = new URL(request.url);
  // ?status= filter — empty / "all" shows both. The select element
  // submits via plain link so the URL is shareable / bookmarkable.
  const statusFilter = (() => {
    const v = (url.searchParams.get("status") ?? "").trim().toLowerCase();
    return v === "approved" || v === "rejected" ? v : "all";
  })();
  const q = (url.searchParams.get("q") ?? "").trim();

  let query = svc
    .from("access_requests")
    .select("id, name, mobile, organization_name, created_at, status");

  if (statusFilter === "all") query = query.neq("status", "pending");
  else query = query.eq("status", statusFilter);
  if (q) {
    // Free-text search across the three textual columns. ILIKE keeps
    // the match case-insensitive; the wildcards bracket the term.
    const term = `%${q}%`;
    query = query.or(
      `name.ilike.${term},organization_name.ilike.${term},mobile.ilike.${term}`,
    );
  }

  const { data: rows } = await query
    .order("created_at", { ascending: false })
    .limit(500);

  return data({
    requests: (rows ?? []) as ProcessedRequest[],
    statusFilter,
    q,
  });
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionResult> {
  await requireOwner(request, context, () => userEmail(request));
  const svc = createServiceRoleClient(context);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  const id = String(fd.get("request_id") ?? "").trim();
  if (!id) return { error: "Missing request id." };

  if (intent === "restore_access_request") {
    const { error } = await svc
      .from("access_requests")
      .update({ status: "pending" })
      .eq("id", id);
    if (error) return { error: error.message };
    return { ok: true, message: "Request moved back to pending." };
  }

  if (intent === "delete_access_request") {
    const { error } = await svc.from("access_requests").delete().eq("id", id);
    if (error) return { error: error.message };
    return { ok: true, message: "Request deleted." };
  }

  return { error: `Unknown intent: ${intent}` };
}

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")";

export default function OwnerRequests({ loaderData }: Route.ComponentProps) {
  const { requests, statusFilter, q } = loaderData;
  const actionData = useActionData<typeof action>();
  const busyFor = useBusyFor();

  const counts = requests.reduce(
    (acc, r) => {
      acc[r.status]++;
      return acc;
    },
    { approved: 0, rejected: 0 } as Record<"approved" | "rejected", number>,
  );

  const card =
    "o-rise rounded-xl border border-stone-200/80 bg-white shadow-[0_14px_34px_-26px_rgba(28,23,20,0.3)]";

  const filterPill = (key: "all" | "approved" | "rejected", label: string) => {
    const active = statusFilter === key;
    const search = new URLSearchParams();
    if (key !== "all") search.set("status", key);
    if (q) search.set("q", q);
    const to = search.toString() ? `?${search.toString()}` : "";
    return (
      <Link
        key={key}
        to={to}
        prefetch="intent"
        className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ring-1 ring-inset transition ${
          active
            ? "bg-stone-900 text-white ring-stone-900"
            : "bg-white text-stone-600 ring-stone-200 hover:border-stone-300 hover:text-stone-900"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="relative min-h-dvh bg-[#F7F4EC] text-stone-900">
      <style>{`@keyframes ownerRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}.o-rise{animation:ownerRise .55s cubic-bezier(.2,.7,.2,1) both}`}</style>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.04] mix-blend-multiply"
        style={{ backgroundImage: GRAIN }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(820px 420px at 82% -12%, rgba(200,162,74,0.11), transparent 60%)",
        }}
      />

      {/* ── Masthead ── */}
      <header className="sticky top-0 z-30 bg-[#1B1714] text-[#EDE6D8]">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 px-4 py-2.5 sm:gap-6 sm:px-6">
          <Link to="/owner" className="flex min-w-0 items-center gap-3">
            <div className="grid size-7 shrink-0 place-items-center rounded border border-[#C8A24A]/40 bg-[#C8A24A]/10 font-[Fraunces,serif] text-sm leading-none text-[#E8C879]">
              സ
            </div>
            <p className="truncate font-[Fraunces,serif] text-sm tracking-tight text-[#F4EEE0]">
              Sahityotsav
              <span className="ml-2 hidden text-[11px] font-normal text-[#9b9080] sm:inline">
                Owner console
              </span>
            </p>
          </Link>
          <Link
            to="/owner"
            className="rounded border border-[#3a322b] px-2.5 py-1 text-xs font-medium text-[#cfc5b3] transition hover:border-[#C8A24A]/50 hover:text-[#F4EEE0]"
          >
            ← Dashboard
          </Link>
        </div>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-[#C8A24A]/55 to-transparent" />
      </header>

      <main className="relative z-10 mx-auto max-w-[1280px] px-4 pb-12 pt-5 sm:px-6 sm:pt-6">
        {/* ── Heading ── */}
        <div className="o-rise mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-3">
            <h1 className="font-[Fraunces,serif] text-2xl font-semibold tracking-tight">
              Request history
            </h1>
            <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-brand-700">
              Manage
            </span>
          </div>
          <p className="text-xs text-stone-500">
            Approved + rejected access requests · most recent 500
          </p>
        </div>

        {actionData && "error" in actionData && (
          <div className="o-rise mb-4 rounded-lg border border-red-200 bg-red-50/80 px-4 py-2.5 text-sm text-red-800">
            {actionData.error}
          </div>
        )}
        {actionData && "ok" in actionData && (
          <div className="o-rise mb-4 rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-2.5 text-sm leading-relaxed text-emerald-800">
            {actionData.message}
          </div>
        )}

        {/* ── Toolbar: filter chips + free-text search ── */}
        <div
          className={`${card} o-rise mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:px-4`}
          style={{ animationDelay: ".03s" }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {filterPill(
              "all",
              `All (${counts.approved + counts.rejected})`,
            )}
            {filterPill("approved", `Approved (${counts.approved})`)}
            {filterPill("rejected", `Rejected (${counts.rejected})`)}
          </div>
          <Form
            method="get"
            className="flex flex-1 min-w-0 items-center gap-2 sm:ml-auto sm:max-w-sm"
          >
            {statusFilter !== "all" && (
              <input type="hidden" name="status" value={statusFilter} />
            )}
            <input
              name="q"
              defaultValue={q}
              placeholder="Search by name, org or phone"
              className="w-full min-w-0 rounded-md border border-stone-300/80 bg-white px-3 py-1.5 text-sm placeholder:text-stone-400 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15"
            />
            <button
              type="submit"
              className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-800"
            >
              Find
            </button>
            {q && (
              <Link
                to={
                  statusFilter === "all"
                    ? ""
                    : `?status=${statusFilter}`
                }
                className="text-xs font-medium text-stone-500 underline decoration-dotted underline-offset-4 hover:text-stone-900"
              >
                Clear
              </Link>
            )}
          </Form>
        </div>

        {/* ── List ── */}
        <section
          className={`${card} overflow-hidden`}
          style={{ animationDelay: ".06s" }}
        >
          {requests.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-stone-400">
              {q || statusFilter !== "all"
                ? "No requests match this filter."
                : "No processed requests yet."}
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {requests.map((r) => {
                const ts = new Date(r.created_at);
                const isApproved = r.status === "approved";
                const restoreBusy = busyFor("restore_access_request", {
                  request_id: r.id,
                });
                const deleteBusy = busyFor("delete_access_request", {
                  request_id: r.id,
                });
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
                  >
                    <div className="min-w-0 flex-1 basis-full sm:basis-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-stone-900">
                          {r.organization_name}
                        </p>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ring-1 ring-inset ${
                            isApproved
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                              : "bg-stone-100 text-stone-500 ring-stone-400/20"
                          }`}
                        >
                          <span className="size-1.5 rounded-full bg-current opacity-70" />
                          {r.status}
                        </span>
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-600">
                        <span className="truncate">{r.name}</span>
                        <span className="text-stone-300">·</span>
                        <a
                          href={waUrl(r.mobile)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-emerald-700 hover:text-emerald-800"
                          title="Open WhatsApp chat"
                        >
                          <span aria-hidden>💬</span>
                          {r.mobile}
                        </a>
                        <span className="text-stone-300">·</span>
                        <span className="text-stone-400">
                          {ts.toLocaleString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </p>
                    </div>
                    <div className="ml-auto flex shrink-0 gap-1.5">
                      <Form method="post" className="contents">
                        <input
                          type="hidden"
                          name="intent"
                          value="restore_access_request"
                        />
                        <input
                          type="hidden"
                          name="request_id"
                          value={r.id}
                        />
                        <button
                          type="submit"
                          disabled={restoreBusy}
                          className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                          title="Move back to pending"
                        >
                          {restoreBusy ? "Restoring…" : "Restore"}
                        </button>
                      </Form>
                      <Form method="post" className="contents">
                        <input
                          type="hidden"
                          name="intent"
                          value="delete_access_request"
                        />
                        <input
                          type="hidden"
                          name="request_id"
                          value={r.id}
                        />
                        <button
                          type="submit"
                          disabled={deleteBusy}
                          onClick={(e) => {
                            if (!confirm("Delete this request permanently?"))
                              e.preventDefault();
                          }}
                          className="rounded-md border border-stone-300 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          title="Delete"
                          aria-label="Delete request"
                        >
                          ✕
                        </button>
                      </Form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
