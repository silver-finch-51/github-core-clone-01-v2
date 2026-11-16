// views.ts — how the forge's records look on the wire, and the pull-request operations every surface
// shares (the changed-files diff and the merge). REST, GraphQL and MCP all read and mutate the same
// store through these helpers, so an object created on one surface is the same object on the others,
// with the same ids, every time it is read.

import type { CommentRec, IssueRec, PullRec, RepoRec } from './store.ts';
import { VIEWER } from './store.ts';
import { HttpError } from './http.ts';
import {
  commitFiles,
  commitOf,
  countLineDiff,
  diffTrees,
  flattenTree,
  getObject,
  isAncestor,
  listCommits,
  mergeBase,
  mergeFileMaps,
  parseIdent,
  peelToCommit,
  type FileChange,
} from './git.ts';
import type { Forge } from './store.ts';

/** The viewer's identity line for commits the forge itself authors (contents writes, merges). */
export function viewerIdent(forge: Forge): string {
  return `${VIEWER.name} <${VIEWER.email}> ${forge.nowEpochSec()} +0000`;
}

export function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 0,
    type: 'User',
    site_admin: false,
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : null,
  };
}

export function repoJson(repo: RepoRec, base: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const url = `${base}/api/v3/repos/${fullName}`;
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    url,
    html_url: `${base}/${fullName}`,
    git_url: `git://${base.replace(/^https?:\/\//, '')}/${fullName}.git`,
    clone_url: `${base}/${fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label === undefined ? 0 : [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.authorLogin),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** An issue-list view of a pull request (GitHub lists pull requests among issues, marked as such). */
export function pullAsIssueJson(repo: RepoRec, pull: PullRec, base: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(pull.authorLogin),
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    pull_request: {
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
      merged_at: pull.mergedAt,
    },
  };
}

/** A branch's current tip sha, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(repo: RepoRec, pull: PullRec, base: string): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: sha ?? '',
    user: userJson(repo.owner),
    repo: repoJson(repo, base),
  });
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.authorLogin),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function commentJson(repo: RepoRec, holderNumber: number, comment: CommentRec, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(comment.id),
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${holderNumber}#issuecomment-${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${holderNumber}`,
  };
}

export function commitJson(repo: RepoRec, sha: string, base: string): Record<string, unknown> {
  const commit = commitOf(repo, sha);
  if (commit === null) throw new HttpError(404, 'Not Found');
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const person = (ident: { name: string; email: string; date: string }): Record<string, unknown> => ({
    name: ident.name,
    email: ident.email,
    date: ident.date,
  });
  const account = (ident: { email: string }): Record<string, unknown> | null =>
    ident.email === VIEWER.email ? userJson(VIEWER.login) : null;
  return {
    sha,
    node_id: sha,
    commit: {
      author: person(author),
      committer: person(committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    author: account(author),
    committer: account(committer),
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and decodable by the forge alone.

function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return encodeGlobalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: RepoRec, number: number): string {
  return encodeGlobalId('Issue', `${repo.id}:${number}`);
}

export function pullGlobalId(repo: RepoRec, number: number): string {
  return encodeGlobalId('PullRequest', `${repo.id}:${number}`);
}

export function commentGlobalId(id: number): string {
  return encodeGlobalId('IssueComment', String(id));
}

export function userGlobalId(): string {
  return encodeGlobalId('User', VIEWER.login);
}

// ------------------------------------------------------------------------------------------------
// Pull request diff and merge

/** The merge base tree of a pull request (empty when the histories are unrelated). */
function pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return null;
  return mergeBase(repo, base, head);
}

/** The changed files of a pull request: merge-base tree against head tree, with line counts. */
export function pullFiles(repo: RepoRec, pull: PullRec): (FileChange & { additions: number; deletions: number; changes: number })[] {
  const head = branchTip(repo, pull.headRef);
  if (head === null) return [];
  const headCommit = commitOf(repo, head);
  if (headCommit === null) return [];
  const baseSha = pullMergeBase(repo, pull);
  const baseCommit = baseSha === null ? null : commitOf(repo, baseSha);
  const changes = diffTrees(repo, baseCommit?.tree ?? null, headCommit.tree);
  return changes.map((change) => {
    const oldText = change.oldSha === null ? '' : getObject(repo, change.oldSha)?.data.toString('utf8') ?? '';
    const newText = change.newSha === null ? '' : getObject(repo, change.newSha)?.data.toString('utf8') ?? '';
    const counts = change.status === 'added'
      ? { additions: countLineDiff('', newText).additions, deletions: 0 }
      : change.status === 'removed'
        ? { additions: 0, deletions: countLineDiff(oldText, '').deletions }
        : countLineDiff(oldText, newText);
    return { ...change, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions };
  });
}

/** Whether a pull request can be merged cleanly right now (the GraphQL mergeable state). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return 'UNKNOWN';
  if (isAncestor(repo, head, base)) return 'CONFLICTING';
  const baseSha = mergeBase(repo, base, head);
  const baseTree = baseSha === null ? new Map() : flattenTree(repo, commitOf(repo, baseSha)?.tree ?? '');
  const oursTree = flattenTree(repo, commitOf(repo, base)?.tree ?? '');
  const theirsTree = flattenTree(repo, commitOf(repo, head)?.tree ?? '');
  const merged = mergeFileMaps(baseTree, oursTree, theirsTree);
  return 'files' in merged ? 'MERGEABLE' : 'CONFLICTING';
}

export interface MergeOutcome {
  sha: string;
}

/**
 * Merge a pull request into its base branch. `method` is 'squash' (one commit holding the head's
 * changes, parented on the base tip) or 'merge' (a two-parent merge commit). Throws HttpError 404
 * for an unknown pull, 405 when it cannot be merged (already merged/closed, nothing to merge, or a
 * file-level conflict).
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) throw new HttpError(405, 'Pull Request is not mergeable');
  if (isAncestor(repo, head, base)) throw new HttpError(405, 'Pull Request is not mergeable: the head branch is already up to date');
  const baseSha = mergeBase(repo, base, head);
  const baseFiles = baseSha === null ? new Map<string, { sha: string; mode: string }>() : flattenTree(repo, commitOf(repo, baseSha)?.tree ?? '');
  const oursFiles = flattenTree(repo, commitOf(repo, base)?.tree ?? '');
  const theirsFiles = flattenTree(repo, commitOf(repo, head)?.tree ?? '');
  const merged = mergeFileMaps(baseFiles, oursFiles, theirsFiles);
  if ('conflict' in merged) {
    throw new HttpError(405, `Pull Request is not mergeable: ${merged.conflict} conflicts between the head and base branches`);
  }
  const ident = viewerIdent(forge);
  const message = method === 'merge'
    ? `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}\n\n${pull.title}\n`
    : `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`;
  const parents = method === 'merge' ? [base, head] : [base];
  const sha = commitFiles(repo, { files: merged.files, parents, authorLine: ident, message });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = forge.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp;
  repo.updatedAt = stamp;
  return { sha };
}

/** Every commit reachable from a ref name or sha in a repository (GET commits' walk). */
export function commitsFrom(repo: RepoRec, refOrSha: string): string[] {
  let tip: string | null = null;
  if (repo.refs.has(refOrSha)) tip = repo.refs.get(refOrSha) ?? null;
  else if (repo.refs.has(`refs/heads/${refOrSha}`)) tip = repo.refs.get(`refs/heads/${refOrSha}`) ?? null;
  else if (getObject(repo, refOrSha)?.type === 'commit') tip = refOrSha;
  else if (getObject(repo, refOrSha)?.type === 'tag') tip = peelToCommit(repo, refOrSha);
  if (tip === null) return [];
  return listCommits(repo, tip);
}
