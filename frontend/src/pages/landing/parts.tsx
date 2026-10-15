import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type HTMLAttributes, type PointerEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { api } from "../../lib/api";
import { FALLBACK_RATES } from "./content";

/** The landing page scrolls inside its own container (the app's body never scrolls), so scroll-linked effects need it. */
export const ScrollerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const useScroller = () => useContext(ScrollerContext);

export function scrollToId(id: string) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
  document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return <section id={id} className={cn("ld-section relative mx-auto w-full max-w-[80rem] px-4 py-16 sm:px-8 sm:py-24", className)}>{children}</section>;
}

export function SectionHead({ eyebrow, title, lead, center }: { eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <div className={cn("max-w-3xl", center && "mx-auto text-center")}>
      <p className={cn("eyebrow flex items-center gap-3 !text-accent-ink", center && "justify-center")}>
        <span aria-hidden className="h-px w-8 bg-accent/60" />{eyebrow}<span aria-hidden className={cn("h-px w-8 bg-accent/60", !center && "hidden")} />
      </p>
      <h2 className="ld-h2 mt-4 text-balance">{title}</h2>
      {lead && <p className="mt-4 text-base leading-relaxed text-mute sm:text-lg">{lead}</p>}
    </div>
  );
}

/** A panel with a soft light that follows the pointer (the glow is CSS, see .ld-spot). */
export function Spot({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return <div onPointerMove={move} className={cn("ld-spot", className)} {...rest}>{children}</div>;
}

export interface PublicRates { usd_inr: number | null; tiers: { id: string; resolution: string; usd_per_second: number }[] }

/** Price of a second of video per quality tier, and the rupee rate. Falls back to fixed numbers if the server can't answer. */
export function usePublicRates() {
  const q = useQuery({
    queryKey: ["public-rates"],
    queryFn: () => api.get<PublicRates>("/api/public/rates", { silent: true }),
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const data = q.data && q.data.tiers.length ? q.data : null;
  return {
    tiers: data?.tiers ?? FALLBACK_RATES.tiers,
    inr: data?.usd_inr ?? FALLBACK_RATES.usd_inr,
    /** true once the real numbers arrived (not the fallback) */
    live: !!data?.usd_inr,
  };
}

/** ₹1,23,456 (Indian digit grouping). */
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
