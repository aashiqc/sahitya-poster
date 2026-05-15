// Reusable ornamental SVGs for the festive theme.
// Inline SVG so it inherits currentColor and ships zero JS.

export function Diamond({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0 L9.5 6.5 L16 8 L9.5 9.5 L8 16 L6.5 9.5 L0 8 L6.5 6.5 Z" />
    </svg>
  );
}

export function DiamondCluster({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 60 12"
      className={className}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="6" cy="6" r="1.5" />
      <path d="M20 1 L22 5 L26 6 L22 7 L20 11 L18 7 L14 6 L18 5 Z" />
      <path d="M30 0 L31 5 L36 6 L31 7 L30 12 L29 7 L24 6 L29 5 Z" opacity=".95" />
      <path d="M40 1 L42 5 L46 6 L42 7 L40 11 L38 7 L34 6 L38 5 Z" />
      <circle cx="54" cy="6" r="1.5" />
    </svg>
  );
}

/**
 * Decorative full-width section divider: thin gold rules + center motif.
 * Optionally embeds a small label between the motifs.
 */
export function Rule({
  label,
  tone = "gold",
  className = "",
}: {
  label?: string;
  tone?: "gold" | "ink" | "paper";
  className?: string;
}) {
  const toneClass =
    tone === "gold"
      ? "text-gold-600"
      : tone === "ink"
      ? "text-ink-500"
      : "text-paper-3";
  return (
    <div
      className={`flex items-center gap-3 ${toneClass} ${className}`}
      aria-hidden
    >
      <span className="h-px flex-1 bg-current opacity-30" />
      <DiamondCluster className="h-3 w-auto opacity-90" />
      {label && (
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.25em] opacity-90">
          {label}
        </span>
      )}
      <DiamondCluster className="h-3 w-auto opacity-90" />
      <span className="h-px flex-1 bg-current opacity-30" />
    </div>
  );
}

/**
 * Decorative repeating top border, like a printed selvage.
 * Renders as a thin striped band (1.5rem tall).
 */
export function Selvage({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`h-2 w-full ${className}`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, var(--color-gold-500) 0 6px, transparent 6px 12px), linear-gradient(90deg, var(--color-gold-200), var(--color-gold-400), var(--color-gold-200))",
        backgroundSize: "12px 2px, 100% 100%",
        backgroundRepeat: "repeat-x, no-repeat",
        backgroundPosition: "center top, center top",
      }}
    />
  );
}

/**
 * Subtle dot-pattern background overlay (kolam-ish), pure CSS.
 * Place inside a `relative` parent.
 */
export function DotMesh({
  opacity = 0.18,
  size = 22,
  className = "",
}: {
  opacity?: number;
  size?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{
        opacity,
        backgroundImage: `radial-gradient(circle, currentColor 1px, transparent 1px)`,
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: "0 0",
      }}
    />
  );
}

/**
 * Corner flourish — a small ornament tucked in the corner of a hero/card.
 * Pass placement via Tailwind positioning utility on the wrapper.
 */
export function CornerLeaf({
  className = "",
  rotate = 0,
}: {
  className?: string;
  rotate?: number;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <path d="M2 62 C 18 46, 30 34, 46 18 C 52 12, 58 8, 62 2" opacity=".7" />
      <path d="M2 62 C 14 50, 22 42, 30 34" opacity=".4" />
      <path d="M30 34 C 30 30, 31 26, 34 24 C 38 22, 42 24, 42 28" opacity=".5" />
      <path d="M46 18 C 50 16, 54 18, 55 22 C 56 26, 52 30, 48 30" opacity=".5" />
      <circle cx="44" cy="20" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="32" cy="32" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="44" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
