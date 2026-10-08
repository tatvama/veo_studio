import { Globe } from "lucide-react";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { useT } from "../../lib/i18n";

/** World: props, the wardrobe timeline and the Continuity Bible. (Filled in by the world build.) */
export default function WorldPage() {
  const t = useT();
  return (
    <RoomPage>
      <RoomHeader icon={Globe} title={t("World")} description={t("Props, wardrobe through the episode, and the state of every scene.")} />
    </RoomPage>
  );
}
