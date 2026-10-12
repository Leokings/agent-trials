import { randomBytes } from "node:crypto";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json" with { type: "json" };
import { getPinnedEvidence } from "./pinned-evidence.mjs";

const endpoint = "https://studio.genlayer.com/api";
const reader = createClient({ chain: studionet, endpoint });
const signer = createClient({ chain: studionet, endpoint, account: createAccount(`0x${randomBytes(32).toString("hex")}`) });
const { evidenceSourceUrl, evidenceSourceSha256 } = await getPinnedEvidence();
const validCriteria = [
  "States that PENDING means the job is still running.",
  "States that PENDING is not a completed status.",
  "Advises checking the existing job ID again.",
  "Warns against creating a new job ID for the same work.",
  "States that DONE means the job completed.",
];
const task = "Explain the status of a pending background job and the safest next step using only the fixed evidence.";
const before = await reader.readContract({ address: deployment.address, functionName: "get_policy", args: [], transactionHashVariant: TransactionHashVariant.LATEST_FINAL });

async function expectRejected(label, trialId, sourceDigest, criteria) {
  const now = Date.now();
  const hash = await signer.writeContract({
    address: deployment.address,
    functionName: "create_trial",
    args: [trialId, "Negative validation case", task, evidenceSourceUrl, sourceDigest, JSON.stringify(criteria), now + 120_000, now + 240_000],
    value: 0n,
    leaderOnly: true,
  });
  const deadline = Date.now() + 300_000;
  let receipt;
  while (Date.now() < deadline) {
    try {
      receipt = await reader.getTransaction({ hash });
      if (receipt.statusName === "FINALIZED") break;
    } catch { /* Continue checking the original transaction. */ }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (receipt?.statusName !== "FINALIZED") throw new Error(`${label} did not finalize (tx ${hash})`);
  const execution = receipt.txExecutionResultName ?? receipt.consensus_data?.leader_receipt?.[0]?.execution_result;
  if (execution === "SUCCESS" || execution === "FINISHED_WITH_RETURN") {
    throw new Error(`${label} was unexpectedly accepted (tx ${hash})`);
  }
  console.log(`PASS: ${label} rejected; tx=${hash}; execution=${execution ?? "failed"}`);
}

await expectRejected("incorrect evidence digest", `bad-source-${randomBytes(4).toString("hex")}`, "0".repeat(64), validCriteria);
const vagueCriteria = [...validCriteria];
vagueCriteria[2] = "Provides an inspiring, professional response that feels right.";
await expectRejected("subjective rubric criterion", `vague-rubric-${randomBytes(4).toString("hex")}`, evidenceSourceSha256, vagueCriteria);

const after = await reader.readContract({ address: deployment.address, functionName: "get_policy", args: [], transactionHashVariant: TransactionHashVariant.LATEST_FINAL });
if (after.trial_count !== before.trial_count) {
  throw new Error(`Rejected test cases changed trial count (${before.trial_count} → ${after.trial_count}).`);
}
console.log("PASS: both rejected transactions left contract state unchanged.");
