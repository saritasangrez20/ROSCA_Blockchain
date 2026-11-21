import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const deploymentsDir = path.resolve(__dirname, "..", "deployments");

// Serves ../deployments/<network>.json at /deployments/<network>.json, read fresh on every
// request, so redeploying the contracts never needs a frontend restart. The file is written by
// `npm run deploy:local` or `npm run seed:local` and is not committed.
function deploymentsPlugin() {
  return {
    name: "rosca-deployments",
    configureServer(server) {
      server.middlewares.use("/deployments", (req, res, next) => {
        const name = path.basename((req.url || "").split("?")[0]);
        const file = path.join(deploymentsDir, name);
        if (!name.endsWith(".json") || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(fs.readFileSync(file));
      });
    },
    // For `npm run build`, copy whatever deployment files exist into dist/deployments.
    writeBundle(options) {
      const out = path.join(options.dir, "deployments");
      fs.mkdirSync(out, { recursive: true });
      for (const f of fs.readdirSync(deploymentsDir)) if (f.endsWith(".json")) fs.copyFileSync(path.join(deploymentsDir, f), path.join(out, f));
    },
  };
}

export default defineConfig({
  plugins: [react(), deploymentsPlugin()],
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    // ABIs are imported straight from ../deployments/abi (exported by scripts/deploy.js).
    fs: { allow: [".."] },
  },
});
