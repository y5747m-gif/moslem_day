#!/usr/bin/env python3
"""Structural checks for the VocalPure site and app.

For each (html, js files) pair:
  1. HTML tag balance (void elements excluded).
  2. Every id referenced by getElementById(...) or $("#...") in the JS
     exists in the HTML.
  3. Every local href=/src= reference in the HTML exists on disk.
Exit code 1 on any failure.
"""
import os
import re
import sys
from html.parser import HTMLParser

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}

TARGETS = [
    ("index.html", ["js/site.js", "js/background.js"]),
    ("app/index.html", ["app/js/isolation.js", "app/js/player.js"]),
]


class Balance(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []
        self.ids = set()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k == "id" and v:
                self.ids.add(v)
            if k in ("href", "src") and v:
                self.refs.append(v)
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))

    def handle_startendtag(self, tag, attrs):
        for k, v in attrs:
            if k == "id" and v:
                self.ids.add(v)
            if k in ("href", "src") and v:
                self.refs.append(v)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f"stray </{tag}> at {self.getpos()}")
            return
        open_tag, pos = self.stack.pop()
        if open_tag != tag:
            self.errors.append(f"<{open_tag}> opened at {pos} closed by </{tag}> at {self.getpos()}")


def check_pair(html_rel, js_rels):
    fails = []
    html_path = os.path.join(REPO, html_rel)
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    p = Balance()
    p.feed(html)
    p.close()
    if p.stack:
        fails += [f"unclosed <{t}> from {pos}" for t, pos in p.stack]
    fails += p.errors

    # duplicate ids
    seen = set()
    for m in re.finditer(r'id="([^"]+)"', html):
        if m.group(1) in seen:
            fails.append(f"duplicate id \"{m.group(1)}\"")
        seen.add(m.group(1))

    # JS id references
    for js_rel in js_rels:
        js_path = os.path.join(REPO, js_rel)
        if not os.path.exists(js_path):
            fails.append(f"missing JS file {js_rel}")
            continue
        with open(js_path, encoding="utf-8") as f:
            js = f.read()
        # ids created at runtime via innerHTML templates in this JS
        # count as existing (the element appears after a sheet opens)
        dyn_ids = set(re.findall(r'id="([\w-]+)"', js))
        dyn_ids |= set(re.findall(r"id='([\w-]+)'", js))
        known = p.ids | dyn_ids
        for m in re.finditer(r'getElementById\(\s*["\']([^"\']+)["\']\s*\)', js):
            if m.group(1) not in known:
                fails.append(f"{js_rel}: getElementById(\"{m.group(1)}\") not created anywhere")
        for m in re.finditer(r'\$\(\s*["\']([^"\']+)["\']\s*\)', js):
            ref = m.group(1)
            if re.fullmatch(r"[A-Za-z][\w-]*", ref) and ref not in known:
                fails.append(f"{js_rel}: $(\"{ref}\") not created anywhere")
        # dynamic ids like $("eq-band-" + i)
        for m in re.finditer(r'\$\(\s*"([\w-]+)"\s*\+\s*\w+\s*\)', js):
            prefix = m.group(1)
            if not any(i.startswith(prefix) for i in known):
                fails.append(f"{js_rel}: dynamic id prefix \"{prefix}\" not created anywhere")

    # local href/src targets exist
    for ref in p.refs:
        if ref.startswith(("http:", "https:", "data:", "#", "mailto:", "javascript:")) or ref.strip() == "":
            continue
        target = ref.split("#")[0].split("?")[0]
        if not target:
            continue
        base = os.path.dirname(html_path)
        if not os.path.exists(os.path.join(base, target)):
            fails.append(f"{html_rel}: reference \"{ref}\" not found on disk")

    return fails


def main():
    total = 0
    for html_rel, js_rels in TARGETS:
        fails = check_pair(html_rel, js_rels)
        status = "OK " if not fails else "FAIL"
        print(f"[{status}] {html_rel} ({len(fails)} issue(s))")
        for f in fails:
            print("        -", f)
        total += len(fails)
    if total:
        sys.exit(1)
    print("HTML/JS structural checks passed.")


if __name__ == "__main__":
    main()
