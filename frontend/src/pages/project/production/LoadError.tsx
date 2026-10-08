import { TriangleAlert } from "lucide-react";
import { Button, Empty } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/** What a page shows when its data failed to load: say so and offer a retry. */
export function LoadError({ what, onRetry, compact }: { what: string; onRetry: () => void; compact?: boolean }) {
  const t = useT();
  return (
    <div className={compact ? "p-4" : "p-6"}>
      <Empty icon={<TriangleAlert className="size-7" />} title={t("Couldn't load {what}", { what })}
        sub={t("Check your connection and try again.")} action={<Button variant="primary" onClick={onRetry}>{t("Try again")}</Button>} />
    </div>
  );
}
