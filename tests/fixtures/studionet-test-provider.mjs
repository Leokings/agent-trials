// Test-only EIP-1193 provider backed by a disposable key supplied by the live test.
// Production agents supply their existing wallet provider instead.
import { createAccount } from "genlayer-js";

const endpoint = "https://studio.genlayer.com/api";
const chainId = 61999;
const key = process.env.AGENT_PRIVATE_KEY;
if (!/^0x[a-f0-9]{64}$/i.test(key ?? "")) throw new Error("Live provider test needs a disposable AGENT_PRIVATE_KEY.");
const account = createAccount(key);

async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export default {
  async request({ method, params = [] }) {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method !== "eth_sendTransaction") throw new Error(`Unsupported test-wallet method: ${method}`);
    const tx = params[0];
    if (!tx || tx.from?.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong test-wallet sender.");
    if (tx.chainId && Number(BigInt(tx.chainId)) !== chainId) throw new Error("Wrong test-wallet chain.");
    const nonce = tx.nonce ?? await rpc("eth_getTransactionCount", [account.address, "pending"]);
    const gasPrice = tx.gasPrice ?? await rpc("eth_gasPrice");
    const gas = tx.gas ?? await rpc("eth_estimateGas", [tx]);
    const signed = await account.signTransaction({
      to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: BigInt(gas),
      gasPrice: BigInt(gasPrice), nonce: Number(BigInt(nonce)), chainId, type: "legacy",
    });
    return rpc("eth_sendRawTransaction", [signed]);
  },
};
