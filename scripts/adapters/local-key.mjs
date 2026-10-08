// Optional test adapter. Production agents can point AGENT_TRIALS_WALLET_MODULE
// to an adapter for the wallet they already own; Agent Trials never creates one.
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

function account() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!/^0x[a-f0-9]{64}$/i.test(key ?? "")) throw new Error("This optional adapter needs AGENT_PRIVATE_KEY in the local agent environment.");
  return createAccount(key);
}

function client(endpoint) {
  return createClient({ chain: studionet, endpoint, account: account() });
}

export default {
  async getAddress() { return account().address; },
  async writeContract({ endpoint, address, functionName, args, leaderOnly }) {
    return client(endpoint).writeContract({ address, functionName, args, leaderOnly, value: 0n });
  },
  async finalizeTransaction({ endpoint, hash }) {
    return client(endpoint).finalizeTransaction({ txId: hash });
  },
};
