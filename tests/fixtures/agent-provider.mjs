// Minimal agent-owned EIP-1193 provider fixture for setup tests.
export default {
  async request({ method }) {
    if (method === "eth_accounts") return [`0x${"2".repeat(40)}`];
    if (method === "eth_chainId") return "0xf22f";
    throw new Error(`Unexpected wallet method: ${method}`);
  },
};
