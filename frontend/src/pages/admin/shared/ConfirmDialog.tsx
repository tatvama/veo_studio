import type { ReactNode } from "react";
import { Button, Modal } from "../../../components/ui";
import { useT } from "../../../lib/i18n";

/** Confirmation before something destructive (replaces the browser's confirm box). Cancel has focus by default. */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel, danger = true, busy, onConfirm, icon }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void | Promise<void>; icon?: ReactNode;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} size="sm" title={title}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus>{t("Cancel")}</Button>
        <Button variant={danger ? "danger" : "primary"} icon={icon} loading={busy} onClick={() => void onConfirm()}>{confirmLabel}</Button>
      </>}>
      <div className="text-sm leading-relaxed text-mute">{children}</div>
    </Modal>
  );
}
