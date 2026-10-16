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
  // jev-browse: a hover-revealed target is invisible when observed and when checked, so it is guarded by identity, name
  // and row text like any other; the visibility flag keeps a target that disappeared stale.
  cache.guard = (e) => {
    if (!e?.isConnected) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [
      visible(e),
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
  // jev-browse: an unnamed checkbox is named by its row ("Select: Casa Flora"), not its value "on".
  const unnamedToggle = (e, rname) => {
    if (!['checkbox', 'radio', 'switch'].includes(rname)) return false;
    const own = name(e);
    return !own || own === e.value;
  };
  const rowContext = (e) => {
    const text = (e.closest('tr,[role="row"],li,label')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return text && 'Select: ' + text;
  };
  // jev-browse: an icon-only control is named the way a person would describe it: by the control it toggles, or by its icon.
  const styleModifier = /^fa-(?:solid|regular|light|brands|lg|xs|sm|fw|\d+x)$/;
  const iconHint = (el) => {
    const testId = (el.getAttribute('data-testid') || '').match(/^icon-(.+)$/);
    if (testId) return testId[1];
    for (const token of (el.getAttribute('class') || '').split(/\s+/)) {
      const hint = !styleModifier.test(token) && token.match(/^(?:lucide|fa|bi|mdi|icon)-(.+)$/);
      if (hint) return hint[1];
    }
    return '';
  };
  const interactive =
    'a,button,input,select,textarea,[contenteditable="true"],' +
    ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox']
      .map((role) => '[role="' + role + '"]')
      .join(',');
  const contextName = (e, hiddenInput, rname) => {
    const own = hiddenInput ? name(hiddenInput).trim() : '';
    if (own) return own;
    const controlled = e.getAttribute('aria-controls');
    if (controlled) {
      const sibling = [...document.querySelectorAll('[aria-controls="' + CSS.escape(controlled) + '"]')].find(
        (other) => other !== e && name(other).trim(),
      );
      const target = sibling ? name(sibling) : document.getElementById(controlled)?.getAttribute('aria-label');
      if (target?.trim()) return 'Toggle ' + target.replace(/\s+/g, ' ').trim();
    }
    const icon = [e, ...e.querySelectorAll('svg,i,span,img')].map(iconHint).find(Boolean);
    if (icon) return icon.replace(/-/g, ' ') + ' icon';
    // jev-browse: with no name, row or icon, a control is named by the short text right around it, as a person reads it.
    // Text inside another control (a neighbouring "Save") is skipped: it would name this one after that one.
    const textAround = (container) => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const words = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const control = node.parentElement.closest(interactive);
        const other = control && control !== e && container.contains(control);
        if (!other && node.parentElement.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          words.push(node.textContent);
      }
      return words.join(' ').replace(/\s+/g, ' ').trim();
    };
    const around = [e.parentElement, e.parentElement?.parentElement]
      .filter((container) => container && container !== document.body && container !== document.documentElement)
      .map(textAround)
      .find((text) => text && text.length <= 80);
    if (!around) return '';
    return unnamedToggle(e, rname) ? 'Select: ' + around : around;
  };
  const queried = roots.flatMap(deepQuery);
  // jev-browse: a checkbox or radio hidden with opacity or display (Grafana's quick time ranges) is chosen through its
  // visible label, so the label stands in for the input. A visible input keeps its own entry; a disabled one stays out.
  const labelOf = new Map();
  for (const input of queried) {
    if (input.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(input.type) || visible(input)) continue;
    const label = input.labels?.[0];
    if (label && !labelOf.has(label) && !input.matches(':disabled') && !input.closest('[aria-disabled="true"],[inert]'))
      labelOf.set(label, input);
  }
  const candidates = [...queried, ...popupItems, ...labelOf.keys()];
  const eligible = (e) => safe(e) && visible(e) && !e.matches(':disabled') && !e.closest('[aria-disabled="true"]');
  const outOfView = (r) => {
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    return r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight;
  };
  // jev-browse: a control shown only while its container is hovered (a panel's menu, a row's Delete) is in the DOM with
  // visibility:hidden or opacity:0. It is listed as "appears on hover", capped at 20, and the executor moves the pointer
  // onto it before the click. display:none is not laid out and touch screens have no hover, so neither counts.
  const canHover = !matchMedia('(hover: none)').matches;
  const hoverSuffix = ' (appears on hover)';
  const standIns = new Set(labelOf.values());
  let hoverListed = 0;
  const hiddenUntilHover = (e) => {
    if (getComputedStyle(e).visibility === 'hidden') return true;
    for (let p = e, depth = 0; p && depth <= 3; p = p.parentElement, depth++)
      if (getComputedStyle(p).opacity === '0') return true;
    return false;
  };
  const revealedByHover = (e) =>
    canHover &&
    hoverListed < 20 &&
    !standIns.has(e) &&
    safe(e) &&
    !e.closest('[aria-hidden="true"],[inert],[aria-disabled="true"]') &&
    !e.matches(':disabled') &&
    hiddenUntilHover(e) &&
    !outOfView(e.getBoundingClientRect()) &&
    Boolean(role(e)) &&
    name(e).trim() !== '';
  // jev-browse: an off-screen link, button or row holding a value the caller supplied is likely the target, but
  // only when nothing on screen holds it, and at most 5 are listed: a common value ("ERROR") would flood the list.
  const holdsWanted = (e, rname) =>
    ['link', 'button', 'row'].includes(rname) && wanted.some((w) => (e.innerText || '').toLowerCase().includes(w));
  const wantedOnscreen =
    wanted.length > 0 &&
    candidates.some((e) => eligible(e) && !outOfView(cache.clickRect(e)) && holdsWanted(e, role(e)));
  let wantedListed = 0;
  // jev-browse: a link or button in an on-screen table row, scrolled sideways out of view inside the table's scroll box, is
  // still a choice: a person swipes the table to reach it, and clicking scrolls it in. At most 2 per row and 20 in all.
  const rowLinksListed = new Map();
  let sidewaysListed = 0;
  const sidewaysRowOf = (e, rname) => {
    const row = ['link', 'button'].includes(rname) && sidewaysListed < 20 ? e.closest('tr,[role="row"]') : null;
    if (!row || (rowLinksListed.get(row) || 0) >= 2 || e.getBoundingClientRect().width <= 0) return null;
    const rowBox = row.getBoundingClientRect(),
      rowY = rowBox.y + rowBox.height / 2;
    if (rowY < 0 || rowY >= innerHeight) return null;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement)
      if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth) return row;
    return null;
  };
  for (const e of candidates) {
    const shown = eligible(e);
    const hover = !shown && revealedByHover(e);
    if (!shown && !hover) continue;
    const hiddenInput = labelOf.get(e),
      r = cache.clickRect(e),
      y = r.y + r.height / 2,
      rname = hiddenInput ? hiddenInput.type : role(e);
    // jev-browse: a sortable header scrolled sideways out of its table is still a choice; clicking scrolls it in.
    const sideways = rname === 'columnheader' && y >= 0 && y < innerHeight && e.getBoundingClientRect().width > 0;
    const offscreen = outOfView(r);
    const wantedOffscreen = offscreen && !wantedOnscreen && wantedListed < 5 && holdsWanted(e, rname);
    if (wantedOffscreen) wantedListed++;
    const sidewaysRow = rname && offscreen && !wantedOffscreen ? sidewaysRowOf(e, rname) : null;
    if (!rname || (offscreen && !sideways && !wantedOffscreen && !sidewaysRow)) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    if (sidewaysRow) {
      sidewaysListed++;
      rowLinksListed.set(sidewaysRow, (rowLinksListed.get(sidewaysRow) || 0) + 1);
    }
    if (hover) hoverListed++;
    const suffix = hover ? hoverSuffix : '';
    const base = {
      node: identity(e),
      role: rname,
      // jev-browse: a row is what it shows; its name would also pull in nested controls ("Select row"). Labels are
      // capped: table rows holding whole JSON payloads otherwise blow the request past the model's token limit.
      label:
        cap(
          ((rname === 'row' || hiddenInput
            ? e.innerText.replace(/\s+/g, ' ').trim()
            : unnamedToggle(e, rname)
              ? rowContext(e)
              : name(e).replace(/\s+/g, ' ').trim()) ||
            contextName(e, hiddenInput, rname) ||
            rname) + (sidewaysRow ? ' — row: ' + sidewaysRow.innerText.replace(/\s+/g, ' ').trim() : ''),
          200 - suffix.length,
        ) + suffix,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
    if (hover) base.hover = true;
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    const toggle = hiddenInput ?? e;
    if (['checkbox', 'radio'].includes(toggle.type)) base.checked = String(toggle.checked);
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
  // jev-browse: controls sharing a role and label (a product grid's "Add to cart" buttons) are told apart by the card or
  // row each sits in, as a person reads the page: "Add to cart — Sauce Labs Bike Light". Only colliding labels change;
  // a nameless control (its label is its bare role) has nothing to share, and members whose cards read the same stay as is.
  const squash = (text) => text.replace(/\s+/g, ' ').trim();
  const bareLabel = (a) => (a.hover ? a.label.slice(0, -hoverSuffix.length) : a.label);
  const alone = (list, value) => list.indexOf(value) === list.lastIndexOf(value);
  // The biggest ancestor (up to 4 levels) holding this control and none of the other members: its card or row.
  const cardOf = (e, members) => {
    let card = null;
    for (let p = e.parentElement, depth = 0; p && p !== document.body && depth < 4; p = p.parentElement, depth++) {
      if (members.some((other) => other !== e && p.contains(other))) break;
      card = p;
    }
    return card;
  };
  // Ways to read a card, best first: its heading, a short link (a product name), then its own text outside controls.
  const headings = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const apart = (members) => (el) => visible(el) && !members.some((m) => m.contains(el) || el.contains(m));
  const cardReadings = [
    (card, members) => [...card.querySelectorAll(headings)].filter(apart(members)).map((h) => squash(h.innerText)),
    (card, members) =>
      [...card.querySelectorAll('a[href]')]
        .filter(apart(members))
        .map((a) => squash(a.innerText))
        .filter((text) => text.length <= 60),
    (card, members) => {
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      const words = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement,
          control = parent.closest(interactive);
        if ((control && card.contains(control)) || members.some((m) => m.contains(parent))) continue;
        if (!parent.closest('script,style,noscript,template') && visible(parent)) words.push(node.textContent);
      }
      return [squash(words.join(' '))];
    },
  ];
  const sharedLabels = new Map();
  for (const a of actions) {
    const label = bareLabel(a);
    if (label === a.role || label === 'Open ' + a.role) continue;
    const key = a.role + '\0' + label;
    sharedLabels.set(key, [...(sharedLabels.get(key) || []), a]);
  }
  for (const group of sharedLabels.values()) {
    const members = [...new Set(group.map((a) => cache.nodes.get(a.node)))];
    if (members.length < 2) continue;
    const shared = bareLabel(group[0]).toLowerCase();
    const cards = members.map((e) => cardOf(e, members));
    // The first reading that tells the most members apart wins; a context already in the label adds nothing. Repeated
    // cards all read as something: if one member's card says nothing, the members share a card (two links to one
    // page) and a context from the other's surroundings would mislead.
    let best = { contexts: [], count: 0 };
    for (const read of cardReadings) {
      const contexts = cards.map((card) => {
        const context = card ? cap(read(card, members).find(Boolean) || '', 60) : '';
        return shared.includes(context.toLowerCase()) ? '' : context;
      });
      if (!contexts.every(Boolean)) continue;
      const count = contexts.filter((context) => context && alone(contexts, context)).length;
      if (count > best.count) best = { contexts, count };
      if (count === members.length) break;
    }
    for (const a of group) {
      const context = best.contexts[members.indexOf(cache.nodes.get(a.node))];
      if (!context || !alone(best.contexts, context)) continue;
      const suffix = a.hover ? hoverSuffix : '';
      a.label = cap(bareLabel(a), 200 - suffix.length - context.length - 3) + ' — ' + context + suffix;
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
