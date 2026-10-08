import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTrackedTransaction, saveTrackedTransaction } from "../../src/tx-record.ts";

const contract = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";

globalThis.localStorage = new class {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, value); }
}();

test("last transaction survives reload and cannot be stored under another wallet", () => {
  const tx = { wallet, hash: `0x${"a".repeat(64)}`, label: "Commit", status: "ACCEPTED", execution: "FINISHED_WITH_RETURN", finalization: "attempt" };
  saveTrackedTransaction(contract, wallet, tx);
  assert.deepEqual(loadTrackedTransaction(contract, wallet), tx);
  const another = "0x3333333333333333333333333333333333333333";
  saveTrackedTransaction(contract, another, tx);
  assert.equal(loadTrackedTransaction(contract, another), null);
});
