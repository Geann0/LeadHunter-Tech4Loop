export interface IpcRenderer {
  send(channel: string, ...args: any[]): void;
  on(
    channel: string,
    listener: (event: any, ...args: any[]) => void
  ): () => void;
  removeListener(
    channel: string,
    listener: (event: any, ...args: any[]) => void
  ): void;
  removeAllListeners(channel: string): void;
  off(channel: string, listener: (event: any, ...args: any[]) => void): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
}

declare global {
  interface Window {
    ipcRenderer?: IpcRenderer;
  }
}

export {};
