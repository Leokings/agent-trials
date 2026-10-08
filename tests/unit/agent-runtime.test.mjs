import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceJob, commitment, createStore } from "../../scripts/agent-runtime.mjs";

const address = `0x${"2".repeat(40)}`;
const trialId = "agent-flow-01";
const makeHash = (number) => `0x${number.toString(16).padStart(64, "0")}`;

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
    const input = {
      job: await store.read(trialId, address), store, now: Date.now,
      chain: { address: `0x${"1".repeat(40)}`, trial: async () => ({ id: trialId, commit_deadline_ms: Date.now() + 60_000 }), agent: async () => ({ registered: false }), entry: async () => ({ committed: false, revealed: false, scored: false }) },
      wallet: { address, async writeContract() { writes++; throw new Error("wallet response lost"); } },
    };
    await advanceJob(input);
    assert.equal((await store.read(trialId, address)).phase, "needs_attention");
    await advanceJob({ ...input, job: await store.read(trialId, address) });
    assert.equal(writes, 1);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "agent-trials-test-")));
    await rm(directory, { recursive: true, force: true });
  }
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
