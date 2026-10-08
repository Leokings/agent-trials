#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  createChain, createStore, generateAnswer, loadWalletAdapter, publicJob, runJob, startJob,
} from "./agent-runtime.mjs";

const command = process.argv[2] ?? "help";
const flags = new Map();
for (let index = 3; index < process.argv.length; index++) {
  const item = process.argv[index];
  if (!item?.startsWith("--")) throw new Error(`Expected a --flag, got ${item ?? "end of command"}.`);
  const name = item.slice(2);
  if (name === "generate") flags.set(name, true);
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    flags.set(name, value);
  }
}

function required(name) {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

async function main() {
  if (command === "help") {
    console.log(`Agent Trials autonomous runner (Node 20+)
  node scripts/agent-runner.mjs run --trial TRIAL_ID --name "My Agent" --answer-file answer.txt
  node scripts/agent-runner.mjs run --trial TRIAL_ID --name "My Agent" --generate
  node scripts/agent-runner.mjs run --trial TRIAL_ID    # resume a saved run
  node scripts/agent-runner.mjs status --trial TRIAL_ID

Set AGENT_TRIALS_WALLET_MODULE to a local adapter for your existing Studionet wallet.
The runner stays active through reveal and scoring; rerun the same command after a restart.
The answer and salt are encrypted in the local state directory, never sent to this website.`);
    return;
  }
  if (command !== "run" && command !== "status") throw new Error(`Unknown command: ${command}.`);
  const trialId = required("trial");
  const [wallet, chain] = await Promise.all([loadWalletAdapter(), Promise.resolve(createChain())]);
  const store = createStore();
  if (command === "status") {
    const [job, entry] = await Promise.all([store.read(trialId, wallet.address), chain.entry(trialId, wallet.address)]);
    console.log(JSON.stringify({ job: publicJob(job), entry }, null, 2));
    return;
  }
  let job = await store.read(trialId, wallet.address);
  if (!job) {
    if (Boolean(flags.has("answer-file")) === Boolean(flags.has("generate"))) {
      throw new Error("Choose exactly one of --answer-file or --generate for a new run.");
    }
    const answer = flags.has("generate")
      ? await generateAnswer(await chain.trial(trialId))
      : await readFile(required("answer-file"), "utf8");
    job = await startJob({ trialId, name: required("name"), answer, chain, wallet, store });
    console.log(JSON.stringify({ event: "run_saved", trialId, address: wallet.address, digest: job.digest }));
  }
  let lastPhase = "";
  const result = await runJob({ trialId, chain, wallet, store, onUpdate: (next) => {
    if (next.phase !== lastPhase) {
      console.log(JSON.stringify({ event: "phase", phase: next.phase, trialId, tx: next.tx, error: next.error }));
      lastPhase = next.phase;
    }
  } });
  console.log(JSON.stringify({ event: "finished", ...result }));
  if (result.phase !== "complete") process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
