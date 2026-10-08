import { createHash, randomBytes } from "node:crypto";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json" with { type: "json" };

const endpoint = "https://studio.genlayer.com/api";
const reader = createClient({ chain: studionet, endpoint });
const creator = createAccount(`0x${randomBytes(32).toString("hex")}`);
const agent = createAccount(`0x${randomBytes(32).toString("hex")}`);
const creatorClient = createClient({ chain: studionet, endpoint, account: creator });
const agentClient = createClient({ chain: studionet, endpoint, account: agent });
const trialId = `full-flow-${randomBytes(5).toString("hex")}`;
const answer = "The job is PENDING, not failed or completed. Check the same job ID again later. Do not create a new job ID. DONE is the completed status.";
const salt = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(
  `agent-trials:v1\n${trialId}\n${agent.address.toLowerCase()}\n${Buffer.byteLength(answer, "utf8")}:${answer}\n${salt}`,
).digest("hex");
const criteria = [
  "States the job is pending, not failed.",
  "States that PENDING is not completion.",
  "Advises checking the same job ID again.",
  "Does not advise creating a new job ID.",
  "States that DONE is the completed status.",
];

const read = (functionName, args = []) => reader.readContract({
  address: deployment.address, functionName, args,
  transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
});

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const write = (client, functionName, args, leaderOnly) => client.writeContract({
  address: deployment.address, functionName, args, value: 0n, leaderOnly,
});

async function waitFinal(label, hash, actor, timeoutMs = 180_000) {
  console.log(`${label}: ${hash}`);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "PENDING";
  let lastFinalizeAttempt = 0;
  let acceptedSince = 0;
  while (Date.now() < deadline) {
    try {
      const receipt = await reader.getTransaction({ hash });
      lastStatus = receipt.statusName ?? String(receipt.status ?? "PENDING");
      if (lastStatus === "FINALIZED") {
        const leader = receipt.consensus_data?.leader_receipt?.[0];
        const execution = receipt.txExecutionResultName ?? leader?.execution_result;
        if (execution !== "SUCCESS" && execution !== "FINISHED_WITH_RETURN") {
          throw new Error(`${label} finalized without success: ${execution ?? "unknown"} ${JSON.stringify(leader?.result ?? {})}`);
        }
        console.log(`${label}: FINALIZED / ${execution}`);
        return receipt;
      }
      if (lastStatus === "ACCEPTED" && !acceptedSince) acceptedSince = Date.now();
      if (lastStatus === "ACCEPTED" && Date.now() - acceptedSince > 45_000
        && Date.now() - lastFinalizeAttempt > 30_000) {
        lastFinalizeAttempt = Date.now();
        try { await actor.finalizeTransaction({ txId: hash }); }
        catch { /* Too early or already being finalized; continue following the original hash. */ }
      }
    } catch (error) {
      if (String(error?.message ?? error).includes("finalized without success")) throw error;
    }
    await pause(3_000);
  }
  throw new Error(`${label} did not finalize within ${timeoutMs / 1000}s (last status: ${lastStatus}; hash: ${hash})`);
}

async function waitUntil(timestamp, label) {
  const waitMs = timestamp + 5_000 - Date.now();
  if (waitMs > 0) {
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for ${label}`);
    await pause(waitMs);
  }
}

console.log(`Trial: ${trialId}; creator: ${creator.address}; agent: ${agent.address}`);
const registerHash = await write(agentClient, "register_agent", [`Test-${trialId.slice(-8)}`], true);
await waitFinal("Register", registerHash, agentClient);

const commitAt = Date.now() + 150_000;
const revealAt = commitAt + 90_000;
const createTxHash = await write(creatorClient, "create_trial", [
  trialId,
  "Full flow integration trial",
  "Explain the pending background job and the safest next step using only the fixed evidence.",
  "The status API returns PENDING until the background job completes. A PENDING job must not be retried with a new ID. A completed job returns DONE.",
  JSON.stringify(criteria), commitAt, revealAt,
], true);
await waitFinal("Create", createTxHash, creatorClient);
const trial = await read("get_trial", [trialId]);
if (trial.official !== false || trial.creator !== creator.address.toLowerCase()) {
  throw new Error("Community trial identity is wrong");
}

const commitHash = await write(agentClient, "commit_answer", [trialId, digest], true);
await waitFinal("Commit", commitHash, agentClient);
let entry = await read("get_entry", [trialId, agent.address]);
if (!entry.committed || entry.revealed || entry.answer !== "") throw new Error("Commit privacy/state failed");

await waitUntil(commitAt, "reveal window");
const revealHash = await write(agentClient, "reveal_answer", [trialId, answer, salt], true);
await waitFinal("Reveal", revealHash, agentClient);
entry = await read("get_entry", [trialId, agent.address]);
if (!entry.revealed || entry.answer !== answer) throw new Error("Reveal state failed");

await waitUntil(revealAt, "scoring window");
const scoreHash = await write(creatorClient, "score_answer", [trialId, agent.address], false);
await waitFinal("Score", scoreHash, creatorClient, 360_000);
entry = await read("get_entry", [trialId, agent.address]);
if (!entry.scored || entry.result?.points !== 100 || entry.result?.checks?.some((check) => check !== true)) {
  throw new Error(`Final score did not match the five clear checks: ${JSON.stringify(entry.result)}`);
}
const status = await read("get_agent_status", [agent.address]);
if (status.points !== 0 || status.scored_trials !== 0) {
  throw new Error("Community result leaked into official global reputation");
}
console.log(`PASS: register → create → commit → reveal → validator-consensus score (100/100) → finalized state; community ranking isolated. Trial ${trialId}`);
