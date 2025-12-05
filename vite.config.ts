import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: [
                "playwright",
                "playwright-core",
                "chromium-bidi",
                "devtools-protocol",
                "ws",
              ],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, "electron/preload.ts"),
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: "cjs", // CommonJS para o preload
                entryFileNames: "preload.cjs", // .cjs em vez de .mjs
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
});
