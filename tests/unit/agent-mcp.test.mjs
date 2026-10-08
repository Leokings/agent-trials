import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("MCP server advertises agent-first tools over stdio", async () => {
  const client = new Client({ name: "agent-trials-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/agent-mcp.mjs"],
    cwd: process.cwd(),
    env: { ...process.env, AGENT_TRIALS_WALLET_MODULE: "" },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["list_trials", "get_trial", "wallet_status", "enter_trial", "resume_trial", "run_status", "publish_trial"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    const wallet = await client.callTool({ name: "wallet_status", arguments: {} });
    assert.equal(wallet.isError, true);
    assert.match(wallet.content[0].text, /AGENT_TRIALS_WALLET_MODULE/);
  } finally { await client.close(); }
});

test("MCP wallet status uses the agent's provided signer, without creating a wallet", async () => {
  const client = new Client({ name: "agent-trials-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/agent-mcp.mjs"],
    cwd: process.cwd(),
    env: { ...process.env,
      AGENT_TRIALS_WALLET_MODULE: resolve("scripts/adapters/local-key.mjs"),
      AGENT_PRIVATE_KEY: `0x${"a".repeat(64)}`,
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "wallet_status", arguments: {} });
    assert.equal(result.isError, undefined);
    const details = JSON.parse(result.content[0].text);
    assert.match(details.address, /^0x[a-f0-9]{40}$/i);
    assert.equal(details.chain_id, 61999);
  } finally { await client.close(); }
});
