/**
 * Stoatworks Labs — support footer.
 *
 * One in-flow footer, appended to the end of <body>, saying the same thing on
 * every hosted web app: the tool is free, it comes from Stoatworks Labs, and
 * there are four ways to fund the work.
 *
 * This file is the MASTER. It is vendored into each hosted app by
 * scripts/sync-support-footer.sh — edit it HERE and re-run the sync, or the
 * copies drift and the apps start making slightly different promises.
 *
 * Why a script rather than markup pasted into nine templates:
 *   - The apps are a React SPA (blend-calc, pixel-peeker, RFutils), a
 *     hand-written landing page (pmse-to-wwb) and four recorded demos whose
 *     HTML is a committed build artefact. There is no shared template.
 *   - One file means the wording and the funding links have exactly one
 *     definition. A copy-pasted footer is four dead links waiting to happen.
 *
 * Why plain classic script and not a module:
 *   `document.currentScript` is null in a module, and the per-app config below
 *   is read off the tag. Load it deferred, so <body> exists when it runs:
 *
 *     <script src="/support-footer.js" defer
 *             data-app="Pixel Peeker"
 *             data-repo="https://github.com/stoatworks-labs/pixel-peeker"></script>
 *
 * Config, all optional:
 *   data-app   Name of the app, bolded in the first line. Defaults to <title>.
 *   data-repo  Source URL. Omit and the "source" link is left out rather than
 *              pointed somewhere plausible-but-wrong.
 *   data-note  One extra sentence, app-specific, shown under the lead. Used for
 *              things only true of some apps ("nothing leaves your browser").
 *
 * Styling: the footer deliberately has no colours of its own. It inherits the
 * page's background and text colour and draws its rules and chips from
 * `currentColor`, so it lands correctly on the dark apps (blend-calc,
 * pixel-peeker, RFutils) and the light ones (flock, pmse-to-wwb in light mode)
 * without either being told which it is. An app that wants its accent on the
 * links sets `--sw-support-accent` in its own stylesheet.
 */
(() => {
  const script = document.currentScript;

  /**
   * The canonical set, matching stoatworks-backend/funding/FUNDING.yml and the
   * website's src/data/site.json. GitHub Sponsors is first because it is the
   * preferred route — it takes no extra account for anyone already signed in to
   * GitHub, which is everyone arriving from a repo link.
   */
  const FUNDING = [
    { name: 'GitHub Sponsors', url: 'https://github.com/sponsors/stoatworks-labs' },
    { name: 'Ko-fi', url: 'https://ko-fi.com/stoatworkslabs' },
    { name: 'Patreon', url: 'https://patreon.com/StoatworksLabs' },
    { name: 'Liberapay', url: 'https://liberapay.com/stoatworks-labs' },
  ];

  const HOME = 'https://stoatworks-labs.com';

  /** The same endpoint behind the website's /feedback form. Reports land as issues in
   *  a PRIVATE triage repo, never on a public project repo — see stoatworks-backend's
   *  intake/src/index.js, where that premise is spelled out. */
  const INTAKE = 'https://intake.stoatworks-labs.com/feedback';
  const FEEDBACK_PAGE = HOME + '/feedback/';
  const ZONE = 'stoatworks-labs.com';

  /** How many of the page's own errors to keep for the "recent errors" tick-box. Ten is
   *  enough to show a repeating failure without turning the report into a log dump. */
  const MAX_ERRORS = 10;

  const CSS = `
.sw-support {
  --sw-rule: color-mix(in srgb, currentColor 14%, transparent);
  --sw-chip: color-mix(in srgb, currentColor 8%, transparent);
  --sw-chip-hover: color-mix(in srgb, currentColor 16%, transparent);
  box-sizing: border-box;
  margin-top: 2.5rem;
  border-top: 1px solid var(--sw-rule);
  padding: 1.25rem 1.25rem 1.6rem;
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* Inherits the page's own colours; only the emphasis is dialled down. */
  opacity: 0.92;
}
/* Deliberately one column, chips under the text, at every width. A two-column
   "text left / chips right" version only actually fits in a narrow band of
   viewport widths — four chips need ~28rem beside 46rem of prose — so it spent
   most of its life wrapping into this layout anyway, just less predictably.

   There used to be a .sw-support__inner rule here describing a wrapper that
   build() never created, so it styled nothing on any of the twenty apps that
   vendor this file. It is gone rather than made real: an app with a max-width
   layout constrains .sw-support from its own stylesheet, and a second
   max-width inside that one would fight it.
   (No backticks in this block: it is inside the CSS template literal, and one
   closes it.) */
.sw-support > * { margin: 0; }
.sw-support > * + * { margin-top: 0.75rem; }

/* The funding chips and the feedback button share a line while there is room for
   both, and the button wraps as a whole when there is not. It used to be a block
   sibling after the chips, so it always started a new line — one lone pill under
   four, with the rest of the footer's width empty beside it, which reads as a
   layout accident rather than a choice. The column gap is deliberately much wider
   than the gap between the chips: on one line these are two different offers, and
   the spacing is what says so. */
.sw-support__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.75rem;
}
.sw-support__say { margin: 0; max-width: 46rem; }
.sw-support__say p { margin: 0 0 0.25rem; }
.sw-support__say p:last-child { margin-bottom: 0; }
.sw-support__note { opacity: 0.75; }
.sw-support__ask { opacity: 0.75; }
.sw-support a { color: var(--sw-support-accent, inherit); }
.sw-support__say a { text-decoration: underline; text-underline-offset: 2px; }

.sw-support__links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.sw-support__links a {
  display: inline-block;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--sw-rule);
  border-radius: 999px;
  background: var(--sw-chip);
  text-decoration: none;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.sw-support__links a:hover,
.sw-support__links a:focus-visible {
  background: var(--sw-chip-hover);
  border-color: color-mix(in srgb, currentColor 30%, transparent);
}

@media print { .sw-support { display: none; } }

/* --- Feedback -------------------------------------------------------------- */

.sw-support__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.9rem;
  align-items: baseline;
}
.sw-fb-open {
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--sw-rule);
  border-radius: 999px;
  background: none;
  transition: background 0.15s, border-color 0.15s;
}
.sw-fb-open:hover,
.sw-fb-open:focus-visible {
  background: var(--sw-chip-hover);
  border-color: color-mix(in srgb, currentColor 30%, transparent);
}

/* The dialog is a child of <body>, not of the footer, so it inherits none of the
   footer's custom properties and has to restate them. Its background and text colour
   are read off the page at open time rather than hard-coded: these apps are a mix of
   dark and light, several with their own theme switch, and a modal is the one part
   that cannot be transparent and inherit its way out of the problem. */
.sw-fb {
  --sw-rule: color-mix(in srgb, currentColor 14%, transparent);
  --sw-chip: color-mix(in srgb, currentColor 8%, transparent);
  --sw-chip-hover: color-mix(in srgb, currentColor 16%, transparent);
  box-sizing: border-box;
  width: min(40rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  padding: 0;
  border: 1px solid var(--sw-rule);
  border-radius: 10px;
  background: var(--sw-fb-bg, Canvas);
  color: var(--sw-fb-fg, CanvasText);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
.sw-fb::backdrop { background: rgba(0, 0, 0, 0.55); }
.sw-fb__form {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 2rem);
}
.sw-fb__head {
  padding: 1rem 1.1rem 0.75rem;
  border-bottom: 1px solid var(--sw-rule);
}
.sw-fb__head h2 { margin: 0 0 0.3rem; font-size: 1.05rem; }
.sw-fb__head p { margin: 0; opacity: 0.75; }
.sw-fb__body {
  padding: 1rem 1.1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.sw-fb__foot {
  padding: 0.85rem 1.1rem;
  border-top: 1px solid var(--sw-rule);
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.sw-fb__foot .sw-fb__note { margin: 0; flex: 1 1 12rem; opacity: 0.7; font-size: 0.92em; }

.sw-fb__field { display: flex; flex-direction: column; gap: 0.3rem; margin: 0; }
.sw-fb__field > label { font-weight: 600; }
.sw-fb__hint { opacity: 0.7; font-size: 0.92em; }
.sw-fb input[type="text"],
.sw-fb input[type="email"],
.sw-fb select,
.sw-fb textarea {
  font: inherit;
  color: inherit;
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--sw-rule);
  border-radius: 6px;
  background: var(--sw-chip);
}
.sw-fb textarea { resize: vertical; min-height: 5.5rem; }
.sw-fb :is(input, select, textarea):focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
}
.sw-fb [aria-invalid="true"] { border-color: #d2483f; }
.sw-fb__err { color: #d2483f; font-size: 0.92em; }

.sw-fb__diag { border: 1px solid var(--sw-rule); border-radius: 8px; padding: 0.6rem 0.7rem; }
.sw-fb__diag > summary { cursor: pointer; font-weight: 600; }
.sw-fb__diag ul { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.sw-fb__diag li { display: flex; flex-direction: column; gap: 0.15rem; }
.sw-fb__check { display: flex; gap: 0.45rem; align-items: baseline; cursor: pointer; }
.sw-fb__check input { margin: 0; }
/* The value is shown in full, always. A tick-box whose contents you cannot read is
   not a choice, and several of these tools promise that nothing leaves the browser. */
.sw-fb__value {
  margin: 0 0 0 1.4rem;
  padding: 0.35rem 0.5rem;
  border-radius: 5px;
  background: var(--sw-chip);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 8rem;
  overflow-y: auto;
  opacity: 0.85;
}

.sw-fb__btn {
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding: 0.4rem 0.9rem;
  border: 1px solid var(--sw-rule);
  border-radius: 6px;
  background: var(--sw-chip);
}
.sw-fb__btn:hover:not(:disabled),
.sw-fb__btn:focus-visible { background: var(--sw-chip-hover); }
.sw-fb__btn:disabled { opacity: 0.5; cursor: default; }
.sw-fb__btn--go { border-color: color-mix(in srgb, currentColor 38%, transparent); font-weight: 600; }

.sw-fb__status { margin: 0; padding: 0.5rem 0.6rem; border-radius: 6px; background: var(--sw-chip); }
.sw-fb__status[data-state="err"] { color: #d2483f; }

.sw-fb__hp {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
`;

  function build() {
    if (document.querySelector('.sw-support')) return;

    const app = script?.dataset.app || document.title || 'This tool';
    const repo = script?.dataset.repo || '';
    const note = script?.dataset.note || '';
    const version = script?.dataset.version || '';
    const project = script?.dataset.project || repoName(repo);
    // data-feedback="off" for the rare page that should not carry the button. Opt-out
    // rather than opt-in, so a newly wired app gets it without anyone remembering to.
    const wantsFeedback = script?.dataset.feedback !== 'off';

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const footer = document.createElement('footer');
    footer.className = 'sw-support';
    // Not role="contentinfo": several of these apps already have a <footer> or a
    // landmark of their own, and two contentinfo landmarks in one document is
    // worse for a screen reader than none.
    footer.setAttribute('aria-label', 'About and support');

    const say = document.createElement('div');
    say.className = 'sw-support__say';

    const lead = document.createElement('p');
    const name = document.createElement('strong');
    name.textContent = app;
    lead.append(name, ' is free to use, from ');
    lead.append(link(HOME, 'Stoatworks Labs'));
    lead.append(repo ? ' — open source, and the ' : ' — open source.');
    if (repo) lead.append(link(repo, 'source is on GitHub'), '.');
    say.appendChild(lead);

    if (note) {
      const p = document.createElement('p');
      p.className = 'sw-support__note';
      p.textContent = note;
      say.appendChild(p);
    }

    const ask = document.createElement('p');
    ask.className = 'sw-support__ask';
    ask.textContent = "If it's useful to you, supporting the work keeps it coming.";
    say.appendChild(ask);

    const list = document.createElement('ul');
    list.className = 'sw-support__links';
    for (const f of FUNDING) {
      const li = document.createElement('li');
      li.appendChild(link(f.url, f.name));
      list.appendChild(li);
    }

    // The chips and the feedback button go in one row rather than straight onto
    // the footer, so they can share a line. An app whose stylesheet reaches into
    // these class names — arraycad does — sees `say` and this row as the footer's
    // two children.
    const row = document.createElement('div');
    row.className = 'sw-support__row';
    row.appendChild(list);
    if (wantsFeedback) row.appendChild(feedbackRow({ app, repo, project, version }));
    footer.append(say, row);
    document.body.appendChild(footer);
    clearDemoBanner(footer);
  }

  /**
   * The four recorded demos carry the demo shim's banner: fixed to the bottom
   * edge of the viewport, and never optional, because a demo must not be
   * mistakable for live equipment.
   *
   * The shim reserves room for it with `body { padding-bottom }`. That is right
   * for an app that ends where the body ends, but this footer is the body's last
   * child — so scrolled to the bottom, the banner lands on top of the funding
   * chips, which are the one part of the footer that has to be clickable.
   *
   * Rather than have two scripts fight over the same body padding, the footer
   * carries the banner's height as its own bottom padding. Watched, not measured
   * once: the banner appears only after the shim's fixtures have loaded, which is
   * well after this runs, and it grows a second line whenever a write is
   * attempted.
   */
  function clearDemoBanner(footer) {
    const BASE = '1.6rem';
    let observer = null;

    const track = (banner) => {
      const apply = () => {
        footer.style.paddingBottom = `calc(${BASE} + ${banner.offsetHeight}px)`;
      };
      apply();
      if (window.ResizeObserver) new ResizeObserver(apply).observe(banner);
      window.addEventListener('resize', apply);
    };

    const found = document.getElementById('stoatworks-demo-banner');
    if (found) return track(found);

    // No banner in this document yet. On an app that has none — every one of
    // these except the demos — the observer simply never fires and is
    // disconnected on load, so nothing is left watching.
    if (!window.MutationObserver) return;
    observer = new MutationObserver(() => {
      const banner = document.getElementById('stoatworks-demo-banner');
      if (!banner) return;
      observer.disconnect();
      track(banner);
    });
    observer.observe(document.body, { childList: true });
    window.addEventListener('load', () => {
      setTimeout(() => observer && observer.disconnect(), 5000);
    });
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------
  /**
   * "Report a bug or send feedback", in a dialog in the page rather than a link that
   * throws the user at GitHub. Most of the people using these tools are working, on a
   * show, on someone else's laptop, and will not stop to make an account — the report
   * that never gets filed is the whole problem being solved here.
   *
   * It posts to the same intake Worker as the website's /feedback form, so a report
   * from inside a tool and one from the site land in the same private triage repo with
   * the same shape. Only `source: 'app'` differs, which becomes a `from-app` label.
   *
   * Two things this deliberately does NOT do:
   *
   *   - Send anything the user has not seen. Every diagnostic is rendered in full,
   *     with a tick-box, before it can go anywhere. Several of these tools promise
   *     that nothing leaves the browser, and a feedback button that quietly posts a
   *     session dump would make that promise false.
   *   - Reach the network from a self-hosted copy. Half these tools ship as Docker
   *     images that run on some LAN address we can neither predict nor allowlist, so
   *     the endpoint would reject them anyway. Those get the offline route below:
   *     the same report, handed to the user to paste.
   */

  /** Errors the page recorded, oldest first. In memory only, capped, and never sent
   *  unless the user ticks the box for them. */
  const ERRORS = [];

  function noteError(text) {
    if (!text) return;
    ERRORS.push(new Date().toISOString().slice(11, 19) + '  ' + String(text).slice(0, 300));
    if (ERRORS.length > MAX_ERRORS) ERRORS.shift();
  }

  /** Path only, never the query. An error line is not worth leaking whatever a tool has
   *  encoded in its URL, and the file and line number are the useful part anyway. */
  function trimUrl(u) {
    try {
      return new URL(u, location.href).pathname;
    } catch {
      return String(u).slice(0, 120);
    }
  }

  // Listening from load, not from when the dialog opens: the interesting error is
  // almost always the one that happened before the user decided to report anything.
  // Capture phase, because a failed <img>/<script> load does not bubble.
  window.addEventListener('error', (e) => {
    if (e.message) {
      noteError(e.message + (e.filename ? ' (' + trimUrl(e.filename) + ':' + e.lineno + ')' : ''));
    } else if (e.target && e.target.tagName) {
      noteError('failed to load ' + e.target.tagName.toLowerCase() + ' ' +
        trimUrl(e.target.src || e.target.href || ''));
    }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    noteError('unhandled rejection: ' + String((r && r.message) || r));
  });

  /** True when this page is one of ours and may therefore post to the intake Worker.
   *  Mirrors isAllowedOrigin() in intake/src/index.js — keep the two in step, and note
   *  the leading dot, without which evilstoatworks-labs.com would match. */
  function canPost() {
    return location.protocol === 'https:' &&
      (location.hostname === ZONE || location.hostname.endsWith('.' + ZONE));
  }

  /** The WebGL adapter, which for the visual tools here is often the entire answer —
   *  "it renders wrong" and "it renders wrong on this exact Intel iGPU driver" are
   *  different bug reports. */
  function graphicsAdapter() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return '';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const out = dbg
        ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) + ' — ' + gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.RENDERER) + ' — ' + gl.getParameter(gl.VENDOR);
      // Hand the context straight back. Browsers cap live WebGL contexts at around 16
      // and drop the oldest to make room — on pixel-peeker or test-card, that oldest
      // one is the tool's own, and asking it for diagnostics would blank the app.
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return out;
    } catch {
      return '';
    }
  }

  /** Coarse on purpose: Safari and Chrome both still report "Intel Mac OS X" on Apple
   *  Silicon, so anything finer than this would be confidently wrong. */
  function platformLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS / iPadOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac OS X/.test(ua)) return 'macOS';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return '';
  }

  /** The tick-list. Anything that comes back empty is left out entirely rather than
   *  offered as a box that sends the word "unknown". */
  function diagnostics() {
    const items = [];
    const screen = window.screen || {};

    items.push({
      id: 'browser',
      label: 'Browser and operating system',
      value: navigator.userAgent + '\nLanguages: ' +
        ((navigator.languages && navigator.languages.join(', ')) || navigator.language || '?'),
    });

    items.push({
      id: 'display',
      label: 'Display and window size',
      value: 'Window ' + window.innerWidth + ' × ' + window.innerHeight + ' CSS px at ' +
        (window.devicePixelRatio || 1) + '×\nScreen ' + (screen.width || '?') + ' × ' +
        (screen.height || '?') + ', ' + (screen.colorDepth || '?') + '-bit colour',
    });

    const gpu = graphicsAdapter();
    if (gpu) items.push({ id: 'graphics', label: 'Graphics adapter', value: gpu });

    items.push({ id: 'page', label: 'Page address', value: location.href });

    items.push({ id: 'time', label: 'Time and time zone', value: new Date().toString() });

    if (ERRORS.length) {
      items.push({
        id: 'errors',
        label: 'Errors this page recorded (' + ERRORS.length + ')',
        value: ERRORS.join('\n'),
      });
    }
    return items;
  }

  /** A modal cannot inherit its way out of needing a background, and these apps are a
   *  mix of dark and light with their own theme switches. So take the page's own
   *  colours: the first ancestor that actually paints something wins, and the system
   *  Canvas/CanvasText keywords in the stylesheet cover the case where none does. */
  function pageColours() {
    let bg = '';
    for (let node = document.body; node; node = node.parentElement) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') { bg = c; break; }
    }
    return { bg, fg: getComputedStyle(document.body).color };
  }

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) node.append(kid);
    return node;
  }

  const KINDS = [
    ['bug', 'Something is broken'],
    ['feature', 'It should be able to…'],
    ['feedback', 'A field report — how it went on a real job'],
    ['question', 'A question'],
  ];

  function openFeedback(ctx) {
    const online = canPost();
    const items = diagnostics();
    const named = ctx.app + (ctx.version ? ' ' + ctx.version : '');

    const dlg = el('dialog', { class: 'sw-fb', 'aria-labelledby': 'sw-fb-title' });
    const { bg, fg } = pageColours();
    if (bg) dlg.style.setProperty('--sw-fb-bg', bg);
    if (fg) dlg.style.setProperty('--sw-fb-fg', fg);

    // --- fields
    const kind = el('select', { id: 'sw-fb-type' });
    for (const [value, text] of KINDS) kind.append(el('option', { value, text }));

    const summary = el('input', { type: 'text', id: 'sw-fb-summary', maxlength: '160',
      placeholder: 'Crashes when I load a second file' });
    const detail = el('textarea', { id: 'sw-fb-detail', rows: '6',
      placeholder: 'What you did, what you expected, and what it did instead.' });
    const email = el('input', { type: 'email', id: 'sw-fb-email', autocomplete: 'email' });
    const botcheck = el('input', { type: 'text', class: 'sw-fb__hp', tabindex: '-1',
      autocomplete: 'off', 'aria-hidden': 'true' });

    const field = (labelFor, labelText, control, hint, required) =>
      el('p', { class: 'sw-fb__field' },
        el('label', { for: labelFor, text: labelText + (required ? ' *' : '') }),
        control,
        hint ? el('span', { class: 'sw-fb__hint', text: hint }) : null);

    // --- diagnostics tick-list
    const boxes = {};
    const list = el('ul', {});
    for (const it of items) {
      const box = el('input', { type: 'checkbox' });
      box.checked = true;
      boxes[it.id] = box;
      list.append(el('li', {},
        el('label', { class: 'sw-fb__check' }, box, el('span', { text: it.label })),
        el('pre', { class: 'sw-fb__value', text: it.value })));
    }
    const diag = el('details', { class: 'sw-fb__diag', open: true },
      el('summary', { text: 'What gets sent with this' }),
      el('p', { class: 'sw-fb__hint',
        text: 'Untick anything you would rather keep. This is everything — nothing else is collected, and none of it goes anywhere until you press the button.' }),
      list);

    // --- chrome
    const status = el('p', { class: 'sw-fb__status', role: 'status', 'aria-live': 'polite', hidden: true });
    const go = el('button', { type: 'submit', class: 'sw-fb__btn sw-fb__btn--go',
      text: online ? 'Send report' : 'Prepare report' });
    const cancel = el('button', { type: 'button', class: 'sw-fb__btn', text: 'Cancel' });

    const form = el('form', { class: 'sw-fb__form', novalidate: true },
      el('div', { class: 'sw-fb__head' },
        el('h2', { id: 'sw-fb-title', text: 'Report a bug or send feedback' }),
        el('p', { text: 'This goes to Stoatworks Labs as a private report, not a public issue. ' +
          'It will say which tool this is (' + named + '), plus whatever you tick below.' })),
      el('div', { class: 'sw-fb__body' },
        botcheck,
        field('sw-fb-type', 'What kind of thing is this?', kind),
        field('sw-fb-summary', 'One line summary', summary, null, true),
        field('sw-fb-detail', 'What happened', detail, null, true),
        field('sw-fb-email', 'Email', email,
          'Only ever used to reply, and never published. Leave it blank to stay anonymous — but then there is no way to ask you anything.'),
        diag,
        status),
      el('div', { class: 'sw-fb__foot' },
        el('p', { class: 'sw-fb__note',
          text: online
            ? 'Lands in a private inbox. Nothing is published without being read first.'
            : 'This copy is self-hosted, so it cannot send directly — you will get the report to paste.' }),
        cancel, go));

    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    cancel.addEventListener('click', () => dlg.close());

    const say = (msg, state) => {
      status.hidden = false;
      status.textContent = msg;
      status.dataset.state = state || '';
    };

    const flagField = (control, msg) => {
      control.setAttribute('aria-invalid', 'true');
      let err = control.parentElement.querySelector('.sw-fb__err');
      if (!err) {
        err = el('span', { class: 'sw-fb__err' });
        control.parentElement.append(err);
      }
      err.textContent = msg;
    };

    form.addEventListener('input', (e) => {
      if (e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
        e.target.removeAttribute('aria-invalid');
        const err = e.target.parentElement.querySelector('.sw-fb__err');
        if (err) err.remove();
      }
    });

    /** The payload, built only from what is ticked. */
    const build = () => {
      const picked = items.filter((it) => boxes[it.id].checked);
      return {
        source: 'app',
        type: kind.value,
        project: ctx.project,
        version: ctx.version,
        summary: summary.value.trim(),
        detail: detail.value.trim(),
        email: email.value.trim(),
        // Only when the user agent itself is going. Withholding the UA but sending the
        // reading taken off it would be a strange sort of promise to keep.
        platform: picked.some((it) => it.id === 'browser') ? platformLabel() : '',
        diagnostics: picked
          .map((it) => it.label + '\n' + it.value.split('\n').map((l) => '  ' + l).join('\n'))
          .join('\n\n'),
        botcheck: botcheck.value,
      };
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      let ok = true;
      for (const [control, msg] of [[summary, 'A one-line summary, so this is findable.'],
                                    [detail, 'Please say what happened.']]) {
        if (!control.value.trim()) { flagField(control, msg); ok = false; }
      }
      if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
        flagField(email, "That doesn't look like an email address."); ok = false;
      }
      if (!ok) {
        say('Have another look at the highlighted fields.', 'err');
        form.querySelector('[aria-invalid="true"]').focus();
        return;
      }

      const payload = build();
      if (!online) return handOver(payload);

      go.disabled = true;
      const was = go.textContent;
      go.textContent = 'Sending…';
      say('Sending…');
      try {
        const res = await fetch(INTAKE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          say('Filed as reference #' + data.reference + '. Thank you — you will get a reply when the current show lets go.', 'ok');
          go.remove();
          cancel.textContent = 'Close';
          cancel.focus();
          return;
        }
        say(data.error || 'That did not send. You can copy the report instead.', 'err');
      } catch {
        say('Could not reach the server. You can copy the report instead.', 'err');
      }
      go.disabled = false;
      go.textContent = was;
      // A failed send should not cost the user what they typed, so offer the same
      // paste-it-yourself route the self-hosted copies get.
      offerCopy(payload);
    });

    /** The offline route: same report, handed back to be pasted. Deliberately not
     *  clipboard-only — navigator.clipboard needs a secure context, and a self-hosted
     *  copy on http://something.local is exactly the case that does not have one. */
    function handOver(payload) {
      say('Ready to paste — this copy cannot send it for you.', '');
      offerCopy(payload);
    }

    function offerCopy(payload) {
      if (form.querySelector('.sw-fb__handover')) return;

      const text = reportText(ctx, kind.options[kind.selectedIndex].text, payload);
      const box = el('textarea', { class: 'sw-fb__handover', rows: '8', readonly: true });
      box.value = text;

      const actions = el('div', { class: 'sw-support__actions' });
      const copy = el('button', { type: 'button', class: 'sw-fb__btn', text: 'Copy report' });
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copied';
        } catch {
          box.focus();
          box.select();
          copy.textContent = 'Press ⌘C / Ctrl-C';
        }
      });
      actions.append(copy);

      // A prefilled issue is the nicest landing for anyone who does have a GitHub
      // account. Long ones are dropped to a title-only link rather than truncated:
      // GitHub silently discards an over-long query and the diagnostics would vanish
      // without saying so, which is worse than an empty box next to the copied text.
      if (ctx.repo) {
        const base = ctx.repo.replace(/\/+$/, '') + '/issues/new?';
        const full = base + new URLSearchParams({ title: payload.summary, body: text });
        const href = full.length <= 6000 ? full : base + new URLSearchParams({ title: payload.summary });
        actions.append(el('a', { class: 'sw-fb__btn', href, target: '_blank', rel: 'noopener',
          text: full.length <= 6000 ? 'Open a GitHub issue' : 'Open a GitHub issue (paste it in)' }));
      }
      actions.append(el('a', { class: 'sw-fb__btn', href: FEEDBACK_PAGE, target: '_blank',
        rel: 'noopener', text: 'Use the web form' }));

      form.querySelector('.sw-fb__body').append(
        el('div', { class: 'sw-fb__field' }, box, actions));
      box.focus();
      box.select();
    }

    dlg.showModal();
    summary.focus();
  }

  /** The same report as markdown, for the routes that end in a paste.
   *
   *  The blank lines are structural and cannot be filtered out with the optional email
   *  row — dropping them runs the three meta rows into a single markdown paragraph, and
   *  the heading ends up welded to the line above it. Hence two joins: `  \n` for a hard
   *  break inside the meta block, plain `\n` between blocks that are already separated. */
  function reportText(ctx, kindText, payload) {
    const meta = [
      '**Tool:** ' + ctx.app + (ctx.version ? ' ' + ctx.version : ''),
      '**Kind:** ' + kindText,
      payload.email ? '**Reply to:** ' + payload.email : '',
    ].filter(Boolean).join('  \n');

    const parts = [meta, '', '## What happened', '', payload.detail];
    if (payload.diagnostics) {
      // Same trick as the Worker's fence(): a run of backticks longer than any inside
      // the payload cannot be closed early by it. An error message is free text and may
      // well contain one.
      const longest = (payload.diagnostics.match(/`+/g) || [])
        .reduce((n, run) => Math.max(n, run.length), 0);
      const ticks = '`'.repeat(Math.max(3, longest + 1));
      parts.push('', '## Diagnostics', '', ticks, payload.diagnostics, ticks);
    }
    return parts.join('\n');
  }

  /** The intake endpoint files by repo NAME, and its validator rejects anything that is
   *  not one. Prefer an explicit data-project, fall back to the tail of data-repo, and
   *  send nothing rather than a guess — a report filed against the wrong project is
   *  worse than one filed against none, which at least lands in the unfiled pile. */
  function repoName(url) {
    const tail = String(url || '').replace(/\/+$/, '').split('/').pop() || '';
    return /^[A-Za-z0-9._-]+$/.test(tail) ? tail : '';
  }

  function feedbackRow(ctx) {
    const btn = el('button', { type: 'button', class: 'sw-fb-open',
      text: 'Report a bug or send feedback' });
    btn.addEventListener('click', () => openFeedback(ctx));
    return el('div', { class: 'sw-support__actions' }, btn);
  }

  function link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  // `defer` already puts this after parsing, but the demos load the shim and the
  // app script in the same document and one of them may still be writing to
  // <body>; appending on DOMContentLoaded keeps the footer last either way.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build, { once: true });
  } else {
    build();
  }
})();
