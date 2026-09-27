# opencode2-subagent-aux

An in-house OpenCode **V2** plugin shared as a reference for extending the built-in `subagent` tool. It adds optional `directory` and `label` arguments without replacing native subagent orchestration. OpenCode itself handles `model: provider/model#variant`; this plugin does not implement separate model or effort selection.

**Reference code, not a supported plugin.** We develop it for our own workflow, do not publish an npm package, and do not provide user support or commit to reviewing issues or pull requests. If you use or adapt it, you are responsible for checking it against your OpenCode version and environment. The source is shared under the [MIT license](LICENSE).

```json
{
  "agent": "general",
  "description": "Review API changes",
  "prompt": "Review the API changes and report correctness issues.",
  "directory": "backend/api",
  "label": "Review · cycle 2"
}
```

## What it does

- `directory` must name an existing directory. Absolute paths are used directly; relative paths resolve from the **calling session's directory**, including when continuing a child via `sessionID`. Paths outside the project and `..` are allowed; `~` is not expanded.
- Without `directory` or `label`, the native Effect is returned directly. All native arguments, including `model`, pass through unchanged. Native OpenCode still owns permissions, child creation/continuation, depth, jobs, background execution, cancellation, and completion notifications.
- The plugin waits until `session.get()` confirms the child's new directory before its new task is submitted. `session.move()` alone only queues the move. The first request then picks up the target's `AGENTS.md`, skills, agent definitions, configuration, and relative paths.
- Launch permissions and validation of a native `model` override happen in the caller's Location before the move. A model available only in the target Location cannot be selected through that override. OpenCode resolves the same agent ID again in the target Location.
- Moving a child preserves its history, but relative paths in older messages are not rewritten. A running child's current work may finish in its previous directory. External concurrent control of the same child is not serialized.
- Empty or nonexistent directories, files instead of directories, and paths ending in whitespace are rejected. A move can take up to two minutes to confirm; it remains interruptible. After a timeout, a queued move may still complete, but this invocation's new task is not submitted. Completed changes are not rolled back.

`label?: string | null` is an **optional display label** used by our separate `opencode2-subagents` TUI sidebar. Omission inherits the child's current label, a string sets or replaces it, and `null` removes it. Labels are recorded in plugin-scoped storage and exposed through a public RPC so the sidebar can recover them when it attaches mid-run. The `directory` behavior does not require that sidebar.

Both arguments are declared in the actual tool schema and description; `label` is removed before invoking the native executor. The original executor's result is returned unchanged.

## Trying the example locally

From this repository:

```bash
npm ci
npm run check
npm run format:check
npm test
```

Add the **plugin directory**, not the repository's parent, to `plugins` in your `opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode2-subagent-aux"],
}
```

The root `index.ts` exports the plugin definition for OpenCode's directory loader. The plugin ID is `trin4ik.subagent-aux`. `private: true` in `package.json` means this is not an npm release.

The single smoke test installs a packed tarball into an isolated environment, starts a real OpenCode server and a deterministic local model endpoint, and checks native calls, directory placement, first-request local instructions and skills, relative file reads, native `model#variant`, and label persistence. It does not use paid model requests or your normal OpenCode credentials. Set `OPENCODE_BIN` if the OpenCode executable is not named `opencode2`.

## Compatibility boundary

`ctx.tool.transform` captures and wraps the registered native `subagent` executor. The plugin relies on a specific internal ordering: native `subagent` awaits `progress({ sessionID, status: "running" })` after preparing the child but **before** submitting its prompt. The wrapper moves the child (and records an explicit label) within that callback. This is not a public before-prompt hook; check the exact host source and run the smoke test when using a different release.

The source was audited against [OpenCode 2.0.12, commit `2670273`](https://github.com/anomalyco/opencode/blob/2670273ff17da96f85c5826ced57aa1b368754fa/packages/core/src/tool/plugin/subagent.ts#L200-L213). The same progress-before-prompt ordering was checked in [2.0.15, commit `6f3639d`](https://github.com/anomalyco/opencode/blob/6f3639d82ed0760091792189b78f8eeb44f699b1/packages/core/src/tool/plugin/subagent.ts), and the smoke test passed with the locally installed 2.0.15. There is no runtime version allowlist; a new version number alone does not prevent loading. Pinned dependencies make the development environment reproducible, not every host version compatible.

Implementation: `src/index.ts` registers the plugin; `src/subagent.ts` wraps the native executor; `src/directory.ts` validates and waits for placement; `src/labels.ts` and `src/rpc.ts` provide the optional label journal. Historical notes and exact source links are in [docs/upstream-audit.md](docs/upstream-audit.md).
