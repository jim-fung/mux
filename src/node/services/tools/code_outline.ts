import { tool } from "ai";
import type { CodeOutlineEntry, CodeOutlineToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { resolvePathWithinCwd } from "./fileCommon";
import { RuntimeError } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/common/utils/shell";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Sensible defaults for bounding tool output (RFC risk matrix:
 * "Large-directory payload blowups"). Overridable via maxFiles/maxSymbols args.
 */
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_SYMBOLS = 200;
/** ast-grep can be slow on huge trees; keep a generous ceiling. */
const OUTLINE_TIMEOUT_SECS = 60;

/**
 * Raw shapes emitted by `ast-grep outline`. These are intentionally permissive:
 * ast-grep's output can churn across versions (RFC risk matrix), so we never
 * throw on a missing/unexpected field — we degrade to an empty/trimmed entry
 * rather than bricking the whole call (AGENTS.md self-healing).
 *
 * Field names captured from ast-grep 0.44.0:
 *   symbolType, isExported, isPublic, members (nested children), signature,
 *   and a 0-based range { start: {line,column}, end: {line,column} }.
 */
interface RawRangePosition {
  line?: number;
  column?: number;
}
interface RawRange {
  start?: RawRangePosition;
  end?: RawRangePosition;
}
interface RawOutlineItem {
  name?: unknown;
  symbolType?: unknown;
  signature?: unknown;
  isExported?: unknown;
  isPublic?: unknown;
  range?: RawRange;
  // ast-grep nests children under `members` (e.g. interface fields, class
  // methods). We also tolerate `items` for forward-compatibility.
  members?: unknown;
  items?: unknown;
}
interface RawOutlineFile {
  path?: unknown;
  language?: unknown;
  items?: unknown;
}

/**
 * Type guard for a string-valued field that may be missing or non-string.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Type guard for an optional boolean.
 */
function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Normalize a 0-based ast-grep position to a 1-based {line, column}.
 * ast-grep emits 0-based lines AND columns; Mux conventions (and file_read)
 * use 1-based line numbers, so we add 1 to every coordinate. Missing
 * coordinates degrade to 0 (kept as 0 after +1 => 1) rather than throwing.
 */
function normalizePosition(pos: RawRangePosition | undefined): {
  line: number;
  column: number;
} {
  const line = typeof pos?.line === "number" ? pos.line : 0;
  const column = typeof pos?.column === "number" ? pos.column : 0;
  return { line: line + 1, column: column + 1 };
}

/**
 * Map a raw ast-grep item to a CodeOutlineEntry, normalizing ranges and
 * recursing into nested children. Recursive over `members`/`items`.
 */
function mapItem(item: RawOutlineItem): CodeOutlineEntry {
  const children = mapItems(item.members ?? item.items);
  return {
    name: asString(item.name),
    symbolType: asString(item.symbolType),
    signature: asString(item.signature),
    ...(asOptionalBoolean(item.isExported) !== undefined && {
      exported: item.isExported as boolean,
    }),
    ...(asOptionalBoolean(item.isPublic) !== undefined && {
      public: item.isPublic as boolean,
    }),
    range: {
      start: normalizePosition(item.range?.start),
      end: normalizePosition(item.range?.end),
    },
    ...(children.length > 0 && { children }),
  };
}

/**
 * Coerce an unknown `items` value into a list of mapped entries.
 * Defensive: any malformed element is skipped, not thrown on.
 */
function mapItems(raw: unknown): CodeOutlineEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeOutlineEntry[] = [];
  for (const el of raw) {
    if (el && typeof el === "object") {
      try {
        out.push(mapItem(el as RawOutlineItem));
      } catch {
        // Self-healing: a single malformed symbol must not brick the call.
      }
    }
  }
  return out;
}

/**
 * code_outline tool factory for AI assistant.
 * Creates a read-only tool that exposes ast-grep structural outlines (symbols,
 * signatures, ranges) for a file or directory, gated behind the
 * astGrepOutline experiment. Mirrors file_read.ts's structure.
 *
 * @param config Required configuration including cwd, runtime, and experiments.
 */
export const createCodeOutlineTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.code_outline.description,
    inputSchema: TOOL_DEFINITIONS.code_outline.schema,
    execute: async (
      { path, items, maxFiles, maxSymbols, symbolTypes },
      { abortSignal: _abortSignal }
    ): Promise<CodeOutlineToolResult> => {
      // Note: abortSignal available but not used - outline runs to completion quickly.

      try {
        // Validate + resolve the path within cwd/runtime semantics. Despite the
        // historical name, resolvePathWithinCwd resolves the exact requested
        // path (see fileCommon.ts) and applies redundant-prefix auto-correction.
        const { resolvedPath } = resolvePathWithinCwd(path, config.cwd, config.runtime);

        // Stat to detect file vs directory. A missing path is surfaced as a
        // success:false result rather than a thrown error (matches file_read).
        let isDirectory: boolean;
        try {
          const stat = await config.runtime.stat(resolvedPath);
          isDirectory = stat.isDirectory;
        } catch (err) {
          if (err instanceof RuntimeError) {
            return {
              success: false,
              error: err.message,
            };
          }
          throw err;
        }

        const kind: "file" | "directory" = isDirectory ? "directory" : "file";
        // Default items mode depends on kind: files -> structure (nested tree),
        // directories -> exports (one entry per file, exported symbols only).
        const itemsMode = items ?? (isDirectory ? "exports" : "structure");
        // Files emit a single JSON array (--json=compact); directories emit one
        // JSON object per line (--json=stream).
        const jsonMode = isDirectory ? "stream" : "compact";
        const viewFlag = itemsMode === "structure" ? "--view=expanded" : null;

        const command = [
          "ast-grep",
          "outline",
          `--json=${jsonMode}`,
          ...(viewFlag ? [viewFlag] : []),
          `--items=${itemsMode}`,
          shellQuote(resolvedPath),
        ].join(" ");

        let result;
        try {
          result = await execBuffered(config.runtime, command, {
            cwd: config.cwd,
            timeout: OUTLINE_TIMEOUT_SECS,
          });
        } catch (err) {
          // Binary missing (ENOENT on ast-grep) or runtime exec failure.
          // Surface a clear tool error per the RFC risk-matrix mitigation.
          return {
            success: false,
            kind,
            error: `Failed to run ast-grep: ${getErrorMessage(err)}`,
          };
        }

        // Authoritative error handling: ast-grep can write `[]` to stdout even
        // when something went wrong (e.g. a missing path prints
        // "ERROR: ... No such file" to stderr with exit 0). So stderr and/or a
        // non-zero exit must override stdout — never parse stdout in that case.
        const trimmedStderr = result.stderr.trim();
        if (result.exitCode !== 0 || trimmedStderr.length > 0) {
          return {
            success: false,
            kind,
            error: trimmedStderr || `ast-grep exited with code ${result.exitCode}`,
          };
        }

        // Parse stdout. Compact => one JSON array of file-results.
        // Stream => one file-result JSON object per line.
        // Defensive per line/object: a single malformed entry is skipped.
        const rawFiles: RawOutlineFile[] = [];
        if (jsonMode === "compact") {
          try {
            const parsed: unknown = JSON.parse(result.stdout);
            if (Array.isArray(parsed)) {
              for (const el of parsed) {
                if (el && typeof el === "object") rawFiles.push(el as RawOutlineFile);
              }
            }
          } catch {
            // Malformed compact JSON => no parseable results. Return graceful empty.
          }
        } else {
          for (const line of result.stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              const parsed: unknown = JSON.parse(trimmed);
              if (parsed && typeof parsed === "object") {
                rawFiles.push(parsed as RawOutlineFile);
              }
            } catch {
              // Self-healing: skip a single malformed stream line, keep going.
            }
          }
        }

        // Map raw file-results -> schema entries.
        const filesMax = maxFiles ?? DEFAULT_MAX_FILES;
        const symbolsMax = maxSymbols ?? DEFAULT_MAX_SYMBOLS;
        let truncated = false;

        const files = rawFiles.slice(0, filesMax).map((rawFile) => {
          // symbolTypes filter is intentionally top-level only: if a top-level
          // entry is filtered out, its children are dropped too (conservative —
          // avoids surfacing partial subtrees the caller didn't ask for).
          let entries = mapItems(rawFile.items);
          if (symbolTypes && symbolTypes.length > 0) {
            const allow = new Set(symbolTypes);
            entries = entries.filter((e) => allow.has(e.symbolType));
          }
          if (entries.length > symbolsMax) {
            entries = entries.slice(0, symbolsMax);
            truncated = true;
          }
          return {
            path: asString(rawFile.path),
            language: asString(rawFile.language),
            entries,
          };
        });
        if (rawFiles.length > filesMax) {
          truncated = true;
        }

        return {
          success: true,
          path,
          kind,
          files,
          ...(truncated && { truncated: true }),
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to outline path: ${message}`,
        };
      }
    },
  });
};
