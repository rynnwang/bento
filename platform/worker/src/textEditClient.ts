// Owner-only "Edit text" control for the html/md deck wrapper (index.ts's
// htmlDeckWrapper). The wrapper page is same-origin with its sandboxed deck
// iframe (allow-same-origin), so this script can reach into the deck's document,
// mark ONE leaf text element editable at a time, and PATCH the result to
// /api/decks/:id/text — where textedit.ts re-validates everything. The client
// side here is convenience and UX (only offer sane targets, strip junk the
// browser's editor adds); the server is the authority on what may change.
//
// Written with String.raw so the script's own backslashes survive; keep it free
// of backticks and dollar-brace sequences.

export const TEXT_EDIT_CSS = String.raw`
#bento-edit-btn{position:fixed;top:14px;right:150px;z-index:10;padding:8px 14px;border:1px solid rgb(255 255 255 / 0.25);
  border-radius:999px;background:rgb(13 27 46 / 0.55);backdrop-filter:blur(6px);color:#fff;font:13px/1 -apple-system,
  BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;cursor:pointer}
#bento-edit-btn:hover{background:rgb(13 27 46 / 0.8)}
#bento-edit-btn[aria-pressed="true"]{background:#ED8266;border-color:#ED8266}
#bento-edit-hint,#bento-edit-toast{position:fixed;left:50%;transform:translateX(-50%);z-index:11;padding:8px 14px;border-radius:10px;
  font:13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#fff;background:rgb(13 27 46 / 0.92);
  box-shadow:0 4px 16px rgb(0 0 0 / .3);pointer-events:none}
#bento-edit-hint{bottom:18px}
#bento-edit-toast{bottom:74px;transition:opacity .3s}
#bento-edit-toast.err{background:#b3372b}
`

export const TEXT_EDIT_SCRIPT = String.raw`
(function () {
  var frame = document.getElementById('bento-html-frame')
  var toggle = document.getElementById('bento-edit-btn')
  if (!frame || !toggle) return
  var deckId = toggle.getAttribute('data-id')
  var version = Number(toggle.getAttribute('data-v')) || null
  var on = false
  var editing = null
  var saveChain = Promise.resolve()
  var hot = null

  var EDITABLE = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, TD: 1, TH: 1, DT: 1, DD: 1, FIGCAPTION: 1, CAPTION: 1, SUMMARY: 1, BLOCKQUOTE: 1, DIV: 1, SPAN: 1 }
  var INLINE = { A: 1, ABBR: 1, B: 1, BR: 1, CITE: 1, CODE: 1, DEL: 1, EM: 1, I: 1, KBD: 1, MARK: 1, Q: 1, S: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1, WBR: 1 }
  var FORMAT = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, DEL: 1, BR: 1 }

  var hint = document.createElement('div')
  hint.id = 'bento-edit-hint'
  hint.textContent = 'Editing text — Ctrl/⌘+B bold · Ctrl/⌘+I italic · Shift+Enter line break · Esc cancel · click away to save'
  hint.hidden = true
  document.body.appendChild(hint)
  var toastEl = document.createElement('div')
  toastEl.id = 'bento-edit-toast'
  toastEl.hidden = true
  document.body.appendChild(toastEl)
  var toastTimer = 0
  function toast(msg, isErr) {
    toastEl.textContent = msg
    toastEl.className = isErr ? 'err' : ''
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.hidden = true }, isErr ? 6000 : 1500)
  }

  function doc() { return frame.contentDocument }
  function norm(s) { return s.replace(/[\s ]+/g, ' ').trim() }
  function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;') }
  function escAttr(t) { return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }
  function sig(n) {
    var a = []
    for (var i = 0; i < n.attributes.length; i++) a.push([n.attributes[i].name, n.attributes[i].value])
    a.sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0 })
    return n.tagName.toLowerCase() + '|' + a.map(function (p) { return p[0] + '=' + p[1] }).join('&')
  }

  function eligible(el) {
    if (!el || el.nodeType !== 1 || !EDITABLE[el.tagName]) return false
    if (el.isContentEditable) return false
    if (!norm(el.textContent || '')) return false
    var all = el.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) if (!INLINE[all[i].tagName]) return false
    return true
  }
  // the deepest eligible element at or above the event target
  function pick(node) {
    var d = doc()
    var n = node
    while (n && n.nodeType !== 1) n = n.parentNode
    for (; n && n !== d.body && n !== d.documentElement; n = n.parentElement) if (eligible(n)) return n
    return null
  }

  // browser-added junk out, allowed formatting + pre-existing inline elements kept
  function ser(nodes, known) {
    var out = ''
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n.nodeType === 3) { out += esc(n.nodeValue); continue }
      if (n.nodeType !== 1) continue
      if (n.tagName === 'BR') { out += '<br>'; continue }
      var tag = n.tagName.toLowerCase()
      var keep = known[sig(n)] || (FORMAT[n.tagName] && n.attributes.length === 0)
      var inner = ser(n.childNodes, known)
      if (!keep) { out += inner; continue }
      var attrs = ''
      for (var j = 0; j < n.attributes.length; j++) attrs += ' ' + n.attributes[j].name + '="' + escAttr(n.attributes[j].value) + '"'
      out += '<' + tag + attrs + '>' + inner + '</' + tag + '>'
    }
    return out
  }

  function startEdit(el) {
    if (!el || editing) return
    var d = doc()
    var tag = el.tagName.toLowerCase()
    var old = norm(el.textContent)
    var same = [].slice.call(d.getElementsByTagName(tag)).filter(function (x) { return norm(x.textContent) === old })
    var known = {}
    var kids = el.querySelectorAll('*')
    for (var i = 0; i < kids.length; i++) known[sig(kids[i])] = 1
    editing = { el: el, tag: tag, old: old, nth: same.indexOf(el), html: el.innerHTML, known: known }
    clearHot()
    el.setAttribute('contenteditable', 'true')
    el.setAttribute('data-bento-editing', '')
    try { d.execCommand('styleWithCSS', false, false) } catch (e) {}
    el.focus()
    el.addEventListener('keydown', onKey)
    el.addEventListener('paste', onPaste)
    el.addEventListener('drop', stop)
    el.addEventListener('beforeinput', onBefore)
    el.addEventListener('blur', onBlur)
    hint.hidden = false
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(false); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) { finish(true); return }
      doc().execCommand('insertLineBreak')
    }
  }
  function onPaste(e) {
    e.preventDefault()
    var t = ((e.clipboardData || window.clipboardData).getData('text/plain') || '').replace(/\s*[\r\n]+\s*/g, ' ')
    doc().execCommand('insertText', false, t)
  }
  function onBefore(e) { if (e.inputType === 'insertParagraph') e.preventDefault() }
  function onBlur() { setTimeout(function () { if (editing) finish(true) }, 0) }
  function stop(e) { e.preventDefault() }

  function finish(save) {
    var e = editing
    if (!e) return
    editing = null
    var el = e.el
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('paste', onPaste)
    el.removeEventListener('drop', stop)
    el.removeEventListener('beforeinput', onBefore)
    el.removeEventListener('blur', onBlur)
    el.removeAttribute('contenteditable')
    el.removeAttribute('data-bento-editing')
    hint.hidden = true
    if (!save || el.innerHTML === e.html) { el.innerHTML = e.html; return }
    var html = ser(el.childNodes, e.known)
    while (html.slice(-4) === '<br>') html = html.slice(0, -4)
    var probe = doc().createElement('div')
    probe.innerHTML = html
    if (!norm(probe.textContent || '')) { el.innerHTML = e.html; toast("Text can't be empty", true); return }
    el.innerHTML = html
    saveChain = saveChain.then(function () {
      return fetch('/api/decks/' + deckId + '/text', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: e.tag, oldText: e.old, nth: e.nth, html: html, baseUpdatedAt: version }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
        .then(function (r) {
          if (r.ok) { if (r.j.updatedAt) version = r.j.updatedAt; toast('Saved') }
          else { el.innerHTML = e.html; toast(r.j.error || 'Could not save that edit', true) }
        })
        .catch(function () { el.innerHTML = e.html; toast('Could not save that edit', true) })
    })
  }

  // ---- edit mode: hover outline + double-click to edit
  var STYLE_ID = 'bento-edit-style'
  function clearHot() { if (hot) { hot.removeAttribute('data-bento-hot'); hot = null } }
  function onOver(e) {
    if (editing) return
    var t = pick(e.target)
    if (t === hot) return
    clearHot()
    if (t) { hot = t; t.setAttribute('data-bento-hot', '') }
  }
  function onDbl(e) {
    if (editing) return
    var t = pick(e.target)
    if (!t) { toast("That element isn't plain text, so it can't be edited here", true); return }
    e.preventDefault()
    e.stopPropagation()
    startEdit(t)
  }
  function onClick(e) {
    // links keep their text editable: don't navigate while editing is on
    var t = e.target
    while (t && t.nodeType === 1 && t.tagName !== 'A') t = t.parentElement
    if (t && t.tagName === 'A') e.preventDefault()
  }

  function enable() {
    var d = doc()
    if (!d || !d.body) { toast('The page is still loading', true); return false }
    var st = d.createElement('style')
    st.id = STYLE_ID
    st.textContent = '[data-bento-hot]{outline:2px dashed #ED8266!important;outline-offset:2px;cursor:text!important}' +
      '[data-bento-editing]{outline:2px solid #ED8266!important;outline-offset:2px;cursor:text!important;-webkit-user-select:text!important;user-select:text!important}'
    d.head.appendChild(st)
    d.addEventListener('mouseover', onOver, true)
    d.addEventListener('dblclick', onDbl, true)
    d.addEventListener('click', onClick, true)
    return true
  }
  function disable() {
    if (editing) finish(true)
    var d = doc()
    clearHot()
    if (!d) return
    d.removeEventListener('mouseover', onOver, true)
    d.removeEventListener('dblclick', onDbl, true)
    d.removeEventListener('click', onClick, true)
    var st = d.getElementById(STYLE_ID)
    if (st) st.remove()
  }

  toggle.addEventListener('click', function () {
    if (!on) {
      if (!enable()) return
      on = true
      toast('Double-click a piece of text to edit it')
    } else {
      disable()
      on = false
    }
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
    toggle.textContent = on ? '✓ Done editing' : '✎ Edit text'
  })
})()
`
