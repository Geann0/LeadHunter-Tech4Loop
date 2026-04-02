import { ipcRenderer, contextBridge } from "electron";

console.log("[Preload] Script carregado!");
console.log("[Preload] ipcRenderer disponível:", !!ipcRenderer);
console.log("[Preload] contextBridge disponível:", !!contextBridge);

// Expose IPC to renderer process with type safety
contextBridge.exposeInMainWorld("ipcRenderer", {
  send(channel: string, ...args: any[]) {
    ipcRenderer.send(channel, ...args);
  },
  on(channel: string, listener: (event: any, ...args: any[]) => void) {
    const wrappedListener = (_event: any, ...args: any[]) =>
      listener(_event, ...args);
    ipcRenderer.on(channel, wrappedListener);
    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
  removeListener(
    channel: string,
    listener: (event: any, ...args: any[]) => void
  ) {
    ipcRenderer.removeListener(channel, listener);
  },
  removeAllListeners(channel: string) {
    ipcRenderer.removeAllListeners(channel);
  },
  off(channel: string, listener: (event: any, ...args: any[]) => void) {
    ipcRenderer.off(channel, listener);
  },
  invoke(channel: string, ...args: any[]) {
    return ipcRenderer.invoke(channel, ...args);
  },
});

console.log("[Preload] window.ipcRenderer exposto!");
