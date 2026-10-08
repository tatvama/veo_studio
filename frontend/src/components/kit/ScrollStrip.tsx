import { cn } from "../../lib/cn";
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

/**
 * Horizontally scrolling strip (tab bars, chip rows). Fades only the edge that has hidden content and keeps the
 * element matching `follow` (default: the selected tab) in view.
 */
export function ScrollStrip({ children, className, follow = '[aria-selected="true"], [aria-current="page"], [data-active="true"]', ...rest }: {
  children: ReactNode; className?: string; follow?: string;
} & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.style.setProperty("--fl", el.scrollLeft > 2 ? "22px" : "0px");
      el.style.setProperty("--fr", el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? "34px" : "0px");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, []);

  // Bring the active item into view whenever the children re-render with a different selection.
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>(follow);
    if (!el || !active) return;
    const a = active.getBoundingClientRect(), b = el.getBoundingClientRect();
    if (a.left < b.left + 24 || a.right > b.right - 24) el.scrollTo({ left: el.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2, behavior: "smooth" });
  });

  return <div ref={ref} className={cn("scroll-strip no-scrollbar overflow-x-auto", className)} {...rest}>{children}</div>;
}
