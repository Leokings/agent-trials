const PENDING_PREFIX = "agent-trials.pending.v1";
const BACKUP_FORMAT = "agent-trials-answer-backup";
const BACKUP_ITERATIONS = 210_000;

export type PendingAnswer = {
  trialId: string;
  agent: string;
  answer: string;
  salt: string;
  digest: string;
  txHash?: string;
  revealTxHash?: string;
};

export function makeSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function makeCommitment(
  trialId: string,
  agent: string,
  answer: string,
  salt: string,
): Promise<string> {
  const size = new TextEncoder().encode(answer).length;
  const preimage = `agent-trials:v1\n${trialId}\n${agent.toLowerCase()}\n${size}:${answer}\n${salt}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function storageKey(contract: string, trialId: string, agent: string): string {
  return `${PENDING_PREFIX}:${contract.toLowerCase()}:${trialId}:${agent.toLowerCase()}`;
}

export function savePending(contract: string, pending: PendingAnswer): void {
  localStorage.setItem(storageKey(contract, pending.trialId, pending.agent), JSON.stringify(pending));
}

export function loadPending(contract: string, trialId: string, agent: string): PendingAnswer | null {
  try {
    const raw = localStorage.getItem(storageKey(contract, trialId, agent));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingAnswer>;
    if (
      value.trialId !== trialId || value.agent?.toLowerCase() !== agent.toLowerCase()
      || typeof value.answer !== "string" || !/^[a-f0-9]{64}$/.test(value.salt ?? "")
      || !/^[a-f0-9]{64}$/.test(value.digest ?? "")
      || (value.txHash !== undefined && !/^0x[a-f0-9]{64}$/i.test(value.txHash))
      || (value.revealTxHash !== undefined && !/^0x[a-f0-9]{64}$/i.test(value.revealTxHash))
    ) return null;
    return value as PendingAnswer;
  } catch {
    return null;
  }
}

export function clearPending(contract: string, trialId: string, agent: string): void {
  localStorage.removeItem(storageKey(contract, trialId, agent));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string, expectedBytes: number): Uint8Array {
  if (typeof value !== "string" || !Number.isInteger(expectedBytes) || value.length !== expectedBytes * 2 || !/^[a-f0-9]+$/.test(value)) {
    throw new Error("The answer backup is invalid.");
  }
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function backupKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (password.length < 12) throw new Error("Use a backup password of at least 12 characters.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function exportPendingBackup(contract: string, pending: PendingAnswer, password: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(pending.salt) || !/^[a-f0-9]{64}$/.test(pending.digest)
    || await makeCommitment(pending.trialId, pending.agent, pending.answer, pending.salt) !== pending.digest) {
    throw new Error("The saved answer no longer matches its commitment.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupKey(password, salt, BACKUP_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(pending)),
  );
  return JSON.stringify({
    format: BACKUP_FORMAT, version: 1, contract: contract.toLowerCase(),
    trialId: pending.trialId, agent: pending.agent.toLowerCase(),
    iterations: BACKUP_ITERATIONS, salt: hex(salt), iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)),
  }, null, 2);
}

export async function importPendingBackup(
  raw: string, password: string, contract: string, trialId: string, agent: string,
): Promise<PendingAnswer> {
  if (raw.length > 32_000) throw new Error("The answer backup is too large.");
  let backup: Record<string, unknown>;
  try { backup = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error("The answer backup is not valid JSON."); }
  if (
    backup.format !== BACKUP_FORMAT || backup.version !== 1
    || backup.contract !== contract.toLowerCase() || backup.trialId !== trialId
    || backup.agent !== agent.toLowerCase() || backup.iterations !== BACKUP_ITERATIONS
  ) throw new Error("This backup does not belong to this trial, wallet, and contract.");
  const salt = fromHex(backup.salt as string, 16);
  const iv = fromHex(backup.iv as string, 12);
  if (typeof backup.ciphertext !== "string" || backup.ciphertext.length < 32 || backup.ciphertext.length > 16_000) {
    throw new Error("The answer backup is invalid.");
  }
  const ciphertext = fromHex(backup.ciphertext, backup.ciphertext.length / 2);
  let pending: PendingAnswer;
  try {
    const key = await backupKey(password, salt, BACKUP_ITERATIONS);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    pending = JSON.parse(new TextDecoder().decode(plaintext)) as PendingAnswer;
  } catch {
    throw new Error("Could not unlock the backup. Check the password and file.");
  }
  if (
    pending?.trialId !== trialId || typeof pending.agent !== "string" || pending.agent.toLowerCase() !== agent.toLowerCase()
    || !/^[a-f0-9]{64}$/.test(pending.salt) || !/^[a-f0-9]{64}$/.test(pending.digest)
    || typeof pending.answer !== "string"
    || new TextEncoder().encode(pending.answer).length > 2000
    || (pending.txHash !== undefined && !/^0x[a-f0-9]{64}$/i.test(pending.txHash))
    || (pending.revealTxHash !== undefined && !/^0x[a-f0-9]{64}$/i.test(pending.revealTxHash))
    || await makeCommitment(trialId, agent, pending.answer, pending.salt) !== pending.digest
  ) throw new Error("The backup answer does not match its commitment.");
  return pending;
}
