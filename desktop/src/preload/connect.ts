/** `window.tatvamConnect` for the Studio server window only (main/connect.ts). Sandboxed, CommonJS like the main bridge. */
import { contextBridge, ipcRenderer } from "electron";
import { CONNECT_IPC } from "../shared/types.ts";

contextBridge.exposeInMainWorld("tatvamConnect", {
  get: () => ipcRenderer.invoke(CONNECT_IPC.get),
  test: (url: string) => ipcRenderer.invoke(CONNECT_IPC.test, url),
  chooseFfmpeg: () => ipcRenderer.invoke(CONNECT_IPC.chooseFfmpeg),
  save: (patch: { serverUrl: string; uiSource: string; ffmpegPath: string }) => ipcRenderer.invoke(CONNECT_IPC.save, patch),
  close: () => ipcRenderer.invoke(CONNECT_IPC.close),
});
