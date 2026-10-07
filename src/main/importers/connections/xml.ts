import { DOMParser, type Document, type Element } from '@xmldom/xmldom'
import { stripBom } from './util'

/**
 * Parses an XML document, throwing `message` for anything that is not
 * well-formed XML (xmldom reports fatal errors by throwing; errors and
 * warnings are collected and treated as fatal too).
 */
export function parseXml(text: string, message: string): Document {
  let failed = false
  const parser = new DOMParser({
    onError: (level) => {
      if (level !== 'warning') failed = true
    }
  })
  let doc: Document
  try {
    doc = parser.parseFromString(stripBom(text).trim(), 'text/xml')
  } catch {
    throw new Error(message)
  }
  if (failed || !doc.documentElement) throw new Error(message)
  return doc
}

/** Direct element children of `el` (optionally only those named `name`). */
export function childElements(el: Element, name?: string): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || n.nodeName === name)) out.push(n as Element)
  }
  return out
}

/** Attributes of an element keyed by lower-case name (case-tolerant lookups). */
export function attributeMap(el: Element): Map<string, string> {
  const map = new Map<string, string>()
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)
    if (a) map.set(a.name.toLowerCase(), a.value)
  }
  return map
}
