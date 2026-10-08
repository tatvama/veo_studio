import { clsx } from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { Menu, Tooltip, type MenuItemDef } from "../../../components/ui";
import { QUALITY_INFO } from "../../../lib/format";
import { useT } from "../../../lib/i18n";

/**
 * Video quality chooser. Never truncates: it is a menu of three tiers with their price and what they use, and the
 * trigger shows the effective tier. `value` "" means "the project default".
 * `joined` attaches it to the right edge of a primary button (a split button).
 */
export function QualityMenu({ value, onChange, defaultKey, defaultLabel, joined, tone = "primary", disabled, className }: {
  value: string; onChange: (v: string) => void; defaultKey: string; /** Heading of the "no override" row (default: the project default). */ defaultLabel?: string;
  /** Attach to the right edge of a button. `tone` must match that button's variant. */
  joined?: boolean; tone?: "primary" | "secondary"; disabled?: boolean; className?: string;
}) {
  const t = useT();
  const eff = value || defaultKey;
  const info = QUALITY_INFO[eff];
  const def = QUALITY_INFO[defaultKey];

  const row = (key: string, title: string, sub: string): MenuItemDef => {
    const on = value === key;
    return {
      active: on,
      onClick: () => onChange(key),
      label: (
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{title}</span>
            <span className="block whitespace-normal text-2xs font-normal leading-snug text-dim">{sub}</span>
          </span>
          {on && <Check className="size-3.5 shrink-0 text-accent-ink" />}
        </span>
      ),
    };
  };

  const items: MenuItemDef[] = [
    row("", `${defaultLabel ?? t("Project default")} · ${t(def?.label ?? defaultKey)}`, def ? `${def.price} · ${t(def.desc)}` : ""),
    ...Object.entries(QUALITY_INFO).map(([k, v], i) => ({ ...row(k, t(v.label), `${v.price} · ${t(v.desc)}`), separator: i === 0 })),
  ];

  return (
    <Menu width={300} placement="bottom-end" items={items} trigger={(p) => (
      <Tooltip content={t("Video quality: {name} {price}", { name: t(info?.label ?? eff), price: info?.price ?? "" })} disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          {...p}
          aria-label={t("Quality")}
          className={clsx(
            "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-xs font-medium transition-[background-color,box-shadow,transform,opacity,filter] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45",
            joined && tone === "primary" && "btn-primary rounded-r-lg border-l border-black/20 pl-2 pr-1.5 text-black",
            joined && tone === "secondary" && "-ml-px rounded-r-lg border border-line bg-raised pl-2 pr-1.5 text-ink hover:border-dim/40 hover:bg-hover",
            !joined && "rounded-lg border border-line bg-raised text-ink hover:border-dim/40 hover:bg-hover",
            className,
          )}
        >
          <span>{t(info?.label ?? eff)}</span>
          {value && <span aria-hidden className={clsx("size-1.5 rounded-full", joined && tone === "primary" ? "bg-black/70" : "bg-accent")} />}
          <ChevronDown className="size-3.5 opacity-70" />
        </button>
      </Tooltip>
    )} />
  );
}
