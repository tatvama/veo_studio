import { Gauge } from "lucide-react";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { useT } from "../../lib/i18n";

/** Production dashboard: progress, footage, spend and the cost of every approved second. (Filled in by the dashboard build.) */
export default function DashboardPage() {
  const t = useT();
  return (
    <RoomPage>
      <RoomHeader icon={Gauge} title={t("Dashboard")} description={t("Progress, footage, spend and what still needs doing.")} />
    </RoomPage>
  );
}
