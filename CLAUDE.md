# CLAUDE.md

사용자에게는 한국어로 답한다. 코드 주석과 UI 문구도 한국어로 쓴다.

## 프로젝트 개요

HTML Visual Editor: `index.html` 파일을 불러와 텍스트·색상·레이아웃을 코드 없이 화면에서 직접 고치고, 수정한 HTML을 다운로드하는 브라우저 전용 편집기다. 서버·설치·외부 라이브러리 없이 순수 HTML/CSS/JS(바닐라)로 만든다. 자세한 기능 목록은 README.md 참고.

## 파일 구성

- `editor.html` / `editor.css` / `editor.js`: **실제 소스.** 여기만 수정한다.
- `editor-standalone.html`: `build.py`가 위 3개를 합쳐 만드는 생성 파일. **직접 수정 금지.**
- `index.html`: GitHub Pages 진입점. `editor-standalone.html`로 리다이렉트만 한다. (편집 대상 샘플 파일이 아님)
- 배포: `main` 브랜치에 push하면 GitHub Pages(https://utaeu.github.io/html-visual-editor/)가 갱신된다.

## 작업 규칙

- 소스를 고친 뒤에는 반드시 `python build.py`로 단일 파일을 다시 만들고 `python build.py --check`로 동기화를 확인한다.
- `build.py`는 `editor.html`의 `<link rel="stylesheet" href="editor.css" />`와 `  <script src="editor.js"></script>`(앞 공백 2칸 포함) 문자열을 그대로 찾아 치환한다. 이 두 태그의 형태를 바꾸지 않는다.
- 줄바꿈은 LF를 유지한다(`.gitattributes`).
- 기능을 추가·변경하면 README.md의 기능 표/단축키/알아두면 좋은 점도 함께 갱신한다.

## editor.js 구조 (IIFE 하나)

- 미리보기: `<iframe id="preview-frame">`에 `srcdoc`로 불러온 HTML을 넣는다. srcdoc 문서의 baseURI는 편집기 URL이라 상대 경로가 풀리지 않는다.
- 폴더 열기(`handleFolder` → `openProjectPage`): 폴더 파일을 `project.files`(폴더 기준 경로 → File)로 들고, HTML을 DOMParser로 파싱해 `rewriteDocRefs()`로 link/script/img/srcset/style url() 등을 blob URL로 바꾼 뒤 srcdoc에 넣는다. CSS 파일은 안쪽 url()/@import도 CSS 위치 기준으로 변환(`assetBlob`). `<a href>` 페이지 링크는 건드리지 않는다. 내보낼 때 `restoreAssetRefs()`가 `project.reverse`(blob URL → 원래 표기)로 문자열을 되돌린다. 파일 하나만 열면 `project`는 null이고 상대 경로 개수만 세어 안내 토스트를 띄운다.
- 편집 표식: 요소마다 `data-editor-id="el-N"`, 하이라이트는 클래스 `__editor-hover` / `__editor-selected`, 주입 스타일은 `#__editor-injected-style`. 하이라이트는 style 속성이 아니라 **클래스로만** 적용한다(내보내기 결과 오염 방지).
- 내보내기: `buildCleanHtml()`이 문서를 복제해 위 표식을 모두 제거하고 doctype을 붙여 `edited-<원본이름>`으로 다운로드한다.
- 스타일 편집은 인라인 style로 저장된다. `applyProp()` → `commit(key, fn)`이 style 속성 전체를 before/after 스냅샷으로 기록한다.
- 되돌리기: 단일 `history` 배열 + `historyIndex`. 같은 요소·같은 key의 1초(`COALESCE_MS`) 내 연속 변경은 한 항목으로 합친다. 복제·삭제는 `pushStructuralHistory()`로 부모+기준 형제를 저장한다. 복원 중에는 `isRestoring`으로 기록을 막는다.
- 편집/보기 모드: 보기 모드 진입 시 `lastGoodHtml` 스냅샷을 저장하고(페이지 스크립트가 문서를 이동시켰을 때 복구용), 편집 모드 복귀 시 새로 생긴 요소에 ID를 다시 부여하고 트리를 재구성한다.
- 선택 모델: `selectedElements` 배열이 기준이고, 모든 선택 변경은 `setSelection(list)`을 거친다(`selectElement(el)`은 한 개짜리 래퍼, `toggleInSelection`은 Ctrl+클릭). 한 개일 때만 `selectedElement`가 채워져 단일 편집 패널이 뜨고, 두 개 이상이면 `selectedElement`는 null이고 `#batch-panel`(일괄 글자 크기)이 뜬다. 선택 표시는 모두 `__editor-selected` 클래스를 공유한다.
- 드래그 범위 선택: 미리보기 문서의 mousedown/mousemove/mouseup으로 처리하고, 사각형(`#drag-box`)은 미리보기가 아니라 편집기 문서에 `position: fixed`로 그린다. 직접 텍스트 노드를 가진 요소만 대상.
- 일괄 편집 되돌리기: `pushBatchHistory()`가 `{ type: 'batch', key, items: [{ el, before, after }] }` 한 항목으로 기록한다. 글자 크기는 모든 요소의 computed 값을 먼저 읽은 뒤 쓴다(부모·자식 동시 선택 시 이중 적용 방지).
- 사진 추가/바꾸기: 사진은 HTML에 넣지 않고 경로로 연결한다. 고른 파일은 blob URL로 미리보고 `insertedAssets`(blob URL → `{ ref, file, needsCopy }`)에 기록하며, 내보낼 때 `restoreAssetRefs()`가 `project.reverse`와 함께 경로로 되돌린다(파일 하나만 연 경우에도 동작). 사진 바꾸기는 `aspect-ratio` + `object-fit: cover`로 칸을 유지하고 'attrs' 히스토리 항목(`src/srcset/sizes/style` 스냅샷)으로 기록한다. 내보내기 후 복사할 사진 목록(`pendingImageCopies`)을 토스트로 알린다.
- 요소 위치: **DOM 순서 이동과 (사진) 정렬만** 한다. absolute·top/left로 픽셀 위치를 옮기는 자유 배치는 넣지 않는다(사용자 결정). 선택된 요소나 그 안쪽을 mousedown하면 범위 선택 대신 `beginMoveDrag`가 시작되고(끌지 않고 떼면 안쪽 요소 선택), `dropPointAt()`이 요소 앞/뒤 자리를 구해 편집기 문서의 `#drop-line`으로 표시한다. 놓을 수 있는지는 `canPlace()`가 판단한다: `REQUIRED_PARENTS`(li·tr·td·option 등은 정해진 부모 안에서만), `STRICT_PARENTS`에는 직접 넣지 않음, 블록 요소는 `PHRASING_ONLY` 조상 안 금지(재파싱 시 구조가 깨짐), a/button·form 중첩 금지, 자기 안 금지. 안 되면 감싸는 요소 쪽으로 올라가며 자리를 찾는다. ↑/↓(`stepTarget`)도 `canPlace`를 거친다. 이동은 'move' 히스토리 항목(`from`/`to` = 부모 + 기준 형제)으로 기록한다. 사진 정렬은 `display:block` + 좌우 margin이며, 가로 flex 부모 안에서는 막는다.
- 하위 요소가 있는 요소는 텍스트 직접 편집 불가(하위 구조 보호). 예외: 자식이 `<br>`뿐인 요소.
- 내용 편집의 줄바꿈: `readEditableText()`/`writeEditableText()`가 입력칸의 `
` ↔ `<br>`을 변환한다(`pre` 계열 white-space 요소는 `
` 그대로). 소스 들여쓰기에서 온 줄바꿈·공백은 읽을 때 공백 하나로 정리한다. 'text' 히스토리 항목은 `innerHTML` 스냅샷이다. `<br>`/`<wbr>`에는 편집 ID를 붙이지 않아 트리·선택 대상에서 빠진다.
- 텍스트 입력 칸에 포커스가 있으면 단축키(`Ctrl+Z/Y/D`, `Delete`)를 무시한다(`isTextEntryTarget`).
- 요소 트리 접기: `#tree-pane.is-collapsed`(기본 접힘). 머리(`.tree-pane__head`, 접기 버튼)는 고정이고 `#tree`만 스크롤된다. 상태는 `localStorage['html-visual-editor:tree-collapsed']`에 저장하며, 접근이 막혀도 동작하도록 try/catch로 감싼다.
- `window.FrontEndEditor`: 선택 요소·미리보기 문서 접근자와 `buildCleanHtml` 등을 노출한다(검증용).

## 확인 방법

개발 중에는 `editor.html`을 브라우저(Chrome)로 직접 열어 확인한다. 테스트 프레임워크는 없다.
