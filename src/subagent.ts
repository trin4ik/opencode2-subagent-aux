/**
 * Extends the registered subagent's schema/description and delegates orchestration to its original executor.
 * Applies optional directory placement before the native child prompt is submitted.
 * Applies explicit labels at the same pre-prompt boundary for durable TUI observation.
 * Reference: anomalyco/opencode@2670273ff17da96f85c5826ced57aa1b368754fa (2.0.12),
 * packages/core/src/tool/plugin/subagent.ts:201–213, the awaited progress-before-prompt boundary.
 */
import { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Option, Predicate, Schema, type JsonSchema } from "effect"
import { awaitDirectory, resolveDirectory } from "./directory.ts"

interface Input {
  directory?: string
  label?: string | null
  [key: string]: unknown
}

export interface SessionState {
  id: string
  parentID?: string
  location: { directory: string; workspaceID?: string }
  time: { idle?: DateTime.Utc }
}

export interface Runtime {
  session(id: string): Effect.Effect<SessionState, unknown>
  move(id: string, directory: string, workspaceID?: string): Effect.Effect<void, unknown>
  label(id: string, value: string | null, context: Tool.Context, afterIdle?: number): Effect.Effect<void, unknown>
}

// progress has an infallible Effect type. Mark only our failures when crossing that boundary;
// native defects (notably permission declines) must retain their original control-flow meaning.
class DirectoryFailure extends Schema.TaggedError<DirectoryFailure>()("SubagentAux.DirectoryFailure", {
  error: Schema.Defect(),
}) {}

class LabelFailure extends Schema.TaggedError<LabelFailure>()("SubagentAux.LabelFailure", {
  error: Schema.Defect(),
}) {}

const decodeProgress = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.String,
    status: Schema.Literal("running"),
  }),
)

const guidance = [
  "label optionally sets a display label above the child's task title in the subagents sidebar, separate from description. A string sets or replaces it, null removes it, and omitting it inherits the child's current label. With sessionID, it updates the current run if still active; completed runs keep their labels.",
  "directory optionally moves the child before admitting this task. Absolute paths are used directly; relative paths resolve from the calling session's current directory, including with sessionID. Paths may be outside the project.",
  "Omitting directory preserves the child's location. Moving preserves history; old relative paths may no longer apply. Target-location instructions, skills and same-ID agent definitions follow native discovery.",
  "Running children move at the native execution boundary; already-started work may finish at the old location. This call waits for the move before sending its task. Failed calls do not roll back completed changes.",
].join("\n")

export function extendInput(input: Tool.ValueSchema): JsonSchema.JsonSchema {
  const document = Schema.isSchema(input) ? Schema.toJsonSchemaDocument(input) : undefined
  const json = document ? { ...document.schema, $defs: document.definitions } : (input as JsonSchema.JsonSchema)
  if (json.type !== "object" || !Predicate.isObject(json.properties)) {
    throw new Error("Unsupported native subagent schema; expected an object schema.")
  }
  const properties = json.properties
  for (const name of ["directory", "label"]) {
    if (name in properties) {
      throw new Error(`Native subagent already defines ${name}; review or remove opencode2-subagent-aux.`)
    }
  }
  return {
    ...json,
    properties: {
      ...json.properties,
      model: {
        type: "string",
        description:
          'The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
      },
      directory: {
        type: "string",
        minLength: 1,
        description:
          "Optional existing working directory for the child, also with sessionID. Absolute or relative to the caller's current directory; may be outside the project. Moves before this task, preserving history and using native target-location configuration.",
      },
      label: {
        type: ["string", "null"],
        description:
          "Optional display label above the child's task title in the subagents sidebar. A string sets/replaces it; null removes it; omission inherits the child's current label. Independent of description and title; completed runs keep their labels.",
      },
    },
  }
}

export function extendSubagent(native: Tool.Info, runtime: Runtime): Tool.Info {
  const execute = Effect.fn("SubagentAux.execute")(
    function* (input: Input, context: Tool.Context) {
      const directory =
        input.directory === undefined
          ? undefined
          : yield* resolveDirectory(input.directory, (yield* runtime.session(context.sessionID)).location.directory)
      // Preserve every native argument, including its model#variant selection.
      // Copy rather than mutate: OpenCode persists the full invocation input.
      const { directory: _directory, label: _label, ...nativeInput } = input
      let applied = false

      // The original executor still owns permissions, depth, child ownership, jobs and cancellation.
      const result = yield* native
        .execute(nativeInput, {
          ...context,
          progress: Effect.fn("SubagentAux.progress")(function* (update: Tool.Metadata) {
            const progress = Option.getOrUndefined(decodeProgress(update))
            if (!applied && progress) {
              if (directory !== undefined) {
                yield* Effect.gen(function* () {
                  const child = yield* runtime.session(progress.sessionID)
                  if (child.parentID !== context.sessionID) {
                    return yield* Effect.fail(
                      new Error("Native subagent reported a session outside the current parent's children."),
                    )
                  }
                  if (child.location.directory !== directory) {
                    yield* runtime.move(child.id, directory, child.location.workspaceID)
                    yield* awaitDirectory(directory, () =>
                      runtime.session(child.id).pipe(Effect.map((state) => state.location.directory)),
                    )
                  }
                }).pipe(
                  // Only our pre-prompt failures get placement diagnostics; native failures retain their identity.
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      const state = yield* runtime
                        .session(progress.sessionID)
                        .pipe(Effect.orElseSucceed(() => undefined))
                      return yield* Effect.fail(
                        new Error(
                          `Subagent setup failed (sessionID: ${progress.sessionID}, directory: ${state?.location.directory ?? "unknown"}). This call's task was not sent; changes were not rolled back. ${error instanceof Error ? error.message : String(error)}`,
                          { cause: error },
                        ),
                      )
                    }),
                  ),
                  Effect.mapError((error) => new DirectoryFailure({ error })),
                  Effect.orDie,
                )
              }
              if (input.label !== undefined) {
                const label = input.label
                yield* Effect.gen(function* () {
                  const child = yield* runtime.session(progress.sessionID)
                  yield* runtime.label(
                    progress.sessionID,
                    label,
                    context,
                    child.time.idle === undefined ? undefined : DateTime.toEpochMillis(child.time.idle),
                  )
                }).pipe(
                  // Public storage is infallible-typed and defects on DB errors; only our writer is inside this catch.
                  Effect.catchDefect((error) => Effect.fail(error)),
                  Effect.mapError(
                    (error) =>
                      new LabelFailure({
                        error: new Error(
                          `Subagent label update failed (sessionID: ${progress.sessionID}). This call's task was not sent; completed changes were not rolled back. ${error instanceof Error ? error.message : String(error)}`,
                          { cause: error },
                        ),
                      }),
                  ),
                  Effect.orDie,
                )
              }
              applied = true
            }
            yield* context.progress(update)
          }),
        })
        .pipe(
          Effect.catchDefect((error) =>
            error instanceof DirectoryFailure || error instanceof LabelFailure
              ? Effect.fail(error.error)
              : Effect.die(error),
          ),
        )
      if (!applied) {
        return yield* Effect.fail(
          new Error(
            "Native subagent did not report its child before running; this OpenCode version needs compatibility review.",
          ),
        )
      }
      // Preserve the native result object, output, content and metadata verbatim.
      return result
    },
    Effect.mapError((error) =>
      error instanceof Tool.Error
        ? error
        : new Tool.Error({
            message: error instanceof Error ? error.message : String(error),
            error,
          }),
    ),
  )

  return {
    ...native,
    input: extendInput(native.input),
    description: `${native.description}\n\n${guidance}`,
    execute: (raw, context) => {
      const input = raw as Input
      return input.directory === undefined && input.label === undefined
        ? native.execute(raw, context)
        : execute(input, context)
    },
  }
}
