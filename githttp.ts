// githttp.ts — git smart HTTP: the ref advertisements, protocol v2 ls-refs and fetch, the v0 fetch
// fallback, and receive-pack with report-status. The wire shapes are the ones git itself speaks (and
// the suite's client parses): pkt-line framing, capability lists after a NUL on the first ref line,
// side-band-64k pack delivery, and per-ref ok/ng report lines.
//
// Layout of a repository's refs in this forge: repo.refs maps full ref names to commit shas; HEAD is
// the symbolic ref to refs/heads/<defaultBranch>. An unborn HEAD (a repository with no commits on
// its default branch) advertises as the zero sha with capabilities^{} on protocol v0, and as an
// `unborn HEAD` line on protocol v2 when the client asks for it.

import type { ServerResponse } from 'node:http';
import type { Forge, RepoRec } from './store.ts';
import { VIEWER } from './store.ts';
import { HttpError, sendRaw, type ReqCtx } from './http.ts';
import {
  ZERO_SHA,
  commitOf,
  getObject,
  isAncestor,
  parsePack,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  planFetch,
  readPktLines,
  storeObjectAt,
  writePack,
} from './git.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';
const AGENT = 'forge/1.0.0';

/** The branch HEAD names in a repository (its default branch). */
function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The sha HEAD resolves to, or null while the default branch is unborn. */
function headSha(repo: RepoRec): string | null {
  return repo.refs.get(headRef(repo)) ?? null;
}

/** Ref names in advertisement order: lexicographic, as git emits them. */
function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

/** The ultimate commit an annotated tag peels to (for ls-refs' peeled attribute). */
function peeledOf(repo: RepoRec, sha: string): string | null {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'tag') return null;
  return peelToCommit(repo, sha);
}

// ------------------------------------------------------------------------------------------------
// Advertisements (info/refs)

/** Protocol v0 ref lines for one service, with the service preamble. */
function advertiseV0(repo: RepoRec, service: string): Buffer {
  const caps =
    service === UPLOAD_PACK
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta deepen-since deepen-not symref=HEAD:${headRef(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  const head = headSha(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else if (head !== null) {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const name of names) parts.push(pktLine(`${repo.refs.get(name)} ${name}\n`));
  } else {
    // Refs exist but HEAD is unborn: the first ref line carries the capabilities.
    names.forEach((name, index) => {
      parts.push(pktLine(index === 0 ? `${repo.refs.get(name)} ${name}\0${caps}\n` : `${repo.refs.get(name)} ${name}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Protocol v2 capabilities for upload-pack (receive-pack is always v0 and never lands here). */
function advertiseV2(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
}

function handleInfoRefs(ctx: ReqCtx, res: ServerResponse, repo: RepoRec): void {
  const service = ctx.query.get('service') ?? '';
  if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) {
    throw new HttpError(400, 'GitHub only serves git-upload-pack and git-receive-pack here');
  }
  if (service === UPLOAD_PACK && ctx.gitProtocol === 'version=2') {
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV2());
    return;
  }
  const contentType = service === UPLOAD_PACK ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  sendRaw(res, 200, contentType, advertiseV0(repo, service));
}

// ------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function handleLsRefs(repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  // HEAD comes first when it is in scope: a prefix list that does not cover "HEAD" leaves it out.
  if (matches('HEAD')) {
    const head = headSha(repo);
    if (head !== null) {
      lines.push(symrefs ? `${head} HEAD symref-target:${headRef(repo)}` : `${head} HEAD`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:${headRef(repo)}` : 'unborn HEAD');
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const sha = repo.refs.get(name) ?? ZERO_SHA;
    let line = `${sha} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
}

// ------------------------------------------------------------------------------------------------
// fetch (protocol v2 and the v0 fallback)

/** One side-band-64k stream carrying a pack: band-1 chunks, then a flush. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepen?: number;
  sideband: boolean;
}

function fetchResponse(repo: RepoRec, args: FetchArgs, version2: boolean): Buffer {
  const plan = planFetch(repo, { wants: args.wants, haves: args.haves, shallow: args.shallow, depth: args.depth, deepen: args.deepen });
  const pack = writePack(plan.objects);
  if (version2) {
    const parts: Buffer[] = [];
    // acknowledgments: one ACK per common have, or a single NAK.
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length > 0) {
      for (const sha of plan.common) parts.push(pktLine(`ACK ${sha} common\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
    // shallow-info: only when the exchange is about shallowness at all.
    if (args.depth !== undefined || args.deepen !== undefined || args.shallow.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    return Buffer.concat(parts);
  }
  // Protocol v0: shallow lines, then the ACK/NAK line, then the pack (sideband when negotiated).
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}\n` : 'NAK\n'));
  parts.push(args.sideband ? sidebandPack(pack) : Buffer.concat([pack, pktFlush()]));
  return Buffer.concat(parts);
}

/** Parse and answer one upload-pack POST (v2 when the body opens with a command, v0 otherwise). */
function handleUploadPack(ctx: ReqCtx, res: ServerResponse, repo: RepoRec): void {
  const body = ctx.body;
  // The first pkt-line's payload decides the protocol: v2 opens with "command=...", v0 with "want ...".
  let firstPayload = '';
  if (body.length >= 4) {
    const length = parseInt(body.subarray(0, 4).toString('ascii'), 16);
    if (Number.isFinite(length) && length >= 4 && body.length >= length) {
      firstPayload = body.subarray(4, length).toString('utf8');
    }
  }
  if (firstPayload.startsWith('command=')) {
    // Protocol v2: command line, capability lines, a delimiter, argument lines, a flush.
    const first = readPktLines(body, 0);
    const commandLine = first.lines[0]?.toString('utf8').trim() ?? '';
    const command = commandLine.replace(/^command=/, '');
    let offset = first.next;
    let args: string[] = [];
    if (first.terminator === 'delim') {
      const second = readPktLines(body, offset);
      args = second.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
      offset = second.next;
    }
    void offset;
    if (command === 'ls-refs') {
      sendRaw(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, args));
      return;
    }
    if (command === 'fetch') {
      const parsed: FetchArgs = { wants: [], haves: [], shallow: [], sideband: true };
      for (const arg of args) {
        if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) parsed.deepen = Number(arg.slice(7).trim());
        else if (arg === 'deepen-since' || arg.startsWith('deepen-since ')) parsed.deepen = undefined;
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, parsed, true));
      return;
    }
    throw new HttpError(400, `unknown protocol v2 command ${command}`);
  }
  // Protocol v0: want lines (the first carries the capabilities after a NUL), a flush, have lines, done.
  const first = readPktLines(body, 0);
  const wants: string[] = [];
  let caps = '';
  for (const raw of first.lines) {
    const line = raw.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) caps = line.slice(nul + 1);
    const trimmed = clean.trim();
    if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).trim());
  }
  const haves: string[] = [];
  if (first.terminator === 'flush' && first.next < body.length) {
    const second = readPktLines(body, first.next);
    for (const raw of second.lines) {
      const trimmed = raw.toString('utf8').trim();
      if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
    }
  }
  const parsed: FetchArgs = { wants, haves, shallow: [], sideband: caps.includes('side-band-64k') || caps.includes('side-band') };
  sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, parsed, false));
}

// ------------------------------------------------------------------------------------------------
// receive-pack

interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Parse and answer one receive-pack POST: unpack, then apply the ref updates in order. */
function handleReceivePack(ctx: ReqCtx, res: ServerResponse, repo: RepoRec): void {
  const body = ctx.body;
  const first = readPktLines(body, 0);
  const commands: RefCommand[] = [];
  let caps = '';
  for (const raw of first.lines) {
    const line = raw.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
    if (nul >= 0) caps = line.slice(nul + 1);
    const parts = clean.split(/\s+/);
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] ?? '') && /^[0-9a-f]{40}$/.test(parts[1] ?? '')) {
      commands.push({ oldSha: parts[0] ?? '', newSha: parts[1] ?? '', ref: parts[2] ?? '' });
    }
  }
  const sideband = caps.includes('side-band-64k');
  const reportStatus = caps.includes('report-status');
  // The pack (when the push carries one) is unpacked before any ref moves.
  let unpackLine = 'unpack ok';
  const packAt = first.next;
  if (packAt < body.length) {
    try {
      const parsed = parsePack(repo, body, packAt);
      for (const object of parsed.objects) storeObjectAt(repo, object.type, object.data, object.sha);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  }
  const report: string[] = [];
  if (unpackLine === 'unpack ok') {
    for (const command of commands) {
      report.push(applyRefCommand(repo, command));
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  }
  if (!reportStatus) {
    sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportBytes = Buffer.concat([pktLine(`${unpackLine}\n`), ...report.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  if (sideband) {
    // The whole report stream travels inside band-1 packets, then a final flush.
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < reportBytes.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(at, Math.min(reportBytes.length, at + CHUNK))])));
    }
    parts.push(pktFlush());
    sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
    return;
  }
  sendRaw(res, 200, 'application/x-git-receive-pack-result', reportBytes);
}

/** Apply one ref update; answers its report line ("ok <ref>" or "ng <ref> <reason>"). */
function applyRefCommand(repo: RepoRec, command: RefCommand): string {
  const { oldSha, newSha, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_SHA;
  if (newSha === ZERO_SHA) {
    // A deletion: the ref must exist and the client's view of it must be current.
    if (current === ZERO_SHA) return `ng ${ref} reference not found`;
    if (current !== oldSha) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = getObject(repo, newSha);
  if (target === null) return `ng ${ref} unknown object`;
  if (oldSha === ZERO_SHA) {
    if (current !== ZERO_SHA) return `ng ${ref} already exists`;
  } else {
    if (current !== oldSha) return `ng ${ref} stale info`;
    // A branch update must be a fast-forward; tags may move freely.
    if (ref.startsWith('refs/heads/') && target.type === 'commit' && !isAncestor(repo, oldSha, newSha)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newSha);
  return `ok ${ref}`;
}

// ------------------------------------------------------------------------------------------------
// Entry point

/**
 * Serve one git smart-HTTP request. `segments` is the decoded path after the leading slash:
 * [owner, repo(.git), 'info/refs' | 'git-upload-pack' | 'git-receive-pack']. A repository that does
 * not exist under the named owner is a 404 on every service, as GitHub answers it.
 */
export function handleGit(ctx: ReqCtx, res: ServerResponse, segments: string[]): void {
  const owner = segments[0] ?? '';
  const repoSegment = (segments[1] ?? '').replace(/\.git$/, '');
  const tail = segments.slice(2).join('/');
  const repo = ctx.forge.getRepo(owner, repoSegment);
  if (repo === null) throw new HttpError(404, 'Not Found');
  if (tail === 'info/refs') {
    handleInfoRefs(ctx, res, repo);
    return;
  }
  if (tail === UPLOAD_PACK) {
    handleUploadPack(ctx, res, repo);
    return;
  }
  if (tail === RECEIVE_PACK) {
    handleReceivePack(ctx, res, repo);
    return;
  }
  throw new HttpError(404, 'Not Found');
}
