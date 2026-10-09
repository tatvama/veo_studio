/**
 * What the sign-in page shows: cinematic stills made with the studio's own AI engines (media in public/showcase/,
 * made by scripts/showcase/generate.py, which also writes slides.generated.ts) and the engine lineup the studio can drive.
 */
export interface Slide {
  slug: string;
  title: string;
  /** Engine that made the still. */
  model: string;
  /** Optional motion loop (mp4 in public/showcase/) and the engine that animated it. */
  loop?: string;
  loopModel?: string;
}

export { SLIDES } from "./slides.generated";

export type EngineKind = "Video" | "Image" | "Voice" | "Lip-sync" | "Writing";
export interface Engine { name: string; via: "Google" | "fal.ai" | "ElevenLabs" | "Sarvam" | "sync.so"; kind: EngineKind }

/** The lineup on the sign-in page. Google is the default route; fal.ai brings the rest of the field under one key. */
export const ENGINES: Engine[] = [
  { name: "Veo 3.1", via: "Google", kind: "Video" },
  { name: "Kling 3", via: "fal.ai", kind: "Video" },
  { name: "Seedance 2.5", via: "fal.ai", kind: "Video" },
  { name: "Nano Banana", via: "Google", kind: "Image" },
  { name: "Wan 3.0", via: "fal.ai", kind: "Video" },
  { name: "Hailuo H3", via: "fal.ai", kind: "Video" },
  { name: "FLUX1.1 Ultra", via: "fal.ai", kind: "Image" },
  { name: "Gemini 3", via: "Google", kind: "Writing" },
  { name: "LTX 2.5", via: "fal.ai", kind: "Video" },
  { name: "Seedream 5", via: "fal.ai", kind: "Image" },
  { name: "Grok Imagine", via: "fal.ai", kind: "Video" },
  { name: "ElevenLabs", via: "ElevenLabs", kind: "Voice" },
  { name: "Sarvam Bulbul", via: "Sarvam", kind: "Voice" },
  { name: "Kling Avatar", via: "fal.ai", kind: "Lip-sync" },
  { name: "sync-3", via: "sync.so", kind: "Lip-sync" },
];
