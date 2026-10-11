/// <reference types="vitest/config" />
import { defineConfig } from "vite";

/** BASE_PATH env (e.g. "/EuroTrainBusMap/") sets the public base; default "/". */
function basePath(): string {
  const b = process.env.BASE_PATH?.trim();
  if (!b) return "/";
  if (b === "." || b === "./") return "./";
  return `/${b.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
}

export default defineConfig({
  base: basePath(),
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: { manualChunks: { maplibre: ["maplibre-gl"] } },
    },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
