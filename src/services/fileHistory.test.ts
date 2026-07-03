import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fsp from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileHistory } from "./fileHistory"

let baseDir: string
const filePath = () => join(baseDir, "file-history.json")

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "vsx-fh-"))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 604_800_000

describe("record + frecency ordering", () => {
  test("repeated opens outrank single opens", () => {
    const fh = createFileHistory({ baseDir })
    const now = 1_000_000_000
    fh.record("/a", now)
    fh.record("/a", now)
    fh.record("/a", now)
    fh.record("/b", now)

    const ranked = fh.top(10, now).map((e) => e.path)
    expect(ranked).toEqual(["/a", "/b"])
  })

  test("a recent single open outranks an old frequent one across bands", () => {
    const fh = createFileHistory({ baseDir })
    const now = 10 * DAY
    // Old-but-frequent: opened 4× a full week ago → /4 band, score 4 → 1.0.
    const old = now - WEEK - 1
    for (let i = 0; i < 4; i++) fh.record("/old", old)
    // Recent single open: within the hour → ×4 band, score 1 → 4.0.
    fh.record("/recent", now - HOUR + 1)

    expect(fh.top(1, now).map((e) => e.path)).toEqual(["/recent"])
    expect(fh.frecency({ path: "/recent", score: 1, lastAccess: now - HOUR + 1 }, now)).toBe(4)
    expect(fh.frecency({ path: "/old", score: 4, lastAccess: old }, now)).toBe(1)
  })

  test("frecency multiplier bands", () => {
    const fh = createFileHistory({ baseDir })
    const now = 100 * DAY
    const entry = (lastAccess: number) => ({ path: "/x", score: 10, lastAccess })
    expect(fh.frecency(entry(now - HOUR + 1), now)).toBe(40) // <1h → ×4
    expect(fh.frecency(entry(now - DAY + 1), now)).toBe(20) // <1d → ×2
    expect(fh.frecency(entry(now - WEEK + 1), now)).toBe(5) // <1w → /2
    expect(fh.frecency(entry(now - WEEK - 1), now)).toBe(2.5) // else → /4
  })
})

describe("aging", () => {
  test("scales scores toward 0.9×MAXAGE and drops sub-1 entries once Σ > MAXAGE", () => {
    const fh = createFileHistory({ baseDir })
    const now = 1_000
    // 10_001 distinct single-open entries pushes Σ just past MAXAGE (10_000).
    // The scale factor is (0.9*10000)/10001 ≈ 0.8999 < 1, so every score-1
    // entry falls below 1 and is dropped — the whole store empties.
    for (let i = 0; i < 10_001; i++) fh.record(`/f${i}`, now)
    expect(fh.top(10_001, now).length).toBe(0)
  })

  test("keeps entries whose scaled score stays >= 1", () => {
    const fh = createFileHistory({ baseDir })
    const now = 1_000
    // One heavily-opened file plus enough singles to cross MAXAGE. After
    // scaling the heavy file stays above 1 while the singles drop out.
    for (let i = 0; i < 9_999; i++) fh.record(`/s${i}`, now)
    for (let i = 0; i < 100; i++) fh.record("/heavy", now)

    const ranked = fh.top(20, now)
    expect(ranked.some((e) => e.path === "/heavy")).toBe(true)
    // Σ before aging is 9_999 + 100 = 10_099 > MAXAGE; heavy's 100 scales by
    // ~0.891 to ~89, comfortably surviving.
    const heavy = ranked.find((e) => e.path === "/heavy")!
    expect(heavy.score).toBeGreaterThan(1)
    expect(heavy.score).toBeLessThan(100)
  })
})

describe("evict", () => {
  test("removes and persists", async () => {
    const fh = createFileHistory({ baseDir })
    const now = 5_000
    fh.record("/keep", now)
    fh.record("/drop", now)
    fh.evict("/drop")
    await fh.flush()

    const reloaded = createFileHistory({ baseDir })
    expect(reloaded.top(10, now).map((e) => e.path)).toEqual(["/keep"])
  })
})

describe("persistence", () => {
  test("roundtrips ranking across instances from the same dir", async () => {
    const now = 2_000_000
    const fh = createFileHistory({ baseDir })
    fh.record("/a", now)
    fh.record("/a", now)
    fh.record("/b", now)
    await fh.flush()

    const reloaded = createFileHistory({ baseDir })
    expect(reloaded.top(10, now).map((e) => e.path)).toEqual(["/a", "/b"])
  })

  test("the target file is valid JSON after a flush mid-recording", async () => {
    const fh = createFileHistory({ baseDir })
    const now = 3_000
    for (let i = 0; i < 200; i++) fh.record(`/f${i}`, now)
    await fh.flush()

    const raw = await readFile(filePath(), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries.length).toBe(200)
  })
})

describe("corruption tolerance", () => {
  test("garbage file loads empty and the next flush rewrites valid JSON", async () => {
    await writeFile(filePath(), "}{ not json at all")

    const fh = createFileHistory({ baseDir })
    expect(fh.top(10).length).toBe(0)

    const now = 4_000
    fh.record("/fresh", now)
    await fh.flush()

    const parsed = JSON.parse(await readFile(filePath(), "utf8"))
    expect(parsed.version).toBe(1)
    expect(parsed.entries.map((e: { path: string }) => e.path)).toEqual(["/fresh"])
  })

  test("wrong-shape file loads empty", () => {
    const fh = createFileHistory({ baseDir })
    expect(fh.top(10).length).toBe(0)
  })
})

describe("pruneMissing", () => {
  test("removes missing+old, keeps missing+recent and existing", async () => {
    const fh = createFileHistory({ baseDir })
    const now = 200 * DAY
    fh.record("/missing-old", now - NINETY_DAYS_PLUS)
    fh.record("/missing-recent", now - DAY)
    fh.record("/present-old", now - NINETY_DAYS_PLUS)
    await fh.flush()

    const exists = async (path: string) => path === "/present-old"
    await fh.pruneMissing(exists, now)

    const paths = fh.top(10, now).map((e) => e.path).sort()
    expect(paths).toEqual(["/missing-recent", "/present-old"])

    // Removal persisted.
    await fh.flush()
    const reloaded = createFileHistory({ baseDir })
    expect(reloaded.top(10, now).map((e) => e.path).sort()).toEqual([
      "/missing-recent",
      "/present-old",
    ])
  })
})

describe("debounce", () => {
  test("multiple records coalesce into a single write via flush()", async () => {
    const renameSpy = spyOn(fsp, "rename")
    const before = renameSpy.mock.calls.length
    const fh = createFileHistory({ baseDir })
    const now = 6_000
    fh.record("/a", now)
    fh.record("/b", now)
    fh.record("/c", now)

    // Nothing written yet: the save is still on its debounce timer.
    await expect(readFile(filePath(), "utf8")).rejects.toThrow()

    await fh.flush()
    expect(renameSpy.mock.calls.length - before).toBe(1)
    renameSpy.mockRestore()

    const parsed = JSON.parse(await readFile(filePath(), "utf8"))
    expect(parsed.entries.length).toBe(3)
  })
})

const NINETY_DAYS_PLUS = 91 * DAY
