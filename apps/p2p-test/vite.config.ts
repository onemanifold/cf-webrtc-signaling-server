import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@cf-webrtc/client": path.resolve(__dirname, "../../packages/client/src/index.ts"),
    },
  },
});
