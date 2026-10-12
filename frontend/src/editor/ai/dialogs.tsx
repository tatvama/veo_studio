/**
 * The AI tools' questions: the price of a paid run (the studio's CostConfirm), a list to review (silences to cut,
 * a language) and a line of text (an instruction). Mounted once in its own root, so a clip's context menu can ask
 * even while the AI panel is closed.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CostConfirm } from "../../components/growth/common";
import { Button, Input, Modal } from "../../components/ui";
import { useAi, type ChoiceAsk, type TextAsk } from "./store";

let mounted = false;

export function ensureDialogs(): void {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const el = document.createElement("div");
  el.dataset.tatvamAi = "dialogs";
  document.body.appendChild(el);
  createRoot(el).render(<AiDialogs />);
}

function AiDialogs() {
  const ask = useAi((s) => s.ask);
  if (!ask) return null;
  if (ask.kind === "price") {
    const over = ask.budgets.find((b) => !b.ok);
    return (
      <CostConfirm open onClose={() => ask.resolve(false)} title={ask.title} amount={ask.amount} lines={ask.lines}
        confirmLabel={over ? "Send for approval" : undefined}
        note={over ? `${over.reason} It waits for a ${over.needs_role ?? "producer"} to approve it.` : ask.note}
        onConfirm={async () => { ask.resolve(true); return true; }} />
    );
  }
  if (ask.kind === "choice") return <ChoiceDialog ask={ask} />;
  return <TextDialog ask={ask} />;
}

function ChoiceDialog({ ask }: { ask: ChoiceAsk }) {
  const [on, setOn] = useState(() => new Set(ask.items.filter((i) => i.checked).map((i) => i.id)));
  useEffect(() => { setOn(new Set(ask.items.filter((i) => i.checked).map((i) => i.id))); }, [ask]);
  const toggle = (id: string) => setOn((s) => {
    const n = new Set(ask.multiple ? s : []);
    if (s.has(id) && ask.multiple) n.delete(id); else n.add(id);
    return n;
  });
  return (
    <Modal open onClose={() => ask.resolve(null)} title={ask.title}
      footer={<>
        <Button variant="ghost" onClick={() => ask.resolve(null)}>Cancel</Button>
        <Button variant="primary" disabled={!on.size} onClick={() => ask.resolve(ask.items.filter((i) => on.has(i.id)).map((i) => i.id))}>
          {ask.confirmLabel}
        </Button>
      </>}>
      {ask.note && <p className="mb-3 text-sm text-mute">{ask.note}</p>}
      {ask.multiple && ask.items.length > 3 && (
        <div className="mb-2 flex gap-2 text-xs">
          <button className="text-accent hover:underline" onClick={() => setOn(new Set(ask.items.map((i) => i.id)))}>All</button>
          <button className="text-accent hover:underline" onClick={() => setOn(new Set())}>None</button>
        </div>
      )}
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {ask.items.map((i) => (
          <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-raised">
            <input type={ask.multiple ? "checkbox" : "radio"} checked={on.has(i.id)} onChange={() => toggle(i.id)} />
            <span className="min-w-0 flex-1 truncate">{i.label}</span>
            {i.detail && <span className="mono shrink-0 text-xs text-dim">{i.detail}</span>}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function TextDialog({ ask }: { ask: TextAsk }) {
  const [text, setText] = useState(ask.initial ?? "");
  const go = () => text.trim() && ask.resolve(text.trim());
  return (
    <Modal open onClose={() => ask.resolve(null)} title={ask.title}
      footer={<>
        <Button variant="ghost" onClick={() => ask.resolve(null)}>Cancel</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={go}>{ask.confirmLabel}</Button>
      </>}>
      <label className="block text-sm">
        <span className="mb-1 block text-mute">{ask.label}</span>
        <Input autoFocus value={text} placeholder={ask.placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
      </label>
    </Modal>
  );
}
