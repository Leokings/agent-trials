import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from gltest.direct.sdk_loader import setup_sdk_paths


BASE = "2026-10-08T10:00:00Z"
COMMIT_CLOSE = "2026-10-08T10:05:00Z"
REVEAL_CLOSE = "2026-10-08T10:07:00Z"
TASK = "Read this support report and explain the likely cause and the safest next step."
EVIDENCE = (
    "The status API returns PENDING until the background job completes. "
    "A PENDING job must not be retried with a new ID. A completed job returns DONE."
)
CRITERIA = [
    "Says the job is still pending rather than failed.",
    "States that PENDING is not a completed outcome.",
    "Advises checking the same job ID again.",
    "Does not recommend creating a new job ID.",
    "Mentions DONE as the completed status.",
]
SALT = "11" * 32
ANSWER = "The job is still PENDING, not failed. Check the same ID later; do not create another job. DONE means complete."


def ms(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def addr(value):
    from genlayer.py.types import Address

    return Address(value) if isinstance(value, bytes) else value


def address_text(value):
    return str(addr(value)).lower()


def commitment(trial_id, agent, answer, salt):
    preimage = (
        f"agent-trials:v1\n{trial_id}\n{agent}\n"
        f"{len(answer.encode('utf-8'))}:{answer}\n{salt}"
    )
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def deploy(direct_vm, direct_deploy, owner):
    setup_sdk_paths(Path("contracts/AgentTrials.py"), "v0.2.16")
    direct_vm.warp(BASE)
    direct_vm.sender = addr(owner)
    return direct_deploy("contracts/AgentTrials.py")


def make_trial(contract, direct_vm, creator, trial_id="trial-one", commit_close=COMMIT_CLOSE, reveal_close=REVEAL_CLOSE):
    direct_vm.sender = addr(creator)
    return contract.create_trial(
        trial_id,
        "Pending job triage",
        TASK,
        EVIDENCE,
        json.dumps(CRITERIA),
        ms(commit_close),
        ms(reveal_close),
    )


def register_and_commit(contract, direct_vm, agent):
    direct_vm.sender = addr(agent)
    contract.register_agent("Test Agent")
    digest = commitment("trial-one", address_text(agent), ANSWER, SALT)
    contract.commit_answer("trial-one", digest)


def test_complete_trial_awards_only_after_scoring(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_alice)
    register_and_commit(contract, direct_vm, direct_bob)

    agent = address_text(direct_bob)
    assert contract.get_agent(agent)["points"] == 0
    assert contract.get_entry("trial-one", agent)["answer"] == ""

    direct_vm.warp(COMMIT_CLOSE)
    direct_vm.sender = addr(direct_bob)
    with direct_vm.expect_revert("does not match"):
        contract.reveal_answer("trial-one", ANSWER, "22" * 32)
    contract.reveal_answer("trial-one", ANSWER, SALT)

    direct_vm.warp(REVEAL_CLOSE)
    direct_vm.mock_llm(r".*independent grader in Agent Trials.*", json.dumps({"checks": [True] * 5}))
    direct_vm.sender = addr(direct_alice)
    assert contract.score_answer("trial-one", agent) == {"checks": [True] * 5, "points": 100, "official": True}
    assert contract.get_agent(agent)["points"] == 100
    assert contract.get_agent(agent)["scored_trials"] == 1
    assert contract.get_leaderboard()[0]["address"] == agent
    with direct_vm.expect_revert("already scored"):
        contract.score_answer("trial-one", agent)


def test_validator_independently_regrades(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_alice)
    register_and_commit(contract, direct_vm, direct_bob)
    direct_vm.warp(COMMIT_CLOSE)
    direct_vm.sender = addr(direct_bob)
    contract.reveal_answer("trial-one", ANSWER, SALT)
    direct_vm.warp(REVEAL_CLOSE)
    direct_vm.mock_llm(r".*independent grader in Agent Trials.*", json.dumps({"checks": [True] * 5}))
    contract.score_answer("trial-one", address_text(direct_bob))

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*independent grader in Agent Trials.*", json.dumps({"checks": [False] * 5}))
    assert direct_vm.run_validator() is False


def test_deadlines_are_enforced(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_alice)
    register_and_commit(contract, direct_vm, direct_bob)
    with direct_vm.expect_revert("Not in the reveal window"):
        contract.reveal_answer("trial-one", ANSWER, SALT)

    direct_vm.warp(COMMIT_CLOSE)
    with direct_vm.expect_revert("Submission window has closed"):
        contract.commit_answer("trial-one", "aa" * 32)
    with direct_vm.expect_revert("did not reveal"):
        direct_vm.warp(REVEAL_CLOSE)
        contract.score_answer("trial-one", address_text(direct_bob))


def test_duplicate_and_invalid_trial_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_alice)
    with direct_vm.expect_revert("already exists"):
        make_trial(contract, direct_vm, direct_alice)

    assert contract.get_agent_status(address_text(direct_bob))["registered"] is False
    direct_vm.sender = addr(direct_bob)
    contract.register_agent("Test Agent")
    assert contract.get_agent_status(address_text(direct_bob))["registered"] is True
    assert contract.get_leaderboard() == []
    with direct_vm.expect_revert("already has an agent"):
        contract.register_agent("Second Agent")


def test_curator_handoff_requires_nominee_acceptance(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    direct_vm.sender = addr(direct_bob)
    with direct_vm.expect_revert("Only the curator"):
        contract.nominate_curator(address_text(direct_bob))
    with direct_vm.expect_revert("Only the nominated"):
        contract.accept_curator()

    direct_vm.sender = addr(direct_alice)
    contract.nominate_curator(address_text(direct_bob))
    assert contract.get_policy()["pending_curator"] == address_text(direct_bob)
    direct_vm.sender = addr(direct_bob)
    contract.accept_curator()
    assert contract.get_policy()["owner"] == address_text(direct_bob)
    assert contract.get_policy()["pending_curator"] == ""

    direct_vm.sender = addr(direct_alice)
    assert make_trial(contract, direct_vm, direct_alice)["official"] is False
    assert make_trial(contract, direct_vm, direct_bob, "trial-two")["official"] is True


def test_any_wallet_can_create_and_community_score_stays_local(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    created = make_trial(contract, direct_vm, direct_bob)
    assert created["creator"] == address_text(direct_bob)
    assert created["official"] is False
    assert contract.get_trial("trial-one")["official"] is False
    assert contract.get_creator_status(address_text(direct_bob))["next_create_ms"] == ms("2026-10-08T10:10:00Z")

    register_and_commit(contract, direct_vm, direct_bob)
    direct_vm.warp(COMMIT_CLOSE)
    direct_vm.sender = addr(direct_bob)
    contract.reveal_answer("trial-one", ANSWER, SALT)
    direct_vm.warp(REVEAL_CLOSE)
    direct_vm.mock_llm(r".*independent grader in Agent Trials.*", json.dumps({"checks": [True] * 5}))
    direct_vm.sender = addr(direct_alice)
    assert contract.score_answer("trial-one", address_text(direct_bob)) == {
        "checks": [True] * 5, "points": 100, "official": False
    }
    assert contract.get_agent(address_text(direct_bob))["points"] == 0
    assert contract.get_leaderboard() == []


def test_community_cooldown_and_trial_paging(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_bob)
    with direct_vm.expect_revert("cooldown"):
        make_trial(contract, direct_vm, direct_bob, "trial-two")
    direct_vm.warp("2026-10-08T10:11:00Z")
    assert make_trial(
        contract, direct_vm, direct_bob, "trial-two",
        "2026-10-08T10:15:00Z", "2026-10-08T10:17:00Z"
    )["official"] is False
    for index in range(21):
        make_trial(
            contract, direct_vm, direct_alice, f"official-{index:02d}",
            "2026-10-08T10:15:00Z", "2026-10-08T10:17:00Z"
        )
    assert contract.get_policy()["trial_count"] == 23
    assert len(contract.list_trials()) == 20
    assert len(contract.list_trials_page(20, 20)) == 3
    assert contract.list_trials_page(40, 20) == []
    with direct_vm.expect_revert("page size"):
        contract.list_trials_page(0, 21)


def test_five_entrants_can_join_and_sixth_is_rejected(direct_vm, direct_deploy, direct_alice):
    contract = deploy(direct_vm, direct_deploy, direct_alice)
    make_trial(contract, direct_vm, direct_alice)
    entrants = [addr(bytes([index]) * 20) for index in range(1, 7)]
    for index, entrant in enumerate(entrants):
        direct_vm.sender = entrant
        contract.register_agent(f"Agent {index + 1}")
        digest = commitment("trial-one", address_text(entrant), ANSWER, SALT)
        if index == 5:
            with direct_vm.expect_revert("full"):
                contract.commit_answer("trial-one", digest)
        else:
            contract.commit_answer("trial-one", digest)
    trial = contract.get_trial("trial-one")
    assert len(trial["entries"]) == 5
    assert trial["entries"] == [address_text(entrant) for entrant in entrants[:5]]
