// rest.ts — the REST v3 surface: the API root and meta, the viewer, repositories (create, read,
// update, delete, the paginated /user/repos list), branches and git refs, commits, the contents API
// (read/write/delete files over commits the forge authors itself), labels, issues and their
// comments, and pull requests with their files and merges.
//
// Conventions GitHub's clients rely on, held throughout: every answer is JSON with a `message` on
// errors; a resource that does not exist under the named owner is a 404 (never a 403); creating
// answers 201, updating 200, deleting 204; a duplicate repository name is a 422 whose body says the
// name already exists; issue and pull request numbers share one sequence per repository.

import type { ServerResponse } from 'node:http';
import type { IssueRec, PullRec, RepoRec } from './store.ts';
import { VIEWER } from './store.ts';
import { HttpError, boolField, sendJson, strField, type ReqCtx } from './http.ts';
import {
  commitFiles,
  commitOf,
  flattenTree,
  getObject,
  parseTree,
  storeObject,
} from './git.ts';
import {
  branchTip,
  commentJson,
  commitJson,
  commitsFrom,
  issueJson,
  labelJson,
  mergePull,
  pullAsIssueJson,
  pullFiles,
  pullJson,
  repoJson,
  userJson,
  viewerIdent,
} from './views.ts';

const INSTALLED_VERSION = '3.0.0-github-core-clone';

interface Page {
  perPage: number;
  page: number;
}

function pageOf(ctx: ReqCtx): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

/** Paginate a list and set the Link header the way GitHub does (next/last, first/prev). */
function paginate<T>(ctx: ReqCtx, res: ServerResponse, items: T[], path: string): T[] {
  const { perPage, page } = pageOf(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const url = (p: number): string => `http://${ctx.host}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) {
    links.push(`<${url(page + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

function notFound(): HttpError {
  return new HttpError(404, 'Not Found');
}

function requireRepo(ctx: ReqCtx, owner: string, name: string): RepoRec {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === null) throw notFound();
  return repo;
}

// ------------------------------------------------------------------------------------------------
// Root, meta, viewer

function handleRoot(ctx: ReqCtx, res: ServerResponse): void {
  const base = `http://${ctx.host}`;
  sendJson(res, 200, {
    current_user_url: `${base}/api/v3/user`,
    repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
    issue_url: `${base}/api/v3/repos/{owner}/{repo}/issues`,
    rate_limit_url: `${base}/api/v3/rate_limit`,
    emojis_url: `${base}/api/v3/emojis`,
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleMeta(res: ServerResponse): void {
  sendJson(res, 200, {
    installed_version: INSTALLED_VERSION,
    verifiable_password_authentication: false,
    github_authentication_token_expiration: false,
    pages: ['builds'],
    importer: ['github-archive'],
  });
}

function handleUser(res: ServerResponse): void {
  sendJson(res, 200, {
    ...userJson(VIEWER.login),
    name: VIEWER.name,
    email: VIEWER.email,
    followers: 0,
    following: 0,
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  });
}

// ------------------------------------------------------------------------------------------------
// Repositories

function handleCreateRepo(ctx: ReqCtx, res: ServerResponse): void {
  const body = ctx.json();
  const name = strField(body, 'name');
  if (name === null || name.trim() === '') {
    throw new HttpError(422, 'Repository creation failed.');
  }
  const repo = ctx.forge.createRepo(name, {
    isPrivate: boolField(body, 'private') ?? false,
    description: strField(body, 'description') ?? '',
    defaultBranch: strField(body, 'default_branch') ?? undefined,
  });
  if (repo === null) {
    sendJson(res, 422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  sendJson(res, 201, repoJson(repo, `http://${ctx.host}`));
}

function handleListUserRepos(ctx: ReqCtx, res: ServerResponse): void {
  const base = `http://${ctx.host}`;
  const mine = ctx.forge.repos.filter((repo) => repo.owner === VIEWER.login);
  const page = paginate(ctx, res, mine, '/api/v3/user/repos');
  sendJson(res, 200, page.map((repo) => repoJson(repo, base)));
}

function handleRepo(ctx: ReqCtx, res: ServerResponse, method: string, repo: RepoRec): void {
  const base = `http://${ctx.host}`;
  if (method === 'GET') {
    sendJson(res, 200, repoJson(repo, base));
    return;
  }
  if (method === 'PATCH') {
    const body = ctx.json();
    const description = strField(body, 'description');
    if (description !== null) repo.description = description;
    const isPrivate = boolField(body, 'private');
    if (isPrivate !== null) repo.isPrivate = isPrivate;
    const name = strField(body, 'name');
    if (name !== null && name !== repo.name) {
      if (!ctx.forge.renameRepo(repo, name)) throw new HttpError(422, 'Repository name already exists on this account');
    }
    const defaultBranch = strField(body, 'default_branch');
    if (defaultBranch !== null) repo.defaultBranch = defaultBranch;
    repo.updatedAt = ctx.forge.nowIso();
    sendJson(res, 200, repoJson(repo, base));
    return;
  }
  if (method === 'DELETE') {
    ctx.forge.deleteRepo(repo);
    res.writeHead(204);
    res.end();
    return;
  }
  throw notFound();
}

// ------------------------------------------------------------------------------------------------
// Branches and git refs

function handleBranches(ctx: ReqCtx, res: ServerResponse, repo: RepoRec, rest: string[]): void {
  const base = `http://${ctx.host}`;
  if (rest.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(`refs/heads/${name}`) ?? ''}` },
        protected: false,
      }));
    sendJson(res, 200, paginate(ctx, res, branches, `/api/v3/repos/${repo.owner}/${repo.name}/branches`));
    return;
  }
  const name = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) throw notFound();
  sendJson(res, 200, {
    name,
    commit: commitJson(repo, sha, base),
    protected: false,
  });
}

function refJson(repo: RepoRec, ref: string): Record<string, unknown> {
  const sha = repo.refs.get(ref) ?? '';
  const object = getObject(repo, sha);
  return { ref, node_id: sha, url: '', object: { sha, type: object?.type ?? 'commit', url: '' } };
}

function handleGitRefs(ctx: ReqCtx, res: ServerResponse, method: string, repo: RepoRec, rest: string[]): void {
  // rest is what follows /git/refs: [] for the collection, otherwise the ref path ('heads/x', ...).
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = ctx.json();
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (ref === null || sha === null || !ref.startsWith('refs/')) throw new HttpError(422, 'Invalid ref or sha');
      if (getObject(repo, sha) === null) throw new HttpError(422, `Object ${sha} does not exist`);
      if (repo.refs.has(ref)) throw new HttpError(422, `Reference already exists: ${ref}`);
      repo.refs.set(ref, sha);
      repo.updatedAt = ctx.forge.nowIso();
      sendJson(res, 201, refJson(repo, ref));
      return;
    }
    if (method === 'GET') {
      const all = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
      sendJson(res, 200, all);
      return;
    }
    throw notFound();
  }
  const ref = `refs/${rest.join('/')}`;
  if (method === 'GET') {
    if (!repo.refs.has(ref)) throw notFound();
    sendJson(res, 200, refJson(repo, ref));
    return;
  }
  if (method === 'DELETE') {
    if (!repo.refs.has(ref)) throw notFound();
    repo.refs.delete(ref);
    res.writeHead(204);
    res.end();
    return;
  }
  throw notFound();
}

// ------------------------------------------------------------------------------------------------
// Commits

function handleCommits(ctx: ReqCtx, res: ServerResponse, repo: RepoRec): void {
  const base = `http://${ctx.host}`;
  const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
  const shas = commitsFrom(repo, shaParam);
  const page = paginate(ctx, res, shas, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  sendJson(res, 200, page.map((sha) => commitJson(repo, sha, base)));
}

// ------------------------------------------------------------------------------------------------
// Contents

/** Resolve a contents ref parameter (branch name, full ref, or sha) to a commit sha. */
function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) ?? null;
  if (getObject(repo, ref)?.type === 'commit') return ref;
  return null;
}

/** The tree sha a contents path resolves against, and the flattened files under it. */
function treeAt(repo: RepoRec, commitSha: string): Map<string, { sha: string; mode: string }> {
  const commit = commitOf(repo, commitSha);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.tree);
}

function handleContentsGet(ctx: ReqCtx, res: ServerResponse, repo: RepoRec, path: string): void {
  const base = `http://${ctx.host}`;
  const commitSha = resolveRef(repo, ctx.query.get('ref'));
  if (commitSha === null) throw notFound();
  const files = treeAt(repo, commitSha);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean !== '') {
    const file = files.get(clean);
    if (file !== undefined) {
      const blob = getObject(repo, file.sha);
      if (blob === null) throw notFound();
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: clean.split('/').pop() ?? clean,
        path: clean,
        sha: file.sha,
        content: blob.data.toString('base64'),
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${clean}`,
        html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${clean}`,
        download_url: null,
      });
      return;
    }
    // A directory when some file lives under it.
    const prefix = `${clean}/`;
    if (![...files.keys()].some((key) => key.startsWith(prefix))) throw notFound();
  }
  // A directory listing: walk the actual tree so directory entries carry their tree shas.
  const commit = commitOf(repo, commitSha);
  const listDir = (dirPath: string): { type: 'dir' | 'file'; name: string; path: string; sha: string; size: number }[] => {
    let treeSha = commit?.tree ?? '';
    if (dirPath !== '') {
      // Descend component by component.
      for (const part of dirPath.split('/')) {
        const tree = getObject(repo, treeSha);
        if (tree === null || tree.type !== 'tree') return [];
        const entriesInTree = new Map<string, { mode: string; sha: string }>();
        for (const entry of parseTreeEntries(repo, treeSha)) entriesInTree.set(entry.name, entry);
        const next = entriesInTree.get(part);
        if (next === undefined) return [];
        treeSha = next.sha;
      }
    }
    return parseTreeEntries(repo, treeSha).map((entry) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      const blob = isDir ? null : getObject(repo, entry.sha);
      return {
        type: isDir ? ('dir' as const) : ('file' as const),
        name: entry.name,
        path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
        sha: entry.sha,
        size: blob?.data.length ?? 0,
      };
    });
  };
  const listing = listDir(clean).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(res, 200, listing.map((entry) => ({
    type: entry.type,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    size: entry.size,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entry.path}`,
    download_url: null,
  })));
}

function parseTreeEntries(repo: RepoRec, treeSha: string): { mode: string; name: string; sha: string }[] {
  const tree = getObject(repo, treeSha);
  if (tree === null || tree.type !== 'tree') return [];
  return parseTree(tree.data);
}

/** Shared write path for PUT and DELETE /contents: mutate the file map and commit on the branch. */
function commitContentsChange(
  ctx: ReqCtx,
  repo: RepoRec,
  branch: string,
  mutate: (files: Map<string, { sha: string; mode: string }>) => void,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) {
    throw new HttpError(422, `Branch not found: ${branch}`);
  }
  const files = tip === null ? new Map<string, { sha: string; mode: string }>() : treeAt(repo, tip);
  mutate(files);
  const sha = commitFiles(repo, {
    files,
    parents: tip === null ? [] : [tip],
    authorLine: viewerIdent(ctx.forge),
    message,
  });
  repo.refs.set(ref, sha);
  repo.updatedAt = ctx.forge.nowIso();
  return sha;
}

function handleContentsPut(ctx: ReqCtx, res: ServerResponse, repo: RepoRec, path: string): void {
  const body = ctx.json();
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '' || clean.split('/').some((part) => part === '..' || part === '')) {
    throw new HttpError(422, 'Invalid path');
  }
  const message = strField(body, 'message') ?? `Update ${clean}`;
  const contentField = strField(body, 'content');
  if (contentField === null) throw new HttpError(422, '"content" wasn\'t supplied');
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) throw new HttpError(422, `Branch not found: ${branch}`);
  const files = tip === null ? new Map<string, { sha: string; mode: string }>() : treeAt(repo, tip);
  const existing = files.get(clean);
  const suppliedSha = strField(body, 'sha');
  if (existing !== undefined) {
    if (suppliedSha === null) throw new HttpError(422, '"sha" wasn\'t supplied');
    if (suppliedSha !== existing.sha) {
      throw new HttpError(409, `${clean} does not match the supplied sha ${suppliedSha}`);
    }
  }
  const data = Buffer.from(contentField.replace(/\s+/g, ''), 'base64');
  const blobSha = storeObject(repo, 'blob', data);
  const commitSha = commitContentsChange(ctx, repo, branch, (map) => {
    map.set(clean, { sha: blobSha, mode: existing?.mode ?? '100644' });
  }, message);
  const commit = commitOf(repo, commitSha);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: {
      name: clean.split('/').pop() ?? clean,
      path: clean,
      sha: blobSha,
      size: data.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: {
      sha: commitSha,
      message,
      author: { name: VIEWER.name, email: VIEWER.email, date: ctx.forge.nowIso() },
      committer: { name: VIEWER.name, email: VIEWER.email, date: ctx.forge.nowIso() },
      tree: { sha: commit?.tree ?? '' },
      parents: commit?.parents.map((parent) => ({ sha: parent })) ?? [],
    },
  });
}

function handleContentsDelete(ctx: ReqCtx, res: ServerResponse, repo: RepoRec, path: string): void {
  const body = ctx.json();
  const clean = path.replace(/^\/+|\/+$/g, '');
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (tip === null) throw notFound();
  const files = treeAt(repo, tip);
  const existing = files.get(clean);
  if (existing === undefined) throw notFound();
  const suppliedSha = strField(body, 'sha');
  if (suppliedSha === null) throw new HttpError(422, '"sha" wasn\'t supplied');
  if (suppliedSha !== existing.sha) throw new HttpError(409, `${clean} does not match the supplied sha ${suppliedSha}`);
  const message = strField(body, 'message') ?? `Delete ${clean}`;
  const commitSha = commitContentsChange(ctx, repo, branch, (map) => {
    map.delete(clean);
  }, message);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
}

// ------------------------------------------------------------------------------------------------
// Labels

function handleLabels(ctx: ReqCtx, res: ServerResponse, method: string, repo: RepoRec): void {
  if (method === 'GET') {
    const labels = [...repo.labels.keys()].sort().map((name) => labelJson(repo, name));
    sendJson(res, 200, labels);
    return;
  }
  if (method === 'POST') {
    const body = ctx.json();
    const name = strField(body, 'name');
    if (name === null || name === '') throw new HttpError(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) {
      throw new HttpError(422, 'Validation Failed: name has already been taken');
    }
    repo.labels.set(name, {
      name,
      color: (strField(body, 'color') ?? 'ededed').replace(/^#/, ''),
      description: strField(body, 'description'),
    });
    sendJson(res, 201, labelJson(repo, name));
    return;
  }
  throw notFound();
}

// ------------------------------------------------------------------------------------------------
// Issues and comments

function validateLabels(repo: RepoRec, names: string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) {
      throw new HttpError(422, `Validation Failed: label "${name}" does not exist in ${repo.owner}/${repo.name}`);
    }
  }
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const labels = body.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function handleIssues(ctx: ReqCtx, res: ServerResponse, method: string, repo: RepoRec, rest: string[]): void {
  const base = `http://${ctx.host}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = ctx.json();
      const title = strField(body, 'title');
      if (title === null || title === '') throw new HttpError(422, 'Validation Failed: title is required');
      const labels = labelNamesOf(body);
      validateLabels(repo, labels);
      const issue = ctx.forge.createIssue(repo, { title, body: strField(body, 'body') ?? '', labels });
      sendJson(res, 201, issueJson(repo, issue, base));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      void sort;
      interface Row { seq: number; json: Record<string, unknown> }
      const rows: Row[] = [];
      for (const issue of repo.issues.values()) {
        if (state !== 'all' && issue.state !== state) continue;
        rows.push({ seq: issue.seq, json: issueJson(repo, issue, base) });
      }
      for (const pull of repo.pulls.values()) {
        if (state !== 'all' && pull.state !== state) continue;
        rows.push({ seq: pull.seq, json: pullAsIssueJson(repo, pull, base) });
      }
      rows.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const page = paginate(ctx, res, rows, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      sendJson(res, 200, page.map((row) => row.json));
      return;
    }
    throw notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) throw notFound();
  if (rest.length === 1) {
    if (method === 'GET') {
      const issue = repo.issues.get(number);
      if (issue !== undefined) {
        sendJson(res, 200, issueJson(repo, issue, base));
        return;
      }
      const pull = repo.pulls.get(number);
      if (pull !== undefined) {
        sendJson(res, 200, pullAsIssueJson(repo, pull, base));
        return;
      }
      throw notFound();
    }
    if (method === 'PATCH') {
      const issue = repo.issues.get(number);
      if (issue === undefined) throw notFound();
      const body = ctx.json();
      const title = strField(body, 'title');
      if (title !== null) issue.title = title;
      const text = strField(body, 'body');
      if (text !== null) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = labelNamesOf(body);
        validateLabels(repo, labels);
        issue.labels = labels;
      }
      const state = strField(body, 'state');
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? ctx.forge.nowIso() : null;
      }
      issue.updatedAt = ctx.forge.nowIso();
      sendJson(res, 200, issueJson(repo, issue, base));
      return;
    }
    throw notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    const holder: IssueRec | PullRec | undefined = repo.issues.get(number) ?? repo.pulls.get(number);
    if (holder === undefined) throw notFound();
    if (method === 'GET') {
      sendJson(res, 200, holder.comments.map((comment) => commentJson(repo, number, comment, base)));
      return;
    }
    if (method === 'POST') {
      const body = ctx.json();
      const text = strField(body, 'body');
      if (text === null) throw new HttpError(422, 'Validation Failed: body is required');
      const comment = ctx.forge.addComment(holder, text);
      sendJson(res, 201, commentJson(repo, number, comment, base));
      return;
    }
    throw notFound();
  }
  throw notFound();
}

// ------------------------------------------------------------------------------------------------
// Pull requests

function stripOwnerPrefix(repo: RepoRec, ref: string): string {
  const colon = ref.indexOf(':');
  if (colon > 0 && ref.slice(0, colon).toLowerCase() === repo.owner.toLowerCase()) return ref.slice(colon + 1);
  return ref;
}

function handlePulls(ctx: ReqCtx, res: ServerResponse, method: string, repo: RepoRec, rest: string[]): void {
  const base = `http://${ctx.host}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = ctx.json();
      const title = strField(body, 'title');
      if (title === null || title === '') throw new HttpError(422, 'Validation Failed: title is required');
      const head = strField(body, 'head');
      const baseRef = strField(body, 'base') ?? repo.defaultBranch;
      if (head === null || head === '') throw new HttpError(422, 'Validation Failed: head is required');
      const headRef = stripOwnerPrefix(repo, head);
      const baseName = stripOwnerPrefix(repo, baseRef);
      if (branchTip(repo, headRef) === null) throw new HttpError(422, `Head branch does not exist: ${headRef}`);
      if (branchTip(repo, baseName) === null) throw new HttpError(422, `Base branch does not exist: ${baseName}`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseName) {
          throw new HttpError(422, `A pull request already exists for ${repo.owner}:${headRef} -> ${baseName}`);
        }
      }
      const pull = ctx.forge.createPull(repo, { title, body: strField(body, 'body') ?? '', headRef, baseRef: baseName });
      sendJson(res, 201, pullJson(repo, pull, base));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.seq - a.seq);
      const page = paginate(ctx, res, pulls, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      sendJson(res, 200, page.map((pull) => pullJson(repo, pull, base)));
      return;
    }
    throw notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) throw notFound();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (method !== 'GET') throw notFound();
    if (pull === undefined) throw notFound();
    sendJson(res, 200, pullJson(repo, pull, base));
    return;
  }
  if (pull === undefined) throw notFound();
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      sha: file.newSha ?? file.oldSha ?? '',
      filename: file.path,
      status: file.status === 'modified' ? 'modified' : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const page = paginate(ctx, res, files, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}/files`);
    sendJson(res, 200, page);
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const body = ctx.body.length > 0 ? ctx.json() : {};
    const methodField = strField(body, 'merge_method') ?? 'squash';
    const how = methodField === 'merge' ? 'merge' : methodField === 'rebase' ? 'rebase' : 'squash';
    const outcome = mergePull(ctx.forge, repo, pull, how);
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  throw notFound();
}

// ------------------------------------------------------------------------------------------------
// Dispatch

/** Serve one /api/v3 request; `segments` is the decoded path after /api/v3. */
export function handleRest(ctx: ReqCtx, res: ServerResponse, method: string, segments: string[]): void {
  if (segments.length === 0) {
    if (method === 'GET') return handleRoot(ctx, res);
    throw notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return handleMeta(res);
    throw notFound();
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') return handleUser(res);
    throw notFound();
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') return handleCreateRepo(ctx, res);
    if (method === 'GET') return handleListUserRepos(ctx, res);
    throw notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = requireRepo(ctx, segments[1] ?? '', segments[2] ?? '');
    const rest = segments.slice(3);
    if (rest.length === 0) return handleRepo(ctx, res, method, repo);
    if (rest[0] === 'branches') return handleBranches(ctx, res, repo, rest.slice(1));
    if (rest[0] === 'git' && rest[1] === 'refs') return handleGitRefs(ctx, res, method, repo, rest.slice(2));
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method === 'GET') return handleCommits(ctx, res, repo);
      throw notFound();
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return handleContentsGet(ctx, res, repo, path);
      if (method === 'PUT') return handleContentsPut(ctx, res, repo, path);
      if (method === 'DELETE') return handleContentsDelete(ctx, res, repo, path);
      throw notFound();
    }
    if (rest[0] === 'labels' && rest.length === 1) return handleLabels(ctx, res, method, repo);
    if (rest[0] === 'issues') return handleIssues(ctx, res, method, repo, rest.slice(1));
    if (rest[0] === 'pulls') return handlePulls(ctx, res, method, repo, rest.slice(1));
    throw notFound();
  }
  throw notFound();
}
