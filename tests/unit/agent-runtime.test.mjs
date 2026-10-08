import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceJob, commitment, createProviderWallet, createStore, recoverUncertain, requestPublicScore, rpcRetryDelay, runJob } from "../../scripts/agent-runtime.mjs";

const address = `0x${"2".repeat(40)}`;
const trialId = "agent-flow-01";
const makeHash = (number) => `0x${number.toString(16).padStart(64, "0")}`;

test("RPC quota errors back off far longer than transient failures", () => {
  assert.equal(rpcRetryDelay(new Error("HTTP 429: 500 requests per hour"), 1), 600_000);
  assert.equal(rpcRetryDelay(new Error("rate limit reached"), 2), 150_000);
  assert.equal(rpcRetryDelay(new Error("500 requests per hour"), 5), 3_600_000);
  assert.equal(rpcRetryDelay(new Error("Rate limit exceeded: 30 requests per minute"), 1), 75_000);
  assert.equal(rpcRetryDelay(new Error("Rate limit exceeded: 30 requests per minute"), 2), 150_000);
  assert.equal(rpcRetryDelay(new Error("Rate limit exceeded: 30 requests per minute"), 5), 180_000);
  assert.equal(rpcRetryDelay(new Error("temporary gateway failure"), 1), 30_000);
  assert.equal(rpcRetryDelay(new Error("temporary gateway failure"), 3), 120_000);
});

test("runner applies increasing quota delays instead of retrying every 15 seconds", async () => {
  const contract = `0x${"1".repeat(40)}`;
  const job = { trialId, address, contract, name: "Test Agent", phase: "queued", tx: {} };
  const delays = [];
  let reads = 0;
  let released = false;
  const store = {
    lock: async () => async () => { released = true; },
    read: async () => job,
    save: async () => {},
  };
  const chain = { address: contract, async trial() { reads++; throw new Error("HTTP 429: RPC quota exceeded"); } };
  const result = await runJob({ trialId, chain, wallet: { address }, store,
    sleep: async (delay) => { delays.push(delay); if (delays.length === 2) job.phase = "complete"; },
  });
  assert.deepEqual(delays, [75_000, 150_000]);
  assert.equal(reads, 2);
  assert.equal(result.phase, "complete");
  assert.equal(released, true);
});

test("standard agent wallet provider signs GenLayer writes without a custom transaction adapter", async () => {
  const requests = [];
  const provider = { async request(input) {
    requests.push(input.method);
    if (input.method === "eth_accounts") return [address];
    if (input.method === "eth_chainId") return "0xf22f";
    throw new Error(`Unexpected wallet method: ${input.method}`);
  } };
  const calls = [];
  const wallet = await createProviderWallet(provider, { clientFactory(config) {
    assert.equal(config.account, address);
    assert.equal(config.provider, provider);
    return {
      async writeContract(input) { calls.push(input); return makeHash(1); },
      async finalizeTransaction(input) { calls.push(input); return makeHash(2); },
    };
  } });
  assert.equal(wallet.address, address);
  assert.deepEqual(requests, ["eth_accounts", "eth_chainId"]);
  assert.equal(await wallet.writeContract({ chainId: 61999, address, functionName: "register_agent", args: ["Atlas One"], leaderOnly: true }), makeHash(1));
  assert.equal(await wallet.finalizeTransaction({ chainId: 61999, hash: makeHash(1) }), makeHash(2));
  assert.deepEqual(calls, [
    { address, functionName: "register_agent", args: ["Atlas One"], leaderOnly: true, value: 0n },
    { txId: makeHash(1) },
  ]);
  await assert.rejects(createProviderWallet({ request: async ({ method }) => method === "eth_accounts" ? [address] : "0x1" }), /switch it to GenLayer Studionet/);
});

test("agent run survives restart, reveals the saved answer, and scores once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    const start = Date.now();
    let current = start;
    const trial = { id: trialId, entries: [], commit_deadline_ms: start + 60_000, reveal_deadline_ms: start + 120_000 };
    const agent = { registered: false };
    const entry = { committed: false, revealed: false, scored: false, result: null };
    const writes = [];
    const intents = new Map();
    const chain = {
      address: `0x${"1".repeat(40)}`,
      trial: async () => trial,
      agent: async () => agent,
      entry: async () => entry,
      transaction: async (hash) => {
        const intent = intents.get(hash);
        if (intent.functionName === "register_agent") agent.registered = true;
        if (intent.functionName === "commit_answer") entry.committed = true;
        if (intent.functionName === "reveal_answer") entry.revealed = true;
        if (intent.functionName === "score_answer") { entry.scored = true; entry.result = { points: 80 }; }
        return { status: "FINALIZED", execution: "FINISHED_WITH_RETURN" };
      },
    };
    const wallet = {
      address,
      async writeContract(intent) {
        const hash = makeHash(writes.length + 1);
        writes.push(intent);
        intents.set(hash, intent);
        return hash;
      },
    };
    const saved = await store.create({ trialId, address, contract: chain.address, name: "Atlas One", answer: "PENDING is not DONE. Keep checking the same job." });
    assert.equal(saved.digest, commitment(trialId, address, "PENDING is not DONE. Keep checking the same job.", (await store.secret(saved)).salt));
    const disk = await readFile(join(directory, `${trialId}-${address.toLowerCase()}.json`), "utf8");
    assert.ok(!disk.includes("PENDING is not DONE"), "saved answer leaked in plaintext");

    const step = async () => advanceJob({ job: await store.read(trialId, address), chain, wallet, store, now: () => current });
    await step(); // register submitted
    await step(); // registration final
    await step(); // commit submitted
    assert.deepEqual(writes.map((item) => item.functionName), ["register_agent", "commit_answer"]);

    // Reconstruct the store to model a stopped and restarted agent process.
    const restarted = createStore(directory);
    const resume = async () => advanceJob({ job: await restarted.read(trialId, address), chain, wallet, store: restarted, now: () => current });
    await resume(); // same commitment reaches finality, no duplicate submit
    await resume(); // waits for reveal
    assert.equal(writes.length, 2);
    current = trial.commit_deadline_ms + 1;
    await resume(); // reveal submitted with the original secret
    const reveal = writes.at(-1);
    assert.equal(reveal.functionName, "reveal_answer");
    assert.equal(reveal.args[1], "PENDING is not DONE. Keep checking the same job.");
    await resume(); // reveal final
    await resume(); // waits for scoring
    current = trial.reveal_deadline_ms + 1;
    await resume(); // scoring submitted
    await resume(); // scoring final
    const final = await resume();
    assert.equal(final.done, true);
    assert.equal((await restarted.read(trialId, address)).points, 80);
    assert.deepEqual(writes.map((item) => item.functionName), ["register_agent", "commit_answer", "reveal_answer", "score_answer"]);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain wallet submission is not automatically repeated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    await store.create({ trialId, address, contract: `0x${"1".repeat(40)}`, name: "Atlas One", answer: "A valid answer." });
    let writes = 0;
    const contract = `0x${"1".repeat(40)}`;
    const trial = { id: trialId, commit_deadline_ms: Date.now() + 60_000, reveal_deadline_ms: Date.now() + 120_000 };
    const input = {
      job: await store.read(trialId, address), store, now: Date.now,
      chain: { address: contract, trial: async () => trial, agent: async () => ({ registered: false }), entry: async () => ({ committed: false, revealed: false, scored: false }) },
      wallet: { address, async writeContract() { writes++; if (writes === 1) throw new Error("wallet response lost"); return makeHash(11); } },
    };
    assert.deepEqual(await advanceJob(input), { done: true });
    assert.equal((await store.read(trialId, address)).phase, "needs_attention");
    await advanceJob({ ...input, job: await store.read(trialId, address) });
    assert.equal(writes, 1);
    const observed = await recoverUncertain({ trialId, chain: input.chain, wallet: input.wallet, store });
    assert.equal(observed.resolution, "not_observed");
    assert.equal(writes, 1, "read-only reconciliation must not submit a duplicate");
    const armed = await recoverUncertain({ trialId, chain: input.chain, wallet: input.wallet, store, allowResubmit: true });
    assert.equal(armed.resolution, "retry_armed");
    await advanceJob({ ...input, job: await store.read(trialId, address) });
    assert.equal(writes, 2, "explicit confirmation permits one retry");
    assert.equal((await store.read(trialId, address)).tx.register.hash, makeHash(11));
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery follows finalized state instead of repeating a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    const contract = `0x${"1".repeat(40)}`;
    const job = await store.create({ trialId, address, contract, name: "Atlas One", answer: "A valid answer." });
    job.phase = "needs_attention";
    job.uncertainStage = "register";
    job.error = "wallet response lost";
    await store.save(job);
    let writes = 0;
    const chain = {
      address: contract,
      trial: async () => ({ id: trialId, commit_deadline_ms: Date.now() + 60_000, reveal_deadline_ms: Date.now() + 120_000 }),
      agent: async () => ({ registered: true }),
      entry: async () => ({ committed: false, revealed: false, scored: false }),
    };
    const wallet = { address, async writeContract() { writes++; return makeHash(12); } };
    const recovery = await recoverUncertain({ trialId, chain, wallet, store });
    assert.equal(recovery.resolution, "already_applied");
    await advanceJob({ job: await store.read(trialId, address), chain, wallet, store });
    assert.equal(writes, 1);
    assert.equal((await store.read(trialId, address)).tx.commit.hash, makeHash(12));
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed finalized transaction leaves a recoverable run instead of polling forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    const contract = `0x${"1".repeat(40)}`;
    const job = await store.create({ trialId, address, contract, name: "Atlas One", answer: "A valid answer." });
    job.tx.register = { hash: makeHash(13), submittedAt: Date.now() - 60_000, finalized: false };
    await store.save(job);
    const chain = {
      address: contract,
      trial: async () => ({ id: trialId, commit_deadline_ms: Date.now() + 60_000, reveal_deadline_ms: Date.now() + 120_000 }),
      agent: async () => ({ registered: false }),
      entry: async () => ({ committed: false, revealed: false, scored: false }),
      transaction: async () => ({ status: "FINALIZED", execution: "FINISHED_WITH_ERROR" }),
    };
    const wallet = { address, async writeContract() { return makeHash(14); } };
    assert.deepEqual(await advanceJob({ job: await store.read(trialId, address), chain, wallet, store }), { done: true });
    assert.equal((await store.read(trialId, address)).tx.register.finalized, true);
    assert.equal((await store.read(trialId, address)).phase, "needs_attention");
    assert.equal((await recoverUncertain({ trialId, chain, wallet, store })).resolution, "not_observed");
    assert.equal((await recoverUncertain({ trialId, chain, wallet, store, allowResubmit: true })).resolution, "retry_armed");
    assert.equal((await store.read(trialId, address)).supersededTx[0].hash, makeHash(13));
    await advanceJob({ job: await store.read(trialId, address), chain, wallet, store });
    assert.equal((await store.read(trialId, address)).tx.register.hash, makeHash(14));
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("public scoring fallback only submits eligible revealed entries", async () => {
  const deadline = Date.now() - 1;
  const entry = { revealed: true, scored: false };
  const intents = [];
  const chain = {
    address: `0x${"1".repeat(40)}`,
    trial: async () => ({ id: trialId, reveal_deadline_ms: deadline }),
    entry: async () => entry,
  };
  const wallet = { address, async writeContract(intent) { intents.push(intent); return makeHash(15); } };
  const scored = await requestPublicScore({ trialId, agentAddress: address, chain, wallet });
  assert.equal(scored.hash, makeHash(15));
  assert.equal(intents[0].functionName, "score_answer");
  assert.equal(intents[0].leaderOnly, false);
  entry.scored = true;
  entry.result = { points: 60 };
  assert.deepEqual(await requestPublicScore({ trialId, agentAddress: address, chain, wallet }), { already_scored: true, result: { points: 60 } });
  assert.equal(intents.length, 1);
  entry.scored = false;
  entry.revealed = false;
  await assert.rejects(requestPublicScore({ trialId, agentAddress: address, chain, wallet }), /did not reveal/);
  entry.revealed = true;
  chain.trial = async () => ({ id: trialId, reveal_deadline_ms: Date.now() + 60_000 });
  await assert.rejects(requestPublicScore({ trialId, agentAddress: address, chain, wallet }), /after the reveal window/);
  chain.trial = async () => ({ id: trialId, reveal_deadline_ms: deadline });
  await assert.rejects(requestPublicScore({ trialId, agentAddress: address, chain,
    wallet: { address, async writeContract() { throw new Error("response lost"); } } }), /submission is uncertain.*wallet history/);
});

test("pending commit is tracked across the deadline instead of expiring or revealing early", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    const contract = `0x${"1".repeat(40)}`;
    const job = await store.create({ trialId, address, contract, name: "Atlas One", answer: "A valid answer." });
    const hash = makeHash(9);
    job.tx.commit = { hash, submittedAt: Date.now() - 90_000, finalized: false, lastFinalizeAt: 0 };
    await store.save(job);
    let checked = 0;
    const chain = {
      address: contract,
      trial: async () => ({ id: trialId, commit_deadline_ms: Date.now() - 30_000, reveal_deadline_ms: Date.now() + 30_000 }),
      agent: async () => ({ registered: true }),
      entry: async () => ({ committed: true, revealed: false, scored: false }),
      transaction: async () => { checked++; return { status: "ACCEPTED", execution: "FINISHED_WITH_RETURN" }; },
      finalizationAction: async () => "",
    };
    const wallet = { address, async writeContract() { throw new Error("must not write"); } };
    await advanceJob({ job: await store.read(trialId, address), chain, wallet, store });
    assert.equal(checked, 1);
    assert.equal((await store.read(trialId, address)).tx.commit.finalized, false);
    assert.equal((await store.read(trialId, address)).phase, "queued");
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("waiting between phases uses saved deadlines without polling Studionet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trials-test-"));
  try {
    const store = createStore(directory);
    const now = Date.now();
    const contract = `0x${"1".repeat(40)}`;
    const job = await store.create({ trialId, address, contract, name: "Atlas One", answer: "A valid answer.",
      trial: { commit_deadline_ms: now + 120_000, reveal_deadline_ms: now + 240_000 } });
    const chain = { address: contract, trial: async () => { throw new Error("unexpected trial read"); } };
    const wallet = { address };
    job.phase = "sealed";
    await store.save(job);
    assert.deepEqual(await advanceJob({ job, chain, wallet, store, now: () => now }), { delay: 60_000 });
    job.phase = "revealed";
    assert.deepEqual(await advanceJob({ job, chain, wallet, store, now: () => now }), { delay: 60_000 });
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});
