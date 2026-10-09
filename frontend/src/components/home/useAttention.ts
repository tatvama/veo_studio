import { useMemo } from "react";
import { useApprovals, useAuthStatus, useNotifications } from "../../lib/queries";
import type { Approval, Notification } from "../../lib/types";

/**
 * Everything that is waiting on this person: approvals they can decide or asked for themselves, plus mentions and
 * budget alerts. (The notification feed repeats approvals for producers, so those are dropped from `notes`.)
 */
export function useAttention() {
  const approvalsQ = useApprovals();
  const notesQ = useNotifications();
  const { data: auth } = useAuthStatus();
  const meId = auth?.user?.id;
  const approvals = approvalsQ.data;
  const all = notesQ.data;
  return useMemo(() => {
    const mine: Approval[] = (approvals ?? []).filter((a) => a.can_decide || (meId !== undefined && a.requested_by_user?.id === meId));
    const notes: Notification[] = (all ?? []).filter((n) => n.type !== "approval");
    return {
      approvals: mine,
      /** approvals this person can decide right now */
      deciding: mine.filter((a) => a.can_decide).length,
      notes,
      total: mine.length + notes.length,
      loading: approvalsQ.isLoading || notesQ.isLoading,
      error: approvalsQ.isError && notesQ.isError,
      retry: () => { void approvalsQ.refetch(); void notesQ.refetch(); },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvals, all, meId, approvalsQ.isLoading, notesQ.isLoading, approvalsQ.isError, notesQ.isError]);
}
