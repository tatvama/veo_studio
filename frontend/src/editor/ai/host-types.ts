/**
 * The editor's side of the AI tools (docs/EDITOR.md §8). The editor implements EditorHost (editor/host.ts); the AI
 * code imports it, and the document model's types, from here only, so it never reaches into the editor's UI.
 */
export type { EditorHost } from "../host";
export type { EditProject, Marker, MediaItem, Sequence, TimelineClip, TitleSpec, Track } from "../model/types.ts";
