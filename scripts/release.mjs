import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(script, label) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`release: ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

run("migrate.mjs", "migrate");
run("seed.mjs", "seed");
console.log("release: complete");
