import { useContext } from "react";
import { useAuthStatus, useSettings } from "../../lib/queries";
import { ROLE_RANK, type Project } from "../../lib/types";
import { ProjectContext } from "../../pages/project/context";

export interface CharScope {
  project: Project | null;
  projectId: number | undefined;
  /** Languages to show voices for: the project's, or every studio language in the character library. */
  languages: string[];
  primary: string;
  episodeNumber: number | undefined;
  canEdit: boolean;
  canProduce: boolean;
}

/**
 * Character screens work inside a project (Bible tab) and on their own (Characters page). Inside a project this reads
 * the project context; outside it falls back to the user's role and all languages.
 */
export function useCharScope(): CharScope {
  const ctx = useContext(ProjectContext);
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  if (ctx) {
    return {
      project: ctx.project, projectId: ctx.project.id, languages: ctx.project.languages, primary: ctx.project.primary_language,
      episodeNumber: ctx.project.episodes.find((e) => e.id === ctx.eid)?.number, canEdit: ctx.canEdit, canProduce: ctx.canProduce,
    };
  }
  const role = auth?.user?.role ?? "viewer";
  const languages = Object.keys(settings?.catalog.languages ?? { en: {} });
  return {
    project: null, projectId: undefined, languages, primary: languages[0] ?? "en", episodeNumber: undefined,
    canEdit: ROLE_RANK[role] >= ROLE_RANK.creator, canProduce: ROLE_RANK[role] >= ROLE_RANK.producer,
  };
}
