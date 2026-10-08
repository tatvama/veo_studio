import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useCostumes } from "../../lib/v3";
import { Input, Select } from "../ui";

const OTHER = "\u0000other";

/**
 * Outfit for one character in a scene: a select of the character's named costumes, with "Other…" revealing a free-text input.
 * Picking a costume (or none) saves straight away; free text saves when the input loses focus.
 */
export function WardrobeSelect({ characterId, characterName, value, disabled, onPick, onText, onCommit }: {
  characterId: number; characterName: string; value: string; disabled?: boolean;
  /** A costume name or "" was chosen: save now. */
  onPick: (outfit: string) => void;
  /** Free text is being typed (draft only). */
  onText: (outfit: string) => void;
  /** Free text input lost focus: save. */
  onCommit: () => void;
}) {
  const t = useT();
  const { data: costumes, isLoading } = useCostumes(characterId);
  const names = (costumes ?? []).map((c) => c.name);
  const known = !!value && names.includes(value);
  const [other, setOther] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Once the costumes arrive, a value that isn't one of them is free text; with no named costumes at all, free text is the only way.
  useEffect(() => { if (!isLoading && ((value && !known) || !names.length)) setOther(true); }, [isLoading, value, known, names.length]);
  const selectValue = other ? OTHER : known ? value : "";
  const label = `${characterName}: ${t("Outfit")}`;

  const choose = (v: string) => {
    if (v === OTHER) { setOther(true); window.setTimeout(() => input.current?.focus(), 30); return; }
    setOther(false);
    onPick(v);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 @sm:flex-row @sm:items-center">
      <Select className="h-8! min-w-0 text-xs!" value={selectValue} disabled={disabled || isLoading} aria-label={label} onChange={(e) => choose(e.target.value)}>
        <option value="">{isLoading ? t("Loading…") : names.length ? t("— default look —") : t("— no named costumes —")}</option>
        {names.map((n) => <option key={n} value={n}>{n}{costumes?.find((c) => c.name === n)?.is_default ? ` · ${t("default")}` : ""}</option>)}
        <option value={OTHER}>{t("Other…")}</option>
      </Select>
      {other && (
        <Input ref={input} className="h-8! min-w-0 text-xs!" disabled={disabled} placeholder={t("Describe the outfit")} aria-label={`${label} (${t("free text")})`}
          value={known ? "" : value} onChange={(e) => onText(e.target.value)}
          onBlur={() => { onCommit(); if (known && names.length) setOther(false); }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      )}
    </div>
  );
}
