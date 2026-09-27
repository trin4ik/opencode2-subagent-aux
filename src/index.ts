/**
 * Declares the Effect plugin and adapts public context to subagent directory placement.
 * Registrations belong to the plugin scope, so OpenCode removes them automatically on unload.
 */
import { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { WorkspaceID } from "@opencode/schema/workspace-id"
import { Effect, Schema } from "effect"
import { makeLabels } from "./labels.ts"
import { ListInput, SubagentLabels, type Change } from "./rpc.ts"
import { extendSubagent, type Runtime } from "./subagent.ts"

export default Plugin.define({
  id: "trin4ik.subagent-aux",
  effect: Effect.fn("SubagentAux.Plugin")(function* (ctx: Plugin.Context) {
    let emit = (_change: Change): Effect.Effect<void, unknown> => Effect.void
    const labels = makeLabels(ctx.storage, (change) => emit(change))
    const rpc = yield* ctx.rpc
      .register(SubagentLabels, {
        list: (input) =>
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknownEffect(ListInput)(input).pipe(Effect.orDie)
            return { changes: yield* labels.list(request.sessionID).pipe(Effect.orDie) }
          }),
      })
      .pipe(Effect.orDie)
    emit = (change) => rpc.events.emit("changed", change as Change & Readonly<Record<string, unknown>>)
    const runtime: Runtime = {
      session: (id) => ctx.session.get({ sessionID: Session.ID.make(id) }),
      move: (id, directory, workspaceID) =>
        ctx.session.move({
          sessionID: Session.ID.make(id),
          directory: AbsolutePath.make(directory),
          ...(workspaceID === undefined ? {} : { workspaceID: WorkspaceID.make(workspaceID) }),
        }),
      label: (id, value, context, afterIdle) => labels.apply(id, value, context, afterIdle).pipe(Effect.asVoid),
    }
    // Replay captures the original definition from the fresh registry, never our previous wrapper.
    yield* ctx.tool
      .transform((editor) => {
        const native = editor.get("subagent")
        if (!native) throw new Error("Native subagent tool is missing; load this plugin after the built-in tools.")
        const extended = extendSubagent(native, runtime)
        editor.update("subagent", (tool) => {
          tool.input = extended.input
          tool.description = extended.description
          tool.execute = extended.execute
        })
      })
      .pipe(Effect.orDie)
  }),
})
