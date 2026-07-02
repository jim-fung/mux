import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ExecResult } from "@/node/utils/runtime/helpers";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { createCodeOutlineTool } from "./code_outline";
import type { CodeOutlineToolResult } from "@/common/types/tools";
import { createTestToolConfig, mockToolCallOptions as sharedMockToolCallOptions } from "./testHelpers";

/**
 * code_outline behavior tests.
 *
 * The tool delegates all real work to the external `ast-grep` binary via
 * execBuffered. We stub execBuffered (spyOn the runtimeHelpers namespace, which
 * Bun's live bindings make the named import in code_outline.ts observe) to feed
 * canned ast-grep JSON through the tool's parsing/normalization/error/bounding
 * logic. This is the established pattern from web_fetch.test.ts.
 *
 * We also spy config.runtime.stat to control the file-vs-directory branch
 * without touching the real filesystem for the binary path.
 */

const toolCallOptions: ToolExecutionOptions = sharedMockToolCallOptions;

function createExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "", stderr: "", exitCode: 0, duration: 1, ...overrides };
}

/**
 * Build a code_outline tool whose exec is stubbed. `statResult` controls whether
 * the tool treats the path as a file or directory. Returns the tool plus the
 * exec spy so tests can assert on the emitted command if needed.
 */
function createStubbedTool(
  statResult: { isDirectory: boolean },
  exec: ReturnType<typeof spyOn<typeof runtimeHelpers, "execBuffered">>,
  cwd = "/repo"
): {
  tool: ReturnType<typeof createCodeOutlineTool>;
  execSpy: typeof exec;
} {
  const config = createTestToolConfig(cwd);
  // Stub stat so the tool branches on a synthetic kind without needing a real
  // file on disk. (LocalRuntime.stat is a real method we can spy on.)
  spyOn(config.runtime, "stat").mockResolvedValue({
    isDirectory: statResult.isDirectory,
    size: 0,
    modifiedTime: new Date(),
  });
  return { tool: createCodeOutlineTool(config), execSpy: exec };
}

/**
 * Raw ast-grep compact-JSON payload for a single file. Ranges here are
 * intentionally 0-based (ast-grep's native convention) so we can assert the
 * tool maps them to 1-based.
 */
function filePayload(
  items: unknown[],
  opts: { path?: string; language?: string } = {}
): string {
  return JSON.stringify([
    { path: opts.path ?? "src/mod.ts", language: opts.language ?? "TypeScript", items },
  ]);
}

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "doThing",
    symbolType: "function",
    signature: "function doThing(): void",
    isExported: true,
    range: {
      // 0-based, matching real ast-grep output.
      start: { line: 4, column: 0 },
      end: { line: 9, column: 1 },
    },
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("code_outline tool — result normalization", () => {
  it("converts ast-grep's 0-based ranges to 1-based (start AND end, line AND column)", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: filePayload([rawItem()]) })
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    const entry = result.files[0].entries[0];
    // Raw 0-based start {line:4, column:0} -> 1-based {line:5, column:1}.
    expect(entry.range.start).toEqual({ line: 5, column: 1 });
    // Raw 0-based end {line:9, column:1} -> 1-based {line:10, column:2}.
    expect(entry.range.end).toEqual({ line: 10, column: 2 });
  });

  it("applies the same +1 normalization to nested children ranges", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({
          stdout: filePayload([
            {
              name: "IFace",
              symbolType: "interface",
              signature: "interface IFace",
              range: { start: { line: 0, column: 0 }, end: { line: 2, column: 1 } },
              members: [
                {
                  name: "field",
                  symbolType: "field",
                  signature: "field: string",
                  range: { start: { line: 1, column: 2 }, end: { line: 1, column: 20 } },
                },
              ],
            },
          ]),
        })
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    const child = result.files[0].entries[0].children?.[0];
    expect(child).toBeDefined();
    // 0-based {line:1, column:2} -> 1-based {line:2, column:3}.
    expect(child?.range.start).toEqual({ line: 2, column: 3 });
    expect(child?.range.end).toEqual({ line: 2, column: 21 });
  });
});

describe("code_outline tool — stderr is authoritative even when stdout is []", () => {
  it("returns failure with the stderr message when exitCode is 0 but stderr is non-empty", async () => {
    // This mirrors the empirically-observed ast-grep behavior for a missing
    // path: exit 0, stdout "[]", non-empty stderr. The implementation must NOT
    // trust stdout when stderr is non-empty.
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({
          stdout: "[]",
          stderr: "ERROR: path /repo/nope.ts No such file",
          exitCode: 0,
        })
      )
    );

    const result = (await env.tool.execute!(
      { path: "nope.ts" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No such file");
    }
  });

  it("returns failure when exitCode is non-zero even with empty stderr", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: "[]", stderr: "", exitCode: 2 })
      )
    );

    const result = (await env.tool.execute!(
      { path: "x.ts" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exited with code 2");
    }
  });
});

describe("code_outline tool — unsupported files return graceful empty", () => {
  it("returns success with no entries for a markdown file (ast-grep emits items:[])", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({
          stdout: filePayload([], { path: "docs/README.md", language: "Markdown" }),
        })
      )
    );

    const result = (await env.tool.execute!(
      { path: "docs/README.md" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0].entries).toEqual([]);
  });
});

describe("code_outline tool — binary-missing failure", () => {
  it("returns failure mentioning ast-grep when exec throws (ENOENT on the binary)", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockRejectedValue(
        new Error("spawn ast-grep ENOENT")
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ast-grep");
      expect(result.error).toContain("spawn ast-grep ENOENT");
    }
  });
});

describe("code_outline tool — truncation under caps", () => {
  it("caps the number of files at maxFiles and sets truncated", async () => {
    // Directory mode (stream): one JSON object per line.
    const manyFiles = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      language: "TypeScript",
      items: [],
    }));
    const streamOut = manyFiles.map((f) => JSON.stringify(f)).join("\n");

    const env = createStubbedTool(
      { isDirectory: true },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: streamOut })
      )
    );

    const result = (await env.tool.execute!(
      { path: ".", maxFiles: 3 },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("caps the number of entries per file at maxSymbols and sets truncated", async () => {
    const manyItems = Array.from({ length: 5 }, (_, i) => ({
      name: `fn${i}`,
      symbolType: "function",
      signature: `function fn${i}() {}`,
      range: { start: { line: i, column: 0 }, end: { line: i, column: 5 } },
    }));

    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: filePayload(manyItems) })
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts", maxSymbols: 2 },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files[0].entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("does not set truncated when output is within caps", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: filePayload([rawItem()]) })
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts", maxSymbols: 200, maxFiles: 50 },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.truncated).toBeUndefined();
  });
});

describe("code_outline tool — stream (directory) parsing", () => {
  it("parses one JSON object per line for directory mode and skips blank lines", async () => {
    const streamOut = [
      "",
      JSON.stringify({
        path: "a.ts",
        language: "TypeScript",
        items: [rawItem({ name: "a", range: { start: { line: 0, column: 0 }, end: { line: 0, column: 3 } } })],
      }),
      "",
      JSON.stringify({ path: "b.ts", language: "TypeScript", items: [] }),
    ].join("\n");

    const env = createStubbedTool(
      { isDirectory: true },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({ stdout: streamOut })
      )
    );

    const result = (await env.tool.execute!(
      { path: ".", items: "exports" },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    // First file's single entry: 0-based line 0 -> 1-based line 1.
    expect(result.files[0].entries[0].range.start.line).toBe(1);
  });
});

describe("code_outline tool — symbolTypes filter", () => {
  it("filters top-level entries by symbolType and drops filtered-out children", async () => {
    const env = createStubbedTool(
      { isDirectory: false },
      spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
        createExecResult({
          stdout: filePayload([
            rawItem({ name: "keep", symbolType: "function" }),
            rawItem({ name: "drop", symbolType: "interface" }),
          ]),
        })
      )
    );

    const result = (await env.tool.execute!(
      { path: "src/mod.ts", symbolTypes: ["function"] },
      toolCallOptions
    )) as CodeOutlineToolResult;

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files[0].entries).toHaveLength(1);
    expect(result.files[0].entries[0].name).toBe("keep");
  });
});
