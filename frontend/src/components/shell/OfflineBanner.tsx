import { WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

/** Slim banner while the browser has no network. Work is safe; the app resumes by itself when it's back. */
export function OfflineBanner() {
  const t = useT();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return (
    <AnimatePresence>
      {!online && (
        <motion.div
          role="status"
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
          className="fixed left-1/2 top-3 z-[95] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warn/40 bg-raised px-4 py-2 text-sm font-medium shadow-pop"
        >
          <WifiOff className="size-4 text-warn" />
          {t("You're offline — reconnecting when the network is back")}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
