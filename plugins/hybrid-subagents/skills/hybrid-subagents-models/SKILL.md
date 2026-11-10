---
name: hybrid-subagents-models
description: Show or change which CLI (claude, codex or copilot), model, reasoning effort, Fast mode and extra arguments each Hybrid Subagents role (worker, scout, reviewer, designer) uses. Use when the user asks to view, change or reset Hybrid Subagents models or settings.
---

# Hybrid Subagents model settings

The helper is `scripts/hybrid-subagents.ts` in the `hybrid-subagents` skill directory, a sibling of this skill's directory: `node <this-skill-dir>/../hybrid-subagents/scripts/hybrid-subagents.ts <command>`. Below, `hybrid-subagents` means that command. It prints JSON. Settings do not require herdr.

1. Run `hybrid-subagents config show`. Present each role's effective `runtime`, `model`, `effort`, `fast` and `args`, where each value comes from (`default`, `user` or `project`), and any `warnings`.
2. Ask which role to change, or whether to reset. Then ask, in order:
   - Runtime: `claude`, `codex` or `copilot`. Each must be installed and logged in where the specialist runs.
   - Model ID, passed unchanged to that CLI. Suggest the current value; the user may type any ID. It is checked only when a specialist starts.
   - Reasoning effort: one of `efforts[<runtime>]` from `config show`, or `default` for the CLI's own default.
   - Fast mode (`on`/`off`), only where `fastSupported[<runtime>]` is true; otherwise off.
   - Scope: `user` (all projects) or `project` (this repository; it takes precedence).
3. Save with:

   ```sh
   hybrid-subagents config set <role> --runtime <runtime> --model <id> --effort <level|default> --fast <on|off> --scope <user|project>
   ```

   Add `--args '<JSON array of strings>'` only when the user asks for extra CLI arguments. Report the saved file and the effective value the command returns. If it reports that a project setting shadows the saved one, say so.
4. To reset, confirm first, then run `hybrid-subagents config reset --scope <user|project>`, adding `--role <role>` to reset one role. Reset writes the bundled defaults to that scope.

Changes apply to specialists started afterwards; running specialists keep their settings. Do not edit model settings unless the user asked. `hybrid-subagents doctor` checks that the configured CLIs are installed.
