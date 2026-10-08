import { createContext, useContext } from "react";
import type { Project } from "../../lib/types";

export interface ProjectCtx {
  project: Project;
  eid: number;
  lang: string;
  setLang: (l: string) => void;
  setEpisode: (eid: number) => void;
  canEdit: boolean;
  canReview: boolean;
  canProduce: boolean;
}

export const ProjectContext = createContext<ProjectCtx | null>(null);

export function useProjectCtx(): ProjectCtx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("useProjectCtx outside ProjectLayout");
  return c;
}
