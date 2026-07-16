import { Fragment } from "react"
import { basename, join, relative } from "node:path"
import { theme } from "../theme"
import { activeRepoFor, type RepoInfo } from "../services/repos"

export type BreadcrumbSegment = {
  label: string
  /** Absolute path this segment reveals (a directory, or the file for the last one). */
  absolutePath: string
}

export type BreadcrumbsProps = {
  /** Absolute path of the active tab's underlying file; null when no tab is open (render nothing). */
  path: string | null
  /** All discovered repos in the workspace (from ReposProvider/useRepos). */
  repos: RepoInfo[]
  /** Workspace root; used as the relative-path base when `path` isn't inside any discovered repo. */
  workspaceRoot: string
  /** Cell width available to the row, used for middle-segment truncation. */
  containerWidth: number
  /** Fired when a segment is clicked, with the ABSOLUTE path that segment represents
   *  (a directory for every segment except the last, which is the file itself). */
  onSegmentClick?: (path: string) => void
}

const SEPARATOR = " › "
const ELLIPSIS = "…"

/**
 * Resolve `path` into a clickable trail: N directory segments + the filename,
 * each carrying the absolute path it points at (cumulative join from the base).
 * The base is the owning repo's root, or `workspaceRoot` when the file lives
 * outside every discovered repo. A leading repo-name segment is prepended only
 * in multi-repo workspaces, mirroring VSCode's per-repo breadcrumb prefix.
 */
export function resolveBreadcrumbSegments(
  path: string,
  repos: RepoInfo[],
  workspaceRoot: string,
): BreadcrumbSegment[] {
  const repo = activeRepoFor(path, repos)
  const base = repo ? repo.root : workspaceRoot
  const parts = relative(base, path)
    .split("/")
    .filter((p) => p.length > 0)

  const segments: BreadcrumbSegment[] = []
  if (repo && repos.length > 1) {
    segments.push({ label: basename(repo.root), absolutePath: repo.root })
  }
  let cursor = base
  for (const part of parts) {
    cursor = join(cursor, part)
    segments.push({ label: part, absolutePath: cursor })
  }
  return segments
}

function renderedWidth(segments: BreadcrumbSegment[]): number {
  const labels = segments.reduce((sum, s) => sum + s.label.length, 0)
  const seps = Math.max(0, segments.length - 1) * SEPARATOR.length
  return labels + seps
}

/**
 * VSCode-style middle-elision: when the full trail overflows `maxWidth`, keep the
 * first segment (repo label or top directory) and as many trailing segments as
 * fit — the filename always survives — collapsing everything between into a lone
 * `…`. Returns the trail untouched when it already fits or is too short to elide.
 */
export function truncateBreadcrumbSegments(
  segments: BreadcrumbSegment[],
  maxWidth: number,
): BreadcrumbSegment[] {
  if (segments.length <= 2) return segments
  if (renderedWidth(segments) <= maxWidth) return segments

  const first = segments[0]
  const ellipsis: BreadcrumbSegment = { label: ELLIPSIS, absolutePath: "" }
  let tail = segments.slice(-1)
  for (let count = 2; count <= segments.length - 2; count++) {
    const candidate = segments.slice(segments.length - count)
    if (renderedWidth([first, ellipsis, ...candidate]) <= maxWidth) tail = candidate
    else break
  }
  return [first, ellipsis, ...tail]
}

/**
 * Path-only breadcrumb trail rendered below a group's tab bar for the active file.
 * Segments are clickable — each fires {@link BreadcrumbsProps.onSegmentClick} with
 * the absolute path it represents; the reveal-in-Explorer behavior is the caller's.
 */
export function Breadcrumbs({
  path,
  repos,
  workspaceRoot,
  containerWidth,
  onSegmentClick,
}: BreadcrumbsProps) {
  // Return null (not a zero-height box) with no active file so the parent column
  // reserves no breadcrumb row at all — the consuming layout composes cleaner.
  if (path === null) return null

  const segments = truncateBreadcrumbSegments(
    resolveBreadcrumbSegments(path, repos, workspaceRoot),
    containerWidth,
  )

  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      backgroundColor={theme.sidebarBackground}
      border={["bottom"]}
      borderColor={theme.border}
    >
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const isEllipsis = segment.label === ELLIPSIS && segment.absolutePath === ""
        const fg = isLast ? theme.foreground : theme.dimForeground
        return (
          <Fragment key={`${i}:${segment.absolutePath}`}>
            {i > 0 && <text fg={theme.dimForeground}>{SEPARATOR}</text>}
            <box
              onMouseDown={
                isEllipsis ? undefined : () => onSegmentClick?.(segment.absolutePath)
              }
            >
              <text fg={fg} selectable={false}>
                {segment.label}
              </text>
            </box>
          </Fragment>
        )
      })}
    </box>
  )
}
