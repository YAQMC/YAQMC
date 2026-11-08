"""One-shot migration: make compact (phone / rail) layouts viewport-driven instead of Android-only.

Inside @media blocks that can only match viewports the Electron window cannot reach
(minWidth 1000 / minHeight 680 in apps/desktop/main/index.ts), drop the
`[data-host-kind='android']` gate so the web build and demo get the same layouts.
Blocks that a desktop window can match (e.g. 840-1199px tablet landscape) keep the gate.

Usage: python3 -I ungate-compact-layouts.py [--write] FILE...
"""

import re
import sys

GATE = ".app-shell[data-host-kind='android']"
DESKTOP_MIN_WIDTH = 1000
DESKTOP_MIN_HEIGHT = 680


def alternative_is_compact(alternative: str) -> bool:
    max_width = re.search(r'max-width:\s*(\d+)px', alternative)
    max_height = re.search(r'max-height:\s*(\d+)px', alternative)
    return bool(
        (max_width and int(max_width.group(1)) < DESKTOP_MIN_WIDTH)
        or (max_height and int(max_height.group(1)) < DESKTOP_MIN_HEIGHT)
    )


def query_is_compact(query: str) -> bool:
    # Every comma alternative must be unreachable on desktop, or the block stays gated.
    return all(alternative_is_compact(part) for part in query.split(','))


def transform(css: str) -> tuple[str, list[tuple[str, bool, int]]]:
    out: list[str] = []
    report: list[tuple[str, bool, int]] = []
    index = 0
    for match in re.finditer(r'@media([^{]+)\{', css):
        if match.start() < index:
            continue
        out.append(css[index : match.end()])
        depth, cursor = 1, match.end()
        while depth:
            char = css[cursor]
            depth += char == '{'
            depth -= char == '}'
            cursor += 1
        body = css[match.end() : cursor]
        query = match.group(1).strip()
        hits = body.count(GATE)
        if hits:
            compact = query_is_compact(query)
            report.append((query, compact, hits))
            if compact:
                body = body.replace(GATE, '.app-shell')
        out.append(body)
        index = cursor
    out.append(css[index:])
    return ''.join(out), report


def _self_check() -> None:
    assert query_is_compact('(orientation: portrait) and (max-width: 599px)')
    assert query_is_compact('(orientation: landscape) and (min-width: 600px) and (max-height: 599px)')
    assert not query_is_compact('(orientation: landscape) and (min-width: 840px) and (max-width: 1199px)')
    assert not query_is_compact('(max-width: 599px), (min-width: 1200px)')
    sample = "@media (max-width: 599px) { .app-shell[data-host-kind='android'] .x { a: b; } }"
    assert transform(sample)[0] == '@media (max-width: 599px) { .app-shell .x { a: b; } }'


if __name__ == '__main__':
    _self_check()
    write = '--write' in sys.argv
    for path in [arg for arg in sys.argv[1:] if arg != '--write']:
        with open(path, encoding='utf-8') as handle:
            source = handle.read()
        result, report = transform(source)
        for query, compact, hits in report:
            print(f"{path}: {'UNGATE' if compact else 'keep  '} x{hits:<3} @media {query}")
        if write and result != source:
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write(result)
