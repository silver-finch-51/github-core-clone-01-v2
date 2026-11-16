// mcp.ts — the MCP endpoint (POST /mcp, JSON-RPC 2.0 over streamable HTTP). It speaks both protocol
// eras the rules accept: the current one, where server/discover answers the server's identity,
// capabilities and supportedVersions in a single request with no handshake, and the handshake era
// (initialize + notifications/initialized, an optional Mcp-Session-Id) for older clients.
//
// The tools are github-mcp-server's core set, acting on the same store as REST and GraphQL: a
// repository or issue created here is the same object there, with the same ids. Tool results carry
// the object both as a JSON text block and as structured content; a tool that cannot run answers
// isError, while a malformed call (unknown tool, missing required argument) answers JSON-RPC
// -32602, and a body that is not JSON answers HTTP 400 with -32700.

import type { ServerResponse } from 'node:http';
import type { RepoRec } from './store.ts';
import { VIEWER } from './store.ts';
import { HttpError, sendJson, type ReqCtx } from './http.ts';
import { commitOf, flattenTree, getObject } from './git.ts';
import { branchTip, issueJson, mergePull, pullJson, repoJson } from './views.ts';

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SESSION_ID = 'forge-mcp-session';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'The issue state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'The pull request state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_file_contents',
    description: 'Read the contents of a file in a repository at a branch (the default branch when omitted).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      path: { type: 'string', description: 'The file path inside the repository.' },
      branch: { type: 'string', description: 'The branch to read from.' },
    },
    required: ['owner', 'repo', 'path'],
  },
]);

/** The tools/list answer: built once, so two calls serialize byte for byte identically. */
const TOOLS_LIST_RESULT = Object.freeze({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  })),
});

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requireRepo(ctx: ReqCtx, args: Record<string, unknown>): RepoRec {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === null) throw new Error(`Repository ${owner}/${name} not found`);
  return repo;
}

function callTool(ctx: ReqCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const base = `http://${ctx.host}`;
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw Object.assign(new Error(`Missing required argument: ${required}`), { rpcCode: -32602 });
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name ?? '');
        const created = ctx.forge.createRepo(repoName, {
          isPrivate: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
        if (created === null) return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
        return toolOk(repoJson(created, base));
      }
      case 'get_repo': {
        return toolOk(repoJson(requireRepo(ctx, args), base));
      }
      case 'create_issue': {
        const repo = requireRepo(ctx, args);
        const issue = ctx.forge.createIssue(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolOk(issueJson(repo, issue, base));
      }
      case 'list_issues': {
        const repo = requireRepo(ctx, args);
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.seq - a.seq)
          .map((issue) => issueJson(repo, issue, base));
        return toolOk(issues);
      }
      case 'create_pull_request': {
        const repo = requireRepo(ctx, args);
        const head = String(args.head ?? '');
        const baseRef = String(args.base ?? repo.defaultBranch);
        if (branchTip(repo, head) === null) return toolError(`Head branch does not exist: ${head}`);
        if (branchTip(repo, baseRef) === null) return toolError(`Base branch does not exist: ${baseRef}`);
        for (const pull of repo.pulls.values()) {
          if (pull.state === 'open' && pull.headRef === head && pull.baseRef === baseRef) {
            return toolError(`A pull request already exists for ${head} -> ${baseRef}`);
          }
        }
        const pull = ctx.forge.createPull(repo, {
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
          headRef: head,
          baseRef,
        });
        return toolOk(pullJson(repo, pull, base));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(ctx, args);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (pull === undefined) return toolError(`Pull request #${String(args.pull_number)} not found`);
        try {
          mergePull(ctx.forge, repo, pull, 'squash');
        } catch (err) {
          if (err instanceof HttpError) return toolError(err.message);
          throw err;
        }
        return toolOk(pullJson(repo, pull, base));
      }
      case 'list_pull_requests': {
        const repo = requireRepo(ctx, args);
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const pulls = [...repo.pulls.values()]
          .filter((pull) => state === 'all' || pull.state === state)
          .sort((a, b) => b.seq - a.seq)
          .map((pull) => pullJson(repo, pull, base));
        return toolOk(pulls);
      }
      case 'get_file_contents': {
        const repo = requireRepo(ctx, args);
        const branch = typeof args.branch === 'string' ? args.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (tip === null) return toolError(`Branch does not exist: ${branch}`);
        const path = String(args.path ?? '').replace(/^\/+|\/+$/g, '');
        const commit = commitOf(repo, tip);
        if (commit === null) return toolError('Branch tip is missing');
        const entry = flattenTree(repo, commit.tree).get(path);
        if (entry === undefined) return toolError(`Path not found: ${path}`);
        const blob = getObject(repo, entry.sha);
        if (blob === null) return toolError(`Path not found: ${path}`);
        return toolOk({
          name: path.split('/').pop() ?? path,
          path,
          sha: entry.sha,
          size: blob.data.length,
          encoding: 'utf-8',
          content: blob.data.toString('utf8'),
        });
      }
      default:
        throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
    }
  } catch (err) {
    if (err instanceof Error && 'rpcCode' in err) throw err;
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

/** Handle one JSON-RPC request object; null means it was a notification (answer 202, no body). */
function handleRpc(ctx: ReqCtx, request: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = (request.id === undefined ? null : request.id) as JsonRpcId;
  const isNotification = request.id === undefined;
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params
    : {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
          },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
        return rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, TOOLS_LIST_RESULT);
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {}) as Record<string, unknown>;
        return rpcResult(id, callTool(ctx, toolName, toolArgs));
      }
      default:
        if (isNotification) return null;
        return rpcError(id, { code: -32601, message: `Method not found: ${method}` });
    }
  } catch (err) {
    const code = err instanceof Error && 'rpcCode' in err ? Number((err as { rpcCode: unknown }).rpcCode) : -32603;
    return rpcError(id, { code, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Serve one POST /mcp (auth is enforced by the router before this runs). */
export function handleMcp(ctx: ReqCtx, res: ServerResponse): void {
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, { code: -32700, message: 'Parse error: the body is not JSON' }));
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? handleRpc(ctx, entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null);
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, { code: -32600, message: 'Invalid request: the body is not a JSON-RPC object' }));
    return;
  }
  const request = parsed as Record<string, unknown>;
  const isNotification = request.id === undefined;
  const answer = handleRpc(ctx, request);
  if (answer === null || isNotification) {
    res.writeHead(202, { 'mcp-session-id': SESSION_ID });
    res.end();
    return;
  }
  sendJson(res, 200, answer, { 'mcp-session-id': SESSION_ID });
}
