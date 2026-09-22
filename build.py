#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""editor.html + editor.css + editor.js  ->  editor-standalone.html

분할 파일을 하나로 합쳐 단일 파일 버전을 만든다.
editor.html 의 <link>/<script> 태그 자리에 CSS/JS 내용을 그대로 끼워 넣을 뿐이라,
결과물은 분할 버전과 완전히 동일하게 동작한다.

사용법:
    python build.py            # editor-standalone.html 재생성
    python build.py --check    # 재생성 없이 동기화 여부만 확인
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
SOURCES = ("editor.html", "editor.css", "editor.js")
TARGET = "editor-standalone.html"

LINK_TAG = '<link rel="stylesheet" href="editor.css" />'
SCRIPT_TAG = '  <script src="editor.js"></script>'


def read(name):
    return (BASE / name).read_text(encoding="utf-8")


def build():
    html, css, js = (read(name) for name in SOURCES)

    for tag, name in ((LINK_TAG, "editor.css"), (SCRIPT_TAG, "editor.js")):
        if html.count(tag) != 1:
            raise SystemExit(
                f"editor.html 에서 {name} 삽입 위치를 찾지 못했습니다 "
                f"({html.count(tag)}개 발견): {tag}"
            )

    html = html.replace(LINK_TAG, "<style>\n" + css + "</style>")
    html = html.replace(SCRIPT_TAG, "  <script>\n" + js + "</script>")
    return html


def main():
    check = "--check" in sys.argv[1:]
    out = build().encode("utf-8")
    target = BASE / TARGET

    if check:
        current = target.read_bytes() if target.exists() else None
        if current == out:
            print(f"동기화됨: {TARGET} 이 분할 파일과 일치합니다.")
        else:
            size = len(current) if current is not None else 0
            print(f"동기화 필요: {TARGET} ({size} bytes) != 빌드 결과 ({len(out)} bytes)")
            print("  python build.py 를 실행해 다시 만드세요.")
            return 1
        return 0

    # 원본 줄바꿈(LF)을 그대로 유지하기 위해 바이트로 쓴다.
    target.write_bytes(out)
    print(f"{TARGET} 재생성 완료 ({len(out)} bytes)")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # 한글 출력이 깨지지 않도록
    except AttributeError:
        pass
    sys.exit(main())
