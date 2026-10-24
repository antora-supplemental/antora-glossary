'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function register ({ config = {}, playbook } = {}) {
  const logger = this.getLogger ? this.getLogger('antora-glossary') : console
  const termsByComponent = new Map()
  const exported = []
  let imported = []
  const exportPath = config.export === false ? null : (typeof config.export === 'string' ? config.export : 'glossary.json')
  const siteUrl = ((playbook && playbook.site && playbook.site.url) || '').replace(/\/+$/, '')
  const cacheDir = path.join((playbook && playbook.runtime && playbook.runtime.cacheDir) || path.join(require('os').homedir(), '.cache', 'antora'), 'antora-glossary')

  this.once('contentAggregated', async () => {
    imported = await loadImports(config.imports || [], cacheDir, logger)
  })

  this.once('contentAggregated', ({ contentAggregate }) => {
    for (const component of contentAggregate) {
      for (const versionBucket of component.versions || []) {
        const terms = collectTerms(versionBucket.files)
        const key = component.name + '@' + versionBucket.version
        termsByComponent.set(key, terms)
        if (!terms.length) continue
        const moduleName = terms[0].module
        addFile(versionBucket, moduleName, 'glossary.adoc', indexPage(terms))
        for (const [letter, group] of groups(terms)) {
          const slug = letter === '#' ? 'num' : letter.toLowerCase()
          addFile(versionBucket, moduleName, 'glossary/letters/' + slug + '.adoc', letterPage(letter, group))
        }
      }
    }
  })

  this.once('pagesComposed', ({ pages }) => {
    const links = new Map()
    for (const page of pages) {
      const rel = page.src && page.src.relative
      if (!rel || !rel.startsWith('glossary/') || rel.startsWith('glossary/letters/')) continue
      if (!page.pub) continue
      const key = page.src.component + '@' + page.src.version
      const terms = termsByComponent.get(key) || []
      const term = terms.find((t) => t.relative === rel)
      if (!term) continue
      links.set(key + '|' + term.stem, page.pub.url)
      const clashes = collisions(term, imported)
      if (clashes.length && !page.contents.toString().includes('glossary-collisions')) {
        page.contents = Buffer.from(page.contents.toString() + collisionsHtml(clashes))
      }
      exported.push({ term: term.title, synonyms: term.synonyms, definition: term.definition, url: siteUrl + page.pub.url, component: page.src.component, version: page.src.version })
      if (term.canonical) {
        const target = pages.find((p) => p.pub && canonicalMatch(term.canonical, p))
        if (target) {
          links.set(key + '|canonical|' + term.stem, target.pub.url)
          const back = '<p class="glossary-backlink">Glossary: <a href="' + escapeAttr(page.pub.url) + '">' + escapeAttr(term.title) + '</a></p>'
          if (!target.contents.toString().includes('glossary-backlink')) {
            target.contents = Buffer.from(back + target.contents.toString())
          } else if (!target.contents.toString().includes(escapeAttr(page.pub.url))) {
            target.contents = Buffer.from(target.contents.toString().replace('</p>', '</p>' + back, 1))
          }
        }
      }
    }
    for (const page of pages) {
      if (!page.contents || !page.pub) continue
      const rel = (page.src && page.src.relative) || ''
      if (rel === 'glossary.adoc' || rel.startsWith('glossary/')) continue
      const key = page.src.component + '@' + page.src.version
      const terms = termsByComponent.get(key) || []
      if (!terms.length && !imported.length) continue
      const phrases = []
      const seen = new Set()
      for (const term of terms) {
        const href = links.get(key + '|canonical|' + term.stem) || links.get(key + '|' + term.stem)
        if (!href) continue
        for (const phrase of [term.title, ...term.synonyms]) {
          seen.add(phrase.toLowerCase())
          phrases.push({ phrase, href, definition: term.definition })
        }
      }
      for (const entry of imported) {
        for (const phrase of [entry.term, ...(entry.synonyms || [])]) {
          if (!phrase || seen.has(phrase.toLowerCase())) continue
          seen.add(phrase.toLowerCase())
          phrases.push({ phrase, href: entry.url, definition: entry.definition || '', external: true })
        }
      }
      phrases.sort((a, b) => b.phrase.length - a.phrase.length)
      page.contents = Buffer.from(highlight(page.contents.toString(), phrases))
    }
  })

  this.once('beforePublish', ({ siteCatalog }) => {
    if (!exportPath || !exported.length) return
    if (!siteUrl) logger.warn('site.url is not set; exported glossary URLs are site-relative and cannot be imported by other sites')
    const body = { format: 'antora-glossary/1', site: siteUrl, terms: exported }
    siteCatalog.addFile({ contents: Buffer.from(JSON.stringify(body, null, 2) + '\n'), out: { path: exportPath } })
  })
}

function collisions (term, imported) {
  const words = new Set([term.title, ...term.synonyms].map((w) => w.toLowerCase()))
  return imported.filter((e) => [e.term, ...(e.synonyms || [])].some((w) => w && words.has(w.toLowerCase())))
}

function collisionsHtml (clashes) {
  const items = clashes.map((e) => {
    let host = ''
    try { host = new URL(e.url).host } catch (_) {}
    const def = e.definition ? ' &#8212; ' + escapeAttr(e.definition) : ''
    return '<li><a class="glossary-term-external" href="' + escapeAttr(e.url) + '">' + escapeAttr(e.term) + '</a>' + (host ? ' <span class="glossary-collision-site">(' + escapeAttr(host) + ')</span>' : '') + def + '</li>'
  })
  return '<div class="sect1 glossary-collisions"><h2 id="_also_defined_elsewhere">Also defined on other sites</h2><div class="sectionbody"><p>This site uses its own definition. These imported glossaries define the same word:</p><ul>' + items.join('') + '</ul></div></div>'
}

async function loadImports (imports, cacheDir, logger) {
  const out = []
  for (const item of imports) {
    const url = typeof item === 'string' ? item : item && item.url
    if (!url) continue
    const file = path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json')
    let data = null
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      data = await res.json()
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(data))
    } catch (err) {
      if (fs.existsSync(file)) {
        logger.warn('glossary import ' + url + ' failed (' + err.message + '); using cached copy')
        data = JSON.parse(fs.readFileSync(file, 'utf8'))
      } else {
        logger.warn('glossary import ' + url + ' failed (' + err.message + '); skipping')
        continue
      }
    }
    for (const t of (data && data.terms) || []) {
      if (t && t.term && /^https?:\/\//.test(t.url || '')) out.push(t)
    }
  }
  return out
}

function collectTerms (files) {
  const terms = []
  for (const file of files) {
    const src = file.src || {}
    if (src.family !== 'page') continue
    const rel = src.relative || ''
    if (!rel.startsWith('glossary/') || rel.startsWith('glossary/letters/')) continue
    if (rel === 'glossary.adoc') continue
    const raw = file.contents ? file.contents.toString('utf8') : ''
    terms.push({
      module: src.module,
      relative: rel,
      stem: src.stem,
      title: titleOf(raw) || src.stem,
      synonyms: synonymsOf(raw),
      canonical: canonicalOf(raw),
      definition: definitionOf(raw),
    })
  }
  terms.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  return terms
}

function titleOf (raw) {
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('= '))
  return line ? line.slice(2).trim() : ''
}

function attributeOf (raw, name) {
  const prefix = ':' + name + ':'
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : ''
}

function synonymsOf (raw) {
  const line = attributeOf(raw, 'page-glossary-synonyms')
  if (!line) return []
  return line.split(',').map((s) => s.trim()).filter(Boolean)
}

function canonicalOf (raw) {
  return attributeOf(raw, 'page-glossary-canonical')
}

function definitionOf (raw) {
  const lines = raw.split(/\r?\n/)
  let started = false
  const buf = []
  for (const line of lines) {
    if (!started) {
      if (line.startsWith('=') || line.startsWith(':') || line.trim() === '') continue
      started = true
    }
    if (line.trim() === '') break
    buf.push(line.trim())
  }
  return buf.join(' ').replace(/\s+/g, ' ').slice(0, 240)
}

function groups (terms) {
  const map = new Map()
  for (const term of terms) {
    const ch = term.title.trim().charAt(0).toUpperCase()
    const letter = /[A-Z]/.test(ch) ? ch : '#'
    if (!map.has(letter)) map.set(letter, [])
    map.get(letter).push(term)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function indexPage (terms) {
  const lines = [
    '= Glossary',
    ':description: Letters that have glossary terms. Each letter links to its term list.',
    ':navtitle: Glossary',
    '',
    'Pick a letter to see the terms under it.',
    'Only letters that have terms are listed.',
    'A synonym uses the same page as its term.',
    'If the term names a canonical article, the letter list links there.',
    '',
  ]
  for (const [letter] of groups(terms)) {
    const slug = letter === '#' ? 'num' : letter.toLowerCase()
    lines.push('* xref:glossary/letters/' + slug + '.adoc[' + letter + ']')
  }
  lines.push('')
  return lines.join('\n')
}

function letterPage (letter, group) {
  const lines = [
    '= ' + letter,
    ':navtitle: ' + letter,
    '',
    'Terms under ' + letter + '.',
    '',
  ]
  for (const term of group) {
    const def = term.definition ? ' -- ' + term.definition : ''
    const target = term.canonical || term.relative
    const extra = term.synonyms.length ? ' (' + term.synonyms.join(', ') + ')' : ''
    lines.push('* xref:' + target + '[' + term.title + ']' + extra + def)
  }
  lines.push('')
  return lines.join('\n')
}

function addFile (versionBucket, moduleName, relative, contents) {
  const path = 'modules/' + moduleName + '/pages/' + relative
  const basename = relative.split('/').pop()
  const stem = basename.replace(/\.adoc$/, '')
  const existing = versionBucket.files.find((f) => f.src && f.src.relative === relative && f.src.module === moduleName)
  if (existing) {
    existing.contents = Buffer.from(contents)
    return
  }
  versionBucket.files.push({
    path,
    contents: Buffer.from(contents),
    src: {
      path,
      component: versionBucket.name,
      version: versionBucket.version,
      module: moduleName,
      family: 'page',
      relative,
      basename,
      stem,
      extname: '.adoc',
      mediaType: 'text/asciidoc',
    },
  })
}

function highlight (html, phrases) {
  if (!phrases.length) return html
  const parts = html.split(/(<[^>]+>)/g)
  let skip = 0
  const skipTags = /^(?:a|code|pre|script|style|kbd|samp)\b/i
  const byPhrase = new Map()
  for (const item of phrases) if (!byPhrase.has(item.phrase.toLowerCase())) byPhrase.set(item.phrase.toLowerCase(), item)
  const re = new RegExp('(?<![\\w-])(?:' + phrases.map((p) => escapeRe(p.phrase)).join('|') + ')(?![\\w-])', 'gi')
  return parts.map((part) => {
    if (part.startsWith('<')) {
      const open = /^<([a-zA-Z0-9]+)/.exec(part)
      const close = /^<\/([a-zA-Z0-9]+)/.exec(part)
      if (open && skipTags.test(open[1]) && !part.endsWith('/>')) skip++
      else if (close && skipTags.test(close[1]) && skip) skip--
      return part
    }
    if (skip || !part) return part
    return part.replace(re, (match) => {
      const item = byPhrase.get(match.toLowerCase())
      const title = item.definition ? ' title="' + escapeAttr(item.definition) + '"' : ''
      const cls = item.external ? 'glossary-term glossary-term-external' : 'glossary-term'
      return '<a class="' + cls + '" href="' + escapeAttr(item.href) + '"' + title + '>' + match + '</a>'
    })
  }).join('')
}

function canonicalMatch (canonical, page) {
  const rel = (page.src && page.src.relative) || ''
  const cleaned = canonical.replace(/^xref:/, '').replace(/\[.*$/, '').replace(/\.adoc$/, '').replace(/#.*$/, '')
  return rel === cleaned + '.adoc' || rel === cleaned
}

function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeAttr (s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

module.exports = { register, collectTerms, highlight, collisions, collisionsHtml }
