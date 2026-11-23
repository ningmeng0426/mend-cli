// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- sections 5 to 8: line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches ----------

/** A file as lines (section 3): its own line break, its lines, and whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** One line of a hunk or chunk body; `oi` is its index among the old lines (context and old), -1 for new lines. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  oi: number;
  fromEmpty?: boolean;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every start position where O occurs in lines at one tier, ascending; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier holding an occurrence (passing `ok`, when given) and its positions, or null. */
function findTier(lines: string[], O: string[], strict: boolean, ok?: (pos: number) => boolean): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    let at = occurrences(lines, O, tier);
    if (ok !== undefined) at = at.filter(ok);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines a match writes: context lines are the file's own; at tier 2 the other lines are re-indented (section 5). */
function renderN(fileLines: string[], pos: number, body: BodyLine[], tier: number): string[] {
  const olds = body.filter((b) => b.kind !== 'new');
  const F = olds.length > 0 && pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const P = olds.length > 0 ? leadWs(olds[0]!.text) : '';
  const out: string[] = [];
  for (const b of body) {
    if (b.kind === 'old') continue;
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + b.oi]!);
      continue;
    }
    let t = b.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/** Moves that succeeded, for the `R` lines of section 2; emptied by run() before the edits run. */
const moves: Array<[string, string]> = [];

// ---------- section 6: unified diffs ----------

interface UHunk {
  a: number;
  body: BodyLine[];
  bsAfter: Set<number>;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  sawPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
}

/** Whether a `\` line follows the hunk's last context or new line. */
function lastBs(h: UHunk): boolean {
  for (let bi = h.body.length - 1; bi >= 0; bi -= 1) {
    if (h.body[bi]!.kind !== 'old') return h.bsAfter.has(bi);
  }
  return false;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const gitRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const headPath = (raw: string): string | null => {
    let p = raw.split('\t')[0]!.trim();
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const fresh = (): USection => ({ oldPath: null, newPath: null, sawPair: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.sawPair) {
        cur = fresh();
        sections.push(cur);
      }
      cur.oldPath = headPath(line.slice(4));
      cur.newPath = headPath(lines[i + 1]!.slice(4));
      cur.sawPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [], bsAfter: new Set() };
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          hunk.body.push({ kind: 'ctx', text: '', oi: hunk.body.filter((b) => b.kind !== 'new').length, fromEmpty: true });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          const kind = c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new';
          hunk.body.push({ kind, text: l.slice(1), oi: kind === 'new' ? -1 : hunk.body.filter((b) => b.kind !== 'new').length });
          j += 1;
          continue;
        }
        if (c === '\\') {
          if (hunk.body.length > 0) hunk.bsAfter.add(hunk.body.length - 1);
          j += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.fromEmpty === true) hunk.body.pop();
      for (const v of [...hunk.bsAfter]) if (v >= hunk.body.length) hunk.bsAfter.delete(v);
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.renameFrom ?? sec.oldPath;
    const newP = sec.renameTo ?? sec.newPath;
    if (sec.oldPath === null || sec.isNew) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, bi) => {
          if (b.kind === 'new') {
            plus.push(b.text);
            bs = h.bsAfter.has(bi);
          }
        });
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
      return;
    }
    if (sec.newPath === null || sec.isDel) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP ?? '';
    const n = newP ?? '';
    if (!safe(o)) throw new Fail('unsafe', o);
    if (!safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    const move = o !== n;
    if (move && tree.get(n) !== null) throw new Fail('exists', n);
    const f = splitFile(before);
    const lines = f.lines.slice();
    let final = f.final;
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.body.filter((b) => b.kind !== 'new').map((b) => b.text);
      const nLen = h.body.filter((b) => b.kind !== 'old').length;
      if (O.length === 0) {
        let at = h.a + d;
        if (at < 0) at = 0;
        if (at > lines.length) at = lines.length;
        const atEnd = at === lines.length;
        const add = renderN(lines, at, h.body, 0);
        lines.splice(at, 0, ...add);
        if (atEnd && h.body.length > 0) final = !lastBs(h);
        d += add.length;
        continue;
      }
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', o);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      let best = Math.abs(pos - target);
      for (const cand of found.at) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const add = renderN(lines, pos, h.body, found.tier);
      const atEnd = pos + O.length === lines.length;
      lines.splice(pos, O.length, ...add);
      if (atEnd) final = nLen === 0 ? lines.length > 0 : !lastBs(h);
      d += nLen - O.length;
    }
    tree.now.set(o, joinFile(lines, f.br, final));
    if (move) {
      tree.now.set(n, tree.now.get(o)!);
      tree.now.set(o, null);
      moves.push([o, n]);
    }
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = [
      ...oldLines.map((t, oi) => ({ kind: 'old' as const, text: t, oi })),
      ...newLines.map((t) => ({ kind: 'new' as const, text: t, oi: -1 })),
    ];
    const out = f.lines.slice();
    out.splice(found.at[0]!, oldLines.length, ...renderN(f.lines, found.at[0]!, body, found.tier));
    tree.now.set(path, joinFile(out, f.br, f.final));
  };
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: Array<['add' | 'delete' | 'update', string]> = [
    ['add', '*** Add File: '],
    ['delete', '*** Delete File: '],
    ['update', '*** Update File: '],
  ];
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = heads.find(([, p]) => line.startsWith(p));
    if (head === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const [kind, prefix] = head;
    const content: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && !heads.some(([, p]) => lines[j]!.startsWith(p))) {
      content.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    sections.push(buildVSection(kind, line.slice(prefix.length).trim(), i + 1, content));
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function buildVSection(kind: 'add' | 'delete' | 'update', path: string, lineNo: number, content: Array<{ text: string; no: number }>): VSection {
  const sec: VSection = { kind, path, lineNo, addLines: [], moveTo: null, chunks: [] };
  if (kind === 'add') {
    for (const c of content) {
      if (c.text.startsWith('+')) sec.addLines.push(c.text.slice(1));
      else if (c.text === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${c.no}`);
    }
    return sec;
  }
  if (kind === 'delete') {
    if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
    return sec;
  }
  let cur: VChunk | null = null;
  let afterEof = false;
  content.forEach((c, idx) => {
    const l = c.text;
    if (idx === 0 && l.startsWith('*** Move to: ')) {
      sec.moveTo = l.slice('*** Move to: '.length).trim();
      return;
    }
    if (l.startsWith('@@')) {
      const t = l.slice(2).trim();
      cur = { anchor: t === '' ? null : t, eof: false, body: [] };
      sec.chunks.push(cur);
      afterEof = false;
      return;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, body: [] };
        sec.chunks.push(cur);
      } else {
        cur.eof = true;
      }
      afterEof = true;
      cur = null;
      return;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (afterEof) throw new Exit2(`error: parse ${c.no}`);
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${c.no}`);
        cur = { anchor: null, eof: false, body: [] };
        sec.chunks.push(cur);
      }
      const kind2 = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind: kind2, text: l === '' ? '' : l.slice(1), oi: kind2 === 'new' ? -1 : cur.body.filter((b) => b.kind !== 'new').length });
      return;
    }
    throw new Exit2(`error: parse ${c.no}`);
  });
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return sec;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const path = sec.path;
    if (sec.kind === 'add') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (!safe(path)) throw new Fail('unsafe', path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    const lines = f.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        const foundA = findTier(lines, [anchor], strict, (p) => p >= cursor);
        if (foundA === null) throw new Fail('no-match', path);
        cursor = foundA.at[0]! + 1;
      }
      const O = ch.body.filter((b) => b.kind !== 'new').map((b) => b.text);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        const add = renderN(lines, at, ch.body, 0);
        lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTier(lines, O, strict, (p) => p >= cursor && (!ch.eof || p + O.length === lines.length));
      if (found === null) throw new Fail('no-match', path);
      const pos = found.at[0]!;
      const add = renderN(lines, pos, ch.body, found.tier);
      lines.splice(pos, O.length, ...add);
      cursor = pos + add.length;
    }
    tree.now.set(path, joinFile(lines, f.br, f.final));
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, tree.now.get(path)!);
      tree.now.set(path, null);
      moves.push([path, sec.moveTo]);
    }
  };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  moves.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rowList: Array<{ key: string; text: string }> = [];
  const claimed = new Set<string>();
  for (const [o, n] of moves) {
    if (claimed.has(o) || claimed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rowList.push({ key: n, text: `R ${o} -> ${n}` });
      claimed.add(o);
      claimed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const rows = rowList.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
