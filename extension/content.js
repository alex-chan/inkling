// Inkling 墨点 —— content script：扫描正文、注释生词、词卡、划词
(() => {
  if (window.__inkling) return;
  window.__inkling = true;
  if (!document.documentElement || !(document instanceof HTMLDocument)) return;

  // ---------------- 设置 ----------------

  const DEFAULTS = {
    enabled: true, disabledSites: [], level: 4500, displayMode: 'ruby',
    knownWords: [], learningWords: [], autoAI: false, aiProvider: 'apikey',
    showPhonetic: false, autoSpeak: false, speechVoice: '', speechRate: 0.9, glossColor: '#000000',
  };
  const KEYS = Object.keys(DEFAULTS);
  let S = { ...DEFAULTS };
  let known = new Set();
  let learning = new Set();
  let active = false;

  // ---------------- 界面文案（由后台按当前界面语言提供） ----------------
  let M = {};
  function t(key, ...subs) {
    return (M[key] ?? key).replace(/{(\d)}/g, (_, i) => (subs[i] ?? ''));
  }
  async function loadMessages() {
    try { M = (await send({ type: 'i18n' })).messages || {}; } catch { /* 后台未就绪时保持原样 */ }
  }
  // 需要配置才能用的错误：词卡里给出「打开设置」链接，自动注释也随之停止
  const CONFIG_CODES = new Set(['no_api_key', 'no_model', 'no_chatgpt_model', 'need_host_permission', 'plan_disabled', 'bad_base']);
  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  const BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, summary, caption, label';
  const SKIP_SEL = [
    'nav', 'footer', 'code', 'pre', 'kbd', 'samp', 'var', 'tt', 'script', 'style', 'noscript', 'template',
    'textarea', 'input', 'select', 'option', 'button', 'svg', 'math', 'iframe', 'canvas', 'video', 'audio',
    '[role="navigation"]', '[role="contentinfo"]', '[role="banner"]', 'header:not(main header, article header)', '[role="menu"]', '[role="menubar"]', '[role="toolbar"]',
    '[role="code"]', '[aria-hidden="true"]', '[contenteditable]:not([contenteditable="false"])',
    '[translate="no"]', '.notranslate', 'ik-a', 'inkling-ui', 'rt', 'rp',
  ].join(',');
  const EN_STOP = new Set('the of and to in is that for it with as was on be by are this have from at he she they we you not or but an his her has had will would said its their which were been who more than also after about'.split(' '));
  // 句首常见的大写功能词：与它相邻的大写词不因此被当作专有名词
  const CAP_FUNC = new Set('the a an in on at of for and but if as to by with from it he she they we i this that these those when while after before its his her their our my your'.split(' '));
  const CAPTION_SEL = '.ytp-caption-window-container, .caption-window, .ytp-caption-segment';

  // 新闻里高频、又恰好是普通英文词的人名：首字母大写时一律视为人名
  const NAME_HINTS = new Set(['trump', 'pence', 'barr', 'xi']);
  const FOREIGN_STOP = new Set('le la les des du une est et que qui pour dans der die das und ist nicht mit den el los las del por para con una que sono della di il lo gli het een van op dat zijn'.split(' '));

  function applySettings(raw) {
    S = { ...DEFAULTS, ...raw };
    known = new Set((S.knownWords || []).map((w) => w.toLowerCase()));
    learning = new Set((S.learningWords || []).map((w) => w.toLowerCase()));
  }
  function shouldBeActive() {
    return !!S.enabled && !(S.disabledSites || []).includes(location.hostname);
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('no response'));
          res.ok ? resolve(res.data) : reject(Object.assign(new Error(res.error?.message || t('error_generic')), res.error));
        });
      } catch (e) { reject(e); }
    });
  }

  // ---------------- 词典信息缓存 ----------------

  const info = new Map(); // 小写词 -> 词典信息 | null

  async function ensureInfo(tokens) {
    const need = [...tokens].filter((t) => !info.has(t));
    for (let i = 0; i < need.length; i += 800) {
      const chunk = need.slice(i, i + 800);
      const res = await send({ type: 'lookup', tokens: chunk });
      for (const t of chunk) info.set(t, res[t] || null);
    }
  }

  // ---------------- 页面统计（专有名词判断用） ----------------

  const pageLower = new Set(); // 页面上以小写形式出现过的词
  const capMid = new Set();    // 页面上在句中以首字母大写出现过的词
  const capCount = new Map();  // 首字母大写出现次数

  function prevSignificant(text) {
    const t = text.replace(/[\s"'“”‘’()[\]{}«»—–\-*•·]+$/u, '');
    return t ? t[t.length - 1] : '';
  }
  const ENDERS = '.!?:;…。！？';

  // lowerOnly：标题里的大写多为标题式大小写，不作为专有名词证据
  function updateStats(text, lowerOnly = false) {
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      const w = m[0];
      if (/^[a-z]/.test(w)) pageLower.add(w.toLowerCase().replace(/['’]s$/, ''));
      else if (!lowerOnly && /^[A-Z][a-z]/.test(w)) {
        const k = w.toLowerCase().replace(/['’]s$/, '');
        capCount.set(k, (capCount.get(k) || 0) + 1);
        const prev = prevSignificant(text.slice(0, m.index));
        if (prev && !ENDERS.includes(prev)) capMid.add(k);
      }
    }
  }

  // ---------------- 块（段落）发现 ----------------

  const blockCache = new WeakMap();
  function blockOf(el) {
    if (!el) return null;
    if (blockCache.has(el)) return blockCache.get(el);
    let b = el.closest(BLOCK_SEL);
    if (!b) {
      let cur = el;
      while (cur && cur !== document.body) {
        const d = getComputedStyle(cur).display;
        if (!d.startsWith('inline') && d !== 'contents') break;
        cur = cur.parentElement;
      }
      b = cur && cur !== document.body ? cur : el;
    }
    blockCache.set(el, b);
    return b;
  }

  function isSkipped(el) {
    if (!el) return true;
    if (el.closest(SKIP_SEL)) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function textWalker(root, { all = false } = {}) {
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (all) return /^(RT|RP|IK-G|SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          return n.matches(SKIP_SEL) || n.isContentEditable ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  // 已交给 IntersectionObserver 的块；gen 变化（停用后再启用）即视为全部未观察
  let gen = 0;
  const observed = new WeakMap();
  const processed = new Set(); // 已注释过的块

  function discover(root) {
    if (!active || !root) return;
    if (root.nodeType === 3) root = root.parentElement;
    if (!root || root.nodeType !== 1) return;
    if (root !== document.body && isSkipped(root)) return;
    const w = textWalker(root);
    const blocks = new Set();
    let n;
    while ((n = w.nextNode())) {
      const v = n.nodeValue;
      if (!v || !/[A-Za-z]{2}/.test(v)) continue;
      updateStats(v, !!n.parentElement.closest('h1, h2, h3, h4, h5, h6'));
      const b = blockOf(n.parentElement);
      if (b) blocks.add(b);
    }
    for (const b of blocks) {
      if (observed.get(b) === gen) continue;
      observed.set(b, gen);
      io.observe(b);
    }
  }

  // 懒处理：进入视口附近（上下各约 1.5 屏）才注释
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      enqueue(e.target);
    }
  }, { rootMargin: '150% 0px 150% 0px' });

  const queue = new Set();
  let flushTimer = 0;
  function enqueue(b) {
    queue.add(b);
    if (!flushTimer) flushTimer = setTimeout(flush, 16);
  }

  async function flush() {
    flushTimer = 0;
    const batch = [...queue].slice(0, 60);
    batch.forEach((b) => queue.delete(b));
    const items = [];
    const tokens = new Set();
    for (const b of batch) {
      if (!b.isConnected || processed.has(b)) continue;
      const nodes = blockTextNodes(b);
      const text = nodes.map((x) => x.nodeValue).join('');
      if (!isEnglish(text)) { processed.delete(b); continue; }
      for (const m of text.matchAll(WORD_RE)) tokens.add(baseToken(m[0]).toLowerCase());
      items.push(b);
    }
    try {
      await ensureInfo(tokens);
    } catch (e) {
      // 扩展被重新加载等情况
      return;
    }
    if (!active) return;
    mutate(() => { for (const b of items) annotateBlock(b); });
    if (queue.size && !flushTimer) flushTimer = setTimeout(flush, 16);
  }

  function blockTextNodes(b) {
    const out = [];
    const w = textWalker(b);
    let n;
    while ((n = w.nextNode())) if (blockOf(n.parentElement) === b) out.push(n);
    return out;
  }

  function isEnglish(text) {
    const letters = text.match(/\p{L}/gu);
    if (!letters) return false;
    const latin = text.match(/[A-Za-z]/g) || [];
    if (latin.length / letters.length < 0.7) return false;
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    if (words.length >= 4) {
      let en = 0, fo = 0;
      for (const w of words) { if (EN_STOP.has(w)) en++; if (FOREIGN_STOP.has(w)) fo++; }
      if (fo > en) return false;
      if (words.length >= 12 && en / words.length < 0.08) return false;
    }
    return true;
  }

  function baseToken(tok) {
    return tok.replace(/['’]s$/i, '');
  }

  // ---------------- 是否注释 ----------------

  // 相邻（只隔空白）的词是否首字母大写，如 Matt Spivey、Mr Trump、Donald Trump
  function capNeighbor(text, start, end) {
    const after = /^\s+([A-Z][A-Za-z'’-]*)/.exec(text.slice(end));
    if (after && !CAP_FUNC.has(after[1].toLowerCase())) return true;
    const before = /([A-Z][A-Za-z'’-]*)\.?\s+$/.exec(text.slice(Math.max(0, start - 40), start));
    return !!(before && !CAP_FUNC.has(before[1].toLowerCase()));
  }

  function decide(tok, sentenceStart, capNear = false) {
    if (/['’]/.test(tok.replace(/['’]s$/i, ''))) return null; // don't / I'm 等缩写
    const base = baseToken(tok);
    if (base.length < 2) return null;
    if (base === base.toUpperCase()) return null;           // 全大写缩写：NATO
    if (/[A-Z]/.test(base.slice(1))) return null;           // iPhone / McDonald
    const lower = base.toLowerCase();
    const I = info.get(lower);
    if (!I) return null;
    if (known.has(lower) || known.has(I.l)) return null;
    const learn = learning.has(lower) || learning.has(I.l);
    const capital = base[0] !== lower[0];
    if (!learn) {
      if (I.name) return null;
      if (capital) {
        if (I.cap) return null; // 词典里只有大写词条：London
        if (capNear || NAME_HINTS.has(lower)) return null; // 连续大写词：人名、机构名
        if (!sentenceStart) {
          // 句中首字母大写：词典里罕见、存在同名大写词条、或全页从未以小写出现 → 视为专有名词
          if (I.hasCap || I.r > 20000 || !pageLower.has(lower)) return null;
        } else if (!pageLower.has(lower) && (capMid.has(lower) || (capCount.get(lower) || 0) >= 2)) {
          // 句首：页面上多次大写出现、从不小写 → 多半是人名（如反复出现的 Trump）
          return null;
        }
      }
      if (base.length < 3) return null;
      if (I.r <= S.level) return null;
    }
    return I;
  }

  // ---------------- 注释渲染 ----------------
  // 每个文本节点先算出「要注释的片段」，再统一渲染：
  //   词典模式：按词频 + 熟词本/生词本判断；
  //   AI 模式（该段已有 AI 结果）：以模型按语境和读者水平给出的条目为准（生词、熟词僻义、短语），
  //   生词本里的词仍然总会注释，熟词本里的永不注释。

  let aiResults = new WeakMap(); // 块 -> [{ text, gloss, level, kind }]

  function shorten(g) {
    return S.displayMode === 'ruby' && g.length > 7 ? g.slice(0, 6) + '…' : g;
  }

  // d: { word, l, gloss, ipa, ai, kind, level }
  function makeAnnotation(d, withGloss) {
    const a = document.createElement('ik-a');
    a.dataset.w = d.word;
    a.dataset.l = d.l;
    if (d.ai) {
      a.dataset.ai = '1';
      a.dataset.ag = d.gloss;
      a.dataset.kind = d.kind || 'word';
      if (d.level) a.dataset.level = d.level;
    }
    const mode = S.displayMode;
    if (withGloss && mode !== 'underline' && d.gloss) {
      const ipa = S.showPhonetic && d.ipa ? d.ipa : '';
      a.className = ipa ? 'ik-gloss ik-ph' : 'ik-gloss';
      // 注释内容：[美式音标] + 释义（释义放在 ik-t 里）
      const parts = [];
      if (ipa) {
        const ph = document.createElement('ik-ipa');
        ph.textContent = `/${ipa}/`;
        parts.push(ph, ' ');
      }
      const t = document.createElement('ik-t');
      t.textContent = shorten(d.gloss);
      parts.push(t);
      if (mode === 'ruby') {
        const r = document.createElement('ruby');
        r.append(d.word);
        const rt = document.createElement('rt');
        rt.append(...parts);
        r.append(rt);
        a.append(r);
      } else {
        a.append(d.word);
        const p = document.createElement('ik-g');
        p.append('（', ...parts, '）');
        a.append(p);
      }
    } else {
      a.append(d.word);
    }
    return a;
  }

  function dictDesc(word, I) {
    return { word, l: I.l, gloss: I.g, ipa: I.us, ai: false };
  }

  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function aiDesc(word, item) {
    const single = !/\s/.test(item.text);
    const lower = baseToken(word).toLowerCase();
    const I = single ? info.get(lower) : null;
    return {
      word, l: single ? (I?.l || lower) : item.text.toLowerCase(),
      gloss: item.gloss, ipa: single ? I?.us : '', ai: true, kind: item.kind, level: item.level,
    };
  }

  function isKnownDesc(d) {
    return known.has(d.l) || known.has(baseToken(d.word).toLowerCase());
  }

  // 行数被截断的标题（-webkit-line-clamp，如 YouTube 侧栏、Google 新闻卡片）：
  // 加释义会撑高行距、把末行挤掉，这类块只加下划线，点词仍可看词卡
  function isClamped(start) {
    for (let el = start, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) {
      const cs = getComputedStyle(el);
      const clamp = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp');
      if (clamp && clamp !== 'none') return true;
    }
    return false;
  }

  function annotateBlock(b) {
    if (!b.isConnected) return;
    processed.add(b);
    const nodes = blockTextNodes(b);
    const clampCache = new Map();
    const clampedAt = (el) => {
      if (!clampCache.has(el)) clampCache.set(el, isClamped(el));
      return clampCache.get(el);
    };
    const items = aiResults.get(b);
    const glossed = new Set();
    let prevChar = ''; // 本块中上一个有意义的字符；为空表示块首
    let count = 0;
    let words = 0;
    const heading = /^H[1-6]$/.test(b.tagName);
    // 标题式大小写（The Perfunctory Diplomacy of…）：不按"相邻大写词"判断人名
    const longWords = nodes.map((n) => n.nodeValue).join(' ').match(/[A-Za-z]{4,}/g) || [];
    const titleCase = heading && longWords.length >= 3 && longWords.filter((w) => /^[A-Z]/.test(w)).length / longWords.length > 0.6;
    // AI 条目按长度降序，短语优先于其中的单词
    const aiRes = items ? [...items].sort((x, y) => y.text.length - x.text.length)
      .map((it) => ({ it, re: new RegExp(`(?<![A-Za-z])${escRe(it.text)}(?![A-Za-z])`, 'gi') })) : null;

    for (const node of nodes) {
      const text = node.nodeValue;
      const found = []; // { start, end, d }
      const taken = (s0, e0) => found.some((f) => s0 < f.end && e0 > f.start);
      if (aiRes) {
        for (const { it, re } of aiRes) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text))) {
            const d = aiDesc(m[0], it);
            if (!taken(m.index, m.index + m[0].length) && !isKnownDesc(d)) found.push({ start: m.index, end: m.index + m[0].length, d });
          }
        }
      }
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(text))) {
        words++;
        const p = prevSignificant(text.slice(0, m.index)) || prevChar;
        const sentenceStart = !p || ENDERS.includes(p);
        const I = decide(m[0], sentenceStart || heading || titleCase,
          !titleCase && /^[A-Z]/.test(m[0]) && capNeighbor(text, m.index, m.index + m[0].length));
        if (!I || taken(m.index, m.index + m[0].length)) continue;
        // 数字后面的短词多是单位缩写：6 min read、5 km、30 mph
        if (m[0].length <= 3 && /\d\s*$/.test(text.slice(0, m.index))) continue;
        // AI 模式下，词典候选只保留生词本里的词（其余以模型判断为准）
        if (aiRes && !(learning.has(I.l) || learning.has(baseToken(m[0]).toLowerCase()))) continue;
        found.push({ start: m.index, end: m.index + m[0].length, d: dictDesc(m[0], I) });
      }
      const tail = prevSignificant(text);
      if (tail) prevChar = tail;
      if (!found.length) continue;
      found.sort((x, y) => x.start - y.start);
      const compact = clampedAt(node.parentElement);
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const f of found) {
        if (f.start > last) frag.append(text.slice(last, f.start));
        const first = !compact && !glossed.has(f.d.l);
        glossed.add(f.d.l);
        frag.append(makeAnnotation(f.d, first));
        last = f.end;
        count++;
      }
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    }
    // 视频字幕变化太快，不做 AI 优化（每行一次请求既慢又费用量）
    if (S.autoAI && !items && words >= 4 && !b.closest(CAPTION_SEL)) aiIO.observe(b);
    if (count) scheduleFit(b);
  }

  // ---------------- 宽注释（音标 + 释义）防重叠 ----------------
  // 带音标的注释左对齐、允许向右溢出（CSS 负边距）。同一行相邻的两个注释若会重叠，
  // 就把前一个的溢出量收回一部分，让排版把后一个词往右推；超出段落右边界的往左挪。

  const fitQueue = new Set();
  let fitRaf = 0;
  function scheduleFit(b) {
    if (S.displayMode !== 'ruby' || !S.showPhonetic) return;
    fitQueue.add(b);
    if (!fitRaf) fitRaf = requestAnimationFrame(runFit);
  }
  function runFit() {
    fitRaf = 0;
    const blocks = [...fitQueue];
    fitQueue.clear();
    mutate(() => { for (const b of blocks) if (b.isConnected) fitBlock(b); });
  }
  function fitBlock(b) {
    const rts = [...b.querySelectorAll('ik-a.ik-ph rt')];
    for (const rt of rts) { rt.style.removeProperty('margin-inline-end'); rt.style.removeProperty('left'); }
    const right = b.getBoundingClientRect().right;
    for (let i = 0; i < rts.length; i++) {
      const a = rts[i].getBoundingClientRect();
      const next = rts[i + 1]?.getBoundingClientRect();
      if (next && Math.abs(next.top - a.top) < 2 && a.right + 6 > next.left) {
        const cur = parseFloat(getComputedStyle(rts[i]).marginInlineEnd) || 0;
        rts[i].style.setProperty('margin-inline-end', `${Math.min(0, cur + (a.right + 6 - next.left))}px`, 'important');
      }
      const r2 = rts[i].getBoundingClientRect();
      if (r2.right > right) {
        rts[i].style.setProperty('position', 'relative', 'important');
        rts[i].style.setProperty('left', `${-Math.min(r2.right - right, r2.left - b.getBoundingClientRect().left)}px`, 'important');
      }
    }
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const b of processed) scheduleFit(b); }, 200);
  });

  function unannotate(root) {
    const list = root.querySelectorAll ? root.querySelectorAll('ik-a') : [];
    const parents = new Set();
    for (const a of list) {
      parents.add(a.parentNode);
      a.replaceWith(document.createTextNode(a.dataset.w || ''));
    }
    for (const p of parents) p?.normalize?.();
  }

  function rerenderAll() {
    mutate(() => {
      for (const b of [...processed]) {
        if (!b.isConnected) { processed.delete(b); continue; }
        unannotate(b);
        annotateBlock(b);
      }
    });
  }

  // 自己改 DOM 时，把这期间产生的 MutationRecord 丢弃
  function mutate(fn) {
    handleMutations(mo.takeRecords());
    try { fn(); } finally { mo.takeRecords(); }
  }

  // ---------------- 动态内容 ----------------

  const pendingRoots = new Set();
  let moTimer = 0;
  function handleMutations(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'IK-A' || n.tagName === 'INKLING-UI')) continue;
        if (n.nodeType !== 1 && n.nodeType !== 3) continue;
        pendingRoots.add(n);
      }
    }
    // 字幕更新要跟上播放节奏，其余内容 250ms 合并一次
    if (pendingRoots.size && !moTimer) {
      const fast = [...pendingRoots].some((n) => (n.nodeType === 1 ? n : n.parentElement)?.closest?.(CAPTION_SEL));
      moTimer = setTimeout(scanPending, fast ? 60 : 250);
    }
  }
  function scanPending() {
    moTimer = 0;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    if (!active) return;
    for (const n of roots) {
      if (!n.isConnected) continue;
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (!el || el.closest('inkling-ui')) continue;
      // 新内容落在已处理的块里：重新处理这个块
      const b = blockOf(el);
      if (b && processed.has(b) && !isSkipped(el)) {
        processed.delete(b);
        mutate(() => unannotate(b));
        observed.delete(b);
        aiResults.delete(b);
      }
      discover(n);
    }
  }
  const mo = new MutationObserver(handleMutations);

  // ---------------- AI 优化注释（可选）：语境释义 + 难度分级 ----------------
  // 段落进入视口附近（约 1 屏）时请求；相邻的短段落合并成一次请求，节省用量。

  let aiStopped = false;
  const aiQueue = new Set();
  const aiPending = new WeakSet();
  let aiTimer = 0;
  const aiIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      aiIO.unobserve(e.target);
      if (aiResults.has(e.target) || aiPending.has(e.target)) continue;
      aiQueue.add(e.target);
    }
    if (aiQueue.size && !aiTimer) aiTimer = setTimeout(flushAI, 150);
  }, { rootMargin: '100% 0px 100% 0px' });

  function flushAI() {
    aiTimer = 0;
    if (!S.autoAI || aiStopped) { aiQueue.clear(); return; }
    let batch = [];
    let size = 0;
    for (const b of aiQueue) {
      aiQueue.delete(b);
      if (!b.isConnected || aiResults.has(b)) continue;
      const text = blockPlainText(b).text.replace(/\s+/g, ' ').trim();
      if (batch.length && (batch.length >= 4 || size + text.length > 2400)) { requestAI(batch); batch = []; size = 0; }
      // 词典初筛的候选：块里当前被注释的词
      const cands = [...new Set([...b.querySelectorAll('ik-a')].map((a) => baseToken(a.dataset.w).toLowerCase()))];
      batch.push({ b, text, cands });
      size += text.length;
    }
    if (batch.length) requestAI(batch);
  }

  async function requestAI(batch) {
    const blocks = batch.map((x) => x.b);
    for (const b of blocks) aiPending.add(b);
    mutate(() => blocks.forEach((b) => b.setAttribute('data-ik-ai', 'loading')));
    try {
      const res = await send({ type: 'annotate', paras: batch.map(({ text, cands }) => ({ text, cands })) });
      if (!active || !S.autoAI) return;
      mutate(() => {
        blocks.forEach((b, i) => {
          aiResults.set(b, res[i]?.items || []);
          if (!b.isConnected || !processed.has(b)) return;
          unannotate(b);
          annotateBlock(b);
          b.setAttribute('data-ik-ai', 'done');
        });
      });
    } catch (e) {
      mutate(() => blocks.forEach((b) => b.removeAttribute('data-ik-ai')));
      if (e.needLogin || e.code) aiStopped = true;
    } finally {
      for (const b of blocks) aiPending.delete(b);
    }
  }

  // ---------------- 文本与语境 ----------------

  // 块的纯文本（不含注释），以及某个节点在其中的偏移
  function blockPlainText(b, target) {
    const w = textWalker(b, { all: true });
    let text = '';
    let offset = -1;
    let n;
    while ((n = w.nextNode())) {
      if (target && offset < 0 && (n === target || target.contains?.(n))) offset = text.length;
      text += n.nodeValue;
    }
    return { text, offset };
  }

  function sentenceContext(text, offset) {
    const re = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)\s*/g;
    const sents = (text.match(re) || [text]).map((s) => s);
    let pos = 0;
    let idx = 0;
    for (let i = 0; i < sents.length; i++) {
      if (offset >= pos && offset < pos + sents[i].length) { idx = i; break; }
      pos += sents[i].length;
    }
    const pick = sents.slice(Math.max(0, idx - 1), idx + 2).join('').replace(/\s+/g, ' ').trim();
    return { sentence: (sents[idx] || '').trim(), context: pick.slice(0, 1200) };
  }

  function contextForNode(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const b = blockOf(el) || el;
    const { text, offset } = blockPlainText(b, node);
    return sentenceContext(text, Math.max(0, offset));
  }

  // ---------------- 词卡（Shadow DOM） ----------------

  let host = null;
  let shadow = null;
  let card = null;
  let selBtn = null;
  let port = null;
  let current = null;

  const CARD_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card, .sel { font: 14px/1.55 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Hiragino Sans", "Yu Gothic", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      --bg: #fffdf8; --fg: #1f1d1a; --muted: #6b665e; --line: #e8e1d4; --accent: #b4541a; --accent-bg: #fbeee2;
      --btn: #f4efe6; --btn-hover: #ebe3d6; --ai-bg: #f7f4ee; --err: #b42318; }
    @media (prefers-color-scheme: dark) {
      .card, .sel { --bg: #23211e; --fg: #ece7df; --muted: #a59e92; --line: #3a3732; --accent: #f0a46a; --accent-bg: #3a2a1d;
        --btn: #2f2c28; --btn-hover: #3a3732; --ai-bg: #2a2825; --err: #ff8a80; }
    }
    .card { position: absolute; z-index: 2147483647; width: 340px; max-width: calc(100vw - 16px);
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08); padding: 14px 16px 12px; }
    .card[hidden], .sel[hidden] { display: none; }
    .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding-right: 22px; }
    .word { font-size: 20px; font-weight: 650; letter-spacing: .2px; word-break: break-word; }
    .ph { color: var(--muted); font-family: "Lucida Sans Unicode", "Segoe UI", "Arial Unicode MS", system-ui, sans-serif; }
    .ph .acc { font: 600 11px system-ui, sans-serif; color: var(--accent); background: var(--accent-bg); border-radius: 4px; padding: 0 4px; margin-right: 4px; vertical-align: 1px; }
    .close { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; border: 0; border-radius: 6px;
      background: transparent; color: var(--muted); font-size: 18px; cursor: pointer; line-height: 1; }
    .close:hover { background: var(--btn); }
    .meta { margin-top: 2px; color: var(--muted); font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .tag { background: var(--accent-bg); color: var(--accent); border-radius: 4px; padding: 0 5px; font-size: 11px; }
    .defs { margin: 8px 0 0; padding: 0; list-style: none; }
    .ctx { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      background: var(--accent-bg); border-radius: 8px; padding: 6px 10px; }
    .ctx-label { font-size: 12px; color: var(--muted); }
    .ctx-gloss { font-weight: 600; }
    .tag.lv { background: var(--fg); color: var(--bg); font-weight: 600; }
    .tag.kind { background: var(--btn); color: var(--muted); }
    .defs li { margin: 2px 0; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    button.b { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--btn); color: var(--fg);
      border-radius: 8px; padding: 4px 10px; cursor: pointer; }
    button.b:hover { background: var(--btn-hover); }
    button.b.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    @media (prefers-color-scheme: dark) { button.b.primary { color: #1f1d1a; } }
    button.b:disabled { opacity: .55; cursor: default; }
    .speak { border: 0; background: var(--btn); border-radius: 50%; width: 28px; height: 28px; cursor: pointer;
      font-size: 14px; line-height: 28px; text-align: center; padding: 0; align-self: center; }
    .speak.on { background: var(--accent-bg); }
    .ai { margin-top: 10px; background: var(--ai-bg); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; font-size: 13.5px; }
    .ai[hidden] { display: none; }
    .ai .err { color: var(--err); }
    .ai a { color: var(--accent); }
    .ai .cursor::after { content: '▍'; animation: blink 1s steps(1) infinite; color: var(--muted); }
    @keyframes blink { 50% { opacity: 0; } }
    .note { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .note.src { font-size: 11px; margin-top: 2px; }
    .sel { position: absolute; z-index: 2147483647; border: 1px solid var(--line); background: var(--accent); color: #fff;
      width: 28px; height: 28px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,.18); padding: 0; }
  `;

  function ensureUI() {
    if (host?.isConnected) return;
    host = document.createElement('inkling-ui');
    host.style.cssText = 'position:absolute!important;top:0!important;left:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;display:block!important;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CARD_CSS}</style>
      <div class="card" role="dialog" aria-label="${esc(t('card_aria'))}" hidden></div>
      <button class="sel" title="${esc(t('sel_title'))}" hidden>${esc(t('sel_label'))}</button>`;
    card = shadow.querySelector('.card');
    selBtn = shadow.querySelector('.sel');
    selBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    selBtn.addEventListener('click', onSelBtn);
    for (const ev of ['mousedown', 'mouseup', 'click', 'keydown']) host.addEventListener(ev, (e) => e.stopPropagation());
    document.documentElement.append(host);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function place(el, rect, width) {
    const sx = window.scrollX, sy = window.scrollY;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    el.style.left = '0px';
    el.style.top = '0px';
    const h = el.offsetHeight || 180;
    let left = rect.left + sx;
    left = Math.max(sx + 8, Math.min(left, sx + vw - width - 8));
    let top = rect.bottom + sy + 8;
    if (rect.bottom + h + 16 > vh) {
      // 下方放不下：放到词上方；上方也放不下就贴着窗口底部，保证整张卡片可见
      top = rect.top - h - 8 > 0 ? rect.top + sy - h - 8 : Math.max(sy + 8, sy + vh - h - 8);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // 卡片内容变高（AI 解释流式输出）后超出窗口底部时，重新定位
  let refitRaf = 0;
  function refitCard() {
    if (refitRaf || !current?.anchor) return;
    refitRaf = requestAnimationFrame(() => {
      refitRaf = 0;
      if (!current || card.hidden) return;
      const r = card.getBoundingClientRect();
      if (r.bottom <= window.innerHeight - 8) return;
      const a = current.anchor;
      const rect = { left: a.left - window.scrollX, top: a.top - window.scrollY, bottom: a.bottom - window.scrollY };
      place(card, rect, r.width);
    });
  }

  function closeCard() {
    if (port) { try { port.disconnect(); } catch { /* 已断开 */ } port = null; }
    if (card) card.hidden = true;
    current = null;
  }

  function openCard(opts) {
    ensureUI();
    closeCard();
    current = opts;
    const { text, I, rect, ai } = opts;
    opts.anchor = { left: rect.left + window.scrollX, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
    const isWord = !!I;
    const isPhrase = /\s/.test(text);
    const KIND_NAMES = { word: t('kind_word'), sense: t('kind_sense'), phrase: isPhrase ? t('kind_phrase') : t('kind_idiom') };
    // AI 按语境给出的释义与难度（开启「AI 优化注释」时才有）
    const aiRow = ai ? `<div class="ctx"><span class="ctx-label">${esc(t('ctx_label'))}</span><b class="ctx-gloss">${esc(ai.gloss)}</b>
        ${ai.level ? `<span class="tag lv" title="${esc(t('cefr_title'))}">${esc(ai.level)}</span>` : ''}
        <span class="tag kind">${esc(KIND_NAMES[ai.kind] || t('kind_word'))}</span></div>` : '';
    const inLearning = I && (learning.has(I.l));
    const tags = I ? I.t.split(' ').filter(Boolean).map((x) => `<span class="tag">${esc(M[`tag_${x}`] || x)}</span>`).join('') : '';
    const lemmaNote = I && I.w.toLowerCase() !== baseToken(text).toLowerCase() ? `<span>${t('lemma', `<b>${esc(I.w)}</b>`)}</span>` : '';
    const rank = I ? `<span>${esc(t('rank', I.r >= 30000 ? '30000+' : I.r))}</span>` : '';
    card.innerHTML = `
      <button class="close" aria-label="${esc(t('close'))}">×</button>
      <div class="head">
        <span class="word">${esc(text)}</span>
        ${I?.us ? `<span class="ph" title="${esc(t('us_ipa'))}"><span class="acc">${esc(t('us_badge'))}</span>/${esc(I.us)}/</span>` : I?.ph ? `<span class="ph">/${esc(I.ph)}/</span>` : ''}
        <button class="speak" title="${esc(t('speak_title'))}" aria-label="${esc(t('speak'))}">🔊</button>
      </div>
      ${aiRow}
      ${isWord ? `<div class="meta">${lemmaNote}${rank}${tags}</div>
      ${I.noGloss ? `<div class="note">${esc(t('no_gloss', t(`gloss_${I.gl}`)))}</div>` : `<ul class="defs">${I.tr.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}
      ${I.src === 'wiktionary' ? `<div class="note src">${esc(t('gloss_source'))}</div>` : ''}` : ai ? '' : `<div class="note">${esc(t(isPhrase ? 'not_in_dict_phrase' : 'not_in_dict_word'))}</div>`}
      <div class="ai" hidden></div>
      <div class="row">
        <button class="b primary act-ai">${esc(t('ai_explain'))}</button>
        ${opts.annotated ? `<button class="b act-known">${esc(t(isPhrase ? 'know_phrase' : 'know_word'))}</button>` : ''}
        ${isWord && !opts.annotated ? `<button class="b act-learn">${esc(t(inLearning ? 'remove_learning' : 'add_learning'))}</button>` : ''}
        ${isWord && opts.annotated && inLearning ? `<button class="b act-learn">${esc(t('remove_learning'))}</button>` : ''}
      </div>`;
    card.hidden = false;
    place(card, rect, Math.min(340, document.documentElement.clientWidth - 16));
    card.querySelector('.close').addEventListener('click', closeCard);
    card.querySelector('.speak').addEventListener('click', (e) => speak(text, e.currentTarget));
    card.querySelector('.act-ai').addEventListener('click', () => explain());
    card.querySelector('.act-known')?.addEventListener('click', () => markKnown(I || { l: opts.lemma || text.toLowerCase() }));
    card.querySelector('.act-learn')?.addEventListener('click', (e) => toggleLearning(I, e.currentTarget));
    if (S.autoSpeak) speak(text, card.querySelector('.speak'));
    if (!isWord && !ai) explain();
  }

  function speak(text, btn) {
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = Number(S.speechRate) || 0.9;
      const v = pickVoice(synth.getVoices(), S.speechVoice);
      if (v) { u.voice = v; u.lang = v.lang; }
      btn.classList.add('on');
      card.dataset.speaking = text;
      card.dataset.rate = String(Number(S.speechRate) || 0.9);
      u.onend = u.onerror = () => btn.classList.remove('on');
      synth.speak(u);
    } catch { /* 浏览器不支持朗读 */ }
  }

  // 指定的声音；否则优先常见的美式英语声音
  function pickVoice(voices, name) {
    return (name && voices.find((x) => x.name === name))
      || voices.find((x) => x.lang === 'en-US' && /Samantha|Google US|Aria|Jenny|Alex/i.test(x.name))
      || voices.find((x) => x.lang === 'en-US')
      || voices.find((x) => /^en/i.test(x.lang));
  }

  function explain() {
    if (!current) return;
    const box = card.querySelector('.ai');
    const btn = card.querySelector('.act-ai');
    box.hidden = false;
    box.innerHTML = '<span class="out cursor"></span>';
    const out = box.querySelector('.out');
    btn.disabled = true;
    btn.textContent = t('ai_explaining');
    if (port) { try { port.disconnect(); } catch { /* */ } }
    try {
      port = chrome.runtime.connect({ name: 'explain' });
    } catch {
      showAIError(box, { message: t('ext_updated') });
      return;
    }
    const myPort = port;
    myPort.onMessage.addListener((m) => {
      if (port !== myPort) return;
      if (m.type === 'delta') { out.textContent += m.text; refitCard(); }
      else if (m.type === 'done') {
        out.classList.remove('cursor');
        btn.disabled = false; btn.textContent = t('ai_reexplain');
        box.dataset.state = 'done';
        refitCard();
      } else if (m.type === 'error') {
        out.classList.remove('cursor');
        btn.disabled = false; btn.textContent = t('ai_explain');
        showAIError(box, m.error, out.textContent);
        refitCard();
      }
    });
    myPort.onDisconnect.addListener(() => { if (port === myPort) port = null; });
    myPort.postMessage({ text: current.text, context: current.context, sentence: current.sentence });
  }

  function showAIError(box, err, partial) {
    box.dataset.state = 'error';
    const parts = [];
    if (partial) parts.push(`<div>${esc(partial)}</div>`);
    parts.push(`<div class="err">${esc(err?.message || t('error_generic'))}</div>`);
    if (err?.link) parts.push(`<div><a href="${esc(err.link)}" target="_blank" rel="noopener">${esc(err.linkText || t('view'))}</a></div>`);
    if (err?.needLogin || CONFIG_CODES.has(err?.code)) parts.push(`<div><a href="#" class="go-opt">${esc(t('open_settings'))}</a></div>`);
    box.innerHTML = parts.join('');
    box.querySelector('.go-opt')?.addEventListener('click', (e) => { e.preventDefault(); send({ type: 'openOptions', hash: 'ai' }); });
  }

  async function saveLists() {
    S.knownWords = [...known];
    S.learningWords = [...learning];
    await chrome.storage.local.set({ knownWords: S.knownWords, learningWords: S.learningWords });
  }

  async function markKnown(I) {
    if (!I) return;
    known.add(I.l);
    learning.delete(I.l);
    closeCard();
    rerenderAll();
    await saveLists();
  }

  async function toggleLearning(I, btn) {
    if (!I) return;
    if (learning.has(I.l)) { learning.delete(I.l); btn.textContent = t('add_learning'); }
    else { learning.add(I.l); known.delete(I.l); btn.textContent = t('remove_learning'); }
    rerenderAll();
    await saveLists();
  }

  // ---------------- 交互：点击注释词 / 划词 ----------------

  function onClick(e) {
    if (!active) return;
    const a = e.target?.closest?.('ik-a');
    if (!a) return;
    // 在链接里也只弹词卡、不跳转
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const phrase = /\s/.test(a.dataset.w);
    const I = phrase ? null : info.get(baseToken(a.dataset.w).toLowerCase()) || null;
    const ai = a.dataset.ai ? { gloss: a.dataset.ag, level: a.dataset.level || '', kind: a.dataset.kind } : null;
    if (!I && !ai) return;
    const { sentence, context } = contextForNode(a);
    openCard({ text: a.dataset.w, I, ai, lemma: a.dataset.l, rect: a.getBoundingClientRect(), annotated: true, sentence, context });
  }

  let selState = null;
  function onMouseUp(e) {
    if (!active || e.button !== 0) return;
    if (e.target?.closest?.('inkling-ui')) return;
    setTimeout(checkSelection, 10);
  }
  function checkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideSelBtn(); return; }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('inkling-ui, input, textarea') || el.isContentEditable) { hideSelBtn(); return; }
    const frag = range.cloneContents();
    frag.querySelectorAll('rt, rp, ik-g, ik-ipa').forEach((x) => x.remove());
    const text = frag.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80 || !/[A-Za-z]/.test(text)) { hideSelBtn(); return; }
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    ensureUI();
    selState = { text, range: range.cloneRange(), rect };
    selBtn.hidden = false;
    selBtn.style.left = `${rect.right + window.scrollX + 4}px`;
    selBtn.style.top = `${rect.bottom + window.scrollY + 4}px`;
  }
  function hideSelBtn() {
    if (selBtn) selBtn.hidden = true;
    selState = null;
  }

  async function onSelBtn() {
    const st = selState;
    hideSelBtn();
    if (!st) return;
    const text = st.text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '') || st.text;
    const { sentence, context } = contextForNode(st.range.startContainer);
    let I = null;
    if (/^[A-Za-z]+(?:['’][A-Za-z]+)?$/.test(text)) {
      const k = baseToken(text).toLowerCase();
      try { await ensureInfo([k]); } catch { /* */ }
      I = info.get(k) || null;
    }
    openCard({ text, I, rect: st.rect, annotated: false, sentence, context, selection: true });
  }

  function onMouseDown(e) {
    if (e.target?.closest?.('inkling-ui')) return;
    if (card && !card.hidden && !e.target?.closest?.('ik-a')) closeCard();
    hideSelBtn();
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeCard(); hideSelBtn(); }
  }

  // 复制时去掉注释文字
  function onCopy(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const holder = document.createElement('div');
    let hit = false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const frag = sel.getRangeAt(i).cloneContents();
      const anns = frag.querySelectorAll('rt, rp, ik-g');
      if (anns.length || frag.querySelector('ik-a')) hit = true;
      anns.forEach((x) => x.remove());
      holder.append(frag);
    }
    if (!hit || !e.clipboardData) return;
    holder.querySelectorAll('ik-a').forEach((a) => a.replaceWith(document.createTextNode(a.dataset.w || a.textContent)));
    holder.querySelectorAll('ruby').forEach((r) => r.replaceWith(...r.childNodes));
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap;';
    document.body.append(holder);
    const plain = holder.innerText;
    const html = holder.innerHTML;
    holder.remove();
    e.clipboardData.setData('text/plain', plain);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
  }

  // ---------------- 启停 ----------------

  let pageBg = [255, 255, 255];
  function detectDarkPage() {
    const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    pageBg = [255, 255, 255];
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const [r, g, b, a = 1] = parse(getComputedStyle(el).backgroundColor);
      if (a > 0.5 && r !== undefined) { pageBg = [r, g, b]; break; }
    }
    document.documentElement.classList.toggle('ik-dark-page', luminance(pageBg) < 0.18);
  }

  function luminance([r, g, b]) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // 释义颜色：用设置里的颜色；与网页背景对比度太低（如深色网页上的黑色）时自动换成看得清的颜色
  function applyGlossColor() {
    let color = /^#[0-9a-f]{6}$/i.test(S.glossColor) ? S.glossColor : '#000000';
    const l1 = luminance(hexToRgb(color));
    const l2 = luminance(pageBg);
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (contrast < 3) color = l2 < 0.18 ? '#e8e8e8' : '#222222';
    document.documentElement.style.setProperty('--ik-gloss-color', color);
  }

  function start() {
    if (active || !document.body) return;
    active = true;
    detectDarkPage();
    applyGlossColor();
    document.documentElement.classList.add('ik-on');
    document.documentElement.dataset.ikMode = S.displayMode;
    mo.observe(document.body, { childList: true, subtree: true });
    discover(document.body);
  }

  function stop() {
    if (!active) return;
    active = false;
    io.disconnect();
    aiIO.disconnect();
    mo.disconnect();
    queue.clear();
    closeCard();
    hideSelBtn();
    unannotate(document.body);
    processed.clear();
    document.documentElement.classList.remove('ik-on');
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => KEYS.includes(k));
    if (!keys.length) return;
    const raw = { ...S };
    for (const k of keys) raw[k] = changes[k].newValue ?? DEFAULTS[k];
    const prevMode = S.displayMode;
    const prevAuto = S.autoAI;
    applySettings(raw);
    const want = shouldBeActive();
    if (!want) { stop(); return; }
    if (!active) {
      gen++; // stop() 断开了观察器，重新发现所有块
      start();
      return;
    }
    document.documentElement.dataset.ikMode = S.displayMode;
    if (keys.includes('glossColor')) applyGlossColor();
    if (keys.some((k) => ['level', 'knownWords', 'learningWords', 'displayMode', 'autoAI', 'showPhonetic'].includes(k))) {
      if (S.displayMode !== prevMode || S.autoAI !== prevAuto) aiStopped = false;
      // AI 的取舍与读者水平有关：水平变了就重新请求（后台按水平分档缓存）；关掉 AI 则回到词典注释
      if (keys.includes('level') || !S.autoAI) aiResults = new WeakMap();
      rerenderAll();
    }
  });

  window.addEventListener('click', onClick, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('copy', onCopy, true);

  // 释义语言切换：清掉词典信息缓存和 AI 结果，整页重新注释
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('glossLanguage' in changes)) return;
    info.clear();
    aiResults = new WeakMap();
    if (active) {
      stop();
      gen++;
      start();
    }
  });

  // 界面语言切换：重新取文案；词卡和划词按钮按新语言重建
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('uiLanguage' in changes)) return;
    closeCard();
    hideSelBtn();
    if (host) { host.remove(); host = null; }
    loadMessages();
  });

  chrome.storage.local.get(KEYS, async (raw) => {
    applySettings(raw || {});
    await loadMessages();
    if (shouldBeActive()) start();
  });
})();
