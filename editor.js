(() => {
  const fileInput = document.getElementById('file-input');
  const fileNameLabel = document.getElementById('file-name');
  const dropzone = document.getElementById('dropzone');
  const previewFrame = document.getElementById('preview-frame');
  const selectionInfo = document.getElementById('selection-info');

  let editorIdCounter = 0;

  // 편집 도구 전용 표식. 내보내기 단계에서 모두 제거된다.
  const HOVER_CLASS = '__editor-hover';
  const SELECTED_CLASS = '__editor-selected';
  const EDITOR_STYLE_ID = '__editor-injected-style';

  // 선택 목록. 한 개일 때만 selectedElement에 담아 단일 편집 패널을 쓰고,
  // 두 개 이상이면 selectedElement는 null로 두고 일괄 편집 패널을 쓴다.
  let selectedElements = [];
  let selectedElement = null;
  let hoveredElement = null;
  let multiSelectMode = false; // 툴바 '복수 선택' 토글. 켜면 클릭이 Ctrl+클릭처럼 동작한다.
  let originalFileName = '';
  let mode = 'edit'; // 'edit' | 'view'
  // 보기 모드 진입 시점의 문서 스냅샷. 페이지가 다른 문서로 이동해 버렸을 때
  // 편집 내용을 되살리는 복구 지점으로 쓴다.
  let lastGoodHtml = null;

  function loadHtmlIntoPreview(htmlText) {
    dropzone.hidden = true;
    previewFrame.hidden = false;
    previewFrame.srcdoc = htmlText;
  }

  function assignEditorIds(doc) {
    // <br>은 '내용' 입력칸의 줄바꿈으로 다루므로 따로 선택·트리 대상이 되지 않게 한다.
    const excludedTags = new Set(['SCRIPT', 'STYLE', 'BR', 'WBR']);
    const body = doc.body;
    if (!body) return;

    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        if (!excludedTags.has(child.tagName)) {
          if (!child.hasAttribute('data-editor-id')) {
            editorIdCounter += 1;
            child.setAttribute('data-editor-id', `el-${editorIdCounter}`);
          }
          walk(child);
        }
      }
    };

    walk(body);
  }

  // 하이라이트는 style 속성이 아닌 클래스로만 적용한다.
  // 이 <style> 태그와 클래스는 내보내기 시 함께 제거된다.
  function injectEditorStyles(doc) {
    if (doc.getElementById(EDITOR_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = EDITOR_STYLE_ID;
    style.textContent = `
      .${HOVER_CLASS} {
        outline: 1px solid #3b82f6 !important;
        outline-offset: -1px !important;
        cursor: pointer !important;
      }
      .${SELECTED_CLASS} {
        outline: 2px solid #ef4444 !important;
        outline-offset: -1px !important;
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function isEditable(el) {
    return !!(el && el.nodeType === 1 && el.hasAttribute('data-editor-id'));
  }

  function renderSelectionInfo(el) {
    if (selectedElements.length > 1) {
      selectionInfo.textContent = `선택됨: ${selectedElements.length}개 요소`;
      return;
    }
    if (!el) {
      selectionInfo.innerHTML = '<span class="selection-info__empty">선택된 요소 없음</span>';
      return;
    }
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('data-editor-id');
    selectionInfo.innerHTML =
      '선택됨: <span class="selection-info__tag"></span> ' +
      '<span class="selection-info__id"></span>';
    selectionInfo.querySelector('.selection-info__tag').textContent = `<${tag}>`;
    selectionInfo.querySelector('.selection-info__id').textContent = `#${id}`;
  }

  function setHovered(el) {
    if (hoveredElement === el) return;
    if (hoveredElement) hoveredElement.classList.remove(HOVER_CLASS);
    hoveredElement = el;
    // 선택된 요소에는 hover 하이라이트를 겹치지 않는다.
    if (hoveredElement && !selectedElements.includes(hoveredElement)) {
      hoveredElement.classList.add(HOVER_CLASS);
    }
  }

  function sameSelection(list) {
    return list.length === selectedElements.length &&
      list.every((el, i) => el === selectedElements[i]);
  }

  // 선택 목록 전체를 교체한다. 단일 선택도 모두 이 함수를 거친다.
  function setSelection(list) {
    const next = Array.from(new Set(list)).filter(isEditable);
    if (sameSelection(next)) return;

    selectedElements.forEach((el) => el.classList.remove(SELECTED_CLASS));
    selectedElements = next;
    selectedElement = next.length === 1 ? next[0] : null;
    selectedElements.forEach((el) => {
      el.classList.remove(HOVER_CLASS);
      el.classList.add(SELECTED_CLASS);
    });

    renderSelectionInfo(selectedElement);

    window.dispatchEvent(new CustomEvent('elementSelected', {
      detail: selectedElement
        ? {
            editorId: selectedElement.getAttribute('data-editor-id'),
            tagName: selectedElement.tagName.toLowerCase(),
            inlineStyle: selectedElement.getAttribute('style') || '',
            element: selectedElement,
            // 다음 단계의 속성 패널이 현재 값을 읽을 때 사용
            computedStyle: previewFrame.contentWindow.getComputedStyle(selectedElement)
          }
        : null
    }));
  }

  function selectElement(el) {
    setSelection(el ? [el] : []);
  }

  // Ctrl+클릭: 선택 목록에 있으면 빼고, 없으면 더한다.
  function toggleInSelection(el) {
    setSelection(selectedElements.includes(el)
      ? selectedElements.filter((s) => s !== el)
      : [...selectedElements, el]);
  }

  /* --- 드래그 범위 선택 ------------------------------------------ */

  const dragBox = document.getElementById('drag-box');
  const DRAG_THRESHOLD = 5; // 이보다 적게 움직이면 클릭으로 본다.
  let drag = null;

  // 직접 품은 글자가 있는 요소만 범위 선택 대상으로 삼는다.
  // (감싸는 레이아웃용 div까지 잡히면 글자 크기 일괄 변경이 의도와 달라진다)
  function hasOwnText(el) {
    return Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== ''
    );
  }

  // 시작점은 문서 좌표로 저장해 드래그 중 스크롤해도 범위가 어긋나지 않게 한다.
  function dragRectInClient(win) {
    const x1 = drag.startX - win.scrollX;
    const y1 = drag.startY - win.scrollY;
    return {
      left: Math.min(x1, drag.curX),
      top: Math.min(y1, drag.curY),
      right: Math.max(x1, drag.curX),
      bottom: Math.max(y1, drag.curY)
    };
  }

  function drawDragBox(rect) {
    const frameRect = previewFrame.getBoundingClientRect();
    const ox = frameRect.left + previewFrame.clientLeft;
    const oy = frameRect.top + previewFrame.clientTop;
    dragBox.style.left = `${ox + rect.left}px`;
    dragBox.style.top = `${oy + rect.top}px`;
    dragBox.style.width = `${rect.right - rect.left}px`;
    dragBox.style.height = `${rect.bottom - rect.top}px`;
    dragBox.hidden = false;
  }

  function elementsInRect(doc, rect) {
    return Array.from(doc.body.querySelectorAll('[data-editor-id]')).filter((el) => {
      if (!hasOwnText(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return r.left < rect.right && r.right > rect.left &&
        r.top < rect.bottom && r.bottom > rect.top;
    });
  }

  function beginDrag(e, additive) {
    const win = e.view;
    drag = {
      doc: e.target.ownerDocument,
      startX: e.clientX + win.scrollX,
      startY: e.clientY + win.scrollY,
      curX: e.clientX,
      curY: e.clientY,
      additive,
      base: selectedElements.slice(), // 추가 선택일 때 이어 붙일 기존 목록
      active: false
    };
  }

  function updateDrag(e) {
    if (!drag) return;
    // 버튼을 뗀 사실을 놓쳤다면(미리보기 밖에서 뗀 경우 등) 그대로 끝낸다.
    if (e.buttons === 0) {
      endDrag(false);
      return;
    }
    drag.curX = e.clientX;
    drag.curY = e.clientY;
    const rect = dragRectInClient(e.view);
    if (!drag.active) {
      if (rect.right - rect.left < DRAG_THRESHOLD && rect.bottom - rect.top < DRAG_THRESHOLD) return;
      drag.active = true;
      setHovered(null);
    }
    drawDragBox(rect);
  }

  function endDrag(apply) {
    if (!drag) return;
    const { doc, active, additive, base } = drag;
    const rect = active && apply ? dragRectInClient(doc.defaultView) : null;
    drag = null;
    dragBox.hidden = true;
    if (!rect) return;

    const hits = elementsInRect(doc, rect);
    if (!hits.length) {
      showToast('범위 안에 글자가 있는 요소가 없습니다.');
      if (!additive) selectElement(null);
      return;
    }
    setSelection(additive ? [...base, ...hits] : hits);
  }

  function attachSelectionHandlers(doc) {
    doc.addEventListener('mouseover', (e) => {
      if (mode !== 'edit' || drag) return;
      setHovered(isEditable(e.target) ? e.target : null);
    }, true);

    doc.addEventListener('mouseout', (e) => {
      if (e.target === hoveredElement) setHovered(null);
    }, true);

    // 미리보기 영역을 벗어나면 hover 해제
    doc.addEventListener('mouseleave', () => setHovered(null), true);

    // 선택은 mousedown에서 처리한다. iframe이 포커스를 얻기 전의 첫 클릭도
    // 놓치지 않고, 반응도 더 즉각적이다.
    doc.addEventListener('mousedown', (e) => {
      if (mode !== 'edit') return;

      e.preventDefault(); // 텍스트 드래그 선택 방지
      e.stopPropagation();

      // Ctrl(맥은 Cmd)·Shift+클릭 또는 복수 선택 모드에서는 목록에 더하거나 뺀다.
      const additive = e.ctrlKey || e.metaKey || e.shiftKey || multiSelectMode;
      if (e.button === 0) beginDrag(e, additive);

      if (isEditable(e.target)) {
        if (additive) toggleInSelection(e.target);
        else selectElement(e.target);
      } else if (!additive && (e.target === doc.body || e.target === doc.documentElement)) {
        // 빈 공간을 누르면 선택 해제
        selectElement(null);
      }
    }, true);

    doc.addEventListener('mousemove', updateDrag, true);
    doc.addEventListener('mouseup', () => endDrag(true), true);

    doc.addEventListener('click', (e) => {
      // 편집 모드: 캡처 단계에서 가로채 원본 동작을 모두 막는다.
      if (mode === 'edit') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // 보기 모드: 페이지 스크립트는 그대로 돌리고, 문서 이동만 막는다.
      //
      // srcdoc 문서의 baseURI는 편집기 자신의 URL이다. 따라서 '#id' 같은
      // 해시 링크조차 editor.html#id 로 resolve되어 편집기가 자기 iframe
      // 안에 재귀 로드된다. 해시든 상대경로든 전부 막고, 해시는 같은 문서
      // 안에서 스크롤로 흉내낸다.
      const link = e.target.closest && e.target.closest('a[href]');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href) return;

      e.preventDefault();

      if (href.startsWith('#')) {
        const id = href.slice(1);
        const target = id
          ? (doc.getElementById(id) || doc.querySelector(`[name="${id}"]`))
          : doc.body;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      showToast('보기 모드에서는 다른 페이지로 이동할 수 없습니다.');
    }, true);

    // 폼 제출은 어느 모드에서도 문서를 갈아치우므로 항상 막는다.
    doc.addEventListener('submit', (e) => {
      e.preventDefault();
      if (mode === 'view') showToast('보기 모드에서는 폼 제출이 차단됩니다.');
    }, true);

    // 포커스가 iframe 안에 있어도 단축키가 동작하도록 전달한다.
    doc.addEventListener('keydown', handleEditorKey);
  }

  previewFrame.addEventListener('load', () => {
    let doc;
    try {
      doc = previewFrame.contentDocument;
    } catch {
      doc = null; // 다른 출처로 이동한 경우 접근이 차단된다.
    }

    if (!doc || !doc.body) {
      showToast('미리보기 문서에 접근할 수 없습니다. 파일을 다시 열어주세요.');
      return;
    }

    // srcdoc으로 넣은 문서는 location이 항상 about:srcdoc이다. 값이 다르면
    // 페이지 스크립트 등이 미리보기를 다른 문서로 이동시킨 것이므로,
    // 그 문서를 계측하지 않고(편집기 자신일 수도 있다) 직전 상태로 되돌린다.
    if (doc.location.href !== 'about:srcdoc') {
      if (lastGoodHtml) {
        showToast('페이지가 다른 문서로 이동해 직전 상태로 복구했습니다.');
        previewFrame.srcdoc = lastGoodHtml;
      } else {
        showToast('페이지가 다른 문서로 이동했습니다. 파일을 다시 열어주세요.');
      }
      return;
    }

    // 새 문서이므로 이전 선택 상태를 초기화한다.
    selectedElements = [];
    selectedElement = null;
    hoveredElement = null;
    drag = null;
    dragBox.hidden = true;
    renderSelectionInfo(null);
    syncPanel(null);

    // 항상 편집 모드로 시작한다.
    mode = 'edit';
    applyModeUI();

    assignEditorIds(doc);
    injectEditorStyles(doc);
    attachSelectionHandlers(doc);
    resetHistory();
    buildTree(doc);

    document.getElementById('export-btn').disabled = false;
    modeButtons.forEach((btn) => { btn.disabled = false; });
    multiSelectBtn.disabled = false;
  });

  // 미리보기 밖에서 버튼을 떼더라도 드래그를 마무리한다.
  window.addEventListener('mouseup', () => endDrag(true));

  // 이후 단계(속성 패널·내보내기)에서 사용하는 공용 접근자
  window.FrontEndEditor = {
    getSelectedElement: () => selectedElement,
    getSelectedElements: () => selectedElements.slice(),
    setSelection,
    getPreviewDocument: () => previewFrame.contentDocument,
    getPreviewWindow: () => previewFrame.contentWindow,
    selectElement,
    EDITOR_STYLE_ID,
    HOVER_CLASS,
    SELECTED_CLASS
  };

  /* ---------------------------------------------------------------
   * 외부 리소스 (CSS·JS·이미지)
   *
   * 미리보기는 srcdoc 문서라 상대 경로(assets/style.css, img/a.jpg)가
   * 편집기 기준으로 풀려 아무것도 불러오지 못한다. 폴더를 통째로 열면
   * 폴더 안 파일을 blob URL로 만들어 경로를 바꿔 끼우고, 내보낼 때
   * 원래 경로로 되돌린다.
   * ------------------------------------------------------------- */

  const pageSelect = document.getElementById('page-select');

  // 폴더로 열었을 때의 상태. 파일 하나만 열었다면 null.
  let project = null;

  const HTML_FILE_RE = /\.html?$/i;

  // 경로 대신 파일을 가리켜야 하는 속성들. <a href> 같은 페이지 이동 링크는 제외한다.
  const URL_ATTRS = [
    ['script[src]', 'src'], ['img[src]', 'src'], ['source[src]', 'src'],
    ['video[src]', 'src'], ['video[poster]', 'poster'], ['audio[src]', 'src'],
    ['track[src]', 'src'], ['embed[src]', 'src'], ['object[data]', 'data'],
    ['input[type="image"][src]', 'src'], ['image[href]', 'href'], ['use[href]', 'href']
  ];
  const LINK_REL_RE = /\b(stylesheet|icon|preload|modulepreload)\b/i;
  const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;

  // 폴더 안 파일을 가리키는 상대 경로인지. (http:, data:, #id, //cdn 등은 제외)
  function isRelativeRef(raw) {
    const v = (raw || '').trim();
    return v !== '' && !v.startsWith('#') && !v.startsWith('//') &&
      !/^[a-z][a-z0-9+.-]*:/i.test(v);
  }

  function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i + 1);
  }

  // 기준 폴더 + 상대 경로 → 폴더 안 경로 ('../', './', '/' 처리)
  function resolvePath(baseDir, ref) {
    let clean = ref.trim().split(/[?#]/)[0];
    try { clean = decodeURIComponent(clean); } catch { /* 잘못된 % 표기는 그대로 둔다 */ }
    const parts = clean.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
    clean.split('/').forEach((seg) => {
      if (seg === '' || seg === '.') return;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    });
    return parts.join('/');
  }

  // 대소문자만 다른 경로도 찾아 준다. (Windows에서는 구분하지 않으므로)
  function findFile(path) {
    return project.files.get(path) || project.lowerFiles.get(path.toLowerCase()) || null;
  }

  const MIME_BY_EXT = { css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml' };

  // CSS 안의 url()·@import를 비동기 변환기로 바꿔 끼운다.
  async function replaceCssRefs(text, convert) {
    const matches = Array.from(text.matchAll(CSS_URL_RE));
    if (!matches.length) return text;
    let out = '';
    let last = 0;
    for (const m of matches) {
      const isImport = m[4] !== undefined;
      const raw = isImport ? m[4] : m[2];
      const next = await convert(raw);
      out += text.slice(last, m.index);
      out += next ? m[0].replace(raw, next) : m[0];
      last = m.index + m[0].length;
    }
    return out + text.slice(last);
  }

  // 폴더 안 파일 → Blob. CSS는 안쪽의 상대 경로까지 (CSS 파일 위치 기준으로) 바꾼다.
  function assetBlob(path, stack = new Set()) {
    if (stack.has(path)) return Promise.resolve(null); // @import 순환 방지
    if (project.blobCache.has(path)) return project.blobCache.get(path);

    const job = (async () => {
      const file = findFile(path);
      if (!file) {
        project.missing.add(path);
        return null;
      }
      const ext = path.split('.').pop().toLowerCase();
      if (ext !== 'css') {
        return MIME_BY_EXT[ext] ? new Blob([file], { type: MIME_BY_EXT[ext] }) : file;
      }
      const inner = new Set(stack).add(path);
      const css = await replaceCssRefs(await file.text(), async (raw) => {
        if (!isRelativeRef(raw)) return null;
        const blob = await assetBlob(resolvePath(dirOf(path), raw), inner);
        return blob ? trackUrl(blob) : null;
      });
      return new Blob([css], { type: 'text/css' });
    })();

    project.blobCache.set(path, job);
    return job;
  }

  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    project.urls.push(url);
    return url;
  }

  // HTML에 적힌 경로 한 개 → blob URL. 내보낼 때 원래 표기로 되돌리기 위해
  // 표기마다 URL을 따로 만들고 역방향 표를 남긴다.
  async function htmlRefToUrl(baseDir, raw) {
    if (!isRelativeRef(raw)) return null;
    if (project.rawCache.has(raw)) return project.rawCache.get(raw);

    const hashAt = raw.indexOf('#');
    const beforeHash = hashAt < 0 ? raw : raw.slice(0, hashAt);
    const hash = hashAt < 0 ? '' : raw.slice(hashAt);

    const blob = await assetBlob(resolvePath(baseDir, raw));
    if (!blob) return null;
    const url = trackUrl(blob);
    project.reverse.set(url, beforeHash);
    project.rawCache.set(raw, url + hash);
    return url + hash;
  }

  // 문서 안의 모든 외부 경로를 convert(raw) 결과로 바꾼다. (null이면 그대로)
  async function rewriteDocRefs(doc, convert) {
    const tasks = [];
    const setAttr = (el, name) => {
      tasks.push(convert(el.getAttribute(name)).then((v) => { if (v) el.setAttribute(name, v); }));
    };

    doc.querySelectorAll('link[href]').forEach((el) => {
      if (LINK_REL_RE.test(el.getAttribute('rel') || '')) setAttr(el, 'href');
    });
    URL_ATTRS.forEach(([selector, name]) => {
      doc.querySelectorAll(selector).forEach((el) => setAttr(el, name));
    });
    doc.querySelectorAll('img[srcset], source[srcset]').forEach((el) => {
      const entries = el.getAttribute('srcset').split(',').map((s) => s.trim()).filter(Boolean);
      tasks.push(Promise.all(entries.map(async (entry) => {
        const [raw, ...desc] = entry.split(/\s+/);
        const v = await convert(raw);
        return [v || raw, ...desc].join(' ');
      })).then((list) => el.setAttribute('srcset', list.join(', '))));
    });
    doc.querySelectorAll('[style*="url("]').forEach((el) => {
      tasks.push(replaceCssRefs(el.getAttribute('style'), convert)
        .then((v) => el.setAttribute('style', v)));
    });
    doc.querySelectorAll('style').forEach((el) => {
      tasks.push(replaceCssRefs(el.textContent, convert).then((v) => { el.textContent = v; }));
    });

    await Promise.all(tasks);
  }

  function serializeParsed(doc) {
    return `${serializeDoctype(doc)}\n${doc.documentElement.outerHTML}`;
  }

  // 내보내기 직전: blob URL을 원래 적혀 있던 경로로 되돌린다.
  function restoreAssetRefs(html) {
    if (!project) return html;
    let out = html;
    project.reverse.forEach((raw, url) => {
      out = out.split(url).join(raw);
    });
    return out;
  }

  function releaseProject() {
    if (project) project.urls.forEach((url) => URL.revokeObjectURL(url));
    project = null;
    pageSelect.hidden = true;
    pageSelect.textContent = '';
  }

  function startDocument(name, html) {
    editorIdCounter = 0;
    originalFileName = name;
    loadHtmlIntoPreview(html);
  }

  // 파일 하나만 연 경우: 예전처럼 그대로 띄우되, 불러오지 못할 외부 파일이
  // 있으면 폴더로 열라고 알려 준다.
  async function handleFile(file) {
    if (!file) return;
    if (!HTML_FILE_RE.test(file.name)) {
      alert('HTML 파일(.html)만 열 수 있습니다.');
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch {
      alert('파일을 읽는 중 오류가 발생했습니다.');
      return;
    }

    releaseProject();
    fileNameLabel.textContent = file.name;
    startDocument(file.name, text);

    const refs = new Set();
    const probe = new DOMParser().parseFromString(text, 'text/html');
    await rewriteDocRefs(probe, async (raw) => {
      if (isRelativeRef(raw)) refs.add(raw);
      return null;
    });
    if (refs.size) {
      showToast(`외부 파일 ${refs.size}개(CSS·이미지 등)는 파일만 열어서는 보이지 않습니다. ` +
        '‘폴더 열기’로 프로젝트 폴더를 열어주세요.', 6000);
    }
  }

  // 폴더를 연 경우. entries: [{ path: '폴더 기준 경로', file }]
  function handleFolder(entries, folderName) {
    const htmlPaths = entries.map((e) => e.path).filter((p) => HTML_FILE_RE.test(p)).sort();
    if (!htmlPaths.length) {
      alert('폴더 안에 HTML 파일이 없습니다.');
      return;
    }

    releaseProject();
    project = {
      name: folderName,
      files: new Map(entries.map((e) => [e.path, e.file])),
      lowerFiles: new Map(entries.map((e) => [e.path.toLowerCase(), e.file])),
      urls: [],
      blobCache: new Map(),
      rawCache: new Map(),
      reverse: new Map(),
      missing: new Set(),
      currentPage: null
    };

    htmlPaths.forEach((p) => pageSelect.add(new Option(p, p)));
    pageSelect.hidden = htmlPaths.length < 2;

    // index.html이 있으면 그것부터, 없으면 가장 얕은 위치의 첫 페이지
    const start = htmlPaths.find((p) => /^index\.html?$/i.test(p)) ||
      htmlPaths.slice().sort((a, b) => a.split('/').length - b.split('/').length)[0];
    openProjectPage(start);
  }

  async function openProjectPage(path) {
    const file = findFile(path);
    if (!file) return;

    project.currentPage = path;
    pageSelect.value = path;
    const name = path.split('/').pop();
    fileNameLabel.textContent = project.name ? `${project.name}/${path}` : path;

    project.missing.clear();
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    await rewriteDocRefs(doc, (raw) => htmlRefToUrl(dirOf(path), raw));
    startDocument(name, serializeParsed(doc));

    if (project.missing.size) {
      showToast(`폴더에서 찾지 못한 파일 ${project.missing.size}개: ` +
        Array.from(project.missing).slice(0, 3).join(', ') +
        (project.missing.size > 3 ? ' …' : ''), 6000);
    }
  }

  pageSelect.addEventListener('change', () => {
    const next = pageSelect.value;
    // 페이지를 바꾸면 편집 중인 문서가 사라지므로 수정 내용이 있으면 확인한다.
    if (historyIndex >= 0 &&
        !confirm('내보내지 않은 수정 내용이 사라집니다. 다른 페이지를 열까요?')) {
      pageSelect.value = project.currentPage;
      return;
    }
    openProjectPage(next);
  });

  // <input webkitdirectory>: webkitRelativePath가 '폴더이름/하위/파일' 형태다.
  function entriesFromFileList(files) {
    const list = Array.from(files);
    const root = (list[0].webkitRelativePath || '').split('/')[0];
    return {
      folderName: root,
      entries: list.map((file) => ({
        path: file.webkitRelativePath
          ? file.webkitRelativePath.split('/').slice(1).join('/')
          : file.name,
        file
      }))
    };
  }

  // 드래그한 폴더를 끝까지 훑어 파일 목록을 만든다.
  async function readDroppedEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
      return;
    }
    const reader = entry.createReader();
    // readEntries는 한 번에 일부만 돌려주므로 빈 배열이 나올 때까지 반복한다.
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) {
        await readDroppedEntry(child, `${prefix}${entry.name}/`, out);
      }
    }
  }

  async function handleDrop(dataTransfer) {
    const items = Array.from(dataTransfer.items || [])
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);

    const dir = items.length === 1 && items[0].isDirectory ? items[0] : null;
    if (dir) {
      const entries = [];
      await readDroppedEntry(dir, '', entries);
      // readDroppedEntry는 '폴더이름/...'으로 쌓으므로 맨 앞 폴더 이름을 떼어 낸다.
      handleFolder(entries.map((e) => ({ ...e, path: e.path.slice(dir.name.length + 1) })), dir.name);
      return;
    }

    const files = Array.from(dataTransfer.files || []);
    if (files.length > 1) {
      // 여러 파일을 한꺼번에 놓았다면 같은 폴더에 있던 것으로 본다.
      handleFolder(files.map((file) => ({ path: file.name, file })), '');
    } else {
      handleFile(files[0]);
    }
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
    fileInput.value = ''; // 같은 파일을 다시 골라도 change가 일어나도록
  });

  // 검증용: [{ path, file }] 목록으로 폴더 열기를 흉내낼 수 있게 노출
  window.FrontEndEditor.openFolder = handleFolder;

  const folderInput = document.getElementById('folder-input');
  folderInput.addEventListener('change', () => {
    if (!folderInput.files || !folderInput.files.length) return;
    const { entries, folderName } = entriesFromFileList(folderInput.files);
    handleFolder(entries, folderName);
    folderInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dropzone--active');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dropzone--active');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    handleDrop(e.dataTransfer);
  });

  /* ---------------------------------------------------------------
   * 속성 편집 패널 (색상 / 위치·크기 / 형태)
   * ------------------------------------------------------------- */

  const placeholder = document.getElementById('sidebar-placeholder');
  const stylePanel = document.getElementById('style-panel');
  const offsetFields = document.getElementById('offset-fields');
  const radiusOutput = document.getElementById('border-radius-out');

  const ctrl = {
    bgColor: document.getElementById('bg-color'),
    textColor: document.getElementById('text-color'),
    width: document.getElementById('width'),
    height: document.getElementById('height'),
    position: document.getElementById('position'),
    top: document.getElementById('top'),
    left: document.getElementById('left'),
    fontSize: document.getElementById('font-size'),
    fontFamily: document.getElementById('font-family'),
    fontFamilyCustom: document.getElementById('font-family-custom'),
    fontWeight: document.getElementById('font-weight'),
    radius: document.getElementById('border-radius'),
    borderWidth: document.getElementById('border-width'),
    borderStyle: document.getElementById('border-style'),
    borderColor: document.getElementById('border-color'),
    boxShadow: document.getElementById('box-shadow')
  };

  const textContentInput = document.getElementById('text-content');
  const textContentNotice = document.getElementById('text-content-notice');
  const lineBreakBtn = document.getElementById('line-break-btn');

  // 텍스트를 담을 수 없는(대체/빈) 요소들. textContent를 넣어도 화면에
  // 나타나지 않거나 직렬화 시 사라진다.
  const VOID_LIKE_TAGS = new Set([
    'IMG', 'BR', 'HR', 'INPUT', 'SOURCE', 'TRACK', 'EMBED', 'AREA', 'COL', 'WBR',
    'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'SVG', 'PICTURE', 'META', 'LINK'
  ]);

  // 자식 요소가 있는 요소의 내용을 덮어쓰면 하위 트리가 통째로
  // 사라지므로(히스토리가 들고 있는 참조까지 무효화됨) 편집을 막는다.
  // 단, 줄바꿈 <br>만 있는 경우는 편집기가 직접 만들고 다루므로 허용한다.
  function textEditState(el) {
    if (!el) return { editable: false, reason: '' };
    if (VOID_LIKE_TAGS.has(el.tagName)) {
      return { editable: false, reason: `<${el.tagName.toLowerCase()}>는 텍스트를 담지 않는 요소입니다.` };
    }
    if (Array.from(el.children).some((child) => child.tagName !== 'BR')) {
      return {
        editable: false,
        reason: '하위 요소가 있어 직접 편집할 수 없습니다. 트리나 화면에서 하위 요소를 선택하세요.'
      };
    }
    return { editable: true, reason: '' };
  }

  // <pre>나 white-space: pre-* 요소는 줄바꿈 문자가 그대로 화면에 보이므로
  // <br> 대신 줄바꿈 문자를 쓴다.
  function preservesNewlines(el) {
    const cs = previewFrame.contentWindow.getComputedStyle(el);
    return /^(pre|break-spaces)/.test(cs.whiteSpace) ||
      cs.whiteSpaceCollapse === 'preserve' || cs.whiteSpaceCollapse === 'preserve-breaks';
  }

  const BR_MARK = '\u0000'; // 공백 정리 중 <br> 자리를 지키기 위한 임시 표식

  // 요소 내용 → 입력칸 문자열. <br>은 줄바꿈(\n)으로 바꾼다.
  // 소스 코드 들여쓰기에서 온 줄바꿈·공백은 화면에서 공백 하나로 보이므로 그렇게 맞춘다.
  function readEditableText(el) {
    const keep = preservesNewlines(el);
    let out = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.nodeName === 'BR') out += keep ? '\n' : BR_MARK;
    });
    if (keep) return out;
    return out
      .replace(/^\s*\n\s*/, '')
      .replace(/\s*\n\s*$/, '')
      .replace(/\s*\n\s*/g, ' ')
      .split(BR_MARK).join('\n');
  }

  // 입력칸 문자열 → 요소 내용. 줄바꿈(\n)은 <br>로 넣는다.
  function writeEditableText(el, value) {
    if (preservesNewlines(el)) {
      el.textContent = value;
      return;
    }
    const doc = el.ownerDocument;
    el.textContent = '';
    value.split('\n').forEach((part, i) => {
      if (i > 0) el.appendChild(doc.createElement('br'));
      if (part) el.appendChild(doc.createTextNode(part));
    });
  }

  function syncTextContent(el) {
    const state = textEditState(el);
    textContentInput.disabled = !state.editable;
    lineBreakBtn.disabled = !state.editable;
    textContentInput.value = state.editable ? readEditableText(el) : '';
    textContentNotice.hidden = state.editable;
    textContentNotice.textContent = state.reason;
  }

  // 내용이 텍스트와 <br>뿐이므로 innerHTML 스냅샷으로 되돌리기를 기록한다.
  textContentInput.addEventListener('input', () => {
    const el = selectedElement;
    if (!el || !textEditState(el).editable) return;

    const before = el.innerHTML;
    writeEditableText(el, textContentInput.value);
    pushHistory(el, 'text', 'text', before, el.innerHTML);
  });

  // 줄바꿈 버튼: 입력칸의 커서 위치(선택 영역이면 그 자리)에 줄바꿈을 넣는다.
  // 버튼을 눌러도 입력칸 포커스·커서가 유지되도록 한다.
  lineBreakBtn.addEventListener('mousedown', (e) => e.preventDefault());

  lineBreakBtn.addEventListener('click', () => {
    if (textContentInput.disabled) return;
    textContentInput.focus();
    textContentInput.setRangeText('\n', textContentInput.selectionStart, textContentInput.selectionEnd, 'end');
    textContentInput.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const customFontField = document.getElementById('font-family-custom-field');
  const alignButtons = Array.from(document.querySelectorAll('.btn-align'));

  const SHADOW_PRESET = '0 2px 8px rgba(0, 0, 0, 0.2)';

  function rgbToHex(value) {
    if (!value) return null;
    const m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (!m) return null;
    // 완전 투명한 색은 색상값으로 표현할 수 없다.
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }

  // 'Times New Roman', Times, serif  ↔  "times new roman",times,serif
  // 처럼 표기만 다른 같은 글꼴 스택을 비교하기 위해 정규화한다.
  function normalizeFontStack(value) {
    return (value || '')
      .toLowerCase()
      .replace(/["']/g, '')
      .split(',')
      .map((s) => s.trim())
      .join(',');
  }

  function normalizeFontWeight(value) {
    if (value === 'normal') return '400';
    if (value === 'bold') return '700';
    return String(parseInt(value, 10) || 400);
  }

  // Chrome의 computed text-align 기본값은 'start'/'end'로 나온다.
  function normalizeTextAlign(value) {
    if (value === 'start') return 'left';
    if (value === 'end') return 'right';
    return value;
  }

  function pxToNumber(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n) : '';
  }

  // 선택된 요소의 인라인 style을 우선 읽고, 없으면 computed style로 대체한다.
  function readProp(el, prop) {
    const inline = el.style.getPropertyValue(prop);
    if (inline) return inline;
    return previewFrame.contentWindow.getComputedStyle(el).getPropertyValue(prop);
  }

  // 색상은 인라인에 'teal'·'#fff' 등 어떤 표기로 적혀 있어도
  // computed style이 항상 rgb()로 정규화해 주므로 그쪽에서 읽는다.
  function readColor(el, prop) {
    return previewFrame.contentWindow.getComputedStyle(el).getPropertyValue(prop);
  }

  // 히스토리에 기록하지 않는 원시 쓰기. 반드시 commit() 안에서만 호출한다.
  function rawApply(prop, value) {
    const el = selectedElement;
    if (!el) return;
    if (value === '' || value === null) {
      el.style.removeProperty(prop);
    } else {
      el.style.setProperty(prop, value);
    }
  }

  /* --- 되돌리기 / 다시하기 --------------------------------------- */

  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  const history = [];
  let historyIndex = -1; // 마지막으로 적용된 항목의 인덱스
  let lastCommitTime = 0;
  let isRestoring = false;

  // 슬라이더 드래그처럼 연속으로 쏟아지는 변경은 한 항목으로 합친다.
  const COALESCE_MS = 1000;

  function updateHistoryButtons() {
    undoBtn.disabled = historyIndex < 0;
    redoBtn.disabled = historyIndex >= history.length - 1;
  }

  function resetHistory() {
    history.length = 0;
    historyIndex = -1;
    lastCommitTime = 0;
    updateHistoryButtons();
  }

  function pushHistory(el, key, type, before, after) {
    if (before === after || isRestoring) return;

    const now = Date.now();
    const last = history[historyIndex];
    const canCoalesce =
      last &&
      historyIndex === history.length - 1 &&
      last.el === el &&
      last.key === key &&
      now - lastCommitTime < COALESCE_MS;

    if (canCoalesce) {
      last.after = after;
    } else {
      history.length = historyIndex + 1; // 되돌린 뒤 새로 편집하면 redo 이력은 폐기
      history.push({ el, key, type, before, after });
      historyIndex = history.length - 1;
    }

    lastCommitTime = now;
    updateHistoryButtons();
  }

  // 여러 요소의 style을 한 번에 바꾼 동작. 요소별 before/after를 묶어
  // 되돌리기 한 번으로 모두 복원한다. 같은 대상·같은 key의 연속 변경은 합친다.
  function pushBatchHistory(key, items) {
    if (isRestoring) return;
    const changed = items.filter((it) => it.before !== it.after);
    if (!changed.length) return;

    const now = Date.now();
    const last = history[historyIndex];
    const canCoalesce =
      last &&
      last.type === 'batch' &&
      historyIndex === history.length - 1 &&
      last.key === key &&
      last.items.length === items.length &&
      last.items.every((it, i) => it.el === items[i].el) &&
      now - lastCommitTime < COALESCE_MS;

    if (canCoalesce) {
      last.items.forEach((it, i) => { it.after = items[i].after; });
    } else {
      history.length = historyIndex + 1; // 되돌린 뒤 새로 편집하면 redo 이력은 폐기
      history.push({ type: 'batch', key, items });
      historyIndex = history.length - 1;
    }

    lastCommitTime = now;
    updateHistoryButtons();
  }

  // 복제·삭제처럼 DOM 구조를 바꾸는 동작. 값 비교나 병합 없이 항상 한 항목으로
  // 남기고, 되돌릴 때 필요한 삽입 위치(부모 + 기준 형제)를 함께 들고 있는다.
  function pushStructuralHistory(type, el, parent, nextSibling) {
    if (isRestoring) return;
    history.length = historyIndex + 1; // 되돌린 뒤 새로 편집하면 redo 이력은 폐기
    history.push({ el, parent, nextSibling, type, key: null });
    historyIndex = history.length - 1;
    lastCommitTime = 0; // 뒤이은 스타일 편집이 이 항목에 합쳐지지 않도록
    updateHistoryButtons();
  }

  // style 속성 전체를 스냅샷으로 남긴다. 한 동작이 여러 속성을 건드려도
  // (예: 테두리 두께 + style 자동 승격) 되돌리기 한 번으로 복원된다.
  function commit(key, fn) {
    const el = selectedElement;
    if (!el) return;

    const before = el.getAttribute('style');
    fn();
    pushHistory(el, key, 'style', before, el.getAttribute('style'));
  }

  function applyProp(prop, value) {
    commit(prop, () => rawApply(prop, value));
  }

  function restoreStyleAttr(el, value) {
    if (value === null) el.removeAttribute('style');
    else el.setAttribute('style', value);
  }

  function restoreEntry(entry, value) {
    if (entry.type === 'text') entry.el.innerHTML = value;
    else restoreStyleAttr(entry.el, value);
  }

  // 일괄 편집 항목을 before/after 중 한쪽으로 돌리고, 다시 선택할 요소들을 돌려준다.
  function restoreBatch(entry, side) {
    entry.items.forEach((it) => restoreStyleAttr(it.el, it[side]));
    return entry.items.map((it) => it.el);
  }

  // 되돌린 지점을 사용자가 볼 수 있도록 해당 요소를 선택 상태로 만든다.
  function focusHistoryTarget(el) {
    if (Array.isArray(el)) {
      // 일괄 편집: 화면에 남아 있는 요소들만 다시 선택한다.
      const alive = el.filter((e) => e.isConnected);
      if (alive.length < el.length) showToast('되돌린 요소 중 일부가 현재 화면에 없습니다.');
      setSelection(alive);
      syncPanel(selectedElement); // 선택이 그대로라 setSelection이 조기 반환한 경우 대비
      highlightTreeNode();
    } else if (!el) {
      // 삭제를 다시 실행한 경우처럼 선택할 대상이 없는 상태
      selectElement(null);
      syncPanel(null);
    } else if (el.isConnected) {
      selectElement(el);
      syncPanel(el); // 이미 선택돼 있던 경우 selectElement가 조기 반환하므로 명시 호출
    } else {
      // 보기 모드에서 페이지 스크립트가 지워버린 요소일 수 있다.
      showToast('되돌린 요소가 현재 화면에 없습니다.');
    }
    lastCommitTime = 0; // 되돌린 직후의 편집이 이전 항목에 합쳐지지 않도록
    updateHistoryButtons();
  }

  const STRUCTURAL_TYPES = new Set(['insert', 'remove']);

  function reinsertNode(entry) {
    const { el, parent, nextSibling } = entry;
    if (!parent.isConnected) {
      showToast('되돌릴 위치가 현재 화면에 없습니다.');
      return;
    }
    // 기준 형제가 그사이 사라졌다면 부모의 맨 뒤에 붙인다.
    if (nextSibling && nextSibling.parentNode === parent) {
      parent.insertBefore(el, nextSibling);
    } else {
      parent.appendChild(el);
    }
  }

  // 노드를 되살리거나(attach) 떼어낸 뒤, 이어서 선택할 대상을 돌려준다.
  function applyStructural(entry, attach) {
    if (attach) reinsertNode(entry);
    else entry.el.remove();

    const doc = previewFrame.contentDocument;
    if (doc) buildTree(doc);

    if (attach) return entry.el;
    // 사라진 요소 대신 부모를 선택한다. 부모가 편집 대상이 아니면 선택 해제.
    return entry.parent.isConnected && entry.parent.hasAttribute('data-editor-id')
      ? entry.parent
      : null;
  }

  function undo() {
    if (historyIndex < 0) return;
    const entry = history[historyIndex];
    isRestoring = true;

    let focus;
    if (STRUCTURAL_TYPES.has(entry.type)) {
      // 넣었던 것은 빼고, 지웠던 것은 되살린다.
      focus = applyStructural(entry, entry.type === 'remove');
    } else if (entry.type === 'batch') {
      focus = restoreBatch(entry, 'before');
    } else {
      restoreEntry(entry, entry.before);
      focus = entry.el;
    }

    isRestoring = false;
    historyIndex -= 1;
    focusHistoryTarget(focus);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    const entry = history[historyIndex + 1];
    isRestoring = true;

    let focus;
    if (STRUCTURAL_TYPES.has(entry.type)) {
      focus = applyStructural(entry, entry.type === 'insert');
    } else if (entry.type === 'batch') {
      focus = restoreBatch(entry, 'after');
    } else {
      restoreEntry(entry, entry.after);
      focus = entry.el;
    }

    isRestoring = false;
    historyIndex += 1;
    focusHistoryTarget(focus);
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // 글자를 입력하는 칸에서는 단축키를 가로채지 않는다.
  // (브라우저 기본 되돌리기와 Delete 키의 글자 지우기를 그대로 둔다)
  const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);

  function isTextEntryTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(t.type);
  }

  function handleEditorKey(e) {
    if (isTextEntryTarget(e.target)) return;

    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (key === 'd') {
        e.preventDefault();
        duplicateSelected();
      }
      return;
    }

    if (e.key === 'Escape' && (selectedElements.length || drag)) {
      e.preventDefault();
      endDrag(false);
      selectElement(null);
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElement) {
      e.preventDefault();
      deleteSelected();
    }
  }

  document.addEventListener('keydown', handleEditorKey);

  /* --------------------------------------------------------------- */

  // 두께나 색만 바꿔도 테두리가 보이도록 style이 none이면 solid로 올려준다.
  function ensureBorderVisibleRaw() {
    const el = selectedElement;
    if (!el) return;
    if (readProp(el, 'border-top-style') === 'none') {
      rawApply('border-style', 'solid');
      ctrl.borderStyle.value = 'solid';
    }
  }

  function syncPanel(el) {
    const isMulti = selectedElements.length > 1;
    batchPanel.hidden = !isMulti;
    if (isMulti) {
      stylePanel.hidden = true;
      placeholder.hidden = true;
      elementActions.hidden = true;
      syncBatchPanel();
      return;
    }
    if (!el) {
      stylePanel.hidden = true;
      placeholder.hidden = false;
      elementActions.hidden = true;
      return;
    }
    placeholder.hidden = true;
    stylePanel.hidden = false;
    elementActions.hidden = false;

    // 내용
    syncTextContent(el);

    // 색상
    ctrl.bgColor.value = rgbToHex(readColor(el, 'background-color')) || '#ffffff';
    ctrl.textColor.value = rgbToHex(readColor(el, 'color')) || '#000000';

    // 텍스트
    ctrl.fontSize.value = pxToNumber(readProp(el, 'font-size'));

    const stack = readProp(el, 'font-family');
    const normalized = normalizeFontStack(stack);
    const match = Array.from(ctrl.fontFamily.options)
      .find((opt) => opt.value !== '__custom' && normalizeFontStack(opt.value) === normalized);
    if (match) {
      ctrl.fontFamily.value = match.value;
      customFontField.hidden = true;
      ctrl.fontFamilyCustom.value = '';
    } else {
      // 목록에 없는 글꼴이면 '직접 입력'으로 두고 현재 스택을 그대로 보여준다.
      ctrl.fontFamily.value = '__custom';
      customFontField.hidden = false;
      ctrl.fontFamilyCustom.value = stack;
    }

    ctrl.fontWeight.value = normalizeFontWeight(readProp(el, 'font-weight'));

    const align = normalizeTextAlign(readProp(el, 'text-align'));
    alignButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.align === align);
    });

    // 위치 / 크기 — 인라인으로 지정된 값이 있을 때만 숫자를 채우고,
    // 지정되지 않았으면 placeholder("auto")를 유지해 의도치 않은 고정을 막는다.
    ctrl.width.value = el.style.width ? pxToNumber(el.style.width) : '';
    ctrl.height.value = el.style.height ? pxToNumber(el.style.height) : '';

    const position = readProp(el, 'position') || 'static';
    ctrl.position.value = ['static', 'relative', 'absolute'].includes(position) ? position : 'static';
    offsetFields.hidden = ctrl.position.value === 'static';
    ctrl.top.value = el.style.top ? pxToNumber(el.style.top) : '';
    ctrl.left.value = el.style.left ? pxToNumber(el.style.left) : '';

    // 여백 — 실제 적용 중인 간격을 보여주는 편이 유용하므로 computed 값을 채운다.
    document.querySelectorAll('[data-spacing]').forEach((input) => {
      input.value = pxToNumber(readProp(el, input.dataset.spacing));
    });

    // 형태
    const radius = pxToNumber(readProp(el, 'border-top-left-radius')) || 0;
    ctrl.radius.value = radius;
    radiusOutput.textContent = `${radius}px`;

    ctrl.borderWidth.value = pxToNumber(readProp(el, 'border-top-width'));
    ctrl.borderStyle.value = readProp(el, 'border-top-style') || 'none';
    ctrl.borderColor.value = rgbToHex(readColor(el, 'border-top-color')) || '#000000';
    ctrl.boxShadow.checked = (readProp(el, 'box-shadow') || 'none') !== 'none';
  }

  // 색상
  ctrl.bgColor.addEventListener('input', () => applyProp('background-color', ctrl.bgColor.value));
  ctrl.textColor.addEventListener('input', () => applyProp('color', ctrl.textColor.value));

  document.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyProp(btn.dataset.reset, '');
      syncPanel(selectedElement);
    });
  });

  // 텍스트
  ctrl.fontSize.addEventListener('input', () => {
    const v = ctrl.fontSize.value;
    applyProp('font-size', v === '' ? '' : `${v}px`);
  });

  ctrl.fontFamily.addEventListener('change', () => {
    if (ctrl.fontFamily.value === '__custom') {
      customFontField.hidden = false;
      ctrl.fontFamilyCustom.focus();
      // 입력이 채워질 때까지는 글꼴을 바꾸지 않는다.
      return;
    }
    customFontField.hidden = true;
    applyProp('font-family', ctrl.fontFamily.value);
  });

  ctrl.fontFamilyCustom.addEventListener('input', () => {
    applyProp('font-family', ctrl.fontFamilyCustom.value.trim());
  });

  ctrl.fontWeight.addEventListener('change', () => {
    applyProp('font-weight', ctrl.fontWeight.value);
  });

  alignButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const align = btn.dataset.align;
      const isActive = btn.classList.contains('is-active');
      // 활성화된 버튼을 다시 누르면 정렬 지정을 해제한다.
      applyProp('text-align', isActive ? '' : align);
      syncPanel(selectedElement);
    });
  });

  // 위치 / 크기
  [['width', 'width'], ['height', 'height'], ['top', 'top'], ['left', 'left']].forEach(([key, prop]) => {
    ctrl[key].addEventListener('input', () => {
      const v = ctrl[key].value;
      applyProp(prop, v === '' ? '' : `${v}px`);
    });
  });

  ctrl.position.addEventListener('change', () => {
    applyProp('position', ctrl.position.value);
    offsetFields.hidden = ctrl.position.value === 'static';
  });

  // 형태
  ctrl.radius.addEventListener('input', () => {
    applyProp('border-radius', `${ctrl.radius.value}px`);
    radiusOutput.textContent = `${ctrl.radius.value}px`;
  });

  // 두께·색 변경과 border-style 자동 승격을 한 항목으로 묶어 기록한다.
  ctrl.borderWidth.addEventListener('input', () => {
    const v = ctrl.borderWidth.value;
    commit('border', () => {
      rawApply('border-width', v === '' ? '' : `${v}px`);
      if (v !== '' && Number(v) > 0) ensureBorderVisibleRaw();
    });
  });

  ctrl.borderStyle.addEventListener('change', () => {
    applyProp('border-style', ctrl.borderStyle.value);
  });

  ctrl.borderColor.addEventListener('input', () => {
    commit('border', () => {
      rawApply('border-color', ctrl.borderColor.value);
      ensureBorderVisibleRaw();
    });
  });

  // 여백 (margin / padding)
  document.querySelectorAll('[data-spacing]').forEach((input) => {
    input.addEventListener('input', () => {
      const v = input.value;
      applyProp(input.dataset.spacing, v === '' ? '' : `${v}px`);
    });
  });

  ctrl.boxShadow.addEventListener('change', () => {
    applyProp('box-shadow', ctrl.boxShadow.checked ? SHADOW_PRESET : 'none');
  });

  /* ---------------------------------------------------------------
   * 일괄 편집 (복수 선택)
   * ------------------------------------------------------------- */

  const batchPanel = document.getElementById('batch-panel');
  const batchFontInput = document.getElementById('batch-font-size');
  const batchFontSummary = document.getElementById('batch-font-summary');

  function currentFontSize(el) {
    const n = parseFloat(previewFrame.contentWindow.getComputedStyle(el).fontSize);
    return Number.isFinite(n) ? Math.round(n) : 16;
  }

  function syncBatchPanel() {
    const sizes = selectedElements.map(currentFontSize);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    // 입력 중인 칸의 값을 덮어쓰면 커서가 튀므로 건드리지 않는다.
    if (document.activeElement !== batchFontInput) {
      batchFontInput.value = min === max ? min : '';
    }
    batchFontSummary.textContent = min === max
      ? `${selectedElements.length}개 요소 · 모두 ${min}px`
      : `${selectedElements.length}개 요소 · 현재 ${min}~${max}px`;
  }

  // compute(현재 px) → 새 px. 모든 요소의 현재 크기를 먼저 읽은 뒤에 쓴다.
  // 부모와 자식이 함께 선택됐을 때 부모를 먼저 바꾸면 자식의 상속값이
  // 달라져 자식만 두 번 커지는 일을 막기 위해서다.
  function applyBatchFontSize(compute) {
    const items = selectedElements.map((el) => ({
      el,
      size: currentFontSize(el),
      before: el.getAttribute('style')
    }));
    items.forEach((it) => {
      it.el.style.setProperty('font-size', `${Math.max(1, compute(it.size))}px`);
      it.after = it.el.getAttribute('style');
      delete it.size;
    });
    pushBatchHistory('font-size', items);
    syncBatchPanel();
  }

  document.querySelectorAll('[data-font-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = Number(btn.dataset.fontStep);
      applyBatchFontSize((size) => size + step);
    });
  });

  batchFontInput.addEventListener('input', () => {
    const v = Number(batchFontInput.value);
    if (batchFontInput.value === '' || !(v >= 1)) return;
    applyBatchFontSize(() => Math.round(v));
  });

  // 포커스를 잃으면 실제 값 기준으로 다시 표시한다. (비워 둔 채 나간 경우 등)
  batchFontInput.addEventListener('blur', () => {
    if (selectedElements.length > 1) syncBatchPanel();
  });

  document.getElementById('clear-selection-btn').addEventListener('click', () => {
    selectElement(null);
  });

  /* ---------------------------------------------------------------
   * 요소 트리 뷰
   * ------------------------------------------------------------- */

  const treeEl = document.getElementById('tree');

  /* --- 트리 접기 / 펼치기 ---------------------------------------- */

  const treePane = document.getElementById('tree-pane');
  const treeToggle = document.getElementById('tree-toggle');
  const TREE_COLLAPSED_KEY = 'html-visual-editor:tree-collapsed';

  function setTreeCollapsed(collapsed) {
    treePane.classList.toggle('is-collapsed', collapsed);
    treeToggle.setAttribute('aria-expanded', String(!collapsed));
    treeToggle.title = collapsed ? '요소 트리 펼치기' : '요소 트리 접기';
    treeToggle.querySelector('.tree-toggle__icon').textContent = collapsed ? '»' : '«';
    // 펼칠 때 선택된 요소가 보이도록 트리 위치를 맞춘다.
    if (!collapsed) {
      const active = treeEl.querySelector('.tree-node.is-active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }

  // 자주 쓰지 않는 패널이라 기본은 접힘. 마지막 상태는 브라우저에 기억한다.
  // (사생활 보호 모드 등에서 저장소 접근이 막혀도 기본값으로 동작)
  let treeCollapsed = true;
  try {
    treeCollapsed = localStorage.getItem(TREE_COLLAPSED_KEY) !== 'false';
  } catch { /* 기본값 유지 */ }
  setTreeCollapsed(treeCollapsed);

  treeToggle.addEventListener('click', () => {
    treeCollapsed = !treeCollapsed;
    setTreeCollapsed(treeCollapsed);
    try {
      localStorage.setItem(TREE_COLLAPSED_KEY, String(treeCollapsed));
    } catch { /* 저장 못 해도 이번 화면에서는 동작 */ }
  });

  function treeLabel(el) {
    // 하이라이트용 클래스는 라벨에 노출하지 않는다.
    const classes = Array.from(el.classList)
      .filter((c) => c !== HOVER_CLASS && c !== SELECTED_CLASS);
    let meta = '';
    if (el.id) meta = `#${el.id}`;
    else if (classes.length) meta = `.${classes[0]}`;
    return { tag: `<${el.tagName.toLowerCase()}>`, meta };
  }

  function buildTree(doc) {
    treeEl.textContent = '';
    if (!doc.body) return;

    const frag = document.createDocumentFragment();

    const walk = (node, depth) => {
      for (const child of Array.from(node.children)) {
        if (!child.hasAttribute('data-editor-id')) continue;

        const { tag, meta } = treeLabel(child);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tree-node';
        btn.style.paddingLeft = `${6 + depth * 12}px`;
        btn.dataset.editorId = child.getAttribute('data-editor-id');
        btn.append(document.createTextNode(tag));
        if (meta) {
          const span = document.createElement('span');
          span.className = 'tree-node__meta';
          span.textContent = ` ${meta}`;
          btn.appendChild(span);
        }
        frag.appendChild(btn);

        walk(child, depth + 1);
      }
    };

    walk(doc.body, 0);

    if (!frag.childNodes.length) {
      const p = document.createElement('p');
      p.className = 'tree__empty';
      p.textContent = '표시할 요소가 없습니다.';
      frag.appendChild(p);
    }

    treeEl.appendChild(frag);
  }

  treeEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tree-node');
    if (!btn) return;
    const doc = previewFrame.contentDocument;
    if (!doc) return;
    const el = doc.querySelector(`[data-editor-id="${btn.dataset.editorId}"]`);
    if (!el) return;
    // 보기 모드에서 트리를 눌렀다면 편집하려는 의도이므로 모드를 되돌린다.
    setMode('edit');
    if (e.ctrlKey || e.metaKey || e.shiftKey || multiSelectMode) toggleInSelection(el);
    else selectElement(el);
  });

  // 선택된 모든 요소를 트리에 표시한다. 스크롤은 단일 선택일 때만 따라간다.
  function highlightTreeNode() {
    const ids = new Set(selectedElements.map((s) => s.getAttribute('data-editor-id')));
    treeEl.querySelectorAll('.tree-node').forEach((btn) => {
      const active = ids.has(btn.dataset.editorId);
      btn.classList.toggle('is-active', active);
      if (active && ids.size === 1) btn.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ---------------------------------------------------------------
   * 요소 복제 / 삭제
   * ------------------------------------------------------------- */

  const elementActions = document.getElementById('element-actions');
  const duplicateBtn = document.getElementById('duplicate-btn');
  const deleteBtn = document.getElementById('delete-btn');

  // 복사본에 도구 전용 표식이 따라붙으면 안 된다. 편집 ID는 비워 두면
  // assignEditorIds가 새 번호를 채워 준다.
  function clearEditorMarks(root) {
    [root, ...root.querySelectorAll('*')].forEach((el) => {
      el.removeAttribute('data-editor-id');
      if (!el.classList) return;
      el.classList.remove(HOVER_CLASS, SELECTED_CLASS);
      // 하이라이트 클래스만 있던 요소에 class="" 가 남지 않도록 정리
      if (el.classList.length === 0) el.removeAttribute('class');
    });
  }

  function duplicateSelected() {
    const el = selectedElement;
    const doc = previewFrame.contentDocument;
    if (mode !== 'edit' || !el || !doc) return;

    const parent = el.parentNode;
    if (!parent) return;

    const clone = el.cloneNode(true);
    clearEditorMarks(clone);

    // 원본 바로 뒤에 넣는다. (기준 형제는 되돌리기에도 쓰인다)
    const nextSibling = el.nextSibling;
    parent.insertBefore(clone, nextSibling);

    assignEditorIds(doc);
    buildTree(doc);
    pushStructuralHistory('insert', clone, parent, nextSibling);

    // 바로 이어서 편집할 수 있도록 복사본을 선택 상태로 만든다.
    selectElement(clone);

    // id는 문서에서 유일해야 하므로 그대로 복사되면 CSS·스크립트가 엉킬 수 있다.
    showToast(clone.id || clone.querySelector('[id]')
      ? '복제했습니다. id도 함께 복사되어 중복될 수 있습니다.'
      : '복제했습니다.');
  }

  function deleteSelected() {
    const el = selectedElement;
    const doc = previewFrame.contentDocument;
    if (mode !== 'edit' || !el || !doc) return;

    const parent = el.parentNode;
    if (!parent) return;

    const nextSibling = el.nextSibling;
    const label = `<${el.tagName.toLowerCase()}>`;

    // 선택·hover 표식을 먼저 걷어내야 되살렸을 때 테두리가 남지 않는다.
    setHovered(null);
    selectElement(null);
    el.remove();

    buildTree(doc);
    pushStructuralHistory('remove', el, parent, nextSibling);

    showToast(`${label} 요소를 삭제했습니다. Ctrl+Z로 되돌릴 수 있습니다.`);
  }

  duplicateBtn.addEventListener('click', duplicateSelected);
  deleteBtn.addEventListener('click', deleteSelected);

  /* ---------------------------------------------------------------
   * 편집 모드 / 보기 모드
   * ------------------------------------------------------------- */

  const modeButtons = Array.from(document.querySelectorAll('.btn-mode'));
  const modeBadge = document.getElementById('mode-badge');
  const previewPane = document.getElementById('preview-pane');

  function applyModeUI() {
    modeButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    });
    previewPane.classList.toggle('is-view-mode', mode === 'view');
    modeBadge.hidden = mode !== 'view';
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    applyModeUI();

    const doc = previewFrame.contentDocument;

    if (mode === 'view') {
      // 하이라이트와 선택을 걷어내 실제 화면처럼 보이게 한다.
      setHovered(null);
      selectElement(null);
      // 페이지 스크립트가 문서를 이동시켜도 되돌아올 수 있도록 복구 지점을 남긴다.
      if (doc && doc.documentElement) {
        lastGoodHtml = `${serializeDoctype(doc)}\n${doc.documentElement.outerHTML}`;
      }
      return;
    }

    if (!doc || !doc.body) return;

    // 보기 모드 동안 페이지 스크립트가 DOM을 바꿨을 수 있다.
    // 새로 생긴 요소에도 편집 ID를 부여하고 트리를 다시 만든다.
    injectEditorStyles(doc);
    assignEditorIds(doc);
    buildTree(doc);
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  /* --- 복수 선택 토글 -------------------------------------------- */

  const multiSelectBtn = document.getElementById('multi-select-btn');

  multiSelectBtn.addEventListener('click', () => {
    multiSelectMode = !multiSelectMode;
    multiSelectBtn.setAttribute('aria-pressed', String(multiSelectMode));
    setMode('edit');
    showToast(multiSelectMode
      ? '복수 선택 켜짐: 클릭할 때마다 선택에 더하거나 뺍니다.'
      : '복수 선택 꺼짐: 클릭하면 한 요소만 선택합니다.');
  });

  /* ---------------------------------------------------------------
   * 반응형 미리보기
   * ------------------------------------------------------------- */

  document.querySelectorAll('.btn-viewport').forEach((btn) => {
    btn.addEventListener('click', () => {
      const width = Number(btn.dataset.viewport);

      document.querySelectorAll('.btn-viewport').forEach((b) => {
        b.classList.toggle('is-active', b === btn);
      });

      if (width === 0) {
        previewFrame.classList.remove('is-constrained');
        previewFrame.style.width = '';
      } else {
        previewFrame.classList.add('is-constrained');
        previewFrame.style.width = `${width}px`;
      }
    });
  });

  window.addEventListener('elementSelected', (e) => {
    const el = e.detail ? e.detail.element : null;
    syncPanel(el);
    highlightTreeNode();
  });

  /* ---------------------------------------------------------------
   * 내보내기 (수정된 index.html 다운로드)
   * ------------------------------------------------------------- */

  const exportBtn = document.getElementById('export-btn');
  const toast = document.getElementById('toast');
  let toastTimer = null;

  function showToast(message, duration = 2600) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, duration);
  }

  // 원본 문서의 DOCTYPE을 그대로 복원한다. (HTML5가 아닌 문서도 보존)
  function serializeDoctype(doc) {
    const dt = doc.doctype;
    if (!dt) return '<!DOCTYPE html>';
    let out = `<!DOCTYPE ${dt.name}`;
    if (dt.publicId) out += ` PUBLIC "${dt.publicId}"`;
    else if (dt.systemId) out += ' SYSTEM';
    if (dt.systemId) out += ` "${dt.systemId}"`;
    return `${out}>`;
  }

  // 편집 중인 실제 DOM은 건드리지 않고, 사본에서 도구 전용 표식만 제거한다.
  function buildCleanHtml(doc) {
    const root = doc.documentElement.cloneNode(true);

    root.querySelectorAll('[data-editor-id]').forEach((el) => {
      el.removeAttribute('data-editor-id');
    });

    root.querySelectorAll('[class]').forEach((el) => {
      el.classList.remove(HOVER_CLASS, SELECTED_CLASS);
      // 하이라이트 클래스만 있던 요소에 class="" 가 남지 않도록 정리
      if (el.classList.length === 0) el.removeAttribute('class');
    });

    const injected = root.querySelector(`[id="${EDITOR_STYLE_ID}"]`);
    if (injected) injected.remove();

    // 폴더로 열었다면 blob URL로 바꿔 둔 경로를 원래 표기로 되돌린다.
    return restoreAssetRefs(`${serializeDoctype(doc)}\n${root.outerHTML}\n`);
  }

  function exportFileName() {
    const base = originalFileName || 'index.html';
    return base.startsWith('edited-') ? base : `edited-${base}`;
  }

  exportBtn.addEventListener('click', () => {
    const doc = previewFrame.contentDocument;
    if (!doc || !doc.documentElement) {
      showToast('내보낼 문서가 없습니다.');
      return;
    }

    const html = buildCleanHtml(doc);
    const name = exportFileName();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast(`내보내기 완료: ${name}`);
  });

  // 검증용으로 직렬화 결과만 얻을 수 있게 노출
  window.FrontEndEditor.buildCleanHtml = () => buildCleanHtml(previewFrame.contentDocument);
})();
