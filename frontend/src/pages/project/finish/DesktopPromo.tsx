import { Cpu, FileType, HardDrive, Laptop, MonitorPlay, WifiOff } from "lucide-react";
import { SectionCard } from "../../../components/room/kit";
import { desktopLink } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";

/** On the web, the desktop-only cards fold into this: what the app adds, and a button that opens this episode in it. */
export function DesktopPromo({ pid, eid, className }: { pid: number; eid: number; className?: string }) {
  const t = useT();
  const adds = [
    { icon: <HardDrive />, label: t("Local project folder, synced") },
    { icon: <FileType />, label: t("Series file names in cut order") },
    { icon: <Cpu />, label: t("4K renders on your graphics card") },
    { icon: <MonitorPlay />, label: t("Windows on several screens") },
    { icon: <WifiOff />, label: t("Cutting offline") },
  ];
  return (
    <SectionCard className={className} icon={<Laptop />} title={t("Tatvam Desktop")}
      description={t("The finishing app for the editor who delivers the cut: local footage, 4K output with hardware encoding and several screens. AI still runs on the studio server, with the same costs and approvals.")}
      actions={(
        <a href={desktopLink(pid, eid)} className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-black">
          <Laptop className="size-4" />{t("Open in Tatvam Desktop")}
        </a>
      )}>
      <ul className="flex flex-wrap gap-1.5">
        {adds.map((a) => (
          <li key={a.label} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised/50 px-2 py-1 text-xs text-mute [&>svg]:size-3.5 [&>svg]:text-accent-ink">
            {a.icon}{a.label}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-2xs text-dim">{t("Nothing happens? Install Tatvam Desktop first — your administrator has the installer.")}</p>
    </SectionCard>
  );
}
