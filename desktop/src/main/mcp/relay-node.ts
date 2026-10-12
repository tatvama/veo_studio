/**
 * The stdio relay's process (docs/EDITOR.md §13.1): `"Tatvam Studio.exe" --mcp-stdio` starts this file in Node mode
 * (ELECTRON_RUN_AS_NODE, see stdio.ts relayViaNode) with the MCP app's stdin and stdout, so the protocol flows through
 * plain Node streams. Bundled on its own (dist/mcp-relay.cjs): no Electron here.
 */
import { RELAY_ENV, startStdioRelay } from "./stdio.ts";

const env = process.env;
let args: string[] = [];
try { args = JSON.parse(env[RELAY_ENV.args] ?? "[]") as string[]; } catch { args = []; }
void startStdioRelay({ userData: env[RELAY_ENV.userData] ?? "", exe: env[RELAY_ENV.exe] ?? process.execPath, args, env, exit: (code) => process.exit(code) });
