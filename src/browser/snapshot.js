(() => {
  if (!document.body) return null;
  const cache = (window.__jevFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const cap = (text, max = 200) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // jev-browse: an element whose centre is off-screen (a table row wider than its scroll box) is clicked at the
  // centre of the part the viewport and its scroll containers leave visible. Everything else keeps its own rect.
  cache.clickRect = (e) => {
    const r = e.getBoundingClientRect();
    const cx = r.x + r.width / 2,
      cy = r.y + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) return r;
    let left = Math.max(r.left, 0),
      top = Math.max(r.top, 0),
      right = Math.min(r.right, innerWidth),
      bottom = Math.min(r.bottom, innerHeight);
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflow === 'visible') continue;
      const c = p.getBoundingClientRect();
      left = Math.max(left, c.left);
      top = Math.max(top, c.top);
      right = Math.min(right, c.right);
      bottom = Math.min(bottom, c.bottom);
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter(Boolean)
      .join(' ');
    return (
      referenced ||
      e.getAttribute('aria-label') ||
      [...(e.labels || [])]
        .map((l) => name(l, seen))
        .filter(Boolean)
        .join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
      e.getAttribute('alt') ||
      (e.tagName === 'INPUT'
        ? ''
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true'
                  ? name(n, seen)
                  : '',
            )
            .join(' ')
            .trim()) ||
      e.getAttribute('title') ||
      e.getAttribute('placeholder') ||
      ''
    );
  };
  const roles = [
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemradio',
    'option',
    'gridcell',
    'combobox',
    'textbox',
    'searchbox',
    'spinbutton',
  ];
  // jev-browse: clickable rows and tabbable custom controls (React tables, cards) count when they show a pointer.
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],tr,th,[role="columnheader"],[tabindex="0"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const pointer = (e) => getComputedStyle(e).cursor === 'pointer';
  const role = (e) => {
    if (popupItems.has(e)) return 'option';
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'TR') return pointer(e) && !e.querySelector('th') ? 'row' : null;
    // jev-browse: sortable column headers (a pointer or aria-sort); a select-all checkbox header is not one.
    if (e.tagName === 'TH' || explicit === 'columnheader') {
      const sortable = pointer(e) || e.hasAttribute('aria-sort');
      return sortable && !e.querySelector('input,select') ? 'columnheader' : null;
    }
    if (e.getAttribute('tabindex') === '0' && !explicit && !['INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(e.tagName)) {
      return pointer(e) ? 'button' : null;
    }
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey = () => [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    [...document.querySelectorAll('input,textarea,select')]
      .filter(safe)
      .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly]),
  ];
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [
      identity(e),
      role(e),
      name(e),
      e.value ?? null,
      e.checked ?? null,
      e.selectedIndex ?? null,
      e.readOnly ?? null,
      e.matches(':disabled'),
      e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),
      e.getAttribute('aria-checked'),
      e.getAttribute('aria-selected'),
      e.getAttribute('href'),
      scope?.innerText?.slice(0, 6000) || '',
    ];
  };
  // jev-browse: when modals are open, only their content is reachable, so read controls and text inside them.
  // Sites often split one sheet into several modal layers (header + panel), so read all outermost ones.
  const modals = [...document.querySelectorAll('[aria-modal="true"],dialog')].filter(
    (m) => (m.tagName !== 'DIALOG' || m.matches(':modal')) && visible(m) && m.getBoundingClientRect().width > 0,
  );
  const roots = modals.length ? modals.filter((m) => !modals.some((o) => o !== m && o.contains(m))) : [document.body];
  const actions = [];
  // jev-browse: controls inside open shadow roots (web components such as MDN's search button) count too.
  const deepQuery = (root) => [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll('*')].filter((host) => host.shadowRoot).flatMap((host) => deepQuery(host.shadowRoot)),
  ];
  // jev-browse: open popups (date pickers, custom menus) often build their items from plain pointer-cursor divs:
  // the outermost pointer element with text and no control inside counts as an option.
  const wanted = Array.isArray(window.__jevWanted) ? window.__jevWanted : [];
  const popupItems = new Set();
  const popupSelector = '[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';
  for (const popup of roots.flatMap((root) => [...root.querySelectorAll(popupSelector)])) {
    if (!visible(popup)) continue;
    for (const e of popup.querySelectorAll('div,span,li,p')) {
      const outermost = !e.parentElement || !pointer(e.parentElement);
      if (pointer(e) && outermost && !e.closest(selector) && !e.querySelector(selector) && e.innerText.trim()) popupItems.add(e);
    }
  }
  for (const e of [...roots.flatMap(deepQuery), ...popupItems]) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = cache.clickRect(e),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2,
      rname = role(e);
    // jev-browse: a sortable header scrolled sideways out of its table is still a choice; clicking scrolls it in.
    const sideways = rname === 'columnheader' && y >= 0 && y < innerHeight && e.getBoundingClientRect().width > 0;
    const offscreen = r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight;
    // jev-browse: an off-screen link, button or row holding a value the caller supplied is likely the target.
    const wantedOffscreen =
      offscreen &&
      wanted.length > 0 &&
      ['link', 'button', 'row'].includes(rname) &&
      wanted.some((w) => (e.innerText || '').toLowerCase().includes(w));
    if (!rname || (offscreen && !sideways && !wantedOffscreen)) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = {
      node: identity(e),
      role: rname,
      // jev-browse: a row is what it shows; its name would also pull in nested controls ("Select row"). Labels are
      // capped: table rows holding whole JSON payloads otherwise blow the request past the model's token limit.
      label: cap((rname === 'row' ? e.innerText.replace(/\s+/g, ' ').trim() : name(e).replace(/\s+/g, ' ').trim()) || rname),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      for (const o of e.options)
        if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
          actions.push({
            ...base,
            kind: 'select',
            value: o.value,
            current_value: [...e.selectedOptions].map((o) => o.label).join(', '),
            label: base.label + ' → ' + o.label,
          });
    } else {
      const editable =
        !e.readOnly &&
        e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          // jev-browse: a contenteditable combobox is a search bar too (Langfuse's trace search).
          (rname === 'combobox' && (['INPUT', 'TEXTAREA'].includes(e.tagName) || e.isContentEditable)));
      const value =
        'value' in e ? String(e.value) : e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
    }
  }
  const words = [];
  const range = document.createRange();
  let node,
    length = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode()) && length < 6000) {
      const value = node.textContent.trim(),
        parent = node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(value);
        length += value.length;
      }
    }
  }
  const text = words.join('\n').slice(0, 6000),
    height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(),
    guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics = actions.map(({ rect, ...action }) => action);
  const marker = [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    document.title,
    text,
    semantics,
    page_key[6],
  ];
  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => (a.id = 'e' + (i + 1)));
  if (scrollY + innerHeight < height - 2)
    actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return {
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    text,
    scroll: { y: scrollY, height },
    actions,
    marker,
    page_key,
    guards,
    omitted_actions,
  };
})();
