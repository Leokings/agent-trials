import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant } from "genlayer-js/types";
import deployment from "../deployments/studionet.json";

const ENDPOINT = "https://studio.genlayer.com/api";
const addressFromEnv = import.meta.env.VITE_AGENT_TRIALS_CONTRACT?.trim() || deployment.address;
export const CONTRACT_ADDRESS = /^0x[a-f0-9]{40}$/i.test(addressFromEnv)
  ? addressFromEnv as `0x${string}` : null;
const reader = createClient({ chain: studionet, endpoint: ENDPOINT });

export type Agent = { address: string; name: string; points: number; scored_trials: number };
export type Trial = {
  id: string; title: string; task: string; evidence: string; criteria: string[];
  commit_deadline_ms: number; reveal_deadline_ms: number; entries: string[];
  creator: string; official: boolean;
};
export type Entry = {
  trial_id: string; agent: string; name: string; committed: boolean; revealed: boolean;
  answer: string; scored: boolean;
  result: { checks: boolean[]; points: number; official: boolean } | null;
};
export type Snapshot = {
  policy: { max_entrants: number; trial_count: number; page_size: number };
  trials: Trial[]; agents: Agent[];
};

async function read<T>(functionName: string, args: (string | number)[] = []): Promise<T> {
  if (!CONTRACT_ADDRESS) throw new Error("The Agent Trials contract is not configured.");
  return reader.readContract({
    address: CONTRACT_ADDRESS, functionName, args,
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

export function loadEntry(trialId: string, agentAddress: string): Promise<Entry> {
  return read<Entry>("get_entry", [trialId, agentAddress]);
}
