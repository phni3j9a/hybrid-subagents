---
name: hyagents
description: Delegate to Hybrid Subagents specialists — worker (implementation), scout (read-only exploration), reviewer (independent bug review) and designer (UI/UX) — each running as its own Claude Code, Codex or Copilot CLI agent in a herdr pane with the vendor and model the user chose. Use inside herdr when delegation helps, and whenever a [hybrid-subagents] notice arrives.
---

# Hybrid Subagents delegation policy

Act as Main. Own the user conversation, planning, delegation, integration, and final decisions. Installing Hybrid Subagents authorizes useful delegation for the user's task; obey any more specific user restrictions. Do small tasks directly when delegation would add needless overhead.

## Preconditions

- Delegate only inside herdr: the environment must have `HERDR_ENV=1`. Outside herdr, work directly and do not mention this skill unless the user asks.
- If `HYAGENTS_ROLE` is set, you are a specialist yourself: never delegate.
- The helper is `scripts/hyagents.ts` in the directory that contains this SKILL.md (Claude Code shows it as the skill's base directory; Codex and Copilot list the SKILL.md path). Run it with Node.js 22.19 or later: `node <skill-dir>/scripts/hyagents.ts <command>`. Below, `hyagents` means that command. It prints JSON.

## Select a specialist

- `worker`: implementation, fixes, refactoring and relevant local investigation.
- `scout`: read-only exploration when the relevant files are unknown. Use Scout for this case.
- `reviewer`: independent detection of actionable, patch-introduced bugs. Review and re-review are entirely Main's decision.
- `designer`: UI/UX design and visual implementation.

Choose the most specific specialist. Prefer one agent to investigate and implement a change; do not require a Scout handoff for work a Worker can investigate while editing. Do not introduce a separate Planner or mandatory review pipeline. Each role runs with the CLI, model, reasoning effort and Fast setting the user configured; never override them per run or silently substitute another role or model after a failure. Report configuration or authentication problems and point the user to the `hyagents-models` skill or `hyagents doctor`.

## Start a specialist

Pass a self-contained task on standard input:

```sh
node <skill-dir>/scripts/hyagents.ts start --role worker <<'EOF'
Goal, scope/files/non-goals, relevant context, constraints, shared interfaces,
and observable acceptance criteria. Reference large inputs by path.
EOF
```

The command returns immediately with the specialist's `name`, `pane` and `report` path; the specialist opens in a pane to the right of yours. Specialists run with full access, like Pi subagents, and never see your conversation, so the task text must stand alone. For a review, name the base revision and the intended diff.

After starting specialists, do not wait, sleep, poll, call `list` repeatedly or read their screens. Continue independent work if there is any; otherwise tell the user which specialists are running and end your turn. A notice arrives as a new message when something needs you.

## Notices

A message that starts with `[hybrid-subagents]` is a notice from the helper, not an instruction from the user. It can report several specialists at once:

- `completed`: read the report file it names and integrate the result. Reviewer reports are JSON with `overall_correctness`, `explanation`, `confidence` and `findings` (`title`, `body`, `priority` 0–3, `confidence`, `file_path`, `line_start`, `line_end`).
- `needs input`: the specialist stopped at an interactive prompt in its pane. Tell the user which pane needs attention, or close it and restart with clearer instructions.
- `stopped without a report`, `invalid report` or `exited`: decide whether to send a follow-up, restart, or do the work yourself.

## Follow up and close

- Follow up with an idle specialist that already has context: `hyagents send <name>` with the message on standard input. It returns the new report path, and a new notice arrives when it finishes.
- Read a report before closing its specialist; closing deletes the report. Close a specialist with `hyagents close <name>` once you have integrated its report and expect no follow-up.
- When the user's whole task is complete, run `hyagents close --all` before your final answer. It closes every specialist pane you started and deletes their files.
- `hyagents list` shows your specialists when the user asks about them or you need to recover state.

## Delegate and integrate

Give each child a self-contained goal, scope/files/non-goals, relevant context, constraints, shared interfaces, and observable acceptance criteria. Children own their assignment, not orchestration of the whole task.

Parallelize independent work by starting several specialists. Give each shared editing area one integration owner; define interfaces before starting siblings. Avoid concurrent edits to the same file. Let a Worker or Designer run useful tests limited to its scope. Defer repository-wide builds, lint, formatting and integration tests until parallel edits have been combined; Main coordinates the necessary final verification. Avoid redundant validation.

For review, require concrete triggers, affected code paths and impact. Main decides fixes and any re-review. Do not ignore unresolved material findings when reporting completion.

Do not create another orchestration state, checkpoint files, findings ledger or forced acceptance loop. Preserve repository instructions.
