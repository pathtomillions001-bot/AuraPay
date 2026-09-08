#!/usr/bin/env python3
"""Guardrail for the hand-written INSERTs in apps/api/src.

For every `db.run(`INSERT INTO t (...) VALUES (...)`, [params])` in the source, check
that the number of columns, the number of value slots and the number of bound
parameters agree. Placeholder drift is otherwise a runtime-only failure (and
SQLite's message points at the driver, not the bug), so it is checked here.
"""
import re, sys, pathlib

def split_top(s):
    out, depth, cur, instr, q = [], 0, '', 0, ''
    for ch in s:
        if instr:
            cur += ch
            if ch == q: instr = 0
            continue
        if ch in '"\'':
            instr, q = 1, ch; cur += ch; continue
        if ch in '([{': depth += 1
        elif ch in ')]}': depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur); cur = ''
        else:
            cur += ch
    if cur.strip(): out.append(cur)
    return [x for x in out if x.strip()]

def find_call(src, i):
    depth, j = 0, i
    while j < len(src):
        if src[j] in '([{': depth += 1
        elif src[j] in ')]}':
            depth -= 1
            if depth == 0: return src[i+1:j], j
        j += 1
    return None, len(src)

problems = []
root = pathlib.Path('src')
for path in sorted(root.rglob('*.ts')):
    src = path.read_text()
    for m in re.finditer(r'INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+(\w+)', src):
        table = m.group(1)
        line = src[:m.start()].count('\n') + 1
        k = src.find('(', m.end())
        if k < 0: continue
        cols = src[k+1:src.find(')', k)]
        ncols = len([c for c in cols.split(',') if c.strip()])
        tail = src[m.end(): src.find('`', m.end()) if '`' in src[m.end():m.end()+1200] else m.end()+1200]
        if re.search(r'\bSELECT\b', tail) and not re.search(r'\bVALUES\b', tail):
            continue  # INSERT INTO t (…) SELECT … — column count vs expression list, checked by the DB
        v = re.search(r'VALUES\s*\(', src[k:])
        if not v: continue
        vs = k + v.end() - 1
        vals, _ = find_call(src, vs)
        nvals = len(split_top(vals))
        after = src[vs + len(vals) + 1:]
        pm = re.match(r'\s*`,\s*\[', after)
        nparams = None
        if pm:
            lb = vs + len(vals) + 1 + pm.end() - 1
            params, _ = find_call(src, lb)
            nparams = len(split_top(params))
        nq = vals.count('?')
        if ncols != nvals or (nparams is not None and nq != nparams):
            problems.append(f"{path}:{line}: {table}: {ncols} columns / {nvals} value slots / {nparams if nparams is not None else '?'} bound params")
if problems:
    print('\n'.join(problems)); print(f'{len(problems)} issue(s)'); sys.exit(1)
print('all INSERT statements agree')
