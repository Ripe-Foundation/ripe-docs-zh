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
const HAS_HAN = /\p{Script=Han}/u

// GitBook transliterates Chinese headings instead of preserving their source
// characters in rendered IDs. The behavior is not documented as a stable
// algorithm and includes non-obvious results (for example, 动态利率 ->
// `dong-tai-li-l`). Keep the verified mappings narrow: only headings that the
// docs link to belong here. A new linked Chinese heading must be checked in the
// GitBook revision preview and added explicitly, so the validator cannot bless
// a source-style fragment that fails in production.
const GITBOOK_CJK_ANCHORS = new Map([
  ['交易时段与周末跳空', 'jiao-yi-shi-duan-yu-zhou-mo-tiao-kong'],
  ['价格缺失时会发生什么', 'jia-ge-que-shi-shi-hui-fa-sheng-shen-me'],
  ['哪些事件可以移动您的代币', 'na-xie-shi-jian-ke-yi-yi-dong-nin-de-dai-bi'],
  ['6. 锚定稳定模块（PSM）', 'id-6.-mao-ding-wen-ding-mo-kuai-psm'],
  ['Underscore Earn 金库集成', 'underscore-earn-jin-ku-ji-cheng'],
  ['三项阈值如何协同：直观指南', 'san-xiang-yu-zhi-ru-he-xie-tong-zhi-guan-zhi-nan'],
  ['加权债务条款详解', 'jia-quan-zhai-wu-tiao-kuan-xiang-jie'],
  ['动态利率', 'dong-tai-li-l'],
  ['了解风险区', 'liao-jie-feng-xian-qu'],
  ['如果出现坏账怎么办', 'ru-guo-chu-xian-huai-zhang-zen-me-ban'],
  ['守护者网络', 'shou-hu-zhe-wang-luo'],
  ['清算为何重要', 'qing-suan-wei-he-zhong-yao'],
  ['清算经济机制', 'qing-suan-jing-ji-ji-zhi'],
  ['第一阶段：稳定池兑换', 'di-yi-jie-duan-wen-ding-chi-dui-huan'],
  ['第二阶段：荷兰式拍卖', 'di-er-jie-duan-he-lan-shi-pai-mai'],
  ['赎回缓冲区', 'shu-hui-huan-chong-qu'],
  ['使用指定资产自行去杠杆', 'shi-yong-zhi-ding-zi-chan-zi-xing-qu-gang-gan'],
  ['无法为账户估值时', 'wu-fa-wei-zhang-hu-gu-zhi-shi'],
  ['RIPE 价值累积', 'ripe-jia-zhi-lei-ji'],
  ['供应上限：全协议共计 10 亿', 'gong-ying-shang-xian-quan-xie-yi-gong-ji-10-yi'],
  ['提前退出：最后手段', 'ti-qian-tui-chu-zui-hou-shou-duan'],
  ['管理您的仓位', 'guan-li-nin-de-cang-wei'],
  ['债券与坏账', 'zhai-quan-yu-huai-zhang'],
  ['领取奖励时如何应用锁定', 'ling-qu-jiang-li-shi-ru-he-ying-yong-suo-ding'],
])

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
function plainHeading(heading) {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
}

export function slugVariants(heading) {
  const cleaned = plainHeading(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
  return [...new Set([cleaned.replace(/\s+/g, '-'), cleaned.replace(/\s/g, '-')])]
}

/** The canonical (whitespace-collapsed) slug for a heading. */
export const slugify = (heading) => slugVariants(heading)[0]

/** The IDs GitBook actually renders for a heading. */
export function gitbookSlugVariants(heading) {
  const text = plainHeading(heading)
  if (!HAS_HAN.test(text)) return slugVariants(heading)
  const mapped = GITBOOK_CJK_ANCHORS.get(text)
  return mapped ? [mapped] : []
}

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
      const variants = gitbookSlugVariants(h[2])
      const key = variants[0] ?? `unmapped:${plainHeading(h[2])}`
      const n = seenSlugs.get(key) ?? 0
      seenSlugs.set(key, n + 1)
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

function decodedHash(hash) {
  try { return decodeURIComponent(hash) } catch { return hash }
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
        if (link.hash && HAS_HAN.test(decodedHash(link.hash))) {
          add(file, link.line, 'unrendered-anchor', `GitBook transliterates Chinese fragments; use its rendered ID instead of #${link.hash}`)
        } else if (link.hash && !doc.headings.some((h) => h.slugs.includes(link.hash))) {
          add(file, link.line, 'broken-anchor', `no rendered heading on this page matches #${link.hash}`)
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
        if (HAS_HAN.test(decodedHash(link.hash))) {
          add(file, link.line, 'unrendered-anchor', `GitBook transliterates Chinese fragments; use its rendered ID instead of #${link.hash}`)
        } else if (target && !target.headings.some((h) => h.slugs.includes(link.hash))) {
          add(file, link.line, 'broken-anchor', `${rel} has no rendered heading matching #${link.hash}`)
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
