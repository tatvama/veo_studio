import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Class-name joiner that also resolves Tailwind conflicts, so `<Button className="h-7 px-2">` really overrides the
 * button's own `h-9 px-3.5`. Our custom design tokens are registered so they aren't mistaken for colours.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs"] }],
      shadow: [{ shadow: ["card", "lift", "pop", "modal", "glow"] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
