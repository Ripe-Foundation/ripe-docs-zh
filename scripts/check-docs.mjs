#!/usr/bin/env node
// Structural checks for the docs tree: every SUMMARY entry resolves, every page
// is reachable from SUMMARY, every relative link/anchor/image resolves, and no
// asset is left behind unreferenced.
//
// Usage: node scripts/check-docs.mjs [root]   (default root: repo root)

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.uai', 'scripts'])
const ASSET_DIR = '.gitbook/assets'
const SUMMARY = 'SUMMARY.md'

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

// --- markdown helpers -------------------------------------------------------

/** Blank out fenced code blocks, preserving line numbering. */
function stripFences(text) {
  let fence = null
  return text.split('\n').map((line) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      return ''
    }
    if (m) { fence = m[1]; return '' }
    return line
  })
}

/**
 * Heading slugs, as an anchor generator would produce them.
 *
 * Renderers disagree on runs of whitespace left behind by stripped punctuation:
 * "Pay back & withdraw" is `pay-back--withdraw` under GitHub's per-space rule and
 * `pay-back-withdraw` when the run is collapsed. Rather than bet on one, we accept
 * both — that still catches a genuine typo without inventing a false failure.
 */
export function slugVariants(heading) {
  const cleaned = heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
  return [...new Set([cleaned.replace(/\s+/g, '-'), cleaned.replace(/\s/g, '-')])]
}

/** The canonical (whitespace-collapsed) slug for a heading. */
export const slugify = (heading) => slugVariants(heading)[0]

/** Links and images: [text](target) / ![alt](target), ignoring optional titles. */
const LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)>\s]*)>?(?:\s+["'][^"']*["'])?\s*\)/g

function parseMarkdown(text) {
  const lines = stripFences(text)
  const links = []
  const headings = []
  const seenSlugs = new Map()

  lines.forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (h) {
      const variants = slugVariants(h[2])
      const n = seenSlugs.get(variants[0]) ?? 0
      seenSlugs.set(variants[0], n + 1)
      const slugs = n ? variants.map((v) => `${v}-${n}`) : variants
      headings.push({ level: h[1].length, text: h[2], slugs, line: i + 1 })
    }
    for (const m of line.matchAll(LINK_RE)) {
      const [target, hash] = splitHash(m[3])
      links.push({ isImage: m[1] === '!', text: m[2], target, hash, raw: m[3], line: i + 1 })
    }
  })
  return { links, headings }
}

function splitHash(raw) {
  const i = raw.indexOf('#')
  return i === -1 ? [raw, ''] : [raw.slice(0, i), raw.slice(i + 1)]
}

// --- fs helpers -------------------------------------------------------------

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(root, join(dir, entry.name), out)
    } else {
      out.push(relative(root, join(dir, entry.name)).split('\\').join('/'))
    }
  }
  return out
}

// --- the checks -------------------------------------------------------------

export function checkDocs(root) {
  const issues = []
  const add = (file, line, code, message) => issues.push({ file, line, code, message })

  const files = walk(root)
  const pages = files.filter((f) => f.endsWith('.md') && f !== SUMMARY)
  const assets = files.filter((f) => f.startsWith(`${ASSET_DIR}/`))
  const parsed = new Map()
  for (const f of [...pages, SUMMARY]) {
    if (existsSync(join(root, f))) parsed.set(f, parseMarkdown(readFileSync(join(root, f), 'utf8')))
  }

  // 1. SUMMARY entries resolve, are markdown, and are not duplicated.
  const summaryTargets = new Map()
  const summary = parsed.get(SUMMARY)
  if (!summary) {
    add(SUMMARY, 0, 'summary-missing', `${SUMMARY} not found`)
  } else {
    for (const link of summary.links) {
      if (link.isImage || !link.target || EXTERNAL.test(link.target)) continue
      const rel = posix.normalize(link.target)
      if (!rel.endsWith('.md')) {
        add(SUMMARY, link.line, 'summary-not-markdown', `entry "${link.text}" points at a non-markdown file: ${link.target}`)
        continue
      }
      if (!existsSync(join(root, rel))) {
        add(SUMMARY, link.line, 'summary-missing-target', `entry "${link.text}" points at a missing page: ${link.target}`)
        continue
      }
      if (summaryTargets.has(rel)) {
        add(SUMMARY, link.line, 'summary-duplicate', `${rel} is already listed on line ${summaryTargets.get(rel)}`)
      } else {
        summaryTargets.set(rel, link.line)
      }
    }
  }

  // 2. No page is unreachable from SUMMARY.
  for (const page of pages) {
    if (!summaryTargets.has(page)) add(page, 0, 'orphan-page', `not listed in ${SUMMARY}`)
  }

  const referencedAssets = new Set()

  for (const [file, doc] of parsed) {
    const dir = dirname(file)

    // 3. Frontmatter description + exactly one H1 (SUMMARY is a ToC, exempt).
    if (file !== SUMMARY) {
      const text = readFileSync(join(root, file), 'utf8')
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
      if (!fm) add(file, 1, 'missing-frontmatter', 'no YAML frontmatter block')
      else if (!/^description:\s*\S/m.test(fm[1])) add(file, 1, 'missing-description', 'frontmatter has no non-empty description')

      const h1s = doc.headings.filter((h) => h.level === 1)
      if (h1s.length !== 1) {
        add(file, h1s[1]?.line ?? 1, 'h1-count', `expected exactly 1 H1, found ${h1s.length}`)
      }
    }

    for (const link of doc.links) {
      // SUMMARY's own entries are fully validated by check 1; re-resolving them
      // here would report every broken entry twice.
      if (file === SUMMARY) continue

      // 4. Images carry alt text.
      if (link.isImage && !link.text.trim()) {
        add(file, link.line, 'missing-alt', `image has no alt text: ${link.raw}`)
      }

      // 5. Nothing points back at the handoff bundle's layout.
      if (link.raw.includes('user-guide-screenshots/')) {
        add(file, link.line, 'stale-path', `references the source bundle path: ${link.raw}`)
      }

      if (EXTERNAL.test(link.raw)) continue

      // 6. Same-page anchors resolve.
      if (!link.target) {
        if (link.hash && !doc.headings.some((h) => h.slugs.includes(link.hash))) {
          add(file, link.line, 'broken-anchor', `no heading on this page matches #${link.hash}`)
        }
        continue
      }

      // 7. Relative targets resolve.
      const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, decodeURIComponent(link.target)))
      if (rel.startsWith('..')) {
        add(file, link.line, 'escapes-repo', `link escapes the docs root: ${link.raw}`)
        continue
      }
      if (!existsSync(join(root, rel))) {
        add(file, link.line, link.isImage ? 'broken-image' : 'broken-link', `target does not exist: ${link.raw}`)
        continue
      }
      if (rel.startsWith(`${ASSET_DIR}/`)) referencedAssets.add(rel)

      // 8. Cross-page anchors resolve.
      if (link.hash && rel.endsWith('.md')) {
        const target = parsed.get(rel)
        if (target && !target.headings.some((h) => h.slugs.includes(link.hash))) {
          add(file, link.line, 'broken-anchor', `${rel} has no heading matching #${link.hash}`)
        }
      }
    }
  }

  // 9. Every committed asset is used by something.
  for (const asset of assets) {
    if (!referencedAssets.has(asset)) add(asset, 0, 'orphan-asset', 'committed but never referenced')
  }

  return issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

// --- cli --------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const issues = checkDocs(root)
  for (const i of issues) console.error(`${i.file}:${i.line}  [${i.code}] ${i.message}`)
  const pageCount = walk(root).filter((f) => f.endsWith('.md')).length
  if (issues.length) {
    console.error(`\n${issues.length} problem(s) found across ${pageCount} markdown file(s).`)
    process.exit(1)
  }
  console.log(`docs ok: ${pageCount} markdown file(s), no structural problems.`)
}
