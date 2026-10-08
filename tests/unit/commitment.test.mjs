import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportPendingBackup, importPendingBackup, makeCommitment, makeSalt,
  loadPending, savePending,
} from "../../src/commitment.ts";

const contract = "0x1111111111111111111111111111111111111111";
const agent = "0x2222222222222222222222222222222222222222";
const trialId = "backup-test-01";
const password = "correct horse battery staple";

globalThis.localStorage = new class {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, value); }
  removeItem(key) { this.#values.delete(key); }
}();

test("commitment is bound to trial, wallet, answer and salt", async () => {
  const salt = makeSalt();
  const digest = await makeCommitment(trialId, agent, "PENDING is not DONE", salt);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await makeCommitment(trialId, agent.toUpperCase(), "PENDING is not DONE", salt));
  assert.notEqual(digest, await makeCommitment(trialId, agent, "DONE", salt));
  assert.notEqual(digest, await makeCommitment("backup-test-02", agent, "PENDING is not DONE", salt));
});

test("encrypted backup restores the same answer and rejects wrong identity/password", async () => {
  const salt = makeSalt();
  const answer = "Keep checking the same pending job; do not restart it.";
  const pending = { trialId, agent, answer, salt, digest: await makeCommitment(trialId, agent, answer, salt) };
  const backup = await exportPendingBackup(contract, pending, password);
  assert.ok(!backup.includes(answer), "plaintext answer leaked in backup");
  assert.deepEqual(await importPendingBackup(backup, password, contract, trialId, agent), pending);
  await assert.rejects(() => importPendingBackup(backup, "wrong password!", contract, trialId, agent));
  await assert.rejects(() => importPendingBackup(backup, password, contract, "another-trial", agent));
  await assert.rejects(() => importPendingBackup(backup, password, contract, trialId,
    "0x3333333333333333333333333333333333333333"));
  await assert.rejects(() => importPendingBackup(backup, password,
    "0x4444444444444444444444444444444444444444", trialId, agent));
  const malformed = JSON.stringify({ ...JSON.parse(backup), ciphertext: "ff" });
  await assert.rejects(() => importPendingBackup(malformed, password, contract, trialId, agent));
});

test("pending answer is scoped to one contract, trial and wallet", async () => {
  const salt = makeSalt();
  const answer = "A";
  const pending = { trialId, agent, answer, salt, digest: await makeCommitment(trialId, agent, answer, salt) };
  savePending(contract, pending);
  assert.deepEqual(loadPending(contract, trialId, agent), pending);
  assert.equal(loadPending(contract, "another-trial", agent), null);
  assert.equal(loadPending("0x4444444444444444444444444444444444444444", trialId, agent), null);
});
