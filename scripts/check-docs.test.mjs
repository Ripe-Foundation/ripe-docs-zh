// Tests for the docs checker. Each case builds a throwaway docs tree in tmp,
// so a check that silently stops firing fails loudly here.
//
// Usage: node --test scripts/

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkDocs, gitbookSlugVariants, slugify, slugVariants } from './check-docs.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Build a docs tree from a {path: contents} map and check it. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), contents)
    }
    return checkDocs(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const codes = (issues) => issues.map((i) => i.code).sort()

const page = (title, body = '') => `---\ndescription: A page.\n---\n\n# ${title}\n\n${body}\n`

const SHOT = '![A screenshot](../.gitbook/assets/shot.png)'

/** guides/01-one.md with the shared asset kept referenced, so fixtures stay isolated. */
const onePage = (body = '') => page('One', `${SHOT}\n\n${body}`)

/** A minimal tree that must always come back clean. */
const CLEAN = {
  'SUMMARY.md': '# Table of contents\n\n* [Home](README.md)\n\n## Guides\n\n* [One](guides/01-one.md)\n',
  'README.md': page('Home', 'See [One](guides/01-one.md).'),
  'guides/01-one.md': page('One', SHOT),
  '.gitbook/assets/shot.png': 'PNG',
}

const withClean = (overrides) => ({ ...CLEAN, ...overrides })

describe('checkDocs', () => {
  test('a well-formed tree reports nothing', () => {
    assert.deepEqual(check(CLEAN), [])
  })

  test('the real repo is clean', () => {
    const issues = checkDocs(REPO_ROOT)
    assert.deepEqual(issues, [], issues.map((i) => `${i.file}:${i.line} [${i.code}] ${i.message}`).join('\n'))
  })

  describe('SUMMARY', () => {
    test('flags an entry with no page behind it', () => {
      const issues = check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Two](guides/02-two.md)\n',
      }))
      assert.deepEqual(codes(issues), ['summary-missing-target'])
      assert.match(issues[0].message, /guides\/02-two\.md/)
    })

    test('flags a page missing from the table of contents', () => {
      const issues = check(withClean({ 'guides/02-two.md': page('Two') }))
      assert.deepEqual(codes(issues), ['orphan-page'])
      assert.equal(issues[0].file, 'guides/02-two.md')
    })

    test('flags the same page listed twice', () => {
      const issues = check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [One again](guides/01-one.md)\n',
      }))
      assert.deepEqual(codes(issues), ['summary-duplicate'])
    })

    test('flags an entry pointing at a non-markdown file', () => {
      const issues = check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Shot](.gitbook/assets/shot.png)\n',
      }))
      assert.deepEqual(codes(issues), ['summary-not-markdown'])
    })

    test('leaves external entries alone', () => {
      assert.deepEqual(check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [GitHub](https://github.com/Ripe-Foundation/ripe-protocol)\n',
      })), [])
    })
  })

  describe('links', () => {
    test('flags a relative link with no file behind it', () => {
      const issues = check(withClean({ 'guides/01-one.md': onePage('See [Two](02-two.md).') }))
      assert.deepEqual(codes(issues), ['broken-link'])
      assert.equal(issues[0].line, 9)
    })

    test('flags an image with no file behind it', () => {
      const issues = check(withClean({ 'guides/01-one.md': onePage('![Shot](../.gitbook/assets/missing.png)') }))
      assert.deepEqual(codes(issues), ['broken-image'])
    })

    test('flags a link that climbs out of the docs root', () => {
      const issues = check(withClean({ 'guides/01-one.md': onePage('[Escape](../../secrets.md)') }))
      assert.deepEqual(codes(issues), ['escapes-repo'])
    })

    test('accepts a link that resolves through a parent directory', () => {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage('[Home](../README.md)'),
      })), [])
    })

    test('ignores links inside fenced code blocks', () => {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage('```md\n[Nope](nowhere.md)\n![Nope](nowhere.png)\n```'),
      })), [])
    })

    test('ignores links inside tilde-fenced blocks', () => {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage('~~~\n[Nope](nowhere.md)\n~~~'),
      })), [])
    })

    test('ignores external and mailto targets', () => {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage('[Site](https://ripe.finance) [Mail](mailto:hi@ripe.finance)'),
      })), [])
    })
  })

  describe('anchors', () => {
    const target = page('Two', '## Deposit Collateral\n\nText.')
    const chineseTarget = page('Two', '## 交易时段与周末跳空\n\nText.')

    test('accepts a cross-page anchor that exists', () => {
      assert.deepEqual(check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Two](guides/02-two.md)\n',
        'guides/01-one.md': onePage('[Go](02-two.md#deposit-collateral)'),
        'guides/02-two.md': target,
      })), [])
    })

    test('accepts the rendered GitBook ID for a Chinese heading', () => {
      assert.deepEqual(check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Two](guides/02-two.md)\n',
        'guides/01-one.md': onePage('[Go](02-two.md#jiao-yi-shi-duan-yu-zhou-mo-tiao-kong)'),
        'guides/02-two.md': chineseTarget,
      })), [])
    })

    test('rejects a source-style Chinese fragment that GitBook will transliterate', () => {
      const issues = check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Two](guides/02-two.md)\n',
        'guides/01-one.md': onePage('[Go](02-two.md#交易时段与周末跳空)'),
        'guides/02-two.md': chineseTarget,
      }))
      assert.deepEqual(codes(issues), ['unrendered-anchor'])
    })

    test('flags a cross-page anchor that does not', () => {
      const issues = check(withClean({
        'SUMMARY.md': CLEAN['SUMMARY.md'] + '* [Two](guides/02-two.md)\n',
        'guides/01-one.md': onePage('[Go](02-two.md#deposit-collatoral)'),
        'guides/02-two.md': target,
      }))
      assert.deepEqual(codes(issues), ['broken-anchor'])
      assert.match(issues[0].message, /#deposit-collatoral/)
    })

    test('flags a same-page anchor that does not exist', () => {
      const issues = check(withClean({
        'guides/01-one.md': onePage('## Real\n\n[Jump](#not-real)'),
      }))
      assert.deepEqual(codes(issues), ['broken-anchor'])
    })

    test('accepts a same-page anchor that does', () => {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage('## Real Heading\n\n[Jump](#real-heading)'),
      })), [])
    })
  })

  describe('assets', () => {
    test('flags an asset nothing points at', () => {
      const issues = check(withClean({ '.gitbook/assets/unused.png': 'PNG' }))
      assert.deepEqual(codes(issues), ['orphan-asset'])
      assert.equal(issues[0].file, '.gitbook/assets/unused.png')
    })

    test('flags a leftover path from the source bundle', () => {
      const issues = check(withClean({
        'guides/01-one.md': onePage('![Old](user-guide-screenshots/01-dashboard.png)'),
      }))
      assert.equal(codes(issues).includes('stale-path'), true)
    })
  })

  describe('page shape', () => {
    test('flags a page with no frontmatter', () => {
      const issues = check(withClean({ 'guides/01-one.md': `# One\n\n${SHOT}\n` }))
      assert.deepEqual(codes(issues), ['missing-frontmatter'])
    })

    test('flags an empty description', () => {
      const issues = check(withClean({
        'guides/01-one.md': `---\ndescription:\n---\n\n# One\n\n${SHOT}\n`,
      }))
      assert.deepEqual(codes(issues), ['missing-description'])
    })

    test('flags a second H1', () => {
      const issues = check(withClean({
        'guides/01-one.md': onePage('# Another'),
      }))
      assert.deepEqual(codes(issues), ['h1-count'])
      assert.match(issues[0].message, /found 2/)
    })

    test('flags a page with no H1', () => {
      const issues = check(withClean({
        'guides/01-one.md': `---\ndescription: A page.\n---\n\n## Only a subhead\n\n${SHOT}\n`,
      }))
      assert.deepEqual(codes(issues), ['h1-count'])
    })

    test('flags an image with no alt text', () => {
      const issues = check(withClean({ 'guides/01-one.md': page('One', '![](../.gitbook/assets/shot.png)') }))
      assert.deepEqual(codes(issues), ['missing-alt'])
    })
  })
})

describe('slugify', () => {
  const cases = [
    ['Deposit Collateral', 'deposit-collateral'],
    ['Guide 1: Deposit collateral', 'guide-1-deposit-collateral'],
    ['**Bold** heading', 'bold-heading'],
    ['A `code` span', 'a-code-span'],
    ['Underscore Earn Vault Integration', 'underscore-earn-vault-integration'],
    ['Trailing spaces   ', 'trailing-spaces'],
    ['[A link](x.md) inside', 'a-link-inside'],
  ]
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => assert.equal(slugify(input), expected))
  }

  test('a punctuation-stripped whitespace run yields both renderer variants', () => {
    assert.deepEqual(slugVariants('Pay back & withdraw'), ['pay-back-withdraw', 'pay-back--withdraw'])
  })

  test('either variant resolves as an anchor', () => {
    for (const anchor of ['pay-back-withdraw', 'pay-back--withdraw']) {
      assert.deepEqual(check(withClean({
        'guides/01-one.md': onePage(`## Pay back & withdraw\n\n[Jump](#${anchor})`),
      })), [], anchor)
    }
  })

  test('a typo in an ambiguous slug is still caught', () => {
    const issues = check(withClean({
      'guides/01-one.md': onePage('## Pay back & withdraw\n\n[Jump](#pay-back-withdrawl)'),
    }))
    assert.deepEqual(codes(issues), ['broken-anchor'])
  })

  test('repeat headings get numbered slugs, GitHub-style', () => {
    const issues = check(withClean({
      'guides/01-one.md': onePage('## Steps\n\n## Steps\n\n[a](#steps) [b](#steps-1)'),
    }))
    assert.deepEqual(issues, [])
  })

  test('uses verified GitBook IDs for linked Chinese headings', () => {
    assert.deepEqual(gitbookSlugVariants('动态利率'), ['dong-tai-li-l'])
    assert.deepEqual(gitbookSlugVariants('6. 锚定稳定模块（PSM）'), ['id-6.-mao-ding-wen-ding-mo-kuai-psm'])
  })

  test('does not guess an unverified Chinese heading ID', () => {
    assert.deepEqual(gitbookSlugVariants('尚未验证的标题'), [])
  })
})
