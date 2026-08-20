import { test, expect } from "bun:test"
import { itemKind, ghRepo, repoOf } from "../src/engine/item"
import type { WorkItem } from "../src/types"

const item = (o: Partial<WorkItem>): WorkItem =>
  ({ id: "pr:80", number: 80, title: "t", state: "OPEN", labels: [], ...o }) as WorkItem

test("the kind comes from the id prefix the gh adapter stamps", () => {
  expect(itemKind(item({ id: "pr:80" }))).toBe("pr")
  expect(itemKind(item({ id: "issue:7" }))).toBe("issue")
})

test("the repo slug is derived from the item url, for both kinds", () => {
  expect(ghRepo(item({ url: "https://example.test/acme/web/pull/80" }))).toBe("acme/web")
  expect(ghRepo(item({ url: "https://example.test/acme/web/issues/7" }))).toBe("acme/web")
})

test("an item with no usable url has no repo rather than a wrong one", () => {
  expect(ghRepo(item({ url: undefined }))).toBeNull()
  expect(ghRepo(item({ url: "https://example.test/acme/web" }))).toBeNull()
})

test("repoOf resolves the same slug as ghRepo when the url is usable", () => {
  expect(repoOf(item({ url: "https://example.test/acme/web/pull/80" }))).toBe("acme/web")
})

test("repoOf throws on an item with no usable url, rather than silently no-op", () => {
  expect(() => repoOf(item({ url: undefined }))).toThrow(/no url/)
})
