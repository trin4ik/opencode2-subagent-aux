// Install the packed plugin, then exercise directory, native model#variant and persisted labels on real OpenCode.
// The local model endpoint keeps this check deterministic and makes no paid API calls.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { SubagentLabels } from "../src/rpc.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
const temp = await mkdtemp("/tmp/opencode/subagent-smoke-")
const destination = `${temp}/backend/api`
const received = []
const definitions = []
let invocation
let server
let log = ""
let passed = false
let releaseChild

async function waitFor(read) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("OpenCode/plugin did not become ready within 15 seconds")
}

const endpoint = http.createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const child = body.model === "agent" || body.model === "child"
  if (child) received.push({ model: body.model, effort: request.headers["x-smoke-effort"], body })
  if (child && releaseChild) await new Promise((resolve) => (releaseChild.resume = resolve))
  const turn = body.messages.slice(body.messages.findLastIndex((message) => message.role === "user") + 1)
  const delegate = body.model === "parent" && !turn.some((message) => message.role === "tool")
  if (delegate) definitions.push(body.tools.find((tool) => tool.function?.name === "subagent").function)
  const toolResults = body.messages.filter((message) => message.role === "tool").length
  const inspect = child && invocation.directory && toolResults < 2
  const message = delegate
    ? {
        role: "assistant",
        tool_calls: [
          {
            id: `call_smoke_${definitions.length}`,
            type: "function",
            function: {
              name: "subagent",
              arguments: JSON.stringify(invocation),
            },
          },
        ],
      }
    : inspect
      ? {
          role: "assistant",
          tool_calls: [
            toolResults === 0
              ? {
                  id: "call_read",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "cwd-marker.txt" }) },
                }
              : {
                  id: "call_skill",
                  type: "function",
                  function: { name: "skill", arguments: JSON.stringify({ id: "api-local" }) },
                },
          ],
        }
      : { role: "assistant", content: child ? "CHILD_OK" : "DONE" }
  const finish = delegate || inspect ? "tool_calls" : "stop"
  const base = { id: "smoke", created: 1, model: body.model }
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }] }),
    )
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const delta =
    delegate || inspect
      ? { ...message, tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
      : message
  for (const [part, reason] of [
    [delta, null],
    [{}, finish],
  ]) {
    response.write(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`,
    )
  }
  response.end("data: [DONE]\n\n")
})

try {
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }),
  )[0]
  await mkdir(`${temp}/installed`)
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      `${temp}/installed`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${temp}/${packed.filename}`,
    ],
    { stdio: "pipe" },
  )
  await mkdir(`${temp}/config`)
  await writeFile(
    `${temp}/config/opencode.json`,
    JSON.stringify({
      plugins: [`${temp}/installed/node_modules/opencode2-subagent-aux`],
      model: "smoke/parent",
      snapshots: false,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      agents: { general: { model: "smoke/agent#low" }, title: { model: "smoke/title" } },
      providers: {
        smoke: {
          package: "@opencode/ai/providers/openai-compatible",
          env: ["OPENCODE_SMOKE_API_KEY"],
          settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1` },
          models: Object.fromEntries(
            ["parent", "agent", "child", "title"].map((id) => [
              id,
              {
                name: id,
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 100_000, output: 1000 },
                variants: ["low", "high"].map((id) => ({ id, headers: { "x-smoke-effort": id } })),
              },
            ]),
          ),
        },
      },
    }),
  )
  await mkdir(`${destination}/.opencode/skills/api-local`, { recursive: true })
  await writeFile(`${destination}/AGENTS.md`, "API_INSTRUCTIONS_MARKER\n")
  await writeFile(`${destination}/cwd-marker.txt`, "TARGET_FILE_CONTENT_MARKER\n")
  await writeFile(
    `${destination}/.opencode/skills/api-local/SKILL.md`,
    "---\nname: api-local\ndescription: API_SKILL_MARKER\n---\nTARGET_SKILL_CONTENT_MARKER\n",
  )
  await writeFile(
    `${destination}/opencode.json`,
    JSON.stringify({ agents: { general: { system: "LOCAL_AGENT_MARKER" } } }),
  )
  server = spawn(process.env.OPENCODE_BIN ?? "opencode2", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: temp,
    env: {
      PATH: process.env.PATH,
      HOME: `${temp}/home`,
      OPENCODE_CONFIG_DIR: `${temp}/config`,
      OPENCODE_SMOKE_API_KEY: "smoke",
      XDG_DATA_HOME: `${temp}/data`,
      XDG_STATE_HOME: `${temp}/state`,
      XDG_CONFIG_HOME: `${temp}/xdg-config`,
      XDG_CACHE_HOME: `${temp}/cache`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => {
    log += chunk
  })
  server.stderr.on("data", (chunk) => {
    log += chunk
  })
  await waitFor(() => /server listening on (\S+)/.test(log) && /server password (\S+)/.test(log))
  const client = OpenCode.make({
    baseUrl: log.match(/server listening on (\S+)/)[1],
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${log.match(/server password (\S+)/)[1]}`).toString("base64")}`,
    },
  })
  const plugin = await waitFor(async () =>
    (await client.plugin.list({ location: { directory: temp } })).data.find(
      (plugin) => plugin.id === "trin4ik.subagent-aux" && plugin.state.status !== "loading",
    ),
  )
  assert.equal(plugin.state.status, "active", JSON.stringify(plugin.state))
  console.log("PASS packed plugin installs and loads")
  const labelRpc = client.rpc(SubagentLabels)

  async function run(name, overrides, model, effort, parent, inspectWhileRunning = false) {
    const firstRequest = received.length
    invocation = { agent: "general", description: `Smoke ${name}`, prompt: "Reply CHILD_OK", ...overrides }
    parent ??= await client.session.create({ title: name, location: { directory: temp } })
    await client.session.prompt({ sessionID: parent.id, text: "Run the subagent smoke check" })
    let runningChild
    if (inspectWhileRunning) {
      runningChild = await waitFor(async () =>
        (await client.session.list({ parentID: parent.id })).data.find((session) => session.parentID === parent.id),
      )
      const cold = await waitFor(async () => {
        const result = await labelRpc.list({ sessionID: runningChild.id }, { location: { directory: temp } })
        return result.changes.length === 1 ? result : undefined
      })
      assert.equal(cold.changes[0].label, overrides.label, "RPC list exposes a durable label before terminal metadata")
      await waitFor(() => releaseChild.resume)
      releaseChild.resume()
      releaseChild = undefined
    }
    await client.session.wait({ sessionID: parent.id }, { signal: AbortSignal.timeout(20_000) })
    const messages = await client.session.context({ sessionID: parent.id })
    const tool = messages
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .findLast((part) => part.type === "tool" && part.name === "subagent")
    assert.equal(tool?.state.status, "completed", JSON.stringify(tool))
    assert.deepEqual(
      tool.state.input,
      invocation,
      "the full invocation input is persisted, including label when present",
    )
    assert.match(JSON.stringify(tool.state.content), /CHILD_OK/)
    const child = await client.session.get({ sessionID: tool.state.metadata.sessionID })
    if (runningChild) assert.equal(child.id, runningChild.id)
    if (overrides.sessionID) assert.equal(child.id, overrides.sessionID, "continuation keeps the child session")
    assert.equal(child.parentID, parent.id)
    assert.deepEqual(child.model, { providerID: "smoke", id: model, variant: effort })
    assert.equal(child.location.directory, overrides.directory ? destination : temp)
    assert.equal((await client.session.get({ sessionID: parent.id })).location.directory, temp)
    for (const request of received.slice(firstRequest)) {
      assert.equal(request.model, model)
      assert.equal(request.effort, effort)
    }
    assert.ok(received.length > firstRequest, "child sent a provider request")
    if (overrides.directory) {
      const first = JSON.stringify(received[firstRequest].body)
      for (const marker of ["API_INSTRUCTIONS_MARKER", "API_SKILL_MARKER", "LOCAL_AGENT_MARKER", destination]) {
        assert.ok(first.includes(marker), `First child request is missing ${marker}`)
      }
      const results = received.at(-1).body.messages.filter((message) => message.role === "tool")
      assert.ok(JSON.stringify(results).includes("TARGET_FILE_CONTENT_MARKER"), "relative read uses child directory")
      assert.ok(
        JSON.stringify(results).includes("TARGET_SKILL_CONTENT_MARKER"),
        `local skill can be loaded: ${JSON.stringify(results)}`,
      )
    }
    console.log(`PASS ${name}: child runs on smoke/${model}#${effort}`)
    return { parent, child }
  }
  for (const [name, overrides, model, effort] of [
    ["native default", {}, "agent", "low"],
    ["native model", { model: "smoke/child#high" }, "child", "high"],
    ["directory", { directory: "backend/api" }, "agent", "low"],
    ["combined", { directory: destination, model: "smoke/child#high", label: "🛠 Backend · cycle 2" }, "child", "high"],
  ]) {
    await run(name, overrides, model, effort)
  }
  const events = labelRpc.events.subscribe("changed")[Symbol.asyncIterator]()
  const changed = events.next()
  releaseChild = {}
  const { parent, child } = await run("label only", { label: "🔎 Review" }, "agent", "low", undefined, true)
  const live = await changed
  assert.equal(live.value.data.sessionID, child.id, "live RPC event identifies the child")
  assert.equal(live.value.data.label, "🔎 Review")
  const initial = await labelRpc.list({ sessionID: child.id }, { location: { directory: temp } })
  assert.equal(initial.changes.length, 1)
  assert.equal(initial.changes[0].afterIdle, undefined, "a new child has no previous idle watermark")
  await run("label omitted continuation", { sessionID: child.id }, "agent", "low", parent)
  assert.equal(
    (await labelRpc.list({ sessionID: child.id }, { location: { directory: temp } })).changes.length,
    1,
    "omitted label writes no journal record",
  )
  await run("label null continuation", { sessionID: child.id, label: null }, "agent", "low", parent)
  const journal = await labelRpc.list({ sessionID: child.id }, { location: { directory: temp } })
  assert.deepEqual(
    journal.changes.map((change) => change.label),
    ["🔎 Review", null],
  )
  assert.equal(typeof journal.changes[1].afterIdle, "number", "continuation records the previous idle watermark")
  assert.ok(journal.changes[0].at <= journal.changes[1].at, "journal is sorted by timestamp")
  await events.return()
  for (const { parameters: schema, description } of definitions) {
    assert.ok(schema.properties.directory, "directory is added to the native schema")
    assert.deepEqual(schema.properties.label.type, ["string", "null"], "label accepts strings and null")
    assert.ok(!schema.required.includes("label"), "label is optional")
    assert.match(schema.properties.label.description, /omission inherits/, "schema explains label inheritance")
    assert.match(description, /label.*null removes it/, "tool description explains the label contract")
    assert.match(schema.properties.model.description, /#variant/, "native model contract is preserved")
    assert.ok(!("effort" in schema.properties), "the plugin no longer exposes a separate effort")
  }
  passed = true
} finally {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit", { signal: AbortSignal.timeout(5000) })
    server.kill("SIGTERM")
    await stopped.catch(() => server.kill("SIGKILL"))
  }
  endpoint.closeAllConnections()
  endpoint.close()
  if (passed) await rm(temp, { recursive: true, force: true })
  else {
    await writeFile(`${temp}/server.log`, log)
    console.error(`Smoke diagnostics: ${temp}`)
  }
}
