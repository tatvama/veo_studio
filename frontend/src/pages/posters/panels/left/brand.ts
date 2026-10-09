/** The brand kit chosen for this design (Brand tab), shared with Templates and AI so new layouts come out on-brand. */
import { useCallback, useMemo } from "react";
import { useBrandKits } from "../../../../lib/queries";
import { useEditor } from "../../store";
import { brandInput } from "./actions";
import { useLeft } from "./state";
import { useNaturalSize } from "./ui";

export function useBrand(designId: number) {
  const kits = useBrandKits();
  const chosen = useLeft((s) => s.brandKit[designId]);
  const designKit = useEditor((s) => s.design?.brand_kit_id ?? null);
  const kitId = chosen !== undefined ? chosen : designKit;
  const kit = useMemo(() => kits.data?.find((k) => k.id === kitId) ?? null, [kits.data, kitId]);
  const logoSize = useNaturalSize(kit?.logo_url || null);
  const input = useMemo(() => brandInput(kit, logoSize), [kit, logoSize]);

  const choose = useCallback((id: number | null) => {
    useLeft.getState().setBrandKit(designId, id);
    const st = useEditor.getState();
    if (st.design && st.design.brand_kit_id !== id) st.setMeta({ brand_kit_id: id });
  }, [designId]);

  return { kits, kit, kitId, input, logoSize, choose };
}
