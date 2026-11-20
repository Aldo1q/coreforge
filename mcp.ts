// The MCP surface: JSON-RPC 2.0 over POST /mcp (Streamable HTTP, answering
// plain application/json). Both protocol eras work: the 2026-07-28 revision
// via server/discover, and the handshake era via initialize +
// notifications/initialized. Tools share the one store with REST and GraphQL.

import { VIEWER, getRepo, createRepo } from './store.ts';
import type { Repo } from './store.ts';
import { repoJson, issueJson, pullJson, createIssue, createPull, mergePull } from './rest.ts';
import type { Reply } from './rest.ts';

const SERVER_INFO = { name: 'coreforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, string>,
  required: string[],
): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, desc] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'number' : 'string', description: desc };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

const OWNER_REPO = { owner: 'The repository owner login', repo: 'The repository name' };

export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user', {
    owner: 'The repository owner login (defaults to the viewer)',
    name: 'The repository name',
    description: 'A short description of the repository',
    private: 'Whether the repository is private',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', { ...OWNER_REPO }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', {
    ...OWNER_REPO,
    title: 'The issue title',
    body: 'The issue body',
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository', {
    ...OWNER_REPO,
    state: 'Filter by state: open, closed or all',
  }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue by number', {
    ...OWNER_REPO,
    issue_number: 'The issue number',
  }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch', {
    ...OWNER_REPO,
    title: 'The pull request title',
    body: 'The pull request body',
    head: 'The head branch name',
    base: 'The base branch name',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List pull requests in a repository', {
    ...OWNER_REPO,
    state: 'Filter by state: open, closed or all',
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge a pull request into its base branch', {
    ...OWNER_REPO,
    pull_number: 'The pull request number',
    merge_method: 'The merge method: merge, squash or rebase',
  }, ['owner', 'repo', 'pull_number']),
];

interface RpcOutcome {
  status: number;
  payload?: unknown;
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(id: unknown, value: unknown, isError = false): RpcOutcome {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError,
  };
  if (!isError && value !== null && typeof value === 'object') result.structuredContent = value;
  return rpcResult(id, result);
}

function toolError(id: unknown, message: string): RpcOutcome {
  return toolResult(id, message, true);
}

function needRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  return getRepo(owner, name);
}

function callTool(id: unknown, name: string, args: Record<string, unknown>): RpcOutcome {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return rpcError(id, -32602, `unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(id, `missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = getRepo(VIEWER.login, repoName);
      if (existing) return toolResult(id, repoJson(existing));
      const repo = createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolResult(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, `repository ${String(args.owner)}/${String(args.repo)} not found`);
      return toolResult(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const issue = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '');
      return toolResult(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return toolResult(id, { issues: items.map((i) => issueJson(repo, i)) });
    }
    case 'get_issue': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return toolError(id, `issue ${String(args.issue_number)} not found`);
      return toolResult(id, issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const head = String(args.head).replace(/^[^:]+:/, '');
      const base = String(args.base).replace(/^[^:]+:/, '');
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return toolError(id, 'head or base branch does not exist');
      }
      const existing = [...repo.pulls.values()].find((p) => p.head === head && p.base === base && p.state === 'open');
      const pull = existing ?? createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(id, pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return toolResult(id, { pull_requests: items.map((p) => pullJson(repo, p)) });
    }
    case 'merge_pull_request': {
      const repo = needRepo(args);
      if (!repo) return toolError(id, 'repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError(id, `pull request ${String(args.pull_number)} not found`);
      if (!pull.merged) {
        const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
        const sha = mergePull(repo, pull, method);
        if (!sha) return toolError(id, 'pull request is not mergeable');
      }
      return toolResult(id, pullJson(repo, pull));
    }
    default:
      return rpcError(id, -32602, `unknown tool: ${name}`);
  }
}

function handleOne(message: Record<string, unknown>): RpcOutcome | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: nothing to answer
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(id, name, args);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** HTTP entry point for POST /mcp. */
export function handleMCP(bodyText: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed
      .map((entry) => handleOne(entry as Record<string, unknown>))
      .filter((o): o is RpcOutcome => o !== null);
    if (outcomes.length === 0) return { status: 202, raw: Buffer.alloc(0) };
    return { status: 200, json: outcomes.map((o) => o.payload) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const outcome = handleOne(parsed as Record<string, unknown>);
    if (outcome === null) return { status: 202, raw: Buffer.alloc(0) };
    return { status: outcome.status, json: outcome.payload };
  }
  return {
    status: 400,
    json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  };
}
