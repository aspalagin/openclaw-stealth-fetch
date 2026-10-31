// Verify the actual npm artifact in a fresh consumer against a public OpenClaw peer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const work = process.env.PACK_TEST_DIR ? resolve(process.env.PACK_TEST_DIR) : mkdtempSync(join(tmpdir(), "stealth-pack-"));
const destination = process.env.PACK_DESTINATION ? resolve(process.env.PACK_DESTINATION) : join(work, "artifacts");
mkdirSync(work, { recursive: true });
mkdirSync(destination, { recursive: true });
const npm = (args, cwd = root) => execFileSync(process.env.npm_execpath ? process.execPath : "npm", process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dry = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"]))[0];
const allowed = new Set(["package.json", ...manifest.files]);
for (const entry of dry.files) {
  assert.ok(allowed.has(entry.path), "Unexpected packed path: " + entry.path);
  assert.ok(!entry.path.includes("node_modules") && !entry.path.includes(".release-work"));
}
for (const required of ["dist/index.js", "openclaw.plugin.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "sidecar/stealth_fetch/config.py"]) {
  assert.ok(dry.files.some((f) => f.path === required), "Missing packed file: " + required);
}
const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination]))[0];
const archive = join(destination, packed.filename);
const consumer = join(work, "consumer");
assert.ok(!existsSync(consumer), "Use a fresh PACK_TEST_DIR for each clean-install check");
mkdirSync(consumer);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "stealth-pack-consumer", private: true, type: "module" }));
npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", archive, "openclaw@2026.10.5"], consumer);
// Read a source-controlled harness, not files from a live OpenClaw installation.
writeFileSync(join(consumer, "smoke.mjs"), readFileSync(join(root, "scripts/pack-smoke.mjs")));
execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
console.log(JSON.stringify({ archive, files: dry.files.length, cleanInstall: "passed", peer: "openclaw@2026.10.5" }));
