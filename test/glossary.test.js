'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { highlight, collectTerms } = require('../lib/index.js')

test('longest phrase wins and whole words only', () => {
  const out = highlight('<p>A user account, not a username.</p>', [
    { phrase: 'user account', href: '/ua', definition: '' },
    { phrase: 'user', href: '/u', definition: '' },
  ])
  assert.match(out, /href="\/ua"[^>]*>user account</)
  assert.doesNotMatch(out, /username<\/a>/)
})

test('skips code and existing links', () => {
  const out = highlight('<p><code>user</code> <a href="x">user</a></p>', [{ phrase: 'user', href: '/u', definition: '' }])
  assert.doesNotMatch(out, /glossary-term/)
})

test('imported terms carry the external class', () => {
  const out = highlight('<p>entity</p>', [{ phrase: 'entity', href: 'https://p/e', definition: 'd', external: true }])
  assert.match(out, /class="glossary-term glossary-term-external" href="https:\/\/p\/e" title="d"/)
})

test('collects terms with synonyms', () => {
  const files = [{ src: { family: 'page', relative: 'glossary/entity.adoc', module: 'ROOT', stem: 'entity' }, contents: Buffer.from('= entity\n:page-glossary-synonyms: organisation\n\nThe thing a user creates.\n') }]
  const [t] = collectTerms(files)
  assert.deepStrictEqual([t.title, t.synonyms, t.definition], ['entity', ['organisation'], 'The thing a user creates.'])
})
test('lists imported definitions of the same word', () => {
  const { collisions, collisionsHtml } = require('../lib/index.js')
  const term = { title: 'entity', synonyms: ['organisation'] }
  const hits = collisions(term, [
    { term: 'Organisation', url: 'https://a.example/org', definition: 'd' },
    { term: 'user', url: 'https://a.example/u' },
  ])
  assert.strictEqual(hits.length, 1)
  assert.match(collisionsHtml(hits), /Also defined on other sites[\s\S]*https:\/\/a\.example\/org[\s\S]*a\.example/)
})