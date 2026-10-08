import { randomBytes } from "node:crypto";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json" with { type: "json" };

const endpoint = "https://studio.genlayer.com/api";
const account = createAccount(`0x${randomBytes(32).toString("hex")}`);
const client = createClient({ chain: studionet, endpoint, account });
const reader = createClient({ chain: studionet, endpoint });
const trialId = `public-smoke-${randomBytes(4).toString("hex")}`;
const commitAt = Date.now() + 10 * 60_000;
const revealAt = commitAt + 5 * 60_000;
const criteria = [
  "States that a pending job has not completed.",
  "Avoids treating a pending job as a failure.",
  "Suggests checking the existing job ID later.",
  "Does not suggest starting a duplicate job.",
  "Mentions that DONE is the completed status.",
];

const policy = await reader.readContract({
  address: deployment.address,
  functionName: "get_policy",
  args: [],
  transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
});
if (account.address.toLowerCase() === policy.owner.toLowerCase()) {
  throw new Error("Smoke account unexpectedly has owner access");
}

const hash = await client.writeContract({
  address: deployment.address,
  functionName: "create_trial",
  args: [
    trialId,
    "Public access smoke test",
    "Explain the status of a pending background job and the safest next step using only the fixed evidence.",
    "The status API returns PENDING until the background job completes. A PENDING job must not be retried with a new ID. A completed job returns DONE.",
    JSON.stringify(criteria),
    commitAt,
    revealAt,
  ],
  value: 0n,
  leaderOnly: true,
});
console.log(`Non-owner: ${account.address}`);
console.log(`Trial: ${trialId}`);
console.log(`Transaction: ${hash}`);

for (let attempt = 0; attempt < 45; attempt++) {
  const receipt = await reader.getTransaction({ hash });
  if (receipt.statusName === "FINALIZED") {
    const execution = receipt.txExecutionResultName
      ?? receipt.consensus_data?.leader_receipt?.[0]?.execution_result;
    if (execution !== "FINISHED_WITH_RETURN" && execution !== "SUCCESS") {
      throw new Error(`Creation finalized with ${execution}`);
    }
    const trial = await reader.readContract({
      address: deployment.address,
      functionName: "get_trial",
      args: [trialId],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
    if (trial.official !== false || trial.creator !== account.address.toLowerCase()) {
      throw new Error("Community trial state did not match the non-owner signer");
    }
    console.log("PASS: non-owner created a finalized community trial");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error("Trial creation did not finalize within 90 seconds");
