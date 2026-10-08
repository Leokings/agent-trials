import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { createChain } from "./agent-runtime.mjs";
import deployment from "../deployments/studionet.json" with { type: "json" };

const endpoint = "https://studio.genlayer.com/api";
const creator = createClient({
  chain: studionet, endpoint, account: createAccount(`0x${randomBytes(32).toString("hex")}`),
});
const agentKey = `0x${randomBytes(32).toString("hex")}`;
const chain = createChain();
const trialId = process.env.AGENT_TRIALS_LIVE_TRIAL_ID || `mcp-agent-${randomBytes(5).toString("hex")}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const directory = await mkdtemp(join(tmpdir(), "agent-trials-mcp-live-"));
let client;
let success = false;
const runnerPids = new Set();

async function waitFinal(hash, label) {
  const until = Date.now() + 240_000;
  let acceptedSince = 0;
  let lastFinalize = 0;
  while (Date.now() < until) {
    try {
      const tx = await chain.transaction(hash);
      if (tx.status === "FINALIZED") {
        if (tx.execution !== "FINISHED_WITH_RETURN") {
          throw new Error(`${label} finalized with ${tx.execution}: ${hash}`);
        }
        return;
      }
      if (tx.status === "ACCEPTED" && !acceptedSince) acceptedSince = Date.now();
      if (acceptedSince && Date.now() - acceptedSince > 45_000 && Date.now() - lastFinalize > 60_000) {
        lastFinalize = Date.now();
        try { await creator.finalizeTransaction({ txId: hash }); } catch { /* Keep checking the original hash. */ }
      }
    } catch (error) {
      if (String(error.message).includes("finalized with")) throw error;
    }
    await pause(15_000);
  }
  throw new Error(`${label} did not finalize: ${hash}`);
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "unknown error"}`);
  return JSON.parse(result.content[0].text);
}

try {
  const commitAt = Date.now() + 180_000;
  const revealAt = commitAt + 90_000;
  const task = "Explain what a PENDING background job means and the safest next step for the user.";
  const evidence = "The job status API returns PENDING while work is still running. DONE means the work completed. A PENDING job should be checked again using its existing job ID; starting a new job with a new ID can duplicate the work.";
  const criteria = [
    "Explains that PENDING means work is still running.",
    "Does not call PENDING a completed job.",
    "Advises checking the existing job ID again.",
    "Warns against starting a duplicate job with a new ID.",
    "Explains that DONE means work completed.",
  ];
  if (!process.env.AGENT_TRIALS_LIVE_TRIAL_ID) {
    console.log(`Creating fresh-wallet MCP trial ${trialId} on Studionet...`);
    const createHash = await creator.writeContract({
      address: deployment.address, functionName: "create_trial",
      args: [trialId, "Fresh-wallet MCP trial", task, evidence, JSON.stringify(criteria), commitAt, revealAt],
      value: 0n, leaderOnly: true,
    });
    console.log(`Creation transaction: ${createHash}`);
    await waitFinal(createHash, "Trial creation");
    console.log("Trial creation: FINALIZED / FINISHED_WITH_RETURN");
  }

  client = new Client({ name: "independent-agent-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["scripts/agent-mcp.mjs"], cwd: process.cwd(),
    env: { ...process.env,
      AGENT_TRIALS_PROVIDER_MODULE: resolve("tests/fixtures/studionet-test-provider.mjs"),
      AGENT_TRIALS_WALLET_MODULE: "", AGENT_TRIALS_STATE_DIR: join(directory, "state"),
      AGENT_PRIVATE_KEY: agentKey,
    },
  });
  await client.connect(transport);
  const wallet = await call("wallet_status");
  const listing = await call("list_trials");
  if (!listing.trials.some((trial) => trial.id === trialId)) {
    throw new Error("New trial is missing from MCP trial discovery.");
  }
  const trial = await call("get_trial", { trial_id: trialId });
  if (process.env.AGENT_TRIALS_LIVE_TRIAL_ID && !trial.official) throw new Error("Expected an official test trial.");
  console.log(`Fresh test wallet: ${wallet.address} (separate from trial creator)`);
  console.log(`Task: ${trial.task}`);
  console.log(`Evidence: ${trial.evidence}`);
  console.log(`Criteria: ${JSON.stringify(trial.criteria)}`);
  const answer = "PENDING means the job is still processing, not completed. Check the same existing job ID again. Do not start a new job with a new ID because that can duplicate the work. DONE means the job completed.";
  const entered = await call("enter_trial", { trial_id: trialId, agent_name: "Fresh Wallet Agent", answer });
  if (entered.runner_pid) runnerPids.add(entered.runner_pid);
  console.log(`MCP enter_trial started runner PID ${entered.runner_pid}.`);

  const until = Date.now() + 20 * 60_000;
  let lastPhase = "";
  let final;
  while (Date.now() < until) {
    try {
      const status = await call("run_status", { trial_id: trialId });
      if (status.run?.phase !== lastPhase) {
        lastPhase = status.run?.phase ?? "unknown";
        console.log(`Agent phase: ${lastPhase}`);
      }
      if (/requests per hour/i.test(status.run?.error ?? "")) throw new Error(`Studionet hourly RPC quota reached: ${status.run.error}`);
      if (status.hint) {
        const resumed = await call("resume_trial", { trial_id: trialId });
        if (resumed.runner_pid) runnerPids.add(resumed.runner_pid);
      }
      if (status.run?.phase === "complete" && status.entry?.scored) {
        final = status;
        break;
      }
    } catch (error) {
      if (/requests per hour/i.test(error.message)) throw error;
      console.log(`Status read retry: ${error.message}`);
    }
    await pause(60_000);
  }
  if (!final) throw new Error(`No finalized MCP agent score within 20 minutes for ${trialId}.`);
  const scoreHash = final.run?.tx?.score?.hash;
  if (!scoreHash || final.run.tx.score.finalized !== true) {
    throw new Error("Agent reported completion without a finalized score transaction.");
  }
  await waitFinal(scoreHash, "Score");
  console.log(`Score transaction: ${scoreHash}`);
  console.log(`Final score: ${final.entry.result?.points} / 100`);
  console.log(`Checks: ${JSON.stringify(final.entry.result?.checks)}`);
  if (final.entry.result?.points !== 100) throw new Error("The independent agent was scored below 100/100.");
  success = true;
  console.log(`PASS: fresh test wallet through MCP -> sealed answer -> reveal -> finalized score (${trialId}). This does not test a third-party wallet vendor.`);
} finally {
  if (client) await client.close();
  if (success) {
    if (!directory.startsWith(join(tmpdir(), "agent-trials-mcp-live-"))) throw new Error("Unsafe temporary cleanup target.");
    await rm(directory, { recursive: true, force: true });
  } else {
    for (const pid of runnerPids) {
      try { process.kill(pid); } catch { /* The test runner may have already stopped. */ }
    }
    console.error(`Unfinished run state retained at ${directory} for diagnosis.`);
  }
}
