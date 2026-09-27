/** Portable RPC contract shared by the server plugin and label consumers such as the TUI. */
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export interface Change {
  readonly id: string
  readonly sessionID: string
  readonly parentSessionID: string
  readonly at: number
  readonly label: string | null
  readonly afterIdle?: number
}

export const changeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    parentSessionID: { type: "string" },
    at: { type: "number" },
    label: { type: ["string", "null"] },
    afterIdle: { type: "number" },
  },
  required: ["id", "sessionID", "parentSessionID", "at", "label"],
  additionalProperties: false,
} as const

export const ListInput = Schema.Struct({ sessionID: Schema.String })

export const SubagentLabels = Rpc.define({
  id: "trin4ik.subagent-labels",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { changes: { type: "array", items: changeSchema } },
        required: ["changes"],
        additionalProperties: false,
      },
    },
  },
  events: { changed: { schema: changeSchema } },
})
