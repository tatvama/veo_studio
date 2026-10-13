/**
 * Typing into the News Room's forms (docs/EDITOR.md §16.8): every key shows at once (the program monitor follows),
 * yet one field focus is one undo step. The first change opens a gesture (store.ts), each further key previews the
 * new value from the same starting document, and leaving the field commits it. `fn` must give the whole new state
 * from the base document (the room/doc.ts updaters do), so previews never pile up.
 */
import type { EditProject } from "../../model/types";
import { ed, gesture } from "../../store";

let open: { key: string; label: string } | null = null;
const mine = () => !!open && ed().h.gesture?.label === open.label;

/** Shows a change while a field is being typed into (`key` names the field, e.g. "story:s1:headline"). */
export function liveEdit(label: string, key: string, fn: (base: EditProject) => EditProject) {
  if (open?.key !== key || !mine()) {
    if (mine()) gesture.commit();
    gesture.begin(label);
    open = { key, label };
  }
  gesture.preview(fn);
}

/** The field was left (blur, Enter): its changes become one undo step. */
export function liveDone(key?: string) {
  if (!open || (key && open.key !== key)) return;
  if (mine()) gesture.commit();
  open = null;
}
