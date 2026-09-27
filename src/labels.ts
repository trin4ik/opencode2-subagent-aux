/** Owns the durable, append-only label journal and its paginated RPC read model. */
import type { Plugin } from "@opencode/plugin/effect"
import type { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Schema } from "effect"
import type { Change } from "./rpc.ts"

const ChangeSchema = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  parentSessionID: Schema.String,
  at: Schema.Finite,
  label: Schema.Union([Schema.String, Schema.Null]),
  afterIdle: Schema.optionalKey(Schema.Finite),
})
const decodeChange = Schema.decodeUnknownEffect(ChangeSchema)
const prefix = "label.v1/"
const pageSize = 1000

const segment = (value: string) => encodeURIComponent(value)

export function makeLabels(storage: Plugin.Context["storage"], emit: (change: Change) => Effect.Effect<void, unknown>) {
  const list = Effect.fn("SubagentLabels.list")(function* (sessionID: string) {
    const changes: Change[] = []
    let after: string | undefined
    do {
      const page = yield* storage.scan({ prefix: `${prefix}${segment(sessionID)}/`, after, limit: pageSize })
      for (const entry of page.entries) changes.push(yield* decodeChange(entry.value))
      after = page.next
    } while (after !== undefined)
    return changes.toSorted(
      (left, right) => left.at - right.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
  })

  const apply = Effect.fn("SubagentLabels.apply")(function* (
    sessionID: string,
    label: string | null,
    context: Tool.Context,
    afterIdle?: number,
  ) {
    const id = `${context.sessionID}/${context.messageID}/${context.id}`
    const key = [prefix.slice(0, -1), sessionID, context.sessionID, context.messageID, context.id]
      .map(segment)
      .join("/")
    const existing = yield* storage.get(key)
    if (existing !== undefined) return yield* decodeChange(existing)
    const change: Change = {
      id,
      sessionID,
      parentSessionID: context.sessionID,
      at: DateTime.toEpochMillis(yield* DateTime.now),
      label,
      ...(afterIdle === undefined ? {} : { afterIdle }),
    }
    yield* storage.set(key, change as unknown as Schema.Json)
    // The record is authoritative. A missed ephemeral event is recovered by list(), so do not fail after commit.
    yield* emit(change).pipe(
      Effect.catch((error) => Effect.logWarning("Failed to emit subagent label change", { error })),
      Effect.catchDefect((error) => Effect.logWarning("Defect while emitting subagent label change", { error })),
    )
    return change
  })

  return { list, apply }
}
