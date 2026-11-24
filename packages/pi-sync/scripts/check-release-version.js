import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseJson(output) {
  try { return JSON.parse(output); } catch { return undefined; }
}

let name;
let version;
try {
  ({ name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  if (typeof name !== "string" || typeof version !== "string") throw new Error("Missing name or version");
} catch (error) {
  console.error(`Invalid package.json: ${error.message}`);
  process.exit(1);
}

const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
  encoding: "utf8",
  timeout: 15000,
});
const response = parseJson(result.stdout);
if (!result.error && typeof result.status === "number" && result.status !== 0 && response?.error?.code === "E404") process.exit(0);
if (!result.error && result.status === 0 && response === version) {
  console.error(`${name}@${version} is already published; update package.json's version.`);
  process.exit(1);
}
console.error(`Could not verify ${name}@${version} is unpublished; refusing to release.`);
process.exit(1);
