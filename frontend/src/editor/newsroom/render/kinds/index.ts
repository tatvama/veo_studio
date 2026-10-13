/** Every layer kind module, imported for its registration (docs/EDITOR.md §16.3). Import this once before drawing. */
import "./basic.ts";
import "./ticker.ts";
import "./clock.ts";
import "./number.ts";
import "./list.ts";
import "./bars.ts";
import "./table.ts";
import "./pins.ts";
import "./slot.ts";
import "./shine.ts";
import "./panels.ts";
import "./bg.ts";
export { layerKind, layerKinds, registerLayerKind, defaultProps } from "../registry.ts";
