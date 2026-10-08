import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json";

const ENDPOINT = "https://studio.genlayer.com/api";
const addressFromEnv = import.meta.env.VITE_AGENT_TRIALS_CONTRACT?.trim() || deployment.address;

export const CONTRACT_ADDRESS = /^0x[a-f0-9]{40}$/i.test(addressFromEnv)
  ? addressFromEnv as `0x${string}`
  : null;

const reader = createClient({ chain: studionet, endpoint: ENDPOINT });

type EthereumProvider = {
  request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletSession = {
  address: `0x${string}`;
  client: ReturnType<typeof createClient>;
};

export type Agent = {
  address: string;
  name: string;
  points: number;
  scored_trials: number;
};

export type AgentStatus = Agent & { registered: boolean };
export type CreatorStatus = { address: string; next_create_ms: number; official: boolean };

export type Trial = {
  id: string;
  title: string;
  task: string;
  evidence: string;
  criteria: string[];
  commit_deadline_ms: number;
  reveal_deadline_ms: number;
  entries: string[];
  creator: string;
  official: boolean;
};

export type Entry = {
  trial_id: string;
  agent: string;
  name: string;
  committed: boolean;
  revealed: boolean;
  answer: string;
  scored: boolean;
  result: { checks: boolean[]; points: number; official: boolean } | null;
};

export type Snapshot = {
  policy: { owner: string; pending_curator: string; max_entrants: number; version: string; trial_count: number; agent_count: number; page_size: number; leaderboard_size: number; community_cooldown_ms: number };
  trials: Trial[];
  agents: Agent[];
};

function contract(): `0x${string}` {
  if (!CONTRACT_ADDRESS) throw new Error("The Agent Trials contract is not configured yet.");
  return CONTRACT_ADDRESS;
}

async function read<T>(functionName: string, args: (string | number)[] = []): Promise<T> {
  return reader.readContract({
    address: contract(),
    functionName,
    args,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  }) as Promise<T>;
}

export async function loadSnapshot(offset = 0): Promise<Snapshot> {
  const [policy, trials, agents] = await Promise.all([
    read<Snapshot["policy"]>("get_policy"),
    read<Trial[]>("list_trials_page", [offset, 20]),
    read<Agent[]>("get_leaderboard"),
  ]);
  return { policy, trials, agents };
}

export function loadAgentStatus(address: string): Promise<AgentStatus> {
  return read<AgentStatus>("get_agent_status", [address]);
}

export function loadCreatorStatus(address: string): Promise<CreatorStatus> {
  return read<CreatorStatus>("get_creator_status", [address]);
}

export function loadEntry(trialId: string, agent: string): Promise<Entry> {
  return read<Entry>("get_entry", [trialId, agent]);
}

export async function connectWallet(): Promise<WalletSession> {
  const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!provider) throw new Error("Install a browser wallet to enter a trial.");
  const addresses = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(addresses) ? addresses[0] : null;
  if (typeof address !== "string" || !/^0x[a-f0-9]{40}$/i.test(address)) {
    throw new Error("The wallet did not return an address.");
  }
  const client = createClient({
    chain: studionet,
    endpoint: ENDPOINT,
    account: address as `0x${string}`,
    provider: provider as NonNullable<Parameters<typeof createClient>[0]>["provider"],
  });
  await client.connect("studionet");
  return { address: address as `0x${string}`, client };
}

export async function write(
  wallet: WalletSession,
  functionName: string,
  args: (string | number)[],
  leaderOnly: boolean,
): Promise<`0x${string}`> {
  return wallet.client.writeContract({
    address: contract(),
    functionName,
    args,
    value: 0n,
    leaderOnly,
  }) as Promise<`0x${string}`>;
}

export async function transactionStatus(hash: string): Promise<{
  status: string;
  execution: string;
  finalization: "none" | "ready" | "attempt";
}> {
  if (!/^0x[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid transaction hash");
  const receipt = await reader.getTransaction({ hash: hash as `0x${string}` & { length: 66 } });
  const raw = receipt as unknown as {
    consensus_data?: { leader_receipt?: Array<{ execution_result?: string }> };
  };
  const leaderExecution = raw.consensus_data?.leader_receipt?.[0]?.execution_result;
  const status = String(receipt.statusName ?? receipt.status ?? "PENDING").toUpperCase();
  const reportedExecution = String(receipt.txExecutionResultName ?? leaderExecution ?? "NOT_VOTED").toUpperCase();
  let finalization: "none" | "ready" | "attempt" = status === "READY_TO_FINALIZE" ? "ready" : "none";
  if (status === "ACCEPTED") {
    // Some Studionet nodes do not expose the lifecycle RPC yet. In that case
    // an Accepted transaction can be attempted manually, but is not "ready".
    const action = await lifecycleAction(hash);
    finalization = action === "Finalize" ? "ready" : action === null ? "attempt" : "none";
  }
  return {
    status,
    execution: reportedExecution === "SUCCESS" ? "FINISHED_WITH_RETURN"
      : reportedExecution === "ERROR" ? "FINISHED_WITH_ERROR" : reportedExecution,
    finalization,
  };
}

let lifecycleAvailable: boolean | null = null;
async function lifecycleAction(hash: string): Promise<string | null> {
  if (lifecycleAvailable === false) return null;
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gen_getTransactionLifecycle", params: [{ txId: hash }] }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { error?: { code?: number }; result?: { resolutionAction?: string } };
    if (body.error?.code === -32601) { lifecycleAvailable = false; return null; }
    if (body.error) return null;
    lifecycleAvailable = true;
    return body.result?.resolutionAction ?? "";
  } catch { return null; }
}

export function watchWalletChanges(onChange: () => void): () => void {
  const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!provider?.on) return () => {};
  provider.on("accountsChanged", onChange);
  provider.on("chainChanged", onChange);
  return () => {
    provider.removeListener?.("accountsChanged", onChange);
    provider.removeListener?.("chainChanged", onChange);
  };
}

export async function finalize(wallet: WalletSession, hash: string): Promise<string> {
  if (!/^0x[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid transaction hash");
  return wallet.client.finalizeTransaction({ txId: hash as `0x${string}` });
}
