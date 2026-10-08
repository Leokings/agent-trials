import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const port = 5185;
const base = process.argv[2] ?? `http://127.0.0.1:${port}`;
const server = process.argv[2] ? null : spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: process.cwd(), stdio: "ignore", windowsHide: true });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server && server.exitCode !== null) throw new Error(`Vite exited with ${server.exitCode}`);
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Vite did not start within 30 seconds");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (!response.ok()) pageErrors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /prove it/i }).waitFor();
    try { await page.locator(".trial-card h3").first().waitFor({ timeout: 15_000 }); }
    catch {
      console.error("Page alerts:", await page.locator('[role="alert"]').allTextContents());
      console.error("Page errors:", pageErrors);
      throw new Error("Public trial data did not load");
    }
    assert.ok((await page.locator(".trial-selector button").count()) > 0, "no public trials loaded");
    if (process.env.AGENT_TRIALS_QA_SCREENSHOTS === "1") {
      await page.screenshot({ path: `.qa-agent-arena-${viewport.width}.png`, fullPage: true });
    }
    assert.equal(await page.getByRole("button", { name: "Connect wallet" }).count(), 0,
      "website still asks visitors to connect a wallet");
    await page.getByRole("button", { name: "For agents" }).click();
    await page.getByRole("heading", { name: /connect an agent/i }).waitFor();
    await page.getByText("Use its wallet.").waitFor();
    await page.getByRole("button", { name: "Copy MCP configuration" }).waitFor();
    assert.match(await page.locator(".code-block code").textContent(), /AGENT_TRIALS_PROVIDER_MODULE/);
    assert.doesNotMatch(await page.locator(".code-block code").textContent(), /AGENT_TRIALS_WALLET_MODULE/);
    if (process.env.AGENT_TRIALS_QA_SCREENSHOTS === "1") {
      await page.screenshot({ path: `.qa-agent-connect-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Rankings" }).click();
    await page.getByRole("heading", { name: /rankings/i }).waitFor();
    await page.getByRole("button", { name: "The arena" }).click();
    await page.getByRole("heading", { name: /the arena/i }).waitFor();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    assert.equal(overflows, false, `${viewport.width}px viewport overflows horizontally`);
    const errors = await page.locator('[role="alert"]').allTextContents();
    assert.deepEqual(errors, [], `${viewport.width}px page showed an error`);
    console.log(`PASS: browser navigation, public trial read, and layout at ${viewport.width}px`);
    await page.close();
  }
} finally {
  await browser?.close();
  server?.kill();
}
