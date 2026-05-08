import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"

function sseLine(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function sseDone() {
  return "data: [DONE]\n\n"
}

function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  }
}

function isTitleRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  return JSON.stringify(body).includes("Generate a title")
}

function titleSSE() {
  return [
    sseLine(chunk({ role: "assistant" })),
    sseLine(chunk({ content: "Test" })),
    sseLine(chunk({}, "stop")),
    sseDone(),
  ].join("")
}

function taskToolSSE() {
  const args = JSON.stringify({
    description: "list files",
    prompt: "list files in the current directory",
    subagent_type: "explore",
  })
  return [
    sseLine(chunk({ role: "assistant" })),
    sseLine(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_task_1",
            type: "function",
            function: { name: "task", arguments: "" },
          },
        ],
      }),
    ),
    sseLine(
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: args } },
        ],
      }),
    ),
    sseLine(chunk({}, "tool_calls")),
    sseDone(),
  ].join("")
}

function bashToolSSE() {
  const args = JSON.stringify({ command: "ls", description: "list files" })
  return [
    sseLine(chunk({ role: "assistant" })),
    sseLine(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_bash_1",
            type: "function",
            function: { name: "bash", arguments: "" },
          },
        ],
      }),
    ),
    sseLine(
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: args } },
        ],
      }),
    ),
    sseLine(chunk({}, "tool_calls")),
    sseDone(),
  ].join("")
}

function textSSE(text: string) {
  return [
    sseLine(chunk({ role: "assistant" })),
    sseLine(chunk({ content: text })),
    sseLine(chunk({}, "stop")),
    sseDone(),
  ].join("")
}

test("subagent permission.asked events appear in --format json stdout", async () => {
  const requests: Array<{ url: string; isTitle: boolean; index: number }> = []
  let requestIndex = 0
  const responses = [
    taskToolSSE(),
    bashToolSSE(),
    textSSE("done"),
    textSSE("complete"),
  ]

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => ({}))
      const url = new URL(req.url).pathname
      const isTitle = isTitleRequest(body)
      const idx = requestIndex
      if (!isTitle) requestIndex++
      requests.push({ url, isTitle, index: idx })
      if (isTitle) {
        return new Response(titleSSE(), {
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      const response = responses[idx] ?? textSSE("ok")
      return new Response(response, {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-integ-"))
  try {
    await $`git init`.cwd(tmpDir).quiet()
    await $`git config user.email "test@test.com"`.cwd(tmpDir).quiet()
    await $`git config user.name "Test"`.cwd(tmpDir).quiet()
    await $`git commit --allow-empty -m "root"`.cwd(tmpDir).quiet()

    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        permission: {
          task: "ask",
          bash: "ask",
        },
        provider: {
          test: {
            options: {
              baseURL: `http://127.0.0.1:${server.port}/v1`,
            },
            models: {
              "test-model": {
                name: "Test Model",
                tool_call: true,
              },
            },
          },
        },
      }),
    )

    const srcPath = path.resolve(__dirname, "../../../src/index.ts")
    const proc = Bun.spawn(
      ["bun", srcPath, "run", "--format", "json", "--model", "test/test-model", "use explore agent to list files"],
      {
        cwd: tmpDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    )

    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    const lines = stdout.split("\n").filter((l) => l.trim())
    const permissionEvents = lines
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e) => e && e.type === "permission_asked")

    const sessionIDs = permissionEvents.map((e: any) => e.permission?.sessionID)
    const uniqueSessionIDs = new Set(sessionIDs.filter(Boolean))

    expect(
      permissionEvents.length,
      `Expected >= 2 permission_asked events but got ${permissionEvents.length}.\n` +
        `Mock server requests: ${JSON.stringify(requests, null, 2)}\n` +
        `stdout:\n${stdout}`,
    ).toBeGreaterThanOrEqual(2)

    expect(
      uniqueSessionIDs.size,
      `Expected >= 2 distinct sessionIDs but got ${uniqueSessionIDs.size}: ${[...uniqueSessionIDs].join(", ")}`,
    ).toBeGreaterThanOrEqual(2)
  } finally {
    server.stop()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})
