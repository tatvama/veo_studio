import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { Toaster } from "sonner";
import { useResolvedTheme } from "./theme";

/** Sonner toaster that follows the app theme: neutral raised surface, status shown by icon + a tinted edge. */
export function ThemedToaster() {
  const theme = useResolvedTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      gap={10}
      offset={{ bottom: 20, right: 20 }}
      mobileOffset={{ bottom: 12, left: 12, right: 12 }}
      icons={{
        success: <CheckCircle2 className="size-[18px] text-ok" />,
        error: <XCircle className="size-[18px] text-bad" />,
        warning: <AlertTriangle className="size-[18px] text-warn" />,
        info: <Info className="size-[18px] text-info" />,
        loading: <Loader2 className="size-[18px] animate-spin text-mute" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border !border-line !bg-raised !text-ink !shadow-pop !font-sans !text-sm !gap-3 !py-3",
          title: "!font-medium !text-ink",
          description: "!text-mute !text-xs",
          closeButton: "!border-line !bg-raised !text-mute hover:!bg-hover hover:!text-ink",
          success: "!border-l-[3px] !border-l-ok",
          error: "!border-l-[3px] !border-l-bad",
          warning: "!border-l-[3px] !border-l-warn",
          info: "!border-l-[3px] !border-l-info",
          actionButton: "!bg-accent !text-[var(--on-accent)] !font-medium !rounded-md",
          cancelButton: "!bg-hover !text-ink !rounded-lg",
        },
      }}
    />
  );
}
