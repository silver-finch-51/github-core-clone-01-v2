// git.ts — the git object model the forge runs on: sha1-addressed blobs, trees, commits and tags;
// pack files (plain objects out, plain + delta objects in); pkt-line framing; ancestry walks; the
// fetch planner behind upload-pack (full, incremental, shallow and deepen); tree diffs for pull
// request files; and the file-level three-way merge behind pull request merges.
//
// Everything is a pure function of the repository's object store, and the store keeps objects
// verbatim: an object the client pushed is served back byte for byte under the sha it arrived with.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, RepoRec } from './store.ts';

export const ZERO_SHA = '0'.repeat(40);
export const SHA40 = /^[0-9a-f]{40}$/;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The sha an object of `type` with payload `data` lives under: sha1 of "<type> <length>\0<data>". */
export function objectSha(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object (idempotent: an object already present keeps its original insertion order). */
export function storeObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const sha = objectSha(type, data);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, { type, data });
    repo.objectSeq.set(sha, repo.nextObjectSeq);
    repo.nextObjectSeq += 1;
  }
  return sha;
}

export function getObject(repo: RepoRec, sha: string): GitObject | null {
  return repo.objects.get(sha) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  /** The raw "Name <email> ts tz" author line. */
  author: string;
  committer: string;
  /** Committer timestamp, epoch seconds (0 when the line carries none). */
  time: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const split = data.indexOf('\n\n');
  const head = split >= 0 ? data.subarray(0, split).toString('utf8') : data.toString('utf8');
  const message = split >= 0 ? data.subarray(split + 2).toString('utf8') : '';
  let tree = ZERO_SHA;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, time: timeMatch ? Number(timeMatch[1]) : 0 };
}

export function formatCommit(input: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Split a raw "Name <email> ts tz" line into the REST author shape. */
export function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}

export interface TreeEntry {
  /** Octal mode as written in the tree: '100644', '100755', '120000', '40000' for a subtree, '160000'. */
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree entry order: by name, with directories compared as if they ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = isTreeMode(a.mode) ? `${a.name}/` : a.name;
    const kb = isTreeMode(b.mode) ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function formatTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {sha, mode} for every blob (and gitlink) under it. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const tree = getObject(repo, treeSha);
  if (tree === null || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) the nested trees for a flat path -> {blob sha, mode} map; answers the root tree sha. */
export function buildTree(repo: RepoRec, files: Map<string, { sha: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] ?? path, entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: write(sub) });
    return storeObject(repo, 'tree', formatTree(entries));
  };
  return write(root);
}

/** Create a commit over a flat file map and store it (the REST contents/merge commit path). */
export function commitFiles(
  repo: RepoRec,
  input: { files: Map<string, { sha: string; mode: string }>; parents: string[]; authorLine: string; message: string },
): string {
  const tree = buildTree(repo, input.files);
  const data = formatCommit({ tree, parents: input.parents, author: input.authorLine, committer: input.authorLine, message: input.message });
  return storeObject(repo, 'commit', data);
}

// ------------------------------------------------------------------------------------------------
// Ancestry

/** Parse a commit, or null when the sha is not a commit in the store. */
export function commitOf(repo: RepoRec, sha: string): CommitInfo | null {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Follow a tag chain to the object it ultimately names. */
export function peelToCommit(repo: RepoRec, sha: string): string | null {
  let current = sha;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] ?? '';
  }
  return null;
}

/** Every commit reachable from `tip` (inclusive), following parents. */
export function collectCommits(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (seen.has(sha)) continue;
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    seen.add(sha);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const genAncestor = generationOf(repo, ancestor);
  // Walk from the descendant, pruning any branch that cannot reach the ancestor (a commit's
  // ancestors all have strictly smaller generations), and stop the moment it is found: an append
  // push is one step, not a walk of the whole history.
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (genAncestor !== null && (generationOf(repo, sha) ?? 0) <= genAncestor) continue;
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/**
 * A commit's generation: 1 + the greatest parent generation (roots are 1), memoized per repository.
 * Generations are monotone along parent edges, which is what lets ancestry walks prune.
 */
export function generationOf(repo: RepoRec, sha: string): number | null {
  const cache = repo.genCache;
  const compute = (current: string, guard: number): number | null => {
    const hit = cache.get(current);
    if (hit !== undefined) return hit;
    if (guard > 100000) return null;
    const commit = commitOf(repo, current);
    if (commit === null) return null;
    let gen = 1;
    for (const parent of commit.parents) {
      const parentGen = compute(parent, guard + 1);
      if (parentGen !== null && parentGen + 1 > gen) gen = parentGen + 1;
    }
    cache.set(current, gen);
    return gen;
  };
  return compute(sha, 0);
}

/** Shortest-path distances from `tip` to each of its ancestors (tip itself is 0). */
export function ancestorDistances(repo: RepoRec, tip: string): Map<string, number> {
  const dist = new Map<string, number>([[tip, 0]]);
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() ?? '';
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    const d = dist.get(sha) ?? 0;
    for (const parent of commit.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/** A best common ancestor of two commits (the merge base), or null for unrelated histories. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = ancestorDistances(repo, a);
  const fromB = ancestorDistances(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [sha, da] of fromA) {
    const db = fromB.get(sha);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = sha;
    }
  }
  return best;
}

/** Commits reachable from `tip`, newest first: committer time, then insertion order, parents after children. */
export function listCommits(repo: RepoRec, tip: string): string[] {
  const all = collectCommits(repo, tip);
  const order = (sha: string): [number, number] => {
    const commit = commitOf(repo, sha);
    return [commit?.time ?? 0, repo.objectSeq.get(sha) ?? 0];
  };
  // A simple priority walk: repeatedly take the newest remaining commit whose children are all out.
  const children = new Map<string, Set<string>>();
  for (const sha of all) children.set(sha, new Set());
  for (const sha of all) {
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    for (const parent of commit.parents) children.get(parent)?.add(sha);
  }
  const ready = new Set<string>([tip]);
  const out: string[] = [];
  const emitted = new Set<string>();
  while (ready.size > 0) {
    let pick: string | null = null;
    let pickKey: [number, number] = [0, 0];
    for (const sha of ready) {
      const key = order(sha);
      if (pick === null || key[0] > pickKey[0] || (key[0] === pickKey[0] && key[1] > pickKey[1])) {
        pick = sha;
        pickKey = key;
      }
    }
    if (pick === null) break;
    ready.delete(pick);
    if (emitted.has(pick) || !all.has(pick)) continue;
    emitted.add(pick);
    out.push(pick);
    const commit = commitOf(repo, pick);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!all.has(parent) || emitted.has(parent)) continue;
      const siblings = children.get(parent) ?? new Set();
      let blocked = false;
      for (const child of siblings) if (!emitted.has(child)) blocked = true;
      if (!blocked) ready.add(parent);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Pack files

const PACK_TYPES: Readonly<Record<number, GitObject['type']>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'commit', 7: 'commit' };

/** Serialize objects as a version-2 pack of plain (whole) objects, with the sha1 trailer. */
export function writePack(objects: readonly { type: string; data: Buffer }[]): Buffer {
  const typeNumbers: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = ((typeNumbers[object.type] ?? 3) << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    // Speed over size: the trial network is loopback, and a level-1 zlib stream is valid pack data
    // that costs a fraction of the CPU to produce.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Inflate one deflate stream starting at `offset`; answers the data and the stream's exact byte length. */
function inflateEntry(buf: Buffer, offset: number): { data: Buffer; length: number } {
  // inflateSync ignores trailing bytes, and a proper prefix of a deflate stream never decodes, so the
  // smallest length that decodes is the stream's true length: probe exponentially, then binary-search.
  const max = buf.length - offset;
  let lo = 1;
  let hi = Math.min(max, 64);
  let data: Buffer | null = null;
  for (;;) {
    try {
      data = inflateSync(buf.subarray(offset, offset + hi));
      break;
    } catch {
      if (hi >= max) throw new Error('pack entry does not inflate');
      lo = hi + 1;
      hi = Math.min(max, hi * 2);
    }
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: data ?? Buffer.alloc(0), length: lo };
}

/** Apply a git delta (copy/insert instructions) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] ?? 0;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (the caller checks the result size)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at] ?? 0;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= (delta[at] ?? 0) << (8 * i); at += 1; }
      if (op & 0x10) { size |= delta[at] ?? 0; at += 1; }
      if (op & 0x20) { size |= (delta[at] ?? 0) << 8; at += 1; }
      if (op & 0x40) { size |= (delta[at] ?? 0) << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface ParsedPackObject {
  type: GitObject['type'];
  data: Buffer;
  sha: string;
}

/**
 * Parse a pack starting at `offset`: answers the objects it carries (deltas resolved against the
 * store and against earlier objects in the same pack) and the offset just past the pack trailer.
 */
export function parsePack(repo: RepoRec, buf: Buffer, offset: number): { objects: ParsedPackObject[]; end: number } {
  if (buf.length < offset + 12 || buf.subarray(offset, offset + 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const count = buf.readUInt32BE(offset + 8);
  let at = offset + 12;
  const raw: { typeNum: number; data: Buffer; baseSha?: string; baseOffset?: number; start: number }[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = buf[at] ?? 0;
    at += 1;
    const typeNum = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = buf[at] ?? 0;
      at += 1;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: a negative offset varint back to the base object's start.
      let b = buf[at] ?? 0;
      at += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buf[at] ?? 0;
        at += 1;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeNum === 7) {
      baseSha = buf.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = inflateEntry(buf, at);
    at += inflated.length;
    byOffset.set(start, raw.length);
    raw.push({ typeNum, data: inflated.data, baseSha, baseOffset, start });
  }
  const end = at + 20; // the trailer is the pack's sha1; the caller does not need it verified
  const resolved: (ParsedPackObject | null)[] = raw.map(() => null);
  const resolve = (index: number): ParsedPackObject => {
    const done = resolved[index];
    if (done !== null && done !== undefined) return done;
    const entry = raw[index];
    if (entry === undefined) throw new Error('pack index out of range');
    let object: ParsedPackObject;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base: ParsedPackObject | null = null;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex !== undefined) base = resolve(baseIndex);
      }
      if (base === null && entry.baseSha !== undefined) {
        const stored = getObject(repo, entry.baseSha);
        if (stored !== null) base = { type: stored.type, data: stored.data, sha: entry.baseSha };
      }
      if (base === null) throw new Error('delta base is not available');
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data, sha: objectSha(base.type, data) };
    } else {
      const type = PACK_TYPES[entry.typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeNum}`);
      object = { type, data: entry.data, sha: objectSha(type, entry.data) };
    }
    resolved[index] = object;
    return object;
  };
  const objects = raw.map((_, index) => resolve(index));
  return { objects, end };
}

// ------------------------------------------------------------------------------------------------
// pkt-lines

/** Frame one pkt-line (4-hex length prefix including itself; payloads cap at 65516 bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > 65516) throw new Error('pkt-line payload too large');
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktStream {
  /** Data lines (length >= 5), as payloads without their length prefix. */
  lines: Buffer[];
  /** Where the first flush/delim stopped the stream: 'flush' | 'delim' | 'end'. */
  terminator: 'flush' | 'delim' | 'end';
  /** The offset just past the terminator. */
  next: number;
}

/** Read pkt-lines from `buf` starting at `offset` until a flush packet, a delimiter, or the end. */
export function readPktLines(buf: Buffer, offset: number): PktStream {
  const lines: Buffer[] = [];
  let at = offset;
  for (;;) {
    if (at + 4 > buf.length) return { lines, terminator: 'end', next: at };
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) return { lines, terminator: 'flush', next: at + 4 };
    if (length === 1) return { lines, terminator: 'delim', next: at + 4 };
    if (length === 2) { at += 2; continue; } // response-end packet (v2): treat as a soft separator
    if (length === 3) throw new Error('pkt-line length 3 is invalid');
    if (at + length > buf.length) throw new Error('pkt-line overruns the body');
    lines.push(buf.subarray(at + 4, at + length));
    at += length;
  }
}

// ------------------------------------------------------------------------------------------------
// Fetch planning (upload-pack)

export interface FetchPlan {
  /** The objects to pack, in a deterministic order (commits newest-first, then trees, then blobs). */
  objects: { sha: string; type: GitObject['type']; data: Buffer }[];
  /** Commits the client should newly mark shallow. */
  shallow: string[];
  /** Commits the client should stop treating as shallow. */
  unshallow: string[];
  /** Haves the server shares with the client (for the acknowledgments section). */
  common: string[];
}

/** The full object closure of a set of root objects, optionally skipping an exclusion set. */
function closureFrom(repo: RepoRec, roots: readonly string[], exclude: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (out.has(sha) || exclude.has(sha)) continue;
    const object = getObject(repo, sha);
    if (object === null) continue;
    out.set(sha, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] ?? '');
    }
  }
  return out;
}

/** Only the tree closure (trees + blobs) of one commit — what a shallow-held commit already has. */
function treeClosureOf(repo: RepoRec, commitSha: string, into: Set<string>): void {
  const commit = commitOf(repo, commitSha);
  if (commit === null) return;
  const stack = [commit.tree];
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (into.has(sha)) continue;
    const object = getObject(repo, sha);
    if (object === null) continue;
    into.add(sha);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.sha);
  }
}

/**
 * Plan one fetch: which objects to send for `wants`, given the client's `haves` and `shallow` lists
 * and an optional depth (a fresh shallow fetch) or deepen (extending a shallow history). Mirrors the
 * semantics the suite's client asserts: haves exclude their whole ancestry, shallow-held haves
 * exclude only themselves and their trees, a depth limit delivers exactly that many generations and
 * marks the boundary, and deepen delivers the generations between the old and the new boundary.
 */
export function planFetch(
  repo: RepoRec,
  input: { wants: string[]; haves: string[]; shallow: string[]; depth?: number; deepen?: number },
): FetchPlan {
  const shallowHeld = new Set(input.shallow.filter((sha) => commitOf(repo, sha) !== null));
  const common: string[] = [];
  const heldComplete = new Set<string>();
  for (const have of input.haves) {
    if (commitOf(repo, have) === null) continue;
    common.push(have);
    if (!shallowHeld.has(have)) {
      for (const sha of collectCommits(repo, have)) heldComplete.add(sha);
    }
  }
  // Object-level exclusions: complete haves exclude their closures; shallow-held commits exclude
  // only themselves plus their tree closures (their parents are precisely what deepen is for).
  const excludedObjects = new Set<string>();
  for (const sha of closureFrom(repo, [...heldComplete], new Set()).keys()) excludedObjects.add(sha);
  for (const sha of shallowHeld) {
    excludedObjects.add(sha);
    treeClosureOf(repo, sha, excludedObjects);
  }

  const limit = input.depth ?? input.deepen ?? Number.POSITIVE_INFINITY;
  // Distances from the wants, never expanding through a completely-held commit.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of input.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const sha = queue.shift() ?? '';
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    const d = dist.get(sha) ?? 0;
    // Never expand a completely-held commit (everything past it is held too), and never expand at
    // the depth limit (parents would land outside the included set anyway).
    if (heldComplete.has(sha)) continue;
    if (d + 1 >= limit) continue;
    for (const parent of commit.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const included = new Set<string>();
  for (const [sha, d] of dist) if (d < limit) included.add(sha);

  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const deliverCommits: string[] = [];
  for (const sha of included) {
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    const parentsHeldOrIncluded = commit.parents.every((p) => included.has(p) || heldComplete.has(p));
    if (!parentsHeldOrIncluded && !shallowHeld.has(sha)) shallowOut.push(sha);
    if (shallowHeld.has(sha) && parentsHeldOrIncluded && commit.parents.length > 0) unshallowOut.push(sha);
    if (!heldComplete.has(sha) && !shallowHeld.has(sha)) deliverCommits.push(sha);
  }
  // A shallow-held commit whose parents are still not all available stays shallow: nothing to say.
  // Deliver: the commits plus their tree closures, minus everything the client already holds.
  const deliver = new Map<string, GitObject>();
  for (const sha of deliverCommits) {
    const object = getObject(repo, sha);
    if (object !== null && !excludedObjects.has(sha)) deliver.set(sha, object);
  }
  for (const sha of deliverCommits) {
    const commit = commitOf(repo, sha);
    if (commit === null) continue;
    const trees = new Set<string>();
    treeClosureOf(repo, sha, trees);
    for (const treeSha of trees) {
      if (deliver.has(treeSha) || excludedObjects.has(treeSha)) continue;
      const object = getObject(repo, treeSha);
      if (object !== null) deliver.set(treeSha, object);
    }
  }
  // Tag objects named directly as wants travel too (peeled commits are already in).
  for (const want of input.wants) {
    const object = getObject(repo, want);
    if (object !== null && object.type === 'tag' && !excludedObjects.has(want)) deliver.set(want, object);
  }
  const typeRank: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const objects = [...deliver.entries()]
    .map(([sha, object]) => ({ sha, type: object.type, data: object.data }))
    .sort((a, b) => {
      const rank = (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9);
      if (rank !== 0) return rank;
      return (repo.objectSeq.get(b.sha) ?? 0) - (repo.objectSeq.get(a.sha) ?? 0);
    });
  return { objects, shallow: shallowOut.sort(), unshallow: unshallowOut.sort(), common };
}

// ------------------------------------------------------------------------------------------------
// Diffs and merges over trees

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldSha: string | null;
  newSha: string | null;
}

/** The file-level diff between two trees (either may be null for the empty tree). */
export function diffTrees(repo: RepoRec, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map<string, { sha: string; mode: string }>() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map<string, { sha: string; mode: string }>() : flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined) {
      if (before.sha !== after.sha) changes.push({ path, status: 'modified', oldSha: before.sha, newSha: after.sha });
    } else if (after !== undefined) {
      changes.push({ path, status: 'added', oldSha: null, newSha: after.sha });
    } else if (before !== undefined) {
      changes.push({ path, status: 'removed', oldSha: before.sha, newSha: null });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Count added/removed lines between two texts with a longest-common-subsequence diff. */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const linesOf = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = linesOf(oldText);
  const b = linesOf(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths over rows of `a`, one row of state at a time.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    prev = cur;
  }
  const common = prev[b.length] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

/**
 * A file-level three-way merge of flattened trees: a path changed on only one side takes that
 * side's value; changed identically on both sides takes it too; changed differently (including
 * modified on one side and deleted on the other) is a conflict.
 */
export function mergeFileMaps(
  base: ReadonlyMap<string, { sha: string; mode: string }>,
  ours: ReadonlyMap<string, { sha: string; mode: string }>,
  theirs: ReadonlyMap<string, { sha: string; mode: string }>,
): { files: Map<string, { sha: string; mode: string }> } | { conflict: string } {
  const files = new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o?.sha === t?.sha) {
      if (o !== undefined) files.set(path, o);
    } else if (b?.sha === o?.sha) {
      if (t !== undefined) files.set(path, t);
    } else if (b?.sha === t?.sha) {
      if (o !== undefined) files.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { files };
}
