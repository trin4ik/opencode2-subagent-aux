/**
 * Resolve a destination against the caller, then observe the child's actual placement after move admission.
 * Core's move() queues a control; wait() waits for all work, which is too strong for a running child.
 */
import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"

export const resolveDirectory = Effect.fn("SubagentAux.resolveDirectory")(function* (value: string, caller: string) {
  if (!value.trim()) return yield* Effect.fail(new Error("directory must not be empty."))
  const directory = path.resolve(caller, value)
  // Core trims move destinations. Reject rather than silently select a different, space-suffixed path.
  if (directory !== directory.trim()) return yield* Effect.fail(new Error("directory must not end with whitespace."))
  const info = yield* Effect.tryPromise({
    try: () => stat(directory),
    catch: (error) => new Error(`Cannot access directory ${directory}`, { cause: error }),
  })
  if (!info.isDirectory()) return yield* Effect.fail(new Error(`Not a directory: ${directory}`))
  return directory
})

export const awaitDirectory = Effect.fn("SubagentAux.awaitDirectory")(function* (
  directory: string,
  read: () => Effect.Effect<string, unknown>,
) {
  // Poll persisted placement, not model output or overall idle status. Sleep and timeout remain interruptible.
  yield* Effect.gen(function* () {
    while ((yield* read()) !== directory) yield* Effect.sleep("50 millis")
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(new Error(`Move to ${directory} was not confirmed within 2 minutes; it may still be queued.`)),
    }),
  )
})
