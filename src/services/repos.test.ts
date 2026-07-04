import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeRepoFor,
  discoverRepositories,
  GitWatcher,
  type RepoInfo,
} from "./repos"

let workspace: string

async function sh(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
  return out
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await sh(dir, ["init", "-q", "-b", "main"])
  await sh(dir, ["config", "user.email", "a@b.com"])
  await sh(dir, ["config", "user.name", "Tester"])
  await sh(dir, ["config", "commit.gpgsign", "false"])
  await writeFile(join(dir, "file.txt"), "x\n")
  await sh(dir, ["add", "-A"])
  await sh(dir, ["commit", "-q", "-m", "init"])
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "vsx-repos-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("discoverRepositories", () => {
  test("finds repo at root, a nested repo, and a linked worktree", async () => {
    // repoA is the workspace root itself.
    await initRepo(workspace)
    // repoB nested one level down inside a subfolder.
    const repoBDir = join(workspace, "pkgs", "repoB")
    await initRepo(repoBDir)
    // linked worktree of repoA within the scan tree.
    const wtDir = join(workspace, "wt")
    await sh(workspace, ["worktree", "add", "-q", wtDir, "-b", "feature"])

    const repos = await discoverRepositories(workspace)
    expect(repos.length).toBe(3)

    // Identify each repo by structure rather than fragile path matching.
    const worktree = repos.find((r) => r.gitDir.includes(join(".git", "worktrees")))
    expect(worktree).toBeDefined()
    const main = repos.find(
      (r) => r !== worktree && r.commonDir === worktree!.commonDir,
    )
    expect(main).toBeDefined()
    const nested = repos.find((r) => r !== worktree && r !== main)
    expect(nested).toBeDefined()

    // Worktree's common-dir resolves to the MAIN repo's .git; its git-dir is
    // the worktree-private path.
    expect(worktree!.commonDir).toBe(main!.gitDir)
    expect(worktree!.gitDir).toContain(join(".git", "worktrees"))
    // The worktree-private dir is named after the worktree directory (`wt`).
    expect(worktree!.gitDir).toContain(join("worktrees", "wt"))

    // The nested repo is a distinct repository with its own git dir.
    expect(nested!.gitDir).not.toBe(main!.gitDir)

    // Every repo carries a usable GitService.
    for (const r of repos) {
      const head = await r.service.head()
      expect(head).toHaveProperty("branch")
    }
  })

  test("respects maxDepth and skips node_modules", async () => {
    await initRepo(workspace)
    // depth 3 — beyond default maxDepth of 2.
    const deep = join(workspace, "a", "b", "c", "deepRepo")
    await initRepo(deep)
    // inside node_modules — must be skipped even at shallow depth.
    const nm = join(workspace, "node_modules", "pkg")
    await initRepo(nm)

    const repos = await discoverRepositories(workspace)
    const roots = repos.map((r) => r.root)
    expect(repos.length).toBe(1)
    expect(roots.some((r) => r.includes("deepRepo"))).toBe(false)
    expect(roots.some((r) => r.includes("node_modules"))).toBe(false)
  })
})

describe("activeRepoFor", () => {
  test("picks the deepest matching repo for a nested path", async () => {
    await initRepo(workspace)
    const repoBDir = join(workspace, "pkgs", "repoB")
    await initRepo(repoBDir)

    const repos = await discoverRepositories(workspace)
    const worktreeless = repos // no worktree here
    const nested = worktreeless.find((r) => r.root.includes("repoB"))!
    const outer = worktreeless.find((r) => r !== nested)!

    // A file inside the nested repo resolves to the nested (deepest) repo.
    const nestedFile = join(nested.root, "file.txt")
    expect(activeRepoFor(nestedFile, repos)!.root).toBe(nested.root)

    // A file only under the outer repo resolves to the outer repo.
    const outerFile = join(outer.root, "file.txt")
    expect(activeRepoFor(outerFile, repos)!.root).toBe(outer.root)

    // A path outside every repo resolves to null.
    expect(activeRepoFor("/definitely/not/a/repo/x.txt", repos)).toBeNull()
  })
})

describe("GitWatcher", () => {
  test("common-dir ref change marks a WORKTREE repo stale", async () => {
    await initRepo(workspace)
    const wtDir = join(workspace, "wt")
    await sh(workspace, ["worktree", "add", "-q", wtDir, "-b", "feature"])

    const repos = await discoverRepositories(workspace)
    const worktree = repos.find((r) =>
      r.gitDir.includes(join(".git", "worktrees")),
    )!
    const main = repos.find(
      (r) => r !== worktree && r.commonDir === worktree.commonDir,
    )!

    const watcher = new GitWatcher(repos)
    const stale: string[] = []
    watcher.onStatusStale((root) => stale.push(root))

    try {
      // Simulate a ref update in the MAIN repo (writes under the shared
      // common-dir refs/). The worktree watches the common dir, so it must
      // become stale even though the change is outside its own working tree.
      await sh(main.root, ["branch", "cross-worktree-ref"])
      await Bun.sleep(300)

      expect(stale).toContain(worktree.root)
    } finally {
      watcher.dispose()
    }
  })

  test("dispose stops further stale notifications", async () => {
    await initRepo(workspace)
    const repos = await discoverRepositories(workspace)
    const repo = repos[0]!

    const watcher = new GitWatcher(repos)
    const stale: string[] = []
    watcher.onStatusStale((root) => stale.push(root))
    watcher.dispose()

    await sh(repo.root, ["branch", "after-dispose"])
    await Bun.sleep(300)
    expect(stale.length).toBe(0)
  })
})

// Keep the RepoInfo type import exercised for verbatimModuleSyntax.
const _typeProbe: RepoInfo | null = null
void _typeProbe
