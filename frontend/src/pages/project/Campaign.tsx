import { Megaphone } from "lucide-react";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { useT } from "../../lib/i18n";

/** Ads & Reels: campaign wizard (variants per language and aspect) and the reels highlight flow. (Filled in by the campaign build.) */
export default function CampaignPage() {
  const t = useT();
  return (
    <RoomPage>
      <RoomHeader icon={<Megaphone size={18} />} title={t("Ads & Reels")} description={t("One brief, every language and aspect ratio. Reels cut from what you already made.")} />
    </RoomPage>
  );
}
