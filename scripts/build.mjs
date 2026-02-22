import path from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const root = process.cwd();
const distDir = path.join(root, "dist");

async function copyAssets() {
  await cp(path.join(root, "src", "manifest.json"), path.join(distDir, "manifest.json"));
  await cp(path.join(root, "src", "content", "styles.css"), path.join(distDir, "styles.css"));
  await cp(path.join(root, "src", "debug", "debug.html"), path.join(distDir, "debug.html"));
  await cp(
    path.join(root, "node_modules", "kuromoji", "build", "kuromoji.js"),
    path.join(distDir, "kuromoji.js")
  );

  const dictSrc = path.join(root, "node_modules", "kuromoji", "dict");
  const dictDst = path.join(distDir, "dict");
  await cp(dictSrc, dictDst, { recursive: true });
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await build({
    entryPoints: {
      content: path.join(root, "src", "content", "index.js"),
      background: path.join(root, "src", "background.js"),
      debug: path.join(root, "src", "debug", "debug.js")
    },
    bundle: true,
    format: "iife",
    target: ["chrome114"],
    outdir: distDir,
    entryNames: "[name]",
    sourcemap: false,
    minify: false,
    logLevel: "info"
  });

  await copyAssets();
  console.log("Build completed. Load dist/ as unpacked extension in Chrome.");
}

main().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
