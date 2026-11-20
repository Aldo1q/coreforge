// A compact GraphQL engine for the forge: lexer, parser and executor for the
// subset gh and the conformance suite speak — queries, mutations, variables,
// aliases, inline fragments, input objects, enums, connections with cursor
// pagination, Relay node(id:) and the __type introspection probes.

import {
  VIEWER,
  getRepo,
  listRepos,
  seqIso,
  parseCommit,
  flattenTree,
  refTree,
  mergeBase,
  mergeFlat,
  allocCommentId,
  nextSeq,
} from './store.ts';
import type { Repo, IssueRec, PullRec, CommentRec } from './store.ts';
import { gid, parseGid } from './util.ts';
import { createIssue, createPull, mergePull, pullFiles } from './rest.ts';
import type { Reply } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<[string, Value]>;
  selectionSet: SelNode[] | null;
}

type SelNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelNode[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$=@!|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== undefined) name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        operations.push({
          type: head === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): SelNode[] {
    this.expect('{');
    const selections: SelNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Array<[string, Value]> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push([argName, this.parseValue()]);
        }
        this.expect(')');
      }
      if (this.peek() === '@') {
        // A directive: skip its name and any argument list.
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced();
      }
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'number', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'number', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// Schema tables (also what __type reports)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'repository', 'author',
    'createdAt', 'updatedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'repository', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['name', 'color'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'messageHeadline', 'committedDate'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Entities and execution
// ---------------------------------------------------------------------------

type GObj =
  | { kind: 'viewer' }
  | { kind: 'query' }
  | { kind: 'mutation' }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: IssueRec }
  | { kind: 'pull'; repo: Repo; pull: PullRec }
  | { kind: 'comment'; comment: CommentRec }
  | { kind: 'ref'; name: string; oid: string }
  | { kind: 'commitRef'; oid: string }
  | { kind: 'label'; name: string; color: string }
  | { kind: 'typeInfo'; name: string }
  | { kind: 'fieldInfo'; name: string }
  | { kind: 'enumInfo'; name: string }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { kind: 'issuesConn'; nodes: GObj[]; pageInfo: GObj; totalCount: number }
  | { kind: 'pullsConn'; nodes: GObj[]; pageInfo: GObj; totalCount: number }
  | { kind: 'filesConn'; files: Array<{ path: string; additions: number; deletions: number; status: string }> }
  | { kind: 'labelsConn'; repo: Repo; issue: IssueRec }
  | { kind: 'commentsConn'; issue: IssueRec }
  | { kind: 'payload'; payloadKind: string; entity: GObj | null }
  | { kind: 'commentEdge'; comment: CommentRec };

function typename(obj: GObj): string {
  switch (obj.kind) {
    case 'viewer': return 'User';
    case 'query': return 'Query';
    case 'mutation': return 'Mutation';
    case 'repo': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'comment': return 'IssueComment';
    case 'ref': return 'Ref';
    case 'commitRef': return 'Commit';
    case 'label': return 'Label';
    case 'typeInfo': return '__Type';
    case 'fieldInfo': return '__Field';
    case 'enumInfo': return '__EnumValue';
    case 'pageInfo': return 'PageInfo';
    case 'issuesConn': return 'IssueConnection';
    case 'pullsConn': return 'PullRequestConnection';
    case 'filesConn': return 'PullRequestFilesConnection';
    case 'labelsConn': return 'LabelConnection';
    case 'commentsConn': return 'IssueCommentConnection';
    case 'commentEdge': return 'IssueCommentEdge';
    case 'payload':
      return {
        createIssue: 'CreateIssuePayload',
        closeIssue: 'CloseIssuePayload',
        createPullRequest: 'CreatePullRequestPayload',
        mergePullRequest: 'MergePullRequestPayload',
        addComment: 'AddCommentPayload',
      }[obj.payloadKind] ?? 'CreateIssuePayload';
  }
}

interface ExecCtx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelNode[]>;
}

function resolveValue(value: Value, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'var': return ctx.variables[value.name] ?? null;
    case 'string': return value.value;
    case 'number': return value.value;
    case 'bool': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of value.fields) out[key] = resolveValue(v, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.args) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function pageOf<T>(items: T[], keyOf: (item: T) => number, args: Record<string, unknown>): { page: T[]; pageInfo: GObj } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const key = Number(decoded.replace(/^cursor:/, ''));
      const idx = items.findIndex((item) => keyOf(item) === key);
      if (idx >= 0) start = idx + 1;
    } catch {
      start = 0;
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const pageInfo: GObj = {
    kind: 'pageInfo',
    hasNextPage,
    endCursor: page.length > 0 ? cursorFor(keyOf(page[page.length - 1])) : (typeof args.after === 'string' ? args.after : null),
    startCursor: page.length > 0 ? cursorFor(keyOf(page[0])) : null,
  };
  return { page, pageInfo };
}

function findRepoById(id: number): Repo | null {
  return listRepos().find((r) => r.id === id) ?? null;
}

function pullMergeable(repo: Repo, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return 'UNKNOWN';
  const baseCommit = repo.objects.get(base);
  if (!baseCommit) return 'UNKNOWN';
  const result = mergeFlat(
    flattenTree(repo, parseCommit(baseCommit.data).tree),
    flattenTree(repo, refTree(repo, `refs/heads/${pull.base}`)),
    flattenTree(repo, refTree(repo, `refs/heads/${pull.head}`)),
  );
  return 'conflict' in result ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(obj: GObj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const type = typename(obj);
  if (field === '__typename') return type;
  if (obj.kind === 'typeInfo') {
    if (field === 'name') return obj.name;
    if (field === 'kind') return ENUM_VALUES[obj.name] ? 'ENUM' : 'OBJECT';
    if (field === 'fields') {
      const names = TYPE_FIELDS[obj.name] ?? [];
      return names.map((name): GObj => ({ kind: 'fieldInfo', name }));
    }
    if (field === 'enumValues') {
      const names = ENUM_VALUES[obj.name] ?? [];
      return names.map((name): GObj => ({ kind: 'enumInfo', name }));
    }
  }
  const known = TYPE_FIELDS[type];
  if (obj.kind !== 'query' && obj.kind !== 'mutation' && known && !known.includes(field)) {
    ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
    return null;
  }
  switch (obj.kind) {
    case 'query': {
      if (field === 'viewer') return { kind: 'viewer' } as GObj;
      if (field === 'repository') {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ kind: 'repo', repo } as GObj) : null;
      }
      if (field === 'node') {
        const parts = parseGid(String(args.id ?? ''));
        if (!parts) return null;
        if (parts[0] === 'Repository') {
          const repo = findRepoById(Number(parts[1]));
          return repo ? ({ kind: 'repo', repo } as GObj) : null;
        }
        if (parts[0] === 'Issue') {
          const repo = findRepoById(Number(parts[1]));
          const issue = repo?.issues.get(Number(parts[2]));
          return repo && issue ? ({ kind: 'issue', repo, issue } as GObj) : null;
        }
        if (parts[0] === 'PullRequest') {
          const repo = findRepoById(Number(parts[1]));
          const pull = repo?.pulls.get(Number(parts[2]));
          return repo && pull ? ({ kind: 'pull', repo, pull } as GObj) : null;
        }
        if (parts[0] === 'User') return { kind: 'viewer' } as GObj;
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        return TYPE_FIELDS[name] || ENUM_VALUES[name] ? ({ kind: 'typeInfo', name } as GObj) : null;
      }
      if (field === '__schema') return null;
      ctx.errors.push({ message: `Field '${field}' doesn't exist on type 'Query'` });
      return null;
    }
    case 'mutation': {
      return resolveMutation(field, args, ctx);
    }
    case 'viewer': {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return gid('User', VIEWER.id);
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      return null;
    }
    case 'repo': {
      const repo = obj.repo;
      switch (field) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { kind: 'viewer' } as GObj;
        case 'defaultBranchRef': {
          const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return oid ? ({ kind: 'ref', name: repo.defaultBranch, oid } as GObj) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'description': return repo.description;
        case 'createdAt': return seqIso(repo.seq);
        case 'updatedAt': return seqIso(repo.seq);
        case 'url': return `https://github.invalid/${repo.owner}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ kind: 'issue', repo, issue } as GObj) : null;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ kind: 'pull', repo, pull } as GObj) : null;
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length > 0) {
            items = items.filter((i) => states.includes(i.state.toUpperCase()));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const direction = orderBy?.direction ?? 'DESC';
          items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const { page, pageInfo } = pageOf(items, (i) => i.number, args);
          return {
            kind: 'issuesConn',
            nodes: page.map((issue): GObj => ({ kind: 'issue', repo, issue })),
            pageInfo,
            totalCount: items.length,
          } as GObj;
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length > 0) {
            items = items.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
          }
          items.sort((a, b) => b.number - a.number);
          const { page, pageInfo } = pageOf(items, (p) => p.number, args);
          return {
            kind: 'pullsConn',
            nodes: page.map((pull): GObj => ({ kind: 'pull', repo, pull })),
            pageInfo,
            totalCount: items.length,
          } as GObj;
        }
        default: return null;
      }
    }
    case 'issue': {
      const { repo, issue } = obj;
      switch (field) {
        case 'id': return gid('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'repository': return { kind: 'repo', repo } as GObj;
        case 'author': return { kind: 'viewer' } as GObj;
        case 'createdAt': return seqIso(issue.seq);
        case 'updatedAt': return seqIso(issue.seq);
        case 'url': return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'labels': return { kind: 'labelsConn', repo, issue } as GObj;
        case 'comments': return { kind: 'commentsConn', issue } as GObj;
        default: return null;
      }
    }
    case 'pull': {
      const { repo, pull } = obj;
      switch (field) {
        case 'id': return gid('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'repository': return { kind: 'repo', repo } as GObj;
        case 'author': return { kind: 'viewer' } as GObj;
        case 'createdAt': return seqIso(pull.seq);
        case 'updatedAt': return seqIso(pull.seq);
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return pull.mergeCommitSha ? ({ kind: 'commitRef', oid: pull.mergeCommitSha } as GObj) : null;
        case 'files': {
          const files = pullFiles(repo, pull).map((f) => ({
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            status: f.status,
          }));
          return { kind: 'filesConn', files } as GObj;
        }
        default: return null;
      }
    }
    case 'comment': {
      if (field === 'id') return gid('IssueComment', obj.comment.id);
      if (field === 'body') return obj.comment.body;
      if (field === 'author') return { kind: 'viewer' } as GObj;
      if (field === 'createdAt') return seqIso(obj.comment.seq);
      return null;
    }
    case 'ref': {
      if (field === 'name') return obj.name;
      if (field === 'target') return { kind: 'commitRef', oid: obj.oid } as GObj;
      return null;
    }
    case 'commitRef': {
      if (field === 'oid') return obj.oid;
      return null;
    }
    case 'label': {
      if (field === 'name') return obj.name;
      if (field === 'color') return obj.color;
      return null;
    }
    case 'fieldInfo': return field === 'name' ? obj.name : null;
    case 'enumInfo': return field === 'name' ? obj.name : null;
    case 'pageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return obj.endCursor;
      if (field === 'startCursor') return obj.startCursor;
      return null;
    }
    case 'issuesConn': case 'pullsConn': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.totalCount;
      if (field === 'edges') return obj.nodes.map((node) => ({ kind: 'commentEdge', comment: undefined as never, node } as unknown as GObj));
      return null;
    }
    case 'filesConn': {
      if (field === 'nodes') {
        return obj.files.map((f) => ({ kind: 'fileNode', ...f } as unknown as GObj));
      }
      if (field === 'totalCount') return obj.files.length;
      return null;
    }
    case 'labelsConn': {
      if (field === 'nodes') {
        return obj.issue.labels.map((name): GObj => ({
          kind: 'label',
          name,
          color: obj.repo.labels.get(name)?.color ?? 'ededed',
        }));
      }
      return null;
    }
    case 'commentsConn': {
      if (field === 'nodes') return obj.issue.comments.map((comment): GObj => ({ kind: 'comment', comment }));
      if (field === 'totalCount') return obj.issue.comments.length;
      return null;
    }
    case 'payload': {
      if (field === 'clientMutationId') return null;
      if (field === 'issue' && obj.entity?.kind === 'issue') return obj.entity;
      if (field === 'pullRequest' && obj.entity?.kind === 'pull') return obj.entity;
      if (field === 'commentEdge' && obj.entity) return obj.entity;
      return null;
    }
    case 'commentEdge': {
      if (field === 'node') return { kind: 'comment', comment: obj.comment } as GObj;
      if (field === 'cursor') return cursorFor(obj.comment.id);
      return null;
    }
  }
  return null;
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const parts = parseGid(String(input.repositoryId ?? ''));
    const repo = parts && parts[0] === 'Repository' ? findRepoById(Number(parts[1])) : null;
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''));
    return { kind: 'payload', payloadKind: 'createIssue', entity: { kind: 'issue', repo, issue } } as GObj;
  }
  if (field === 'closeIssue') {
    const parts = parseGid(String(input.issueId ?? ''));
    const repo = parts && parts[0] === 'Issue' ? findRepoById(Number(parts[1])) : null;
    const issue = repo?.issues.get(Number(parts?.[2]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    issue.state = 'closed';
    repo.mutationSeq += 1;
    return { kind: 'payload', payloadKind: 'closeIssue', entity: { kind: 'issue', repo, issue } } as GObj;
  }
  if (field === 'createPullRequest') {
    const parts = parseGid(String(input.repositoryId ?? ''));
    const repo = parts && parts[0] === 'Repository' ? findRepoById(Number(parts[1])) : null;
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!repo || !repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch not found' });
      return null;
    }
    const existing = [...repo.pulls.values()].find((p) => p.head === head && p.base === base && p.state === 'open');
    const pull = existing ?? createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
    return { kind: 'payload', payloadKind: 'createPullRequest', entity: { kind: 'pull', repo, pull } } as GObj;
  }
  if (field === 'mergePullRequest') {
    const parts = parseGid(String(input.pullRequestId ?? ''));
    const repo = parts && parts[0] === 'PullRequest' ? findRepoById(Number(parts[1])) : null;
    const pull = repo?.pulls.get(Number(parts?.[2]));
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    if (!pull.merged) {
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const sha = mergePull(repo, pull, method);
      if (!sha) {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
        return null;
      }
    }
    return { kind: 'payload', payloadKind: 'mergePullRequest', entity: { kind: 'pull', repo, pull } } as GObj;
  }
  if (field === 'addComment') {
    const parts = parseGid(String(input.subjectId ?? ''));
    const repo = parts && parts[0] === 'Issue' ? findRepoById(Number(parts[1])) : null;
    const issue = repo?.issues.get(Number(parts?.[2]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const comment: CommentRec = {
      id: allocCommentId(),
      body: String(input.body ?? ''),
      seq: nextSeq(),
    };
    issue.comments.push(comment);
    repo.mutationSeq += 1;
    return { kind: 'payload', payloadKind: 'addComment', entity: { kind: 'commentEdge', comment } } as GObj;
  }
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
  return null;
}

function executeSelectionSet(obj: GObj, selections: SelNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition === null || sel.typeCondition === typename(obj)) {
        Object.assign(out, executeSelectionSet(obj, sel.selectionSet, ctx));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment) Object.assign(out, executeSelectionSet(obj, fragment, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args = argsOf(sel, ctx);
    const value = resolveField(obj, sel.name, args, ctx);
    out[key] = applySelection(value, sel.selectionSet, ctx);
  }
  return out;
}

function applySelection(value: unknown, selectionSet: SelNode[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === null) return value;
  if (Array.isArray(value)) return value.map((item) => applySelection(item, selectionSet, ctx));
  // A pseudo-object produced for file nodes: resolve its plain fields.
  if (typeof value === 'object' && (value as Record<string, unknown>).kind === 'fileNode') {
    const record = value as Record<string, unknown>;
    {
      const out: Record<string, unknown> = {};
      for (const sel of selectionSet) {
        if (sel.kind !== 'field') continue;
        const key = sel.alias ?? sel.name;
        if (sel.name === 'path') out[key] = record.path;
        else if (sel.name === 'additions') out[key] = record.additions;
        else if (sel.name === 'deletions') out[key] = record.deletions;
        else if (sel.name === 'changeType') out[key] = String(record.status).toUpperCase();
        else out[key] = null;
      }
      return out;
    }
  }
  if (typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    return executeSelectionSet(value as GObj, selectionSet, ctx);
  }
  return value;
}

export function executeGraphQL(
  queryText: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): { data?: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = { variables, errors: [], fragments: new Map() };
  try {
    const document = new Parser(tokenize(queryText)).parseDocument();
    ctx.fragments = document.fragments;
    const operation =
      document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
    if (!operation) return { errors: [{ message: 'no operation in document' }] };
    const root: GObj = operation.type === 'mutation' ? { kind: 'mutation' } : { kind: 'query' };
    const data = executeSelectionSet(root, operation.selectionSet, ctx);
    const out: { data?: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
}

/** HTTP entry point for /api/graphql, including operation batching. */
export function handleGraphQL(bodyText: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { errors: [{ message: 'invalid JSON body' }] } };
  }
  const runOne = (entry: Record<string, unknown>) => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    return executeGraphQL(query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne(entry as Record<string, unknown>));
    return { status: 200, json: results };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { status: 200, json: runOne(parsed as Record<string, unknown>) };
  }
  return { status: 400, json: { errors: [{ message: 'invalid GraphQL body' }] } };
}
