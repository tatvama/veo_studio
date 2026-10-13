/**
 * The tool-call executor (docs/EDITOR.md §13.1), mounted by the editor: this window attaches its open edit, so the
 * main process routes assistant tool calls here; each runs as an "Assistant: <tool>" command (bridge/tools.ts) and the
 * answer goes back. Renders nothing.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useEditor } from "../../editor/store";
import { assistantsBridge, errText } from "../api";
import { PAGE_TOOLS } from "./tools";

export default function AssistantExecutor() {
  const nav = useNavigate();
  const navRef = useRef(nav);
  navRef.current = nav;
  const path = useEditor((s) => s.path);
  const name = useEditor((s) => s.h.present.name);
  const dirty = useEditor((s) => s.h.present !== s.saved);

  useEffect(() => {
    const b = assistantsBridge();
    if (!b || !path) return;
    void b.attach(path, { name, dirty }).catch(() => undefined);
    // one call at a time, in order (a later call sees what an earlier one did)
    let chain: Promise<unknown> = Promise.resolve();
    const off = b.onCall((call) => {
      chain = chain.then(async () => {
        try {
          const tool = PAGE_TOOLS[call.tool];
          if (!tool) throw new Error(`The editor doesn't know ${call.tool}`);
          const result = await tool(call.args ?? {}, call, { navigate: (u) => navRef.current(u) });
          await b.reply(call.id, { ok: true, result });
        } catch (e) {
          await b.reply(call.id, { ok: false, error: errText(e) }).catch(() => undefined);
        }
      });
    });
    return () => { off(); void b.detach(path).catch(() => undefined); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // unsaved changes and the name, for open_edit's check
  useEffect(() => {
    const b = assistantsBridge();
    if (b && path) void b.attach(path, { name, dirty }).catch(() => undefined);
  }, [path, name, dirty]);

  return null;
}
