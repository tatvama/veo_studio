import { useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useImageEngines, type ImageEngine } from "../../lib/boards";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Character } from "../../lib/types";
import { Select } from "../ui";

/** "$0.09/image", or why there's no price: no key yet (placeholders), or the catalog's own label. */
export function enginePrice(e: Pick<ImageEngine, "est_usd" | "provider_mode" | "price_label">): string {
  if (e.est_usd > 0) return `${usd(e.est_usd, 3)}/${tr("image")}`;
  if (e.provider_mode === "mock") return tr("no key: placeholders");
  return e.price_label;
}

/** Which image engine makes this character's sheet, expressions, lighting and outfits. Auto = the team's image chain
 * (Google first); a pick is remembered on the character and runs on that engine only (e.g. Seedream on BytePlus). */
export function SheetEnginePicker({ character: c, editable }: { character: Character; editable: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useImageEngines();
  const [busy, setBusy] = useState(false);
  const value = c.sheet_engine || "auto";
  const engines = data?.engines ?? [];
  const known = value === "auto" || engines.some((e) => e.id === value);
  const autoFirst = engines.find((e) => e.id === data?.auto_first);
  const picked = engines.find((e) => e.id === value);

  const change = async (v: string) => {
    setBusy(true);
    try {
      await api.patch(`/api/characters/${c.id}`, { sheet_engine: v });
      qc.invalidateQueries({ queryKey: ["character", c.id] });
      toast.success(v === "auto" ? tr("{name}'s images follow the team's image chain again", { name: c.name })
        : tr("{name}'s images will be made with {engine}", { name: c.name, engine: engines.find((e) => e.id === v)?.display_name ?? v }));
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-bg/40 p-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute"><Cpu className="size-4" /></span>
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={`sheet-engine-${c.id}`} className="text-sm font-medium">{t("Image engine for this character")}</label>
        <p className="text-xs text-mute">
          {value === "auto"
            ? t("Auto follows the team's image chain{first}. Pick an engine to make this character's sheet, expressions, lighting and outfits with it only.",
              { first: autoFirst ? ` (${autoFirst.display_name} first)` : "" })
            : t("Sheet, expressions, lighting and outfits are made with {engine} only: no other engine or provider is tried (unless the team turned on the safety fallback).",
              { engine: picked?.display_name ?? value })}
        </p>
      </div>
      <Select id={`sheet-engine-${c.id}`} className="w-full @lg:w-auto @lg:min-w-72" value={value} disabled={!editable || busy}
        onChange={(e) => void change(e.target.value)}>
        <option value="auto">{t("Auto · team image chain")}</option>
        {!known && <option value={value}>{t("{engine} (not available now)", { engine: value })}</option>}
        {engines.map((e) => (
          <option key={e.id} value={e.id}>
            {e.display_name} · {enginePrice(e)}{e.group_max > 0 ? ` · ${t("board in one go")}` : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}
