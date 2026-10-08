import { clsx } from "clsx";
import { Clapperboard, type LucideIcon } from "lucide-react";

/** Stable hue (0–359) for an id or a name, so the same project / character always gets the same colour. */
export function hueOf(key: number | string): number {
  if (typeof key === "number") return (key * 47) % 360;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export const artGradient = (hue: number) =>
  `linear-gradient(135deg, oklch(0.62 0.14 ${hue}), oklch(0.44 0.12 ${(hue + 40) % 360}))`;

/** Small square thumbnail (project pickers, lists): the picture, or the gradient with a tiny icon. */
export function MiniThumb({ src, hue, icon: Icon = Clapperboard, className }: { src?: string; hue: number; icon?: LucideIcon; className?: string }) {
  return (
    <span className={clsx("grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg", className)} style={src ? undefined : { background: artGradient(hue) }}>
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <Icon className="size-4 text-white/85" strokeWidth={1.7} />}
    </span>
  );
}

/** Placeholder portrait for a person without a picture yet: the same gradient with their initial. */
export function InitialArt({ name, hue, className }: { name: string; hue: number; className?: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div aria-hidden className={clsx("relative grid size-full place-items-center overflow-hidden", className)} style={{ background: artGradient(hue) }}>
      <div className="absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-transparent" />
      <span className="relative text-6xl font-semibold text-white/90 drop-shadow-sm transition-transform duration-300 group-hover:scale-110">{letter}</span>
    </div>
  );
}

/** Placeholder picture for things that don't have one yet: a soft gradient, a highlight and a large faint icon. */
export function ThumbArt({ hue, icon: Icon = Clapperboard, className, iconClassName }: {
  hue: number; icon?: LucideIcon; className?: string; iconClassName?: string;
}) {
  return (
    <div aria-hidden className={clsx("relative size-full overflow-hidden", className)} style={{ background: artGradient(hue) }}>
      <div className="absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-transparent" />
      <Icon className="absolute -bottom-4 -right-3 size-24 -rotate-12 text-white/15" strokeWidth={1.25} />
      <div className="absolute inset-0 grid place-items-center">
        <Icon className={clsx("size-9 text-white/85 drop-shadow transition-transform duration-300 group-hover:scale-110", iconClassName)} strokeWidth={1.6} />
      </div>
    </div>
  );
}
