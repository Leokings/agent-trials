import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json" with { type: "json" };

const endpoint = "https://studio.genlayer.com/api";
const creator = createAccount(`0x${randomBytes(32).toString("hex")}`);
const agentKey = `0x${randomBytes(32).toString("hex")}`;
const agent = createAccount(agentKey);
const creatorClient = createClient({ chain: studionet, endpoint, account: creator });
const agentClient = createClient({ chain: studionet, endpoint, account: agent });
const reader = createClient({ chain: studionet, endpoint });
const trialId = `agent-run-${randomBytes(5).toString("hex")}`;
const answer = "The job is PENDING, not failed or completed. Check the same job ID again later. Do not create a new job ID. DONE is the completed status.";
const criteria = [
  "States the job is pending, not failed.",
  "States that PENDING is not completion.",
  "Advises checking the same job ID again.",
  "Does not advise creating a new job ID.",
  "States that DONE is the completed status.",
];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const write = (client, functionName, args, leaderOnly) => client.writeContract({
  address: deployment.address, functionName, args, value: 0n, leaderOnly,
});
const read = (functionName, args = []) => reader.readContract({
  address: deployment.address, functionName, args, transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
});

async function waitFinal(label, hash, actor, timeoutMs = 240_000) {
  console.log(`${label}: ${hash}`);
  const until = Date.now() + timeoutMs;
  let acceptedSince = 0;
  let lastFinalize = 0;
  while (Date.now() < until) {
    try {
      const tx = await reader.getTransaction({ hash });
      const status = String(tx.statusName ?? tx.status ?? "PENDING").toUpperCase();
      const execution = String(tx.txExecutionResultName ?? tx.consensus_data?.leader_receipt?.[0]?.execution_result ?? "NOT_VOTED").toUpperCase();
      if (status === "FINALIZED") {
        if (execution !== "SUCCESS" && execution !== "FINISHED_WITH_RETURN") throw new Error(`${label} finalized with ${execution}`);
        console.log(`${label}: FINALIZED / ${execution}`);
        return;
      }
      if (status === "ACCEPTED" && !acceptedSince) acceptedSince = Date.now();
      if (acceptedSince && Date.now() - acceptedSince > 45_000 && Date.now() - lastFinalize > 60_000) {
        lastFinalize = Date.now();
        try { await actor.finalizeTransaction({ txId: hash }); } catch { /* Follow the original hash. */ }
      }
    } catch (error) {
      if (String(error.message).includes("finalized with")) throw error;
    }
    await pause(5_000);
  }
  throw new Error(`${label} did not finalize within ${timeoutMs / 1000}s. Original hash: ${hash}`);
}

const directory = await mkdtemp(join(tmpdir(), "agent-trials-live-"));
try {
  console.log(`Live agent test trial: ${trialId}`);
  await waitFinal("Register", await write(agentClient, "register_agent", [`Runner-${trialId.slice(-6)}`], true), agentClient);
  const commitAt = Date.now() + 180_000;
  const revealAt = commitAt + 90_000;
  await waitFinal("Create", await write(creatorClient, "create_trial", [
    trialId, "Agent runner integration trial",
    "Explain the pending background job and the safest next step using only the fixed evidence.",
    "The status API returns PENDING until the background job completes. A PENDING job must not be retried with a new ID. A completed job returns DONE.",
    JSON.stringify(criteria), commitAt, revealAt,
  ], true), creatorClient);
  const answerPath = join(directory, "answer.txt");
  await writeFile(answerPath, answer, { mode: 0o600 });
  const runner = spawn(process.execPath, [resolve("scripts/agent-runner.mjs"), "run", "--trial", trialId,
    "--name", `Runner-${trialId.slice(-6)}`, "--answer-file", answerPath], {
    cwd: process.cwd(), env: { ...process.env,
      AGENT_TRIALS_PROVIDER_MODULE: resolve("tests/fixtures/studionet-test-provider.mjs"),
      AGENT_TRIALS_WALLET_MODULE: "",
      AGENT_TRIALS_STATE_DIR: join(directory, "state"), AGENT_PRIVATE_KEY: agentKey },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  runner.stdout.on("data", (chunk) => process.stdout.write(chunk));
  runner.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const code = await new Promise((done, reject) => {
    const timeout = setTimeout(() => { runner.kill(); reject(new Error("Agent runner timed out after 10 minutes.")); }, 10 * 60_000);
    runner.on("exit", (exitCode) => { clearTimeout(timeout); done(exitCode); });
    runner.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  if (code !== 0) throw new Error(`Agent runner exited with code ${code}.`);
  const saved = JSON.parse(await readFile(join(directory, "state", `${trialId}-${agent.address.toLowerCase()}.json`), "utf8"));
  if (!saved.tx?.score?.hash || saved.tx.score.finalized !== true) {
    throw new Error("Agent runner stopped before confirming score finalization.");
  }
  await waitFinal("Runner score", saved.tx.score.hash, agentClient, 360_000);
  const entry = await read("get_entry", [trialId, agent.address]);
  if (!entry.scored || entry.result?.points !== 100 || entry.result?.checks?.some((item) => item !== true)) {
    throw new Error(`Finalized agent score was not 100/100: ${JSON.stringify(entry.result)}`);
  }
  console.log(`PASS: existing EIP-1193 agent wallet → one-command runner → sealed answer → timed reveal → finalized GenLayer score 100/100 (${trialId})`);
} finally {
  if (!directory.startsWith(join(tmpdir(), "agent-trials-live-"))) throw new Error("Unsafe temporary directory cleanup target.");
  await rm(directory, { recursive: true, force: true });
}
