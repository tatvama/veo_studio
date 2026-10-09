import { clsx } from "clsx";
import { Pipette, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { hex6 } from "../../components/growth/BrandPreview";
import { Input } from "../../components/ui";
import { useT } from "../../lib/i18n";

const ROLES = ["Background", "Accent", "Extra", "Extra", "Extra", "Extra"];
export const MAX_COLORS = 6;

/** Black or white, whichever reads better on the colour. */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? "black" : "white";
}

function Swatch({ value, role, onChange, disabled }: { value: string; role: string; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  const ok = hex6(value);
  const ink = ok ? inkOn(ok) : "var(--color-dim)";
  return (
    <>
      {/* user data: a brand colour is the one allowed inline colour */}
      <div className={clsx("group relative h-[4.5rem] overflow-hidden rounded-lg border transition-colors", ok ? "border-line hover:border-dim/60" : "border-bad/60")}
        style={{ background: ok ?? "repeating-conic-gradient(var(--color-raised) 0% 25%, var(--color-hover) 0% 50%) 0 0 / 14px 14px" }}>
        <input type="color" value={ok ?? "#000000"} disabled={disabled} onChange={(e) => onChange(e.target.value)}
          aria-label={t("Pick the {role} colour", { role: t(role).toLowerCase() })}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
        <span className="eyebrow pointer-events-none absolute left-2 top-2" style={{ color: ink }}>{t(role)}</span>
        <span className="pointer-events-none absolute bottom-1.5 right-2 text-base font-bold leading-none" style={{ color: ink }}>Aa</span>
        {!disabled && (
          <span className="pointer-events-none absolute bottom-1.5 left-2 grid size-5 place-items-center rounded-md bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <Pipette className="size-3" />
          </span>
        )}
      </div>
      <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder="#F97316" spellCheck={false}
        aria-label={t("Hex code for the {role} colour", { role: t(role).toLowerCase() })}
        className={clsx("mt-1.5 h-8 px-2 font-mono text-xs uppercase", !ok && value && "border-bad/60")} />
    </>
  );
}

/** The palette as one proportional bar, the way an end card will use it. */
function Strip({ colors }: { colors: string[] }) {
  return (
    <div aria-hidden className="mb-4 flex h-3 overflow-hidden rounded-md border border-line bg-raised">
      {colors.map((c, i) => <i key={i} className="block flex-1" style={{ background: hex6(c) ?? undefined }} />)}
    </div>
  );
}

/** Row of colour swatches: click a swatch for the native colour picker, or type a hex code underneath. */
export function ColorSwatches({ colors, onChange, disabled }: { colors: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const t = useT();
  const addDefault = colors.length === 0 ? "#111111" : colors.length === 1 ? "#F97316" : "#FFFFFF";
  return (
    <div>
      {colors.length > 0 && <Strip colors={colors} />}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-4">
        <AnimatePresence initial={false}>
          {colors.map((c, i) => (
            <motion.div key={i} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="group/sw relative w-[7.25rem]">
              <Swatch value={c} role={ROLES[i] ?? "Extra"} disabled={disabled}
                onChange={(v) => onChange(colors.map((x, j) => (j === i ? v : x)))} />
              {colors.length > 1 && !disabled && (
                <button type="button" onClick={() => onChange(colors.filter((_, j) => j !== i))} aria-label={t("Remove colour")} title={t("Remove colour")}
                  className="absolute -right-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-md border border-line bg-panel text-mute opacity-0 shadow-card transition-opacity hover:text-bad focus-visible:opacity-100 group-hover/sw:opacity-100 pointer-coarse:right-1 pointer-coarse:top-1 pointer-coarse:size-10 pointer-coarse:opacity-100">
                  <X className="size-3" />
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {!disabled && colors.length < MAX_COLORS && (
          <button type="button" onClick={() => onChange([...colors, addDefault])}
            className="grid h-[4.5rem] w-[7.25rem] place-items-center rounded-lg border border-dashed border-line text-mute transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-accent-ink">
            <span className="flex flex-col items-center gap-0.5 text-xs font-medium"><Plus className="size-4" />{t("Add colour")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
