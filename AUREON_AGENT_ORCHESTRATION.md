# Aureon Unified Agent Architecture

Aureon is being consolidated around a provider-neutral agent layer while preserving existing Claude, Codex, Cursor, OpenCode, terminal, editor, Git/GitHub, MCP, projects, sessions and PWA functionality.

## Agent roles
- planner: analyzes the task and produces an implementation plan without modifying files
- builder: implements the approved plan in the project workspace
- tester: runs the appropriate checks/tests and reports failures
- reviewer: inspects the diff for correctness, security and regressions
- fixer: applies targeted fixes after test/review failures

## Execution model
1. Create or resume a persistent project workspace.
2. Authenticate the selected provider through Aureon's existing provider system.
3. Run the planner with read-only permissions.
4. Run the builder with workspace permissions.
5. Run tests/build checks.
6. Run the reviewer against the resulting diff.
7. If needed, run the fixer and repeat checks.
8. Persist status, logs, checkpoints and the final result so mobile clients can reconnect.

## Safety
Agents must operate inside an explicitly selected workspace. Destructive commands, secret access and operations outside the workspace require explicit permission. Provider credentials must never be exposed to the model or client.

## Provider independence
The orchestration layer must not assume a specific vendor. Claude, Codex/OpenAI, OpenCode-compatible providers, Gemini and future providers expose capabilities through the existing provider registry.

## Subscription rule
Aureon does not require an Aureon subscription or upgrade to use coding features. Provider/API charges, if any, remain separate from Aureon.
