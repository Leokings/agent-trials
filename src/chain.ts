import deployment from "../deployments/studionet.json";
import archive from "../deployments/studionet-archive.json";

const ENDPOINT = "https://studio.genlayer.com/api";
const addressFromEnv = import.meta.env.VITE_AGENT_TRIALS_CONTRACT?.trim() || deployment.address;
export const CONTRACT_ADDRESS = /^0x[a-f0-9]{40}$/i.test(addressFromEnv)
  ? addressFromEnv as `0x${string}` : null;
export const ARCHIVE_CONTRACT_ADDRESS = archive.address as `0x${string}`;

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
export type SnapshotLoad = { data: Partial<Snapshot>; failed: string[] };

// Load the SDK only when contract data is needed, not with the first paint.
async function createReader() {
  const [{ createClient }, { studionet }, { TransactionHashVariant }] = await Promise.all([
    import("genlayer-js"), import("genlayer-js/chains"), import("genlayer-js/types"),
  ]);
  return { client: createClient({ chain: studionet, endpoint: ENDPOINT }), variant: TransactionHashVariant.LATEST_FINAL };
}
let readerPromise: ReturnType<typeof createReader> | null = null;
function getReader() {
  readerPromise ??= createReader().catch((error) => { readerPromise = null; throw error; });
  return readerPromise;
}

async function read<T>(functionName: string, args: (string | number)[] = [], address = CONTRACT_ADDRESS): Promise<T> {
  if (!address) throw new Error("The Agent Trials contract is not configured.");
  const { client, variant } = await getReader();
  return client.readContract({ address, functionName, args, transactionHashVariant: variant }) as Promise<T>;
}

export async function loadSnapshot(offset = 0, address = CONTRACT_ADDRESS): Promise<SnapshotLoad> {
  const names = ["policy", "trials", "agents"] as const;
  const results = await Promise.allSettled([
    read<Snapshot["policy"]>("get_policy", [], address),
    read<Trial[]>("list_trials_page", [offset, 20], address),
    read<Agent[]>("get_leaderboard", [], address),
  ]);
  const data: Partial<Snapshot> = {};
  const failed: string[] = [];
  results.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") {
      if (name === "policy") data.policy = result.value as Snapshot["policy"];
      else if (name === "trials") data.trials = result.value as Trial[];
      else data.agents = result.value as Agent[];
    } else failed.push(name);
  });
  return { data, failed };
}

export function loadEntry(trialId: string, agentAddress: string, address = CONTRACT_ADDRESS): Promise<Entry> {
  return read<Entry>("get_entry", [trialId, agentAddress], address);
}
