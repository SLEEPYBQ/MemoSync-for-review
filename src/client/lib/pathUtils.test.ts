import { describe, expect, test } from "bun:test"
import { parseLocalFileLink, shouldOpenLocalFileLinkInEditor } from "./pathUtils"

describe("parseLocalFileLink", () => {
  test("parses an absolute file path with a line fragment", () => {
    expect(parseLocalFileLink("/Users/reviewer/Projects/example/src/app.ts#L12")).toEqual({
      path: "/Users/reviewer/Projects/example/src/app.ts",
      line: 12,
      column: undefined,
    })
  })

  test("parses an absolute file path without a fragment", () => {
    expect(parseLocalFileLink("/Users/reviewer/Projects/example/src/app.ts")).toEqual({
      path: "/Users/reviewer/Projects/example/src/app.ts",
    })
  })

  test("parses an absolute file path with a line suffix", () => {
    expect(parseLocalFileLink("/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs:1")).toEqual({
      path: "/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: undefined,
    })
  })

  test("parses an absolute file path with line and column suffixes", () => {
    expect(parseLocalFileLink("/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs:1:2")).toEqual({
      path: "/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: 2,
    })
  })

  test("parses same-origin absolute file urls with a line suffix", () => {
    const originalWindow = globalThis.window


    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          origin: "http://localhost:9000",
        },
      },
      configurable: true,
      writable: true,
    })

    try {
      expect(parseLocalFileLink("http://localhost:9000/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs:1")).toEqual({
        path: "/Users/reviewer/Projects/example-agent/scripts/e2b-proxy.mjs",
        line: 1,
        column: undefined,
      })
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      })
    }
  })

  test("does not treat web links as local file links", () => {
    expect(parseLocalFileLink("https://example.com")).toBeNull()
  })
})

describe("shouldOpenLocalFileLinkInEditor", () => {
  test("opens source, markdown, and text files in the editor", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/src/app.ts")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/README.md")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/notes.txt")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/.gitignore")).toBe(true)
  })

  test("opens media and document files in the default app", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/shot.png")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/movie.mp4")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/report.docx")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/reviewer/Projects/example/archive.zip")).toBe(false)
  })
})
