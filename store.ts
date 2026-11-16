// store.ts — the forge's state: one token owner, their repositories, and inside each repository a git
// object store, refs, labels, issues, pull requests and comments. Everything lives in memory; a trial
// starts from an empty forge and the suite builds what it needs through the public surfaces.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a logical
// clock that starts at MAKEFUN_TRIAL_NOW when the env provides one (a fixed base otherwise) and
// advances one second per call, so the same request sequence always produces the same bytes — the
// same commit shas, the same ids, the same created_at strings.

/** The one user the bearer token acts as: the forge is single-tenant, like a personal GitHub account. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

/** One git object (blob, tree, commit or tag) as raw bytes under its type. */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  /** Forge-wide numeric id (GitHub comment ids are global, not per issue). */
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  number: number;
  /** Forge-wide numeric id, the REST `id` and the GraphQL `databaseId`. */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Per-repository creation order; the sort key behind created_at ordering. */
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRec[];
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface RepoRec {
  /** Forge-wide numeric id, the REST `id` and the GraphQL `databaseId`. */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** The git object store, by sha. Objects are immutable once stored. */
  objects: Map<string, GitObject>;
  /** Insertion order per object, the deterministic tie-break for commit listings. */
  objectSeq: Map<string, number>;
  nextObjectSeq: number;
  /** Memoized commit generations (see git.ts generationOf); commits are immutable, so it never invalidates. */
  genCache: Map<string, number>;
  /** Full ref names ('refs/heads/main') to the sha they point at. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  nextNumber: number;
  /** Creation order inside the repository, shared by issues and pull requests. */
  nextSeq: number;
}

const CLOCK_BASE_FALLBACK = '2026-01-01T00:00:00.000Z';

export class Forge {
  /** Every repository, in creation order. */
  readonly repos: RepoRec[] = [];
  private readonly repoByKey = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private readonly clockBaseMs: number;
  private clockTicks = 0;
  private requestTicks = 0;

  constructor() {
    const fromEnv = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(fromEnv);
    this.clockBaseMs = Number.isFinite(parsed) ? parsed : Date.parse(CLOCK_BASE_FALLBACK);
  }

  /** The next logical instant as an ISO string; every call advances the clock by one second. */
  nowIso(): string {
    this.clockTicks += 1;
    return new Date(this.clockBaseMs + this.clockTicks * 1000).toISOString();
  }

  /** The next logical instant as epoch seconds, for git author/committer lines. */
  nowEpochSec(): number {
    this.clockTicks += 1;
    return Math.floor((this.clockBaseMs + this.clockTicks * 1000) / 1000);
  }

  /** A per-request id for the X-GitHub-Request-Id header: sequential, so replays agree. */
  nextRequestId(): string {
    this.requestTicks += 1;
    return `forge-${this.requestTicks.toString(16).padStart(8, '0')}`;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** Find a repository by owner and name (both case-insensitive, as GitHub treats them). */
  getRepo(owner: string, name: string): RepoRec | null {
    return this.repoByKey.get(this.key(owner, name)) ?? null;
  }

  /** Create an empty repository owned by the viewer; null when the name is already taken. */
  createRepo(name: string, options: { isPrivate?: boolean; description?: string; defaultBranch?: string }): RepoRec | null {
    if (this.getRepo(VIEWER.login, name) !== null) return null;
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      objectSeq: new Map(),
      nextObjectSeq: 1,
      genCache: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextSeq: 1,
    };
    this.nextRepoId += 1;
    this.repos.push(repo);
    this.repoByKey.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  /** Delete a repository and everything in it. */
  deleteRepo(repo: RepoRec): void {
    this.repoByKey.delete(this.key(repo.owner, repo.name));
    const at = this.repos.indexOf(repo);
    if (at >= 0) this.repos.splice(at, 1);
  }

  /** Rename a repository, keeping the lookup index in step. */
  renameRepo(repo: RepoRec, name: string): boolean {
    if (this.getRepo(repo.owner, name) !== null && this.getRepo(repo.owner, name) !== repo) return false;
    this.repoByKey.delete(this.key(repo.owner, repo.name));
    repo.name = name;
    this.repoByKey.set(this.key(repo.owner, repo.name), repo);
    return true;
  }

  /** A fresh forge-wide issue/pull-request id. */
  newIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  /** A fresh forge-wide comment id. */
  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** Create an issue in a repository (labels must already exist; callers validate). */
  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const stamp = this.nowIso();
    const issue: IssueRec = {
      number: repo.nextNumber,
      id: this.newIssueId(),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      authorLogin: VIEWER.login,
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
      seq: repo.nextSeq,
    };
    repo.nextNumber += 1;
    repo.nextSeq += 1;
    repo.issues.set(issue.number, issue);
    repo.updatedAt = stamp;
    return issue;
  }

  /** Create a pull request in a repository from branch names (callers validate the refs). */
  createPull(repo: RepoRec, input: { title: string; body?: string; headRef: string; baseRef: string }): PullRec {
    const stamp = this.nowIso();
    const pull: PullRec = {
      number: repo.nextNumber,
      id: this.newIssueId(),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      comments: [],
      authorLogin: VIEWER.login,
      createdAt: stamp,
      updatedAt: stamp,
      seq: repo.nextSeq,
    };
    repo.nextNumber += 1;
    repo.nextSeq += 1;
    repo.pulls.set(pull.number, pull);
    repo.updatedAt = stamp;
    return pull;
  }

  /** Add a comment to an issue or a pull request (they share the comment shape). */
  addComment(holder: { comments: CommentRec[] }, body: string): CommentRec {
    const stamp = this.nowIso();
    const comment: CommentRec = { id: this.newCommentId(), body, authorLogin: VIEWER.login, createdAt: stamp, updatedAt: stamp };
    holder.comments.push(comment);
    return comment;
  }
}
