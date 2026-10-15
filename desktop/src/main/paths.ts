/**
 * Path confinement, shared by the editor's allow-list, the library, the bridge (library.open) and the MCP server.
 * One rule everywhere: a file is inside a folder when it is that folder or sits below it, compared case-insensitively
 * with either slash. A sibling folder that merely shares the prefix ("D:\A" vs "D:\AB") is outside.
 */
import path from "node:path";
import { pathKey } from "./naming.ts";

export function isInside(dir: string, file: string): boolean {
  const d = pathKey(path.resolve(dir));
  const f = pathKey(path.resolve(file));
  return f === d || f.startsWith(`${d}/`);
}
