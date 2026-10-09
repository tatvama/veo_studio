import { useId } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";

/** The Tatvam mark: a hexagonal lens with a play-triangle core, in the cyan-to-indigo gradient. */
export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="0.55" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0.22" />
          <stop offset="1" stopColor="#818cf8" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      <path d="M16 2.2 27.3 8.6v12.8L16 27.8 4.7 21.4V8.6L16 2.2Z" fill={`url(#${id}-f)`} stroke={`url(#${id}-g)`} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12.6 10.6v10.8l9-5.4-9-5.4Z" fill={`url(#${id}-g)`} />
      <path d="M16 2.2v3.4M16 26.4v3.4M4.7 8.6l2.9 1.7M24.4 21.7l2.9 1.7" stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Mark + wordmark. The subtitle is a mono "eyebrow" so it reads like an instrument label. */
export function Brand({ compact, className, to = "/" }: { compact?: boolean; className?: string; to?: string }) {
  return (
    <Link to={to} aria-label="Tatvam AI Studio" className={cn("group flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/50", className)}>
      <LogoMark className="transition-transform duration-300 group-hover:rotate-[30deg]" />
      {!compact && (
        <span className="leading-none">
          <span className="text-gradient block text-[0.95rem] font-semibold tracking-[0.2em]">TATVAM</span>
          <span className="eyebrow mt-1 block !text-[0.625rem] tracking-[0.3em]">AI STUDIO</span>
        </span>
      )}
    </Link>
  );
}
