/** A wave-3 transition ("tv:<id>"): GLSL ES 3.00 `vec4 transition(vec2 uv)` in image space (uv y down), with the pack
 *  prelude (getFromColor / getToColor, progress, ratio, bgColor(), noise, geometry and colour helpers). */
export type PackGroup = "Luma mattes" | "Light" | "Motion" | "Glitch & retro" | "3D";
export const PACK_GROUPS: PackGroup[] = ["Luma mattes", "Light", "Motion", "Glitch & retro", "3D"];

export interface PackParam {
  name: string; type: "float" | "int" | "bool" | "vec2" | "vec3" | "vec4";
  default: number | boolean | number[]; min?: number; max?: number; step?: number; color?: boolean; description?: string;
}

export interface PackTransition {
  id: string; label: string; group: PackGroup; glsl: string; params: PackParam[];
  /** The inputs get a mip chain (blur by level). */
  mips?: boolean;
  /** Luma mattes: the matte the renderer generates into `u_matte`. */
  matte?: string;
  tags?: string[];
}
