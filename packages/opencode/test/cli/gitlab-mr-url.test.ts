import { test, expect } from "bun:test"
import { parseGitLabMRUrl } from "../../src/cli/cmd/gitlab"

test("parses standard gitlab.com MR URL", () => {
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/123")).toEqual({
    instanceUrl: "https://gitlab.com",
    projectPath: "org/repo",
    mrIid: 123,
  })
})

test("parses nested group MR URL", () => {
  expect(parseGitLabMRUrl("https://gitlab.com/org/group/subgroup/repo/-/merge_requests/42")).toEqual({
    instanceUrl: "https://gitlab.com",
    projectPath: "org/group/subgroup/repo",
    mrIid: 42,
  })
})

test("parses self-hosted instance URL", () => {
  expect(parseGitLabMRUrl("https://gitlab.example.com/team/project/-/merge_requests/7")).toEqual({
    instanceUrl: "https://gitlab.example.com",
    projectPath: "team/project",
    mrIid: 7,
  })
})

test("parses URL with fragment (note anchor)", () => {
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/99#note_456")).toEqual({
    instanceUrl: "https://gitlab.com",
    projectPath: "org/repo",
    mrIid: 99,
  })
})

test("parses http URL", () => {
  expect(parseGitLabMRUrl("http://gitlab.internal/team/repo/-/merge_requests/1")).toEqual({
    instanceUrl: "http://gitlab.internal",
    projectPath: "team/repo",
    mrIid: 1,
  })
})

test("parses URL with port", () => {
  expect(parseGitLabMRUrl("https://gitlab.local:8443/org/repo/-/merge_requests/5")).toEqual({
    instanceUrl: "https://gitlab.local:8443",
    projectPath: "org/repo",
    mrIid: 5,
  })
})

test("returns null for GitHub URLs", () => {
  expect(parseGitLabMRUrl("https://github.com/owner/repo/pull/123")).toBeNull()
})

test("returns null for non-MR GitLab URLs", () => {
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/issues/10")).toBeNull()
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/pipelines/50")).toBeNull()
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo")).toBeNull()
})

test("returns null for invalid URLs", () => {
  expect(parseGitLabMRUrl("not-a-url")).toBeNull()
  expect(parseGitLabMRUrl("")).toBeNull()
  expect(parseGitLabMRUrl("gitlab.com/org/repo/-/merge_requests/1")).toBeNull()
})

test("returns null for MR URL without IID", () => {
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/")).toBeNull()
  expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests")).toBeNull()
})
