// graphql.ts — the GraphQL v4 surface gh speaks: a hand-rolled parser and executor over the forge's
// one schema. It covers exactly the documents real clients send — viewer, repository reads, issue
// and pull request connections with cursor pagination, the create/close/merge/comment mutations,
// Relay node(id:) reads, __type introspection, and operation batching — and it holds GitHub's error
// contract: a GraphQL-level failure (an unknown field, a bad mutation input) is a 200 whose body
// carries `errors`, never an HTTP error; an unknown repository is data.repository = null, no errors.
//
// Global ids are opaque base64url "Kind:key" strings (see views.ts): stable across reads, never the
// plain database id or issue number, and decodable only by the forge.

import type { ServerResponse } from 'node:http';
import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';
import { VIEWER } from './store.ts';
import { HttpError, sendJson, type ReqCtx } from './http.ts';
import {
  branchTip,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  mergePull,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  userGlobalId,
} from './views.ts';

// ------------------------------------------------------------------------------------------------
// Parsing

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type SelectionNode =
  | { kind: 'field'; alias: string | null; name: string; args: Map<string, ValueNode>; selection: SelectionNode[] | null }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface GqlDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class GqlSyntaxError extends Error {}
class GqlValidationError extends Error {}
class GqlExecError extends Error {}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] ?? '';
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1] ?? '';
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else {
            value += escapes[esc] ?? esc;
            at += 2;
          }
        } else {
          value += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new GqlSyntaxError('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new GqlSyntaxError(`bad number at ${at}`);
      tokens.push({ kind: 'number', value: match[0] });
      at += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      if (match === null) throw new GqlSyntaxError(`bad name at ${at}`);
      tokens.push({ kind: 'name', value: match[0] });
      at += match[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at] ?? { kind: 'eof', value: '' };
  }

  private next(): Token {
    const token = this.peek();
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new GqlSyntaxError(`expected ${value}, got ${token.value || token.kind}`);
  }

  private skip(value: string): boolean {
    if (this.peek().value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token.value || token.kind}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.value === '$') {
      this.next();
      return { kind: 'var', name: this.next().value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'number') {
      this.next();
      return { kind: 'number', value: Number(token.value) };
    }
    if (token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.value || token.kind}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          throw new GqlSyntaxError('bad fragment selection');
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | null = null;
      if (this.skip(':')) {
        alias = name;
        name = this.next().value;
      }
      const args = this.peek().value === '(' ? this.parseArguments() : new Map<string, ValueNode>();
      this.skipDirectives();
      const selection = this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return selections;
  }
}

// ------------------------------------------------------------------------------------------------
// Schema: the field table is the single source for both execution validation and introspection.

const TYPE_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', search: 'SearchResultItemConnection', rateLimit: 'RateLimit' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
    reopenIssue: 'ReopenIssuePayload',
  },
  User: {
    id: 'ID', login: 'String', name: 'String', email: 'String', databaseId: 'Int', url: 'URI',
    createdAt: 'DateTime', updatedAt: 'DateTime', isViewer: 'Boolean', followers: 'FollowerConnection', following: 'FollowingConnection',
  },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', description: 'String', owner: 'RepositoryOwner',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', hasWikiEnabled: 'Boolean',
    isPrivate: 'Boolean', isFork: 'Boolean', url: 'URI', sshUrl: 'URI', createdAt: 'DateTime', updatedAt: 'DateTime',
    pushedAt: 'DateTime', stargazerCount: 'Int', forkCount: 'Int', primaryLanguage: 'Language',
    issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
  },
  Ref: { id: 'ID', name: 'String', prefix: 'String', target: 'GitObject', repository: 'Repository' },
  GitObject: { id: 'ID', oid: 'GitObjectID', abbreviatedOid: 'String' },
  Commit: { id: 'ID', oid: 'GitObjectID', abbreviatedOid: 'String', message: 'String', messageHeadline: 'String', committedDate: 'DateTime', authoredDate: 'DateTime' },
  Issue: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', state: 'IssueState', body: 'String', bodyText: 'String',
    url: 'URI', createdAt: 'DateTime', updatedAt: 'DateTime', closedAt: 'DateTime', author: 'Actor', repository: 'Repository',
    labels: 'LabelConnection', comments: 'IssueCommentConnection', assignees: 'UserConnection', locked: 'Boolean',
    milestone: 'Milestone', viewerCanUpdate: 'Boolean',
  },
  PullRequest: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', mergeable: 'MergeableState', headRefName: 'String', baseRefName: 'String', headRef: 'Ref', baseRef: 'Ref',
    mergeCommit: 'Commit', mergedAt: 'DateTime', closedAt: 'DateTime', createdAt: 'DateTime', updatedAt: 'DateTime',
    author: 'Actor', repository: 'Repository', files: 'PullRequestFileConnection', url: 'URI',
    additions: 'Int', deletions: 'Int', changedFiles: 'Int', isDraft: 'Boolean', viewerCanUpdate: 'Boolean',
  },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', createdAt: 'DateTime', updatedAt: 'DateTime', author: 'Actor', url: 'URI' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  ReopenIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', description: 'String', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ------------------------------------------------------------------------------------------------
// Execution

/** A value in the graph: a tagged record the field resolvers switch on. */
interface GqlObj {
  tn: string;
  [key: string]: unknown;
}

interface ExecCtx {
  forge: Forge;
  base: string;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

function obj(tn: string, fields: Record<string, unknown> = {}): GqlObj {
  return { tn, ...fields };
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'number': return node.value;
    case 'bool': return node.value;
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: Extract<SelectionNode, { kind: 'field' }>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = evalValue(value, ctx.variables);
  return out;
}

function userObj(login: string): GqlObj {
  return obj('User', { login });
}

function repoObj(repo: RepoRec): GqlObj {
  return obj('Repository', { repo });
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  return obj('PullRequest', { repo, pull });
}

function refObj(repo: RepoRec, name: string): GqlObj | null {
  const sha = branchTip(repo, name);
  if (sha === null) return null;
  return obj('Ref', { repo, name, sha });
}

function cursorFor(key: string): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

interface ConnectionItem {
  node: GqlObj;
  key: string;
}

/** Slice a connection: order is the caller's, `after` resumes past the item whose key it names. */
function connection(tn: string, edgeTn: string, items: ConnectionItem[], args: Record<string, unknown>): GqlObj {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      if (decoded.startsWith('cursor:')) {
        const key = decoded.slice('cursor:'.length);
        const at = items.findIndex((item) => item.key === key);
        if (at >= 0) start = at + 1;
      }
    } catch {
      // An undecodable cursor restarts the connection; GitHub errors, but nothing here sends one.
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const page = items.slice(start, start + first);
  const nodes = page.map((item) => item.node);
  const edges = page.map((item) => obj(edgeTn, { node: item.node, cursor: cursorFor(item.key) }));
  const pageInfo = obj('PageInfo', {
    hasNextPage: start + page.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorFor(page[0]?.key ?? '') : null,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.key ?? '') : null,
  });
  return obj(tn, { nodes, edges, pageInfo, totalCount: items.length });
}

function repoById(forge: Forge, id: number): RepoRec | null {
  return forge.repos.find((repo) => repo.id === id) ?? null;
}

/** Resolve a global id to the object it names (node(id:) and the mutation inputs). */
function nodeById(ctx: ExecCtx, id: string): GqlObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoById(ctx.forge, Number(decoded.key));
    return repo === null ? null : repoObj(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map(Number);
    const repo = repoById(ctx.forge, repoId ?? NaN);
    if (repo === undefined || repo === null) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number ?? NaN);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(number ?? NaN);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (decoded.kind === 'IssueComment') {
    const commentId = Number(decoded.key);
    for (const repo of ctx.forge.repos) {
      for (const holder of [...repo.issues.values(), ...repo.pulls.values()]) {
        const comment = holder.comments.find((entry) => entry.id === commentId);
        if (comment !== undefined) return obj('IssueComment', { repo, holder, comment });
      }
    }
    return null;
  }
  if (decoded.kind === 'User') return userObj(decoded.key);
  return null;
}

type Field = Extract<SelectionNode, { kind: 'field' }>;

function resolveField(ctx: ExecCtx, source: GqlObj, field: Field): unknown {
  const args = argsOf(field, ctx);
  const name = field.name;
  if (name === '__typename') return source.tn;
  if (source.tn === 'Query') {
    switch (name) {
      case 'viewer': return userObj(VIEWER.login);
      case 'repository': {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
        const repo = ctx.forge.getRepo(owner, repoName);
        return repo === null ? null : repoObj(repo);
      }
      case 'node': return nodeById(ctx, String(args.id ?? ''));
      case '__type': return typeObj(String(args.name ?? ''));
      case '__schema': return obj('__Schema', {});
      default: break;
    }
  }
  if (source.tn === 'Mutation') return resolveMutation(ctx, name, args);
  switch (source.tn) {
    case 'User': return resolveUser(source, name);
    case 'Repository': return resolveRepository(ctx, source, name, args);
    case 'Issue': return resolveIssue(ctx, source, name);
    case 'PullRequest': return resolvePullRequest(ctx, source, name, args);
    case 'Ref': {
      if (name === 'name') return source.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'repository') return repoObj(source.repo as RepoRec);
      if (name === 'target') return obj('Commit', { oid: source.sha });
      if (name === 'id') return Buffer.from(`Ref:${(source.repo as RepoRec).id}:${source.name as string}`, 'utf8').toString('base64url');
      return null;
    }
    case 'Commit': {
      if (name === 'oid' || name === 'id') return source.oid;
      if (name === 'abbreviatedOid') return String(source.oid).slice(0, 7);
      return null;
    }
    case 'PullRequestFile': {
      if (name === 'path') return source.path;
      if (name === 'additions') return source.additions;
      if (name === 'deletions') return source.deletions;
      if (name === 'changeType') return String(source.status).toUpperCase() === 'ADDED' ? 'ADDED' : String(source.status).toUpperCase() === 'REMOVED' ? 'DELETED' : 'MODIFIED';
      return null;
    }
    case '__Type': {
      if (name === 'name') return source.typeName;
      if (name === 'kind') return source.kind;
      if (name === 'description') return null;
      if (name === 'fields') {
        const table = TYPE_FIELDS[String(source.typeName)] ?? {};
        return Object.keys(table).map((fieldName) => obj('__Field', { fieldName, typeName: table[fieldName] }));
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[String(source.typeName)] ?? []).map((value) => obj('__EnumValue', { valueName: value }));
      }
      return null;
    }
    case '__Field': {
      if (name === 'name') return source.fieldName;
      if (name === 'description') return null;
      if (name === 'type') return obj('__Type', { typeName: source.typeName, kind: 'OBJECT' });
      return null;
    }
    case '__EnumValue': {
      if (name === 'name') return source.valueName;
      if (name === 'description') return null;
      return null;
    }
    default: break;
  }
  // Connections, edges, page info and payloads carry their values on the object itself.
  if (source.tn.endsWith('Connection') || source.tn.endsWith('Edge') || source.tn === 'PageInfo' || source.tn.endsWith('Payload')) {
    return source[name] ?? null;
  }
  if (source.tn === 'Label') {
    if (name === 'name') return source.labelName;
    if (name === 'color') return 'ededed';
    if (name === 'id') return Buffer.from(`Label:${String(source.labelName)}`, 'utf8').toString('base64url');
    return null;
  }
  if (source.tn === 'IssueComment') {
    const comment = source.comment as { id: number; body: string; createdAt: string; updatedAt: string; authorLogin: string };
    switch (name) {
      case 'id': return commentGlobalId(comment.id);
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'createdAt': return comment.createdAt;
      case 'updatedAt': return comment.updatedAt;
      case 'author': return userObj(comment.authorLogin);
      default: return null;
    }
  }
  return null;
}

function typeObj(name: string): GqlObj | null {
  if (ENUM_VALUES[name] !== undefined) return obj('__Type', { typeName: name, kind: 'ENUM' });
  if (TYPE_FIELDS[name] !== undefined) return obj('__Type', { typeName: name, kind: 'OBJECT' });
  return null;
}

function resolveUser(source: GqlObj, name: string): unknown {
  const login = String(source.login);
  switch (name) {
    case 'id': return userGlobalId();
    case 'login': return login;
    case 'name': return login === VIEWER.login ? VIEWER.name : login;
    case 'email': return login === VIEWER.login ? VIEWER.email : '';
    case 'databaseId': return VIEWER.id;
    case 'isViewer': return login === VIEWER.login;
    case 'createdAt': case 'updatedAt': return '2023-01-01T00:00:00Z';
    case 'url': return `https://github.com/${login}`;
    default: return null;
  }
}

function resolveRepository(ctx: ExecCtx, source: GqlObj, name: string, args: Record<string, unknown>): unknown {
  const repo = source.repo as RepoRec;
  switch (name) {
    case 'id': return repoGlobalId(repo);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'description': return repo.description;
    case 'owner': return userObj(repo.owner);
    case 'defaultBranchRef': return refObj(repo, repo.defaultBranch);
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'hasWikiEnabled': return true;
    case 'isPrivate': return repo.isPrivate;
    case 'isFork': return false;
    case 'url': return `${ctx.base}/${repo.owner}/${repo.name}`;
    case 'sshUrl': return `git@github.com:${repo.owner}/${repo.name}.git`;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': case 'pushedAt': return repo.updatedAt;
    case 'stargazerCount': case 'forkCount': return 0;
    case 'primaryLanguage': return null;
    case 'issue': {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toLowerCase());
        issues = issues.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      return connection('IssueConnection', 'IssueEdge', issues.map((issue) => ({ node: issueObj(repo, issue), key: String(issue.number) })), args);
    }
    case 'pullRequest': {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toUpperCase());
        pulls = pulls.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => b.seq - a.seq);
      return connection('PullRequestConnection', 'PullRequestEdge', pulls.map((pull) => ({ node: pullObj(repo, pull), key: String(pull.number) })), args);
    }
    default: return null;
  }
}

function resolveIssue(ctx: ExecCtx, source: GqlObj, name: string): unknown {
  const repo = source.repo as RepoRec;
  const issue = source.issue as IssueRec;
  switch (name) {
    case 'id': return issueGlobalId(repo, issue.number);
    case 'databaseId': return issue.id;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'state': return issue.state.toUpperCase();
    case 'body': case 'bodyText': return issue.body;
    case 'url': return `${ctx.base}/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'createdAt': return issue.createdAt;
    case 'updatedAt': return issue.updatedAt;
    case 'closedAt': return issue.closedAt;
    case 'author': return userObj(issue.authorLogin);
    case 'repository': return repoObj(repo);
    case 'locked': return false;
    case 'viewerCanUpdate': return true;
    case 'labels': {
      const nodes = issue.labels.map((label) => obj('Label', { labelName: label }));
      return obj('LabelConnection', { nodes, totalCount: nodes.length });
    }
    case 'comments': {
      const items = issue.comments.map((comment) => ({
        node: obj('IssueComment', { repo, holder: issue, comment }),
        key: String(comment.id),
      }));
      return connection('IssueCommentConnection', 'IssueCommentEdge', items, {});
    }
    default: return null;
  }
}

function resolvePullRequest(ctx: ExecCtx, source: GqlObj, name: string, args: Record<string, unknown>): unknown {
  const repo = source.repo as RepoRec;
  const pull = source.pull as PullRec;
  switch (name) {
    case 'id': return pullGlobalId(repo, pull.number);
    case 'databaseId': return pull.id;
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged': return pull.merged;
    case 'mergeable': return pullMergeable(repo, pull);
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRef': return refObj(repo, pull.headRef);
    case 'baseRef': return refObj(repo, pull.baseRef);
    case 'mergeCommit': return pull.mergeCommitSha === null ? null : obj('Commit', { oid: pull.mergeCommitSha });
    case 'mergedAt': return pull.mergedAt;
    case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
    case 'createdAt': return pull.createdAt;
    case 'updatedAt': return pull.updatedAt;
    case 'author': return userObj(pull.authorLogin);
    case 'repository': return repoObj(repo);
    case 'url': return `${ctx.base}/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'isDraft': return false;
    case 'viewerCanUpdate': return true;
    case 'files': {
      const files = pullFiles(repo, pull);
      const items = files.map((file) => ({
        node: obj('PullRequestFile', { path: file.path, additions: file.additions, deletions: file.deletions, status: file.status }),
        key: file.path,
      }));
      return connection('PullRequestFileConnection', 'PullRequestEdge', items, args);
    }
    case 'additions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
    case 'deletions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
    case 'changedFiles': return pullFiles(repo, pull).length;
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Mutations

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function repoFromGlobalId(ctx: ExecCtx, id: unknown): RepoRec {
  const decoded = decodeGlobalId(String(id ?? ''));
  if (decoded === null || decoded.kind !== 'Repository') throw new GqlExecError('Could not resolve the repository id');
  const repo = repoById(ctx.forge, Number(decoded.key));
  if (repo === null) throw new GqlExecError('Could not resolve the repository id');
  return repo;
}

function resolveMutation(ctx: ExecCtx, name: string, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  switch (name) {
    case 'createIssue': {
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const title = String(input.title ?? '');
      if (title === '') throw new GqlExecError('Title is required');
      const issue = ctx.forge.createIssue(repo, { title, body: String(input.body ?? '') });
      return obj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue': case 'reopenIssue': {
      const target = nodeById(ctx, String(input.issueId ?? ''));
      if (target === null || target.tn !== 'Issue') throw new GqlExecError('Could not resolve the issue id');
      const repo = target.repo as RepoRec;
      const issue = target.issue as IssueRec;
      if (name === 'closeIssue') {
        issue.state = 'closed';
        issue.closedAt = ctx.forge.nowIso();
      } else {
        issue.state = 'open';
        issue.closedAt = null;
      }
      issue.updatedAt = ctx.forge.nowIso();
      const payloadTn = name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
      return obj(payloadTn, { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.defaultBranch);
      const title = String(input.title ?? '');
      if (title === '') throw new GqlExecError('Title is required');
      if (branchTip(repo, headRef) === null) throw new GqlExecError(`Head branch does not exist: ${headRef}`);
      if (branchTip(repo, baseRef) === null) throw new GqlExecError(`Base branch does not exist: ${baseRef}`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
          throw new GqlExecError(`A pull request already exists for ${headRef} -> ${baseRef}`);
        }
      }
      const pull = ctx.forge.createPull(repo, { title, body: String(input.body ?? ''), headRef, baseRef });
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const target = nodeById(ctx, String(input.pullRequestId ?? ''));
      if (target === null || target.tn !== 'PullRequest') throw new GqlExecError('Could not resolve the pull request id');
      const repo = target.repo as RepoRec;
      const pull = target.pull as PullRec;
      const method = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const how = method === 'SQUASH' ? 'squash' : method === 'REBASE' ? 'rebase' : 'merge';
      try {
        mergePull(ctx.forge, repo, pull, how);
      } catch (err) {
        if (err instanceof HttpError) throw new GqlExecError(err.message);
        throw err;
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const target = nodeById(ctx, String(input.subjectId ?? ''));
      if (target === null || (target.tn !== 'Issue' && target.tn !== 'PullRequest')) {
        throw new GqlExecError('Could not resolve the subject id');
      }
      const repo = target.repo as RepoRec;
      const holder = (target.tn === 'Issue' ? target.issue : target.pull) as IssueRec | PullRec;
      const body = String(input.body ?? '');
      if (body === '') throw new GqlExecError('Body is required');
      const comment = ctx.forge.addComment(holder, body);
      const node = obj('IssueComment', { repo, holder, comment });
      const edge = obj('IssueCommentEdge', { node, cursor: cursorFor(String(comment.id)) });
      return obj('AddCommentPayload', { commentEdge: edge, subject: target, clientMutationId: input.clientMutationId ?? null });
    }
    default:
      throw new GqlValidationError(`Field '${name}' doesn't exist on type 'Mutation'`);
  }
}

// ------------------------------------------------------------------------------------------------
// Completion: walk a selection set over a resolved value.

function completeValue(ctx: ExecCtx, value: unknown, selection: SelectionNode[] | null, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection, depth));
  if (typeof value === 'object' && 'tn' in (value as Record<string, unknown>)) {
    return executeSelectionSet(ctx, value as GqlObj, selection, depth);
  }
  return value;
}

function executeSelectionSet(ctx: ExecCtx, source: GqlObj, selections: SelectionNode[], depth: number): Record<string, unknown> {
  if (depth > 64) throw new GqlExecError('Selection is too deep');
  const out: Record<string, unknown> = {};
  const walk = (nodes: SelectionNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === source.tn) walk(node.selection);
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === source.tn)) {
          walk(fragment.selection);
        }
        continue;
      }
      const key = node.alias ?? node.name;
      if (node.name === '__type' && source.tn === 'Query') {
        const args = argsOf(node, ctx);
        out[key] = completeValue(ctx, typeObj(String(args.name ?? '')), node.selection, depth + 1);
        continue;
      }
      const table = TYPE_FIELDS[source.tn];
      const isKnown = node.name === '__typename' || (table !== undefined && node.name in table);
      if (!isKnown) {
        throw new GqlValidationError(`Field '${node.name}' doesn't exist on type '${source.tn}'`);
      }
      const value = resolveField(ctx, source, node);
      out[key] = completeValue(ctx, value, node.selection, depth + 1);
    }
  };
  walk(selections);
  return out;
}

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

function executeOperation(ctx: ExecCtx, operation: Operation): GqlResult {
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const errors: { message: string; path?: (string | number)[] }[] = [];
  const data: Record<string, unknown> = {};
  // Root fields run one by one so a mutation's failure nulls its own field, not the document.
  for (const node of operation.selection) {
    if (node.kind !== 'field') {
      Object.assign(data, executeSelectionSet(ctx, root, [node], 0));
      continue;
    }
    const key = node.alias ?? node.name;
    try {
      const rootTable = TYPE_FIELDS[root.tn];
      if (node.name !== '__typename' && node.name !== '__type' && (rootTable === undefined || !(node.name in rootTable))) {
        throw new GqlValidationError(`Field '${node.name}' doesn't exist on type '${root.tn}'`);
      }
      const value = node.name === '__type'
        ? typeObj(String(argsOf(node, ctx).name ?? ''))
        : resolveField(ctx, root, node);
      data[key] = completeValue(ctx, value, node.selection, 1);
    } catch (err) {
      if (err instanceof GqlValidationError) throw err;
      if (err instanceof GqlExecError) {
        data[key] = null;
        errors.push({ message: err.message, path: [key] });
        continue;
      }
      throw err;
    }
  }
  const result: GqlResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function executeOne(forge: Forge, base: string, body: Record<string, unknown>): GqlResult {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query === '') return { errors: [{ message: 'A query is required' }] };
  let document: GqlDocument;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    if (err instanceof GqlSyntaxError) return { errors: [{ message: `Syntax error: ${err.message}` }] };
    throw err;
  }
  if (document.operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = (operationName !== null ? document.operations.find((op) => op.name === operationName) : undefined) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: `Unknown operation ${operationName}` }] };
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? body.variables
    : {}) as Record<string, unknown>;
  const ctx: ExecCtx = { forge, base, variables, fragments: document.fragments };
  try {
    return executeOperation(ctx, operation);
  } catch (err) {
    if (err instanceof GqlValidationError) return { errors: [{ message: err.message }] };
    if (err instanceof GqlExecError) return { errors: [{ message: err.message }] };
    throw err;
  }
}

/** Serve one POST /api/graphql: one operation, or an array of them answered in order (batching). */
export function handleGraphQL(ctx: ReqCtx, res: ServerResponse): void {
  const base = `http://${ctx.host}`;
  const text = ctx.body.toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === '' ? '{}' : text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne(ctx.forge, base, (entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  const result = executeOne(ctx.forge, base, (parsed ?? {}) as Record<string, unknown>);
  sendJson(res, 200, result);
}
