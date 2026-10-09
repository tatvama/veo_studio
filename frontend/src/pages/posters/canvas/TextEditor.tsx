/**
 * Inline text editing: an HTML textarea laid exactly over a text layer (same font, size, spacing, alignment), moved,
 * rotated and scaled with the canvas. Click outside or Ctrl/⌘+Enter commits; Escape cancels.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { familyStack, loadFont } from "../fonts";
import type { TextLayer } from "../types";
import type { View } from "./overlays";
import { cssPaint, isGradient, isTransparent } from "./paint";
import { layoutText } from "./textLayout";

export function TextEditor({ layer: l, view, fontsVersion, onCommit, onCancel }: {
  layer: TextLayer; view: View; fontsVersion: number; onCommit: (text: string) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(l.text);
  const done = useRef(false);
  const lay = layoutText(l, l.width, l.height, fontsVersion);
  const pad = l.background ? l.background.padding : 0;

  useEffect(() => {
    void loadFont(l.fontFamily, l.fontWeight, l.fontStyle, l.text || "Aa");
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, lay.fontSize, l.width]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  const gradient = isGradient(l.fill);
  const fillVisible = !isTransparent(l.fill);
  const stroke = l.stroke && l.stroke.width > 0 ? l.stroke : null;
  const sh = l.shadow && l.shadow.opacity > 0 ? l.shadow : null;
  // browsers lay text out a hair wider than the canvas measures; a little slack stops early wrapping
  const slack = Math.max(0, lay.letterSpacing) + lay.fontSize * 0.04 + 2;
  const justify = l.verticalAlign === "top" ? "flex-start" : l.verticalAlign === "bottom" ? "flex-end" : "center";

  return (
    <div
      className="pst-text-editor"
      style={{
        width: l.width, height: l.height, padding: pad, justifyContent: justify,
        transform: `translate(${view.x + l.x * view.z}px, ${view.y + l.y * view.z}px) rotate(${l.rotation || 0}deg) scale(${view.z})`,
        opacity: l.opacity, ["--pst-z" as string]: view.z,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        spellCheck={false}
        aria-label="Edit text"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); finish(false); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        }}
        style={{
          width: `calc(100% + ${slack}px)`, marginLeft: l.align === "center" ? -slack / 2 : l.align === "right" ? -slack : 0,
          fontFamily: familyStack(l.fontFamily), fontSize: lay.fontSize, fontWeight: l.fontWeight, fontStyle: l.fontStyle,
          lineHeight: l.lineHeight > 0 ? l.lineHeight : 1.2, letterSpacing: `${lay.letterSpacing}px`, textAlign: l.align,
          textTransform: l.uppercase ? "uppercase" : "none",
          color: gradient || !fillVisible ? "transparent" : (l.fill as string),
          backgroundImage: gradient ? cssPaint(l.fill) : undefined,
          WebkitBackgroundClip: gradient ? "text" : undefined, backgroundClip: gradient ? "text" : undefined,
          WebkitTextStroke: stroke ? `${(fillVisible ? 2 : 1) * lay.strokeWidth}px ${stroke.color}` : undefined,
          paintOrder: "stroke fill",
          textShadow: sh ? `${sh.x}px ${sh.y}px ${sh.blur}px color-mix(in srgb, ${sh.color} ${Math.round(sh.opacity * 100)}%, transparent)` : undefined,
        }}
      />
    </div>
  );
}
