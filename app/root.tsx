import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400..800;1,400..800&family=Open+Sans:wght@400;500;600;700;800&family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..600&family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600;1,700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Anek+Malayalam:wght@100..800&family=Manjari:wght@400;700&family=Montserrat:wght@400;500;600;700;800&family=Poppins:wght@400;500;600;700;800&family=Bowlby+One&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light" />
        <meta name="theme-color" content="#0B090A" />
        <Meta />
        <Links />
      </head>
      <body className="font-sans antialiased text-black bg-white min-h-dvh">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "An unexpected error occurred.";
  let is404 = false;
  let notLive = false;

  if (isRouteErrorResponse(error)) {
    is404 = error.status === 404;
    const body = typeof error.data === "string" ? error.data.trim() : "";
    // Prefer the message we actually threw (error.data) over React
    // Router's generic statusText ("Not Found"), so a tenant 404
    // explains itself (e.g. "…results aren't published yet").
    detail = body || error.statusText || detail;
    notLive = /publish|check back/i.test(body);
    title = !is404
      ? `Error ${error.status}`
      : notLive
      ? "Results not live yet"
      : "Address not set up";
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
  }

  return (
    <main className="min-h-dvh flex items-center justify-center px-4 bg-stone-50">
      <div className="max-w-md w-full text-center">
        <p className="font-display text-[11px] font-bold tracking-[0.3em] uppercase text-brand-700">
          Sahityotsav
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-2">{title}</h1>
        <p className="text-sm text-stone-600 mt-2">{detail}</p>
        {is404 && !notLive && (
          <p className="text-xs text-stone-400 mt-3">
            Each team has its own address, e.g.
            {" "}
            <span className="font-mono">your-name.sahityotsav.live</span>.
          </p>
        )}
      </div>
    </main>
  );
}
