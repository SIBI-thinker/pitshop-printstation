// Print preview: shows the sheets of paper that will come out of the printer for one file and its
// settings (paper size and orientation, printer margins, scaling, black & white, page selection,
// front/back for double-sided). Pages are drawn in the browser with pdf.js, so the low-spec laptop
// only hands over the file. Used by the phone site (app.js) and the counter (counter.js).
(() => {
  // Paper sizes in points (1/72 inch), portrait.
  const PAPER = { a3: [842, 1191], a4: [595, 842], a5: [420, 595], a6: [298, 420], letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224] };
  // Most printers cannot print the outer ~4 mm of the sheet; "fit" scales into what is left.
  const MARGIN = 12;
  const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
  const RENDER_PX = 520;

  // ---------- loading ----------
  let pdfjsPromise = null;
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return lib;
      });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  // file: { key, kind: 'pdf' | 'image' | 'office', url, blob?, size? }
  const sources = new Map();
  function load(file) {
    if (sources.has(file.key)) return sources.get(file.key);
    const promise = (async () => {
      const local = file.blob && file.kind !== 'office';
      if (!local && file.size > MAX_DOWNLOAD_BYTES) throw new Error('Too large to preview.');
      if (file.kind === 'image') {
        const url = local ? URL.createObjectURL(file.blob) : file.url;
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Image could not be read.'));
          img.src = url;
        });
        // Photos print at about 96 dpi when not scaled; 0.75 turns pixels into points.
        return { type: 'image', url, numPages: 1, width: img.naturalWidth * 0.75, height: img.naturalHeight * 0.75 };
      }
      const lib = await pdfjs();
      let data;
      if (local) data = await file.blob.arrayBuffer();
      else {
        const res = await fetch(file.url);
        if (!res.ok) throw new Error('Preview not available.');
        data = await res.arrayBuffer();
      }
      const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
      return { type: 'pdf', doc, numPages: doc.numPages };
    })();
    promise.catch(() => sources.delete(file.key));
    sources.set(file.key, promise);
    return promise;
  }

  // One page is drawn at a time so a weak phone never renders several big pages at once.
  let chain = Promise.resolve();
  function queued(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  // Each page is drawn once and kept as a small JPEG, so changing settings only re-arranges it.
  const images = new Map();
  function pageImage(file, number) {
    const id = `${file.key}:${number}`;
    if (images.has(id)) return images.get(id);
    const promise = load(file).then((source) => {
      if (source.type === 'image') return { src: source.url, width: source.width, height: source.height };
      return queued(async () => {
        const page = await source.doc.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RENDER_PX / Math.max(base.width, base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        // "print" draws what the printer gets and does not wait for animation frames.
        await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
        page.cleanup();
        return { src: canvas.toDataURL('image/jpeg', 0.85), width: base.width, height: base.height };
      });
    });
    promise.catch(() => images.delete(id));
    images.set(id, promise);
    return promise;
  }

  // ---------- layout ----------
  function paperSize(settings) {
    return PAPER[String(settings.paper || 'A4').toLowerCase()] || PAPER.a4;
  }

  // Where a page lands on the sheet, following SumatraPDF: the sheet turns to the chosen
  // orientation (or the page's own on Auto), the page turns to match, then it is scaled.
  function layout(width, height, settings) {
    let [pw, ph] = paperSize(settings);
    const wide = width > height;
    const landscape = settings.orientation === 'landscape' || (settings.orientation !== 'portrait' && wide);
    if (landscape) [pw, ph] = [ph, pw];
    const rotate = width !== height && wide !== landscape;
    const ew = rotate ? height : width;
    const eh = rotate ? width : height;
    const fit = Math.min((pw - 2 * MARGIN) / ew, (ph - 2 * MARGIN) / eh);
    const scale = settings.scale === 'noscale' ? 1 : settings.scale === 'shrink' ? Math.min(fit, 1) : fit;
    return { pw, ph, rotate, w: (width * scale) / pw * 100, h: (height * scale) / ph * 100 };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sizeTo(node, pw, ph, box) {
    const ratio = pw / ph;
    const [bw, bh] = box;
    const w = bw / bh > ratio ? bh * ratio : bw;
    node.style.width = `${Math.round(w)}px`;
    node.style.height = `${Math.round(w / ratio)}px`;
  }

  // A blank sheet of the right shape while the page is still being drawn (or for an empty back side).
  function blankSheet(settings, box, label) {
    let [pw, ph] = paperSize(settings);
    if (settings.orientation === 'landscape') [pw, ph] = [ph, pw];
    const node = el('div', 'pv-paper');
    sizeTo(node, pw, ph, box);
    node.append(label ? el('span', 'pv-blank', label) : el('span', 'spinner'));
    return node;
  }

  function printedSheet(image, settings, box) {
    const spot = layout(image.width, image.height, settings);
    const node = el('div', `pv-paper${settings.color === 'bw' ? ' gray' : ''}`);
    sizeTo(node, spot.pw, spot.ph, box);
    const content = el('div', 'pv-content');
    content.style.width = `${spot.w}%`;
    content.style.height = `${spot.h}%`;
    if (spot.rotate) content.style.transform = 'translate(-50%, -50%) rotate(90deg)';
    const img = el('img');
    img.alt = '';
    img.src = image.src;
    content.append(img);
    node.append(content);
    return node;
  }

  function parsePages(range, total) {
    const picked = new Set();
    if (!range || range === 'all') {
      for (let n = 1; n <= total; n++) picked.add(n);
      return picked;
    }
    for (const part of String(range).split(',')) {
      const [from, to = from] = part.split('-').map(Number);
      for (let n = from; n <= Math.min(to, total); n++) picked.add(n);
    }
    return picked;
  }

  // The physical sheets for one copy: [{ front, back }] with page numbers (back is null when blank).
  function sheetsFor(total, range, settings) {
    const pages = [...parsePages(range, total)].sort((a, b) => a - b);
    if (settings.sides === 'single') return pages.map((front) => ({ front, back: null }));
    const sheets = [];
    for (let i = 0; i < pages.length; i += 2) sheets.push({ front: pages[i], back: pages[i + 1] ?? null });
    return sheets;
  }

  // ---------- sheet list ----------
  // Fills `container` with the sheets one copy produces. `box(duplex)` gives the [width, height]
  // each side may take. Returns a function that re-draws with new settings or page range.
  function sheetsView(container, { file, pages, range, settings, box, root }) {
    let observer = null;
    function draw(nextRange, nextSettings) {
      observer?.disconnect();
      const duplex = nextSettings.sides !== 'single';
      const sideBox = box(duplex);
      const sheets = sheetsFor(pages, nextRange, nextSettings);
      container.replaceChildren();
      if (!sheets.length) return container.append(el('p', 'muted', 'No pages selected.'));
      const cards = sheets.map((sheet, index) => {
        const card = el('div', 'pv-sheet');
        const sides = el('div', 'pv-sides');
        const slots = [['front', sheet.front], ...(duplex ? [['back', sheet.back]] : [])];
        for (const [side, number] of slots) {
          const slot = el('div', 'pv-side');
          slot.append(number ? blankSheet(nextSettings, sideBox) : blankSheet(nextSettings, sideBox, 'Blank'));
          const label = duplex ? `${side === 'front' ? 'Front' : 'Back'}${number ? ` · p${number}` : ''}` : `Page ${number}`;
          slot.append(el('span', 'pv-label', label));
          slot.dataset.page = number || '';
          sides.append(slot);
        }
        card.append(el('div', 'pv-sheet-title', `Sheet ${index + 1} of ${sheets.length}`), sides);
        return card;
      });
      container.append(...cards);

      function fill(card) {
        for (const slot of card.querySelectorAll('.pv-side')) {
          const number = Number(slot.dataset.page);
          if (!number) continue;
          pageImage(file, number).then((image) => {
            if (!slot.isConnected) return;
            slot.firstChild.replaceWith(printedSheet(image, nextSettings, sideBox));
          }, () => {
            if (slot.isConnected) slot.firstChild.replaceChildren(el('span', 'pv-blank', 'Preview not available'));
          });
        }
      }
      // The first few sheets are drawn straight away; later ones when scrolled near.
      cards.slice(0, 6).forEach(fill);
      if (cards.length > 6) {
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            fill(entry.target);
          }
        }, { root: root || container, rootMargin: '400px' });
        cards.slice(6).forEach((card) => observer.observe(card));
      }
    }
    draw(range, settings);
    return draw;
  }

  // ---------- thumbnail: the first printed sheet, small ----------
  function thumb(target, { file, range, settings, pages }) {
    const first = [...parsePages(range, pages || 1)].sort((a, b) => a - b)[0] || 1;
    pageImage(file, first).then((image) => {
      if (!target.isConnected) return;
      const box = [target.clientWidth || 40, target.clientHeight || 52];
      target.querySelector('.pv-paper')?.remove();
      target.classList.add('has-thumb');
      target.append(printedSheet(image, settings, box));
    }, () => {});
  }

  // ---------- full-screen preview (read-only) ----------
  function open({ title, subtitle, chips = [], file, pages, range = 'all', settings }) {
    const backdrop = el('div', 'pv-backdrop');
    const panel = el('div', 'pv-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = el('div', 'pv-head');
    const titles = el('div', 'pv-titles');
    titles.append(el('h2', '', title), el('p', 'muted small', subtitle || ''));
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close preview');
    head.append(titles, close);
    const chipRow = el('div', 'chips pv-chips');
    chipRow.append(...chips.map((text) => el('span', 'chip', text)));
    const grid = el('div', 'pv-sheets grid');
    panel.append(head, chipRow, grid);
    backdrop.append(panel);
    document.body.append(backdrop);
    document.body.style.overflow = 'hidden';

    function dismiss() {
      backdrop.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    }
    function onKey(event) { if (event.key === 'Escape') dismiss(); }
    close.onclick = dismiss;
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) dismiss(); });
    document.addEventListener('keydown', onKey);
    close.focus();

    const columnWidth = () => {
      const width = grid.clientWidth || 320;
      const columns = Math.max(1, Math.floor(width / 260));
      return (width - (columns - 1) * 16) / columns - 24;
    };
    sheetsView(grid, {
      file,
      pages,
      range,
      settings,
      root: panel,
      box: (duplex) => {
        const side = duplex ? (columnWidth() - 10) / 2 : columnWidth();
        return [side, side * 1.42];
      },
    });
  }

  function sheetCount(pages, range, settings) {
    return sheetsFor(pages, range, settings).length;
  }

  window.PrintPreview = { open, thumb, sheetsView, parsePages, sheetCount };
})();
