import { cn } from "../../lib/cn";

const HUES = [18, 32, 46, 150, 175, 200, 225, 262, 295, 330];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Round avatar with initials on a colour derived from the name (stable per person). */
export function Avatar({ name, src, size = 28, className, ring }: { name: string; src?: string; size?: number; className?: string; ring?: boolean }) {
  const hue = HUES[hash(name) % HUES.length];
  return (
    <span
      title={name}
      aria-label={name}
      className={cn("inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-semibold uppercase", ring && "ring-2 ring-panel", className)}
      style={{
        width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)),
        background: src ? undefined : `linear-gradient(135deg, oklch(0.62 0.13 ${hue}), oklch(0.5 0.12 ${(hue + 28) % 360}))`,
        color: "#fff",
      }}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 4, size = 24 }: { names: string[]; max?: number; size?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((n, i) => <Avatar key={n + i} name={n} size={size} ring className={i ? "-ml-2" : ""} />)}
      {extra > 0 && (
        <span className="-ml-2 inline-grid place-items-center rounded-full bg-raised text-2xs font-medium text-mute ring-2 ring-panel" style={{ width: size, height: size }}>+{extra}</span>
      )}
    </span>
  );
}
