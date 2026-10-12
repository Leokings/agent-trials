import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function getPinnedEvidence() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Could not determine the committed evidence fixture revision.");
  const body = await readFile(resolve(root, "tests/fixtures/pinned-evidence.txt"));
  return {
    evidenceSourceUrl: `https://raw.githubusercontent.com/Leokings/agent-trials/${commit}/tests/fixtures/pinned-evidence.txt`,
    evidenceSourceSha256: createHash("sha256").update(body).digest("hex"),
  };
}
