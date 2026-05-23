import { useEffect, useState } from "react";

// Chrome's beforeinstallprompt event isn't in lib.dom yet — narrow it
// to the two members we actually call.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISSED_KEY = "pwa-install-dismissed";
const SHOW_AFTER_MS = 5000;

/**
 * Bottom-right install-as-PWA toast. Two paths:
 *
 *   - Chrome / Edge / Brave / Android: capture `beforeinstallprompt`,
 *     show a custom toast after a 5s delay, hand the deferred event to
 *     the user's "Install" click.
 *   - iOS Safari: no programmatic install API, so show a short hint
 *     pointing at the share-sheet Add-to-Home-Screen flow.
 *
 * Self-suppresses when: already running standalone, already dismissed
 * once (permanent localStorage flag), or the page was opened via the
 * installed shortcut (?src=pwa). The browser still owns the actual OS
 * install dialog — we only own when our toast offers it.
 */
export function InstallPrompt({ orgName }: { orgName: string }) {
  const [deferred, setDeferred] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<"chrome" | "ios" | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already installed (running standalone) — never prompt. Covers
    // both the W3C standard (display-mode media query) and the iOS
    // legacy navigator.standalone flag.
    if (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    ) {
      return;
    }

    // Opened via the installed shortcut → manifest start_url carries
    // ?src=pwa, so suppress the prompt for this session.
    if (new URL(window.location.href).searchParams.get("src") === "pwa") {
      return;
    }

    // Permanently dismissed in a prior visit.
    try {
      if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    } catch {
      // Private-mode browsers throw on localStorage — proceed without
      // the dismiss memory rather than crashing.
    }

    // iOS Safari only (Chrome/Firefox on iOS can't install PWAs at
    // all; showing them the share-sheet hint would be wrong).
    const ua = navigator.userAgent;
    const isIOSSafari =
      /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

    let timer: ReturnType<typeof setTimeout> | null = null;

    const onBeforeInstall = (e: Event) => {
      // Stop Chrome's mini-info bar from popping up — our toast will
      // surface this offer instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      timer = setTimeout(() => setMode("chrome"), SHOW_AFTER_MS);
    };
    const onInstalled = () => {
      setMode(null);
      try {
        localStorage.setItem(DISMISSED_KEY, "1");
      } catch {}
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    if (isIOSSafari) {
      timer = setTimeout(() => setMode("ios"), SHOW_AFTER_MS);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    setMode(null);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {}
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    // Whatever the OS prompt's outcome, the user has had their say —
    // don't ask again. (`appinstalled` will also set this, but only on
    // an accept; we want dismiss to be sticky too.)
    setDeferred(null);
    dismiss();
  };

  if (!mode) return null;

  const label = orgName.trim() || "Sahityotsav";

  return (
    <div
      role="dialog"
      aria-labelledby="pwa-install-title"
      className="font-sans pointer-events-none fixed inset-x-3 bottom-3 z-40 sm:bottom-4 sm:right-4 sm:left-auto sm:max-w-sm"
    >
      <div className="pointer-events-auto rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)] animate-[pwa-slide-up_280ms_ease-out]">
        <div className="flex items-start gap-3">
          <img
            src="/web-app-manifest-192x192.png"
            alt=""
            aria-hidden
            className="h-11 w-11 shrink-0 rounded-xl ring-1 ring-stone-200"
          />
          <div className="min-w-0 flex-1">
            <p
              id="pwa-install-title"
              className="text-[13.5px] font-semibold leading-tight text-stone-900"
            >
              Install {label} Results
            </p>
            <p className="mt-1 text-[12px] leading-snug text-stone-600">
              {mode === "ios" ? (
                <>
                  Tap{" "}
                  <span
                    aria-hidden
                    className="mx-0.5 inline-flex h-4 w-4 -translate-y-px items-center justify-center rounded border border-stone-300 align-middle text-[10px]"
                  >
                    ↑
                  </span>{" "}
                  Share, then{" "}
                  <em className="font-semibold not-italic">
                    Add to Home Screen
                  </em>
                  .
                </>
              ) : (
                "One-tap shortcut on your home screen — opens like an app, no browser bar."
              )}
            </p>
            <div className="mt-2.5 flex items-center gap-1.5">
              {mode === "chrome" && (
                <button
                  type="button"
                  onClick={install}
                  className="rounded-full bg-stone-900 px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-stone-700"
                >
                  Install
                </button>
              )}
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full px-3 py-1.5 text-[12.5px] font-medium text-stone-500 transition hover:bg-stone-100"
              >
                {mode === "chrome" ? "Not now" : "Got it"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes pwa-slide-up {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
