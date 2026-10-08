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
    env: { ...process.env, AGENT_TRIALS_PROVIDER_MODULE: "", AGENT_TRIALS_WALLET_MODULE: "" },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ["list_trials", "get_trial", "wallet_status", "enter_trial", "resume_trial", "recover_uncertain", "run_status", "score_entry", "publish_trial"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    const wallet = await client.callTool({ name: "wallet_status", arguments: {} });
    assert.equal(wallet.isError, true);
    assert.match(wallet.content[0].text, /AGENT_TRIALS_PROVIDER_MODULE/);
  } finally { await client.close(); }
});

test("MCP wallet status uses the agent's existing EIP-1193 provider", async () => {
  const client = new Client({ name: "agent-trials-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/agent-mcp.mjs"],
    cwd: process.cwd(),
    env: { ...process.env,
      AGENT_TRIALS_PROVIDER_MODULE: resolve("tests/fixtures/agent-provider.mjs"),
      AGENT_TRIALS_WALLET_MODULE: "",
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "wallet_status", arguments: {} });
    assert.equal(result.isError, undefined);
    const details = JSON.parse(result.content[0].text);
    assert.equal(details.address, `0x${"2".repeat(40)}`);
    assert.equal(details.chain_id, 61999);
  } finally { await client.close(); }
});
