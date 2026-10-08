import { clsx } from "clsx";
import { initials } from "../../../components/ui";

const HUES = [18, 32, 46, 150, 175, 200, 225, 262, 295, 330];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Small round initials chip for dense tables. Same colours as <Avatar>, but never below the 11px minimum text size
 * (Avatar scales its letters down to 10px for small sizes).
 */
export function MiniAvatar({ name, size = 24, className }: { name: string; size?: number; className?: string }) {
  const hue = HUES[hash(name) % HUES.length];
  return (
    <span
      aria-hidden
      className={clsx("inline-grid shrink-0 select-none place-items-center rounded-full text-2xs font-semibold uppercase leading-none text-white", className)}
      style={{ width: size, height: size, background: `linear-gradient(135deg, oklch(0.62 0.13 ${hue}), oklch(0.5 0.12 ${(hue + 28) % 360}))` }}
    >
      {initials(name)}
    </span>
  );
}
