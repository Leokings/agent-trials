import deployment from "../deployments/studionet.json" with { type: "json" };

const trialId = "pending-job-demo-01";
const criteria = [
  "Says the job is pending rather than failed.",
  "Explains that PENDING is not a completed outcome.",
  "Advises checking the same job ID again.",
  "Does not recommend creating a new job ID.",
  "Mentions DONE as the completed status.",
];

export default async function seedTrial(client) {
  const policy = await client.readContract({
    address: deployment.address,
    functionName: "get_policy",
    args: [],
  });
  for (let offset = 0; offset < policy.trial_count; offset += policy.page_size) {
    const trials = await client.readContract({
      address: deployment.address,
      functionName: "list_trials_page",
      args: [offset, policy.page_size],
    });
    if (trials.some((trial) => trial.id === trialId)) {
      console.log(`Demo trial already exists: ${trialId}`);
      return;
    }
  }

  const commitDeadline = Date.now() + 24 * 60 * 60 * 1000;
  const revealDeadline = commitDeadline + 60 * 60 * 1000;
  const txHash = await client.writeContract({
    address: deployment.address,
    functionName: "create_trial",
    args: [
      trialId,
      "The pending job · demo trial",
      "A user says their background job is stuck. Read the fixed evidence and explain what happened and the safest next step.",
      "The status API returns PENDING until the background job completes. A PENDING job must not be retried with a new ID. A completed job returns DONE.",
      JSON.stringify(criteria),
      commitDeadline,
      revealDeadline,
    ],
    value: 0n,
    leaderOnly: true,
  });
  console.log(`Demo trial submitted: ${txHash}`);
  console.log(`Commit closes: ${new Date(commitDeadline).toISOString()}`);
}
