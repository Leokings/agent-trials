const PREFIX = "agent-trials.last-transaction.v1";

export type TrackedTransaction = {
  wallet: string;
  hash: string;
  label: string;
  status: string;
  execution: string;
  finalization: "none" | "ready" | "attempt";
};

function key(contract: string, wallet: string): string {
  return `${PREFIX}:${contract.toLowerCase()}:${wallet.toLowerCase()}`;
}

export function loadTrackedTransaction(contract: string, wallet: string): TrackedTransaction | null {
  try {
    const raw = localStorage.getItem(key(contract, wallet));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TrackedTransaction>;
    if (!/^0x[a-f0-9]{64}$/i.test(value.hash ?? "") || typeof value.label !== "string") return null;
    return {
      wallet,
      hash: value.hash as string,
      label: value.label,
      status: typeof value.status === "string" ? value.status : "PENDING",
      execution: typeof value.execution === "string" ? value.execution : "NOT_VOTED",
      finalization: value.finalization === "ready" || value.finalization === "attempt" ? value.finalization : "none",
    };
  } catch { return null; }
}

export function saveTrackedTransaction(contract: string, wallet: string, tx: TrackedTransaction): void {
  if (tx.wallet.toLowerCase() !== wallet.toLowerCase()) return;
  try { localStorage.setItem(key(contract, wallet), JSON.stringify(tx)); }
  catch { /* A blocked storage API must not hide the transaction in the current tab. */ }
}
