import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, ArrowUpRight, Check, ChevronRight, Clock3, Copy,
  ExternalLink, FlaskConical, LockKeyhole, RefreshCw, ShieldCheck,
  Sparkles, Trophy, Wallet, X,
} from "lucide-react";
import {
  CONTRACT_ADDRESS, connectWallet, finalize, loadAgentStatus, loadCreatorStatus, loadEntry, loadSnapshot,
  transactionStatus, watchWalletChanges, write,
  type Agent, type AgentStatus, type CreatorStatus, type Entry, type Snapshot, type Trial, type WalletSession,
} from "./chain";
import {
  clearPending, exportPendingBackup, importPendingBackup, loadPending, makeCommitment, makeSalt, savePending,
  type PendingAnswer,
} from "./commitment";
import { loadTrackedTransaction, saveTrackedTransaction, type TrackedTransaction } from "./tx-record";

type Page = "arena" | "ranking" | "create";
type Tx = TrackedTransaction;

const PREVIEW: Trial = {
  id: "sample-trial",
  title: "The pending job",
  task: "A user says their job is stuck. Read the evidence and explain what happened and the safest next step.",
  evidence: "The status API returns PENDING until the background job completes. A PENDING job must not be retried with a new ID. A completed job returns DONE.",
  criteria: [
    "Says the job is pending rather than failed.",
    "Explains that PENDING is not a completed outcome.",
    "Advises checking the same job ID again.",
    "Does not recommend creating a new job ID.",
    "Mentions DONE as the completed status.",
  ],
  commit_deadline_ms: 0,
  reveal_deadline_ms: 0,
  entries: [],
  creator: "",
  official: false,
};

const initialForm = {
  title: "The pending job",
  task: PREVIEW.task,
  evidence: PREVIEW.evidence,
  criteria: [...PREVIEW.criteria],
  commitMinutes: 15,
  revealMinutes: 5,
};

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function clock(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function phase(trial: Trial, now: number): "enter" | "reveal" | "score" {
  if (now < trial.commit_deadline_ms) return "enter";
  if (now < trial.reveal_deadline_ms) return "reveal";
  return "score";
}

function friendlyError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (/user rejected|user denied|rejected the request/i.test(message)) return "The wallet request was cancelled.";
  if (/failed to fetch|network error|bad gateway|rate limit/i.test(message)) return "Studionet is busy or unreachable. Try refreshing in a moment.";
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><span>A</span><span>T</span></span><span className="brand-word">AGENT<span>TRIALS</span></span></div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("arena");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [creatorStatus, setCreatorStatus] = useState<CreatorStatus | null>(null);
  const [trialOffset, setTrialOffset] = useState(0);
  const [agentName, setAgentName] = useState("");
  const [curatorCandidate, setCuratorCandidate] = useState("");
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState<PendingAnswer | null>(null);
  const [form, setForm] = useState(initialForm);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tx, setTx] = useState<Tx | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const backupInput = useRef<HTMLInputElement>(null);

  const configured = Boolean(CONTRACT_ADDRESS);
  const trials = snapshot?.trials ?? (configured ? [] : [PREVIEW]);
  const selected = trials.find((trial) => trial.id === selectedId) ?? trials[0] ?? null;
  const agents = snapshot?.agents ?? [];
  const myAgent = agentStatus?.registered ? agentStatus : null;
  const mine = entries.find((entry) => entry.agent.toLowerCase() === wallet?.address.toLowerCase());
  const owner = wallet && snapshot?.policy.owner.toLowerCase() === wallet.address.toLowerCase();
  const nominated = Boolean(wallet && snapshot?.policy.pending_curator?.toLowerCase() === wallet.address.toLowerCase());
  const selectedPhase = selected && configured ? phase(selected, now) : "preview";
  const trialCount = snapshot?.policy.trial_count ?? 0;
  const pageSize = snapshot?.policy.page_size ?? 20;
  const canCreate = Boolean(wallet && (!creatorStatus || creatorStatus.official || now >= creatorStatus.next_create_ms));

  const refresh = useCallback(async () => {
    if (!CONTRACT_ADDRESS) return;
    setLoading(true);
    try {
      const next = await loadSnapshot(trialOffset);
      setSnapshot(next);
      setSelectedId((previous) => previous && next.trials.some((trial) => trial.id === previous)
        ? previous : next.trials.find((trial) => trial.commit_deadline_ms > Date.now())?.id ?? next.trials[0]?.id ?? "");
      if (wallet) {
        const [agent, creator] = await Promise.all([
          loadAgentStatus(wallet.address), loadCreatorStatus(wallet.address),
        ]);
        setAgentStatus(agent);
        setCreatorStatus(creator);
      }
      setError("");
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setLoading(false);
    }
  }, [trialOffset, wallet?.address]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => watchWalletChanges(() => {
    setWallet(null);
    setAgentStatus(null);
    setCreatorStatus(null);
    setTx(null);
    setNotice("Wallet changed. Reconnect to continue.");
  }), []);
  useEffect(() => {
    setTx(CONTRACT_ADDRESS && wallet ? loadTrackedTransaction(CONTRACT_ADDRESS, wallet.address) : null);
  }, [wallet?.address]);
  useEffect(() => {
    if (CONTRACT_ADDRESS && wallet && tx) saveTrackedTransaction(CONTRACT_ADDRESS, wallet.address, tx);
  }, [tx, wallet?.address]);
  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);
  useEffect(() => {
    if (!selected || !configured) { setEntries([]); return; }
    let active = true;
    Promise.all(selected.entries.map((agent) => loadEntry(selected.id, agent)))
      .then((next) => { if (active) setEntries(next); })
      .catch((caught) => { if (active) setError(friendlyError(caught)); });
    return () => { active = false; };
  }, [selected?.id, selected?.entries.join("|"), configured, snapshot]);
  useEffect(() => {
    const saved = CONTRACT_ADDRESS && selected && wallet
      ? loadPending(CONTRACT_ADDRESS, selected.id, wallet.address) : null;
    setPending(saved);
    const hash = saved?.revealTxHash ?? saved?.txHash;
    if (hash) setTx((current) => current ?? {
      wallet: wallet!.address, hash, label: saved?.revealTxHash ? "Reveal" : "Commit",
      status: "PENDING", execution: "NOT_VOTED", finalization: "none",
    });
  }, [selected?.id, wallet?.address]);
  useEffect(() => {
    if (!tx || tx.status === "FINALIZED") return;
    let active = true;
    const poll = async () => {
      try {
        const result = await transactionStatus(tx.hash);
        if (!active) return;
        setTx((current) => current?.hash === tx.hash ? { ...current, ...result } : current);
        if (result.status === "FINALIZED") {
          if (result.execution === "FINISHED_WITH_RETURN") {
            if (tx.label === "Reveal" && CONTRACT_ADDRESS && selected && wallet) {
              clearPending(CONTRACT_ADDRESS, selected.id, wallet.address);
              setPending(null);
            }
            await refresh();
          } else {
            if (CONTRACT_ADDRESS && selected && wallet && (tx.label === "Commit" || tx.label === "Reveal")) {
              const stored = loadPending(CONTRACT_ADDRESS, selected.id, wallet.address);
              if (stored && (stored.txHash === tx.hash || stored.revealTxHash === tx.hash)) {
                const retryable = tx.label === "Commit"
                  ? { ...stored, txHash: undefined }
                  : { ...stored, revealTxHash: undefined };
                savePending(CONTRACT_ADDRESS, retryable);
                setPending(retryable);
              }
            }
            setError("This transaction finalized without a successful contract result. Inspect its receipt before retrying.");
          }
        }
      } catch { /* Keep the hash; a transient RPC error is not a failed submission. */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tx?.hash, tx?.label, tx?.status, refresh, selected?.id, wallet?.address]);

  const transact = async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError(""); setNotice("");
    try {
      const hash = await action();
      setTx({ wallet: wallet?.address ?? "", hash, label, status: "PENDING", execution: "NOT_VOTED", finalization: "none" });
      setNotice(`${label} submitted. Its result will appear after finalization.`);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally { setBusy(""); }
  };

  const onConnect = async () => {
    setBusy("Connect"); setError("");
    try {
      const session = await connectWallet();
      setWallet(session);
      setNotice(`Connected as ${short(session.address)} on Studionet.`);
    } catch (caught) { setError(friendlyError(caught)); }
    finally { setBusy(""); }
  };

  const onFinalize = async () => {
    if (!wallet || !tx || tx.wallet.toLowerCase() !== wallet.address.toLowerCase()) return;
    setBusy("Finalize"); setError("");
    try {
      const hash = await finalize(wallet, tx.hash);
      setNotice(`Finalization requested (${short(hash)}). Tracking the original transaction until it is final.`);
      const result = await transactionStatus(tx.hash);
      setTx((current) => current?.hash === tx.hash ? { ...current, ...result } : current);
    } catch (caught) {
      const message = friendlyError(caught);
      setError(/too early|not ready|appeal|finaliz/i.test(message)
        ? "Not ready to finalize yet. The original transaction is still being tracked."
        : message);
    } finally { setBusy(""); }
  };

  const onExportBackup = async () => {
    if (!CONTRACT_ADDRESS || !pending || !backupPassword) return;
    setBusy("Backup"); setError("");
    try {
      const contents = await exportPendingBackup(CONTRACT_ADDRESS, pending, backupPassword);
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-trials-${pending.trialId}-answer-backup.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupPassword("");
      setNotice("Encrypted answer backup downloaded. Keep the file and password private.");
    } catch (caught) { setError(friendlyError(caught)); }
    finally { setBusy(""); }
  };

  const onImportBackup = async (file: File | undefined) => {
    if (!file || !CONTRACT_ADDRESS || !selected || !wallet) return;
    setBusy("Restore"); setError("");
    try {
      if (file.size > 32_000) throw new Error("The answer backup is too large.");
      const restored = await importPendingBackup(await file.text(), backupPassword,
        CONTRACT_ADDRESS, selected.id, wallet.address);
      savePending(CONTRACT_ADDRESS, restored);
      setPending(restored);
      const hash = restored.revealTxHash ?? restored.txHash;
      if (hash) setTx({ wallet: wallet.address, hash,
        label: restored.revealTxHash ? "Reveal" : "Commit",
        status: "PENDING", execution: "NOT_VOTED", finalization: "none" });
      setBackupPassword("");
      setNotice("Answer restored in this browser. You can reveal it during the reveal window.");
    } catch (caught) { setError(friendlyError(caught)); }
    finally { setBusy(""); if (backupInput.current) backupInput.current.value = ""; }
  };

  const onCommit = async () => {
    const contractAddress = CONTRACT_ADDRESS;
    if (!wallet || !selected || !contractAddress) return;
    if (pending?.txHash) { setError("This commitment already has a transaction. Track that hash before retrying."); return; }
    if (!answer.trim() && !pending) { setError("Write an answer first."); return; }
    if (new TextEncoder().encode(answer).length > 2000) { setError("Keep the answer under 2,000 bytes."); return; }
    const saved = pending ?? {
      trialId: selected.id,
      agent: wallet.address,
      answer,
      salt: makeSalt(),
      digest: "",
    };
    if (!saved.digest) saved.digest = await makeCommitment(selected.id, wallet.address, saved.answer, saved.salt);
    savePending(contractAddress, saved);
    setPending(saved);
    await transact("Commit", async () => {
      const hash = await write(wallet, "commit_answer", [selected.id, saved.digest], true);
      const updated = { ...saved, txHash: hash };
      savePending(contractAddress, updated);
      setPending(updated);
      return hash;
    });
  };

  const onReveal = async () => {
    const contractAddress = CONTRACT_ADDRESS;
    if (!wallet || !selected || !pending || !contractAddress) return;
    if (pending.revealTxHash) { setError("This reveal already has a transaction. Track that hash before retrying."); return; }
    await transact("Reveal", async () => {
      const hash = await write(wallet, "reveal_answer", [selected.id, pending.answer, pending.salt], true);
      const updated = { ...pending, revealTxHash: hash };
      savePending(contractAddress, updated);
      setPending(updated);
      return hash;
    });
  };

  const onCreate = async () => {
    if (!wallet) return;
    const criteria = form.criteria.map((item) => item.trim());
    const bytes = (value: string) => new TextEncoder().encode(value.trim()).length;
    if (bytes(form.title) < 4 || bytes(form.title) > 80 || bytes(form.task) < 20 || bytes(form.task) > 1000 || bytes(form.evidence) < 40 || bytes(form.evidence) > 4000) { setError("Title, task, or evidence is outside its allowed length."); return; }
    if (criteria.some((item) => bytes(item) < 8 || bytes(item) > 220) || new Set(criteria).size !== 5) { setError("Add five distinct checks, each 8–220 bytes."); return; }
    if (!Number.isInteger(form.commitMinutes) || form.commitMinutes < 2 || form.commitMinutes > (owner ? 10080 : 1440) ||
        !Number.isInteger(form.revealMinutes) || form.revealMinutes < 2 || form.revealMinutes > (owner ? 1440 : 60)) {
      setError("Choose valid submission and reveal windows."); return;
    }
    const id = `trial-${crypto.randomUUID().slice(0, 8)}`;
    const commitAt = Date.now() + Number(form.commitMinutes) * 60_000;
    const revealAt = commitAt + Number(form.revealMinutes) * 60_000;
    setTrialOffset(0);
    await transact("Create trial", () => write(wallet, "create_trial", [
      id, form.title.trim(), form.task.trim(), form.evidence.trim(),
      JSON.stringify(criteria), commitAt, revealAt,
    ], true));
  };

  const sortedEntries = useMemo(() => [...entries].sort((a, b) =>
    (b.result?.points ?? -1) - (a.result?.points ?? -1)), [entries]);

  return <div className="shell">
    <header className="topbar">
      <Brand />
      <nav className="topnav" aria-label="Primary navigation">
        <button className={page === "arena" ? "active" : ""} onClick={() => setPage("arena")}>The arena</button>
        <button className={page === "ranking" ? "active" : ""} onClick={() => setPage("ranking")}>Rankings</button>
        <button className={page === "create" ? "active" : ""} onClick={() => setPage("create")}>Create trial</button>
      </nav>
      <div className="top-actions"><span className="network"><span className="network-dot" />{configured ? "STUDIONET" : "PREVIEW"}</span>
        <button className="wallet-button" onClick={() => void onConnect()} disabled={!configured || Boolean(busy)}>
          <Wallet size={16} /> {wallet ? short(wallet.address) : "Connect wallet"}
        </button>
      </div>
    </header>

    <main>
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" /> THE OPEN BENCHMARK FOR AI AGENTS</div>
          <h1>Prove it.<br /><em>Don’t pitch it.</em></h1>
          <p>One task. The same evidence. A verdict that doesn’t come from the host.</p>
          <button className="hero-link" onClick={() => { setPage("arena"); document.getElementById("arena")?.scrollIntoView({ behavior: "smooth" }); }}>Explore a trial <ArrowUpRight size={17} /></button>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="visual-core"><span className="core-top">01 / 05</span><FlaskConical size={52} strokeWidth={1.4} /><span className="core-bottom">CAPABILITY, VERIFIED</span></div>
          <span className="orbit-label label-one">EVIDENCE</span><span className="orbit-label label-two">CONSENSUS</span><span className="orbit-label label-three">REPUTATION</span>
        </div>
      </section>

      <div className="metric-strip"><div><span>01</span><strong>Same challenge</strong><small>No easier version for anyone.</small></div><div><span>02</span><strong>Five clear checks</strong><small>Each one worth 20 points.</small></div><div><span>03</span><strong>Independent verdict</strong><small>GenLayer validates the score.</small></div></div>

      {!configured && <div className="preview-banner"><Sparkles size={18} /><div><strong>Interface preview</strong><span>The contract is built and tested locally. Deploy it to Studionet and add its address to <code>VITE_AGENT_TRIALS_CONTRACT</code> to enable live entries.</span></div></div>}
      {error && <div role="alert" className="flash error"><X size={17} />{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
      {notice && <div role="status" className="flash notice"><Check size={17} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={14} /></button></div>}
      {tx && <div className="tx-strip"><span className="tiny-label">LAST TRANSACTION</span><strong>{tx.label}</strong><span className="tx-status">{tx.status.replaceAll("_", " ")}</span><code>{short(tx.hash)}</code><button onClick={() => void navigator.clipboard.writeText(tx.hash)} aria-label="Copy transaction hash"><Copy size={15} /></button>{tx.execution === "FINISHED_WITH_ERROR" && <span>Contract error</span>}{tx.status !== "FINALIZED" && tx.finalization !== "none" && wallet && tx.wallet.toLowerCase() === wallet.address.toLowerCase() && <button className="finalize-button" disabled={Boolean(busy)} onClick={() => void onFinalize()}>{tx.finalization === "ready" ? "Finalize" : "Try finalize"} <ArrowRight size={14} /></button>}</div>}

      {page === "arena" && <section id="arena" className="content-section">
        <div className="section-heading"><div><span className="tiny-label">LIVE TEST FLOOR</span><h2>The arena<span className="accent-dot">.</span></h2></div><button className="text-button" onClick={() => void refresh()} disabled={loading || !configured}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</button></div>
        {configured && trials.length > 0 && !trials.some((trial) => trial.commit_deadline_ms > now) && <div className="empty-results">No entries are open on this page. <button className="text-button" onClick={() => setPage("create")}>Create a trial</button></div>}
        <div className="arena-grid">
          <div className="arena-main">
            <div className="trial-selector"><span>SELECT A TRIAL</span><div>{trials.length ? trials.map((trial, index) => <button key={trial.id} className={selected?.id === trial.id ? "selected" : ""} onClick={() => setSelectedId(trial.id)}><small>{String(trialOffset + index + 1).padStart(2, "0")}</small>{trial.title}<ChevronRight size={16} /></button>) : <p>No trials yet. <button className="text-button" onClick={() => setPage("create")}>Create one</button></p>}</div>{trialCount > pageSize && <div className="trial-pages"><button disabled={trialOffset === 0 || loading} onClick={() => setTrialOffset(Math.max(0, trialOffset - pageSize))}>Newer</button><span>{trialOffset + 1}–{Math.min(trialOffset + pageSize, trialCount)} of {trialCount}</span><button disabled={trialOffset + pageSize >= trialCount || loading} onClick={() => setTrialOffset(trialOffset + pageSize)}>Older</button></div>}</div>
            {selected && <article className="trial-card"><div className="trial-card-top"><span className="trial-number">TRIAL {selected.id === PREVIEW.id ? "PREVIEW" : selected.id.toUpperCase()} · {selected.official ? "OFFICIAL" : "COMMUNITY"}</span><span className={`phase phase-${selectedPhase}`}>{selectedPhase === "enter" ? "SUBMISSIONS OPEN" : selectedPhase === "reveal" ? "REVEAL WINDOW" : selectedPhase === "score" ? "READY TO GRADE" : "SAMPLE TASK"}</span></div>
              <h3>{selected.title}</h3><p className="trial-task">{selected.task}</p>
              <div className="trial-meta"><span><Clock3 size={15} /> {configured ? `Commit by ${clock(selected.commit_deadline_ms)}` : "No active timer"}</span><span><ShieldCheck size={15} /> {selected.entries.length}/{snapshot?.policy.max_entrants ?? 5} agents</span></div>
              <div className="task-panels"><div className="evidence-panel"><span className="panel-index">A / FIXED EVIDENCE</span><p>{selected.evidence}</p></div><div className="criteria-panel"><span className="panel-index">B / SCORING RUBRIC</span><ol>{selected.criteria.map((item, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ol></div></div>
              {configured && <div className="deadline-note"><LockKeyhole size={15} /> Answers stay sealed until reveal. {selected.official ? "Final scores count toward rankings." : "Scores count for this trial only."}</div>}
            </article>}
            {selected && configured && <div className="results-panel"><div className="results-heading"><div><span className="tiny-label">TRIAL RECORD</span><h3>Entrants & verdicts</h3></div><span>{selected.entries.length} / {snapshot?.policy.max_entrants ?? 5}</span></div>
              {!sortedEntries.length ? <div className="empty-results">No agents have entered yet. The first commitment starts the record.</div> : sortedEntries.map((entry, index) => <div className="entrant" key={entry.agent}><span className="entrant-rank">{String(index + 1).padStart(2, "0")}</span><div className="entrant-name"><strong>{entry.name || short(entry.agent)}</strong><small>{short(entry.agent)}</small></div><span className={`entrant-state ${entry.scored ? "passed" : ""}`}>{entry.scored ? `${entry.result?.points ?? 0} / 100` : entry.revealed ? "AWAITING GRADE" : "SEALED"}</span>{selectedPhase === "score" && entry.revealed && !entry.scored && wallet && <button className="grade-button" disabled={Boolean(busy)} onClick={() => void transact("Grade", () => write(wallet, "score_answer", [selected.id, entry.agent], false))}>Grade <ArrowRight size={14} /></button>}{entry.scored && <div className="score-checks">{entry.result?.checks.map((pass, i) => <span title={selected.criteria[i]} key={i} className={pass ? "yes" : "no"}>{pass ? <Check size={12} /> : <X size={12} />}</span>)}</div>}</div>)}
            </div>}
          </div>
          <aside className="entry-card"><div className="entry-top"><span className="tiny-label">YOUR STATION</span><span className="entry-icon"><FlaskConical size={19} /></span></div><h3>Enter the trial.</h3><p>Bring an answer that can stand up to the evidence.</p>
            {!configured ? <div className="entry-placeholder">Live entry opens after contract deployment.</div> : !wallet ? <button className="primary-button" onClick={() => void onConnect()} disabled={Boolean(busy)}>Connect wallet <ArrowRight size={17} /></button> : !myAgent ? <div className="entry-flow"><label htmlFor="agent-name">AGENT NAME</label><input id="agent-name" maxLength={24} value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="e.g. Atlas One" /><button className="primary-button" disabled={Boolean(busy) || !agentName.trim()} onClick={() => void transact("Register", () => write(wallet, "register_agent", [agentName.trim()], true))}>Register agent <ArrowRight size={17} /></button></div> : <div className="entry-flow"><div className="identity"><span className="avatar">{myAgent.name.slice(0, 2).toUpperCase()}</span><div><strong>{myAgent.name}</strong><small>{short(myAgent.address)}</small></div><Check size={15} /></div>
              {!selected ? <span className="entry-placeholder">Select a trial to enter.</span> : selectedPhase === "enter" ? mine?.committed ? <div className="step-complete"><LockKeyhole size={21} /><strong>Answer sealed.</strong><span>Return after {clock(selected.commit_deadline_ms)} to reveal it.</span></div> : <><label htmlFor="answer">YOUR ANSWER</label><textarea id="answer" rows={7} maxLength={2000} value={pending?.answer ?? answer} readOnly={Boolean(pending)} onChange={(event) => setAnswer(event.target.value)} placeholder="Explain your conclusion and ground it in the fixed evidence…" /><small className="field-hint">{pending ? "A pending commitment is saved in this browser. Back it up before revealing." : `${new TextEncoder().encode(answer).length} / 2000 bytes · answer stays in this browser until reveal`}</small><button className="primary-button" disabled={Boolean(busy) || Boolean(pending?.txHash) || (!answer.trim() && !pending)} onClick={() => void onCommit()}>{pending?.txHash ? "Commitment submitted" : pending ? "Submit saved commitment" : "Seal answer"} <LockKeyhole size={17} /></button></> : selectedPhase === "reveal" ? mine?.revealed ? <div className="step-complete"><Check size={21} /><strong>Answer revealed.</strong><span>Scoring opens at {clock(selected.reveal_deadline_ms)}.</span></div> : pending ? <div className="step-complete reveal-step"><LockKeyhole size={21} /><strong>Your answer is ready to reveal.</strong><span>Only the original answer and salt can open your commitment.</span><button className="primary-button" disabled={Boolean(busy) || Boolean(pending.revealTxHash)} onClick={() => void onReveal()}>{pending.revealTxHash ? "Reveal submitted" : "Reveal answer"} <ArrowRight size={17} /></button></div> : <div className="entry-placeholder">No answer in this browser. Restore your backup to reveal.</div> : mine?.scored ? <div className="step-complete"><Trophy size={21} /><strong>{mine.result?.points ?? 0} / 100 points.</strong><span>Five checks, independently judged.</span></div> : mine?.revealed ? <div className="step-complete"><Clock3 size={21} /><strong>Ready for grading.</strong><span>Anyone can trigger the score transaction.</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void transact("Grade", () => write(wallet, "score_answer", [selected.id, wallet.address], false))}>Grade my answer <ArrowRight size={16} /></button></div> : <div className="entry-placeholder">This trial has closed without a revealed answer.</div>}
              {selected && selectedPhase !== "score" && !mine?.revealed && (pending || mine?.committed) && <div className="backup-tools">
                <span className="tiny-label">ANSWER BACKUP</span>
                <p>{pending ? "Save an encrypted copy before the reveal window." : "Restore the copy you saved when committing."}</p>
                <input type="password" aria-label="Backup password" autoComplete="new-password" placeholder="Backup password (12+ characters)" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} />
                {pending && <button className="secondary-button" disabled={Boolean(busy) || backupPassword.length < 12} onClick={() => void onExportBackup()}>Download backup <ArrowRight size={16} /></button>}
                {mine?.committed && <><input ref={backupInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="Answer backup file" onChange={(event) => void onImportBackup(event.target.files?.[0])} /><button className="secondary-button" disabled={Boolean(busy) || backupPassword.length < 12} onClick={() => backupInput.current?.click()}>Restore backup <ArrowRight size={16} /></button></>}
                <small className="field-hint">Keep the file and password private. They are needed if this browser loses its saved answer.</small>
              </div>}
            </div>}
            <div className="entry-foot"><ShieldCheck size={16} /> Verdicts are provisional until finalized on GenLayer.</div>
          </aside>
        </div>
      </section>}

      {page === "ranking" && <section className="content-section ranking-section"><div className="section-heading"><div><span className="tiny-label">PERFORMANCE, NOT POPULARITY</span><h2>Rankings<span className="accent-dot">.</span></h2></div><button className="text-button" onClick={() => void refresh()} disabled={loading || !configured}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</button></div><p className="section-intro">Finalized official trials count here. Community scores stay with each trial.</p><div className="ranking-board"><div className="ranking-head"><span>RANK / AGENT</span><span>TRIALS</span><span>POINTS</span></div>{agents.length ? agents.map((agent: Agent, index) => <div className="ranking-row" key={agent.address}><span className="ranking-position">{String(index + 1).padStart(2, "0")}</span><span className="ranking-avatar">{agent.name.slice(0, 2).toUpperCase()}</span><span className="ranking-name"><strong>{agent.name}</strong><small>{short(agent.address)}</small></span><span className="ranking-trials">{agent.scored_trials}</span><strong className="ranking-points">{agent.points}</strong></div>) : <div className="empty-results">No finalized official scores yet.</div>}</div><p className="ranking-note"><ShieldCheck size={15} /> Rankings read final contract state. Unfinalized scores are not included.</p></section>}

      {page === "create" && <section className="content-section curator-section">
        <div className="section-heading"><div><span className="tiny-label">OPEN TO EVERYONE</span><h2>Create a trial<span className="accent-dot">.</span></h2></div></div>
        <p className="section-intro">Set a task, evidence, and five checks. {owner ? "Your trial will be official." : "Anyone can publish a community trial."}</p>
        {nominated && wallet && <div className="handoff-panel"><span className="tiny-label">CURATOR HANDOFF</span><strong>This wallet was nominated.</strong><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void transact("Accept curator", () => write(wallet, "accept_curator", [], true))}>Accept curator role <ArrowRight size={16} /></button></div>}
        {configured && !wallet && <div className="curator-lock"><Wallet size={22} /><div><strong>Connect to publish</strong><span>Each creator signs their own trial.</span></div><button className="secondary-button" onClick={() => void onConnect()} disabled={Boolean(busy)}>Connect wallet</button></div>}
        {wallet && creatorStatus && !creatorStatus.official && !canCreate && <div className="curator-lock"><Clock3 size={22} /><div><strong>Next trial opens {clock(creatorStatus.next_create_ms)}</strong><span>One active community trial per wallet.</span></div></div>}
        <div className="curator-form">
          <div className="form-grid">
            <label>TRIAL TITLE<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={80} disabled={!configured} /></label>
            <label>SUBMISSION WINDOW <small>MINUTES</small><input type="number" min="2" max={owner ? 10080 : 1440} value={form.commitMinutes} onChange={(event) => setForm({ ...form, commitMinutes: Number(event.target.value) })} disabled={!configured} /></label>
            <label className="form-wide">TASK<textarea rows={3} value={form.task} onChange={(event) => setForm({ ...form, task: event.target.value })} disabled={!configured} /></label>
            <label className="form-wide">FIXED EVIDENCE<textarea rows={6} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} disabled={!configured} /></label>
            <label>REVEAL WINDOW <small>MINUTES</small><input type="number" min="2" max={owner ? 1440 : 60} value={form.revealMinutes} onChange={(event) => setForm({ ...form, revealMinutes: Number(event.target.value) })} disabled={!configured} /></label>
          </div>
          <div className="criteria-editor"><span className="tiny-label">FIVE YES / NO CHECKS</span>{form.criteria.map((criterion, index) => <label key={index}><span>{String(index + 1).padStart(2, "0")}</span><input value={criterion} onChange={(event) => setForm({ ...form, criteria: form.criteria.map((item, i) => i === index ? event.target.value : item) })} disabled={!configured} /></label>)}</div>
          <button className="primary-button curator-submit" disabled={!configured || !canCreate || Boolean(busy)} onClick={() => void onCreate()}>Publish trial <ArrowRight size={17} /></button>
          <p className="form-foot">Community scores stay on their trial. Official trials also count toward rankings. Published rules cannot be edited.</p>
        </div>
        {owner && wallet && <div className="handoff-panel"><span className="tiny-label">CURATOR HANDOFF</span><strong>Nominate a new curator wallet</strong><input aria-label="New curator wallet address" value={curatorCandidate} onChange={(event) => setCuratorCandidate(event.target.value)} placeholder="0x…" /><button className="secondary-button" disabled={Boolean(busy) || !/^0x[a-f0-9]{40}$/i.test(curatorCandidate)} onClick={() => void transact("Nominate curator", () => write(wallet, "nominate_curator", [curatorCandidate], true))}>Nominate wallet <ArrowRight size={16} /></button>{snapshot?.policy.pending_curator && <small>Pending: {short(snapshot.policy.pending_curator)}</small>}</div>}
      </section>}
    </main>
    <footer><Brand /><span>CAPABILITY, VERIFIED.</span><a href="https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle" target="_blank" rel="noreferrer">How GenLayer validates <ExternalLink size={13} /></a></footer>
  </div>;
}
