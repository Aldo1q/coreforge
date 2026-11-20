// The REST v3 surface: repositories, contents, refs, branches, commits,
// labels, issues, comments and pull requests, in GitHub's shapes. Issues and
// pull requests share one number sequence per repository.

import {
  VIEWER,
  repos,
  repoKey,
  getRepo,
  createRepo,
  listRepos,
  nextSeq,
  seqIso,
  makeBlob,
  makeCommit,
  flattenTree,
  treeFromFlat,
  refTree,
  parseCommit,
  parseTree,
  mergeBase,
  mergeFlat,
  diffTrees,
  allocCommentId,
  peel,
} from './store.ts';
import type { Repo, IssueRec, PullRec, FileDiff } from './store.ts';
import { isOid, nextRequestId } from './util.ts';

export interface Reply {
  status: number;
  json?: unknown;
  /** Pre-serialized JSON body (cache hits); used verbatim when present. */
  jsonText?: string;
  headers?: Record<string, string>;
  raw?: Buffer;
  contentType?: string;
}

function err(status: number, message: string): Reply {
  return { status, json: { message } };
}

export function userJson() {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoJson(repo: Repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: seqIso(repo.seq),
    updated_at: seqIso(repo.seq),
  };
}

export function issueJson(repo: Repo, issue: IssueRec) {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: seqIso(issue.seq),
    updated_at: seqIso(issue.seq),
  };
}

export function pullJson(repo: Repo, pull: PullRec) {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: seqIso(pull.seq),
    updated_at: seqIso(pull.seq),
  };
}

/** Create an issue in the shared number sequence. */
export function createIssue(repo: Repo, title: string, body: string, labels: string[] = []): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.mutationSeq += 1;
  return issue;
}

/** Create a pull request in the shared number sequence. */
export function createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRec {
  const pull: PullRec = {
    number: repo.nextNumber,
    title,
    body,
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/**
 * Merge a pull request into its base branch. Returns the merge commit sha,
 * or null when the merge conflicts (or the branches have no common history).
 */
export function mergePull(repo: Repo, pull: PullRec, method: string): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return null;
  const baseCommit = repo.objects.get(base);
  if (!baseCommit) return null;
  const baseTree = parseCommit(baseCommit.data).tree;
  const result = mergeFlat(
    flattenTree(repo, baseTree),
    flattenTree(repo, refTree(repo, `refs/heads/${pull.base}`)),
    flattenTree(repo, refTree(repo, `refs/heads/${pull.head}`)),
  );
  if ('conflict' in result) return null;
  const tree = treeFromFlat(repo, result.merged);
  const seq = nextSeq();
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo, tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.head}`, seq);
  } else {
    sha = makeCommit(repo, tree, [baseTip], `${pull.title} (#${pull.number})`, seq);
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = seqIso(seq);
  pull.mergeCommitSha = sha;
  return sha;
}

/** The changed files of a pull request (merge-base to head tip). */
export function pullFiles(repo: Repo, pull: PullRec): FileDiff[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(peel(repo, headTip));
  if (!baseCommit || !headCommit) return [];
  return diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface Ctx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  bodyError: boolean;
  base: string;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

function linkHeader(ctx: Ctx, path: string, total: number, perPage: number, pageNum: number): Record<string, string> {
  if ((pageNum - 1) * perPage + perPage >= total) return {};
  const next = pageNum + 1;
  const last = Math.ceil(total / perPage);
  const url = (p: number) => `${ctx.base}/api/v3${path}?per_page=${perPage}&page=${p}`;
  return { link: `<${url(next)}>; rel="next", <${url(last)}>; rel="last"` };
}

function resolveCommit(repo: Repo, refOrSha: string | null): string | null {
  if (refOrSha === null) {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${refOrSha}`);
  if (byBranch) return byBranch;
  if (repo.refs.has(refOrSha)) return repo.refs.get(refOrSha)!;
  if (isOid(refOrSha) && repo.objects.has(refOrSha)) return refOrSha;
  return null;
}

function contentsGet(repo: Repo, path: string, refParam: string | null): Reply {
  const tip = resolveCommit(repo, refParam);
  if (!tip) return err(404, 'Not Found');
  const commit = repo.objects.get(peel(repo, tip));
  if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
  let treeOid = parseCommit(commit.data).tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return err(404, 'Not Found');
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return err(404, 'Not Found');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return dirListing(repo, entry.oid, path);
      const blob = repo.objects.get(entry.oid);
      if (!blob) return err(404, 'Not Found');
      return {
        status: 200,
        json: {
          type: 'file',
          name: entry.name,
          path,
          sha: entry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        },
      };
    }
    if (entry.mode !== '40000') return err(404, 'Not Found');
    treeOid = entry.oid;
  }
  return dirListing(repo, treeOid, path);
}

function dirListing(repo: Repo, treeOid: string, path: string): Reply {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return err(404, 'Not Found');
  const entries = parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      size: isDir || !blob ? 0 : blob.data.length,
    };
  });
  return { status: 200, json: entries };
}

function contentsPut(repo: Repo, path: string, body: Record<string, unknown>): Reply {
  if (path === '') return err(422, 'Validation Failed');
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const files = flattenTree(repo, refTree(repo, ref));
  const existing = files.get(path);
  if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
    return err(409, 'Conflict: the sha does not match the current file');
  }
  if (existing && body.sha === undefined) {
    return err(422, 'Validation Failed: sha is required to update a file');
  }
  const content = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
  const blobOid = makeBlob(repo, content);
  files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const tree = treeFromFlat(repo, files);
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const commit = makeCommit(repo, tree, tip ? [tip] : [], message);
  repo.refs.set(ref, commit);
  return {
    status: existing ? 200 : 201,
    json: {
      content: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commit },
    },
  };
}

function contentsDelete(repo: Repo, path: string, body: Record<string, unknown>): Reply {
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  if (!tip) return err(404, 'Not Found');
  const files = flattenTree(repo, refTree(repo, ref));
  const existing = files.get(path);
  if (!existing) return err(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== existing.oid) {
    return err(409, 'Conflict: the sha does not match the current file');
  }
  files.delete(path);
  const tree = treeFromFlat(repo, files);
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const commit = makeCommit(repo, tree, [tip], message);
  repo.refs.set(ref, commit);
  return { status: 200, json: { content: null, commit: { sha: commit } } };
}

export function handleRest(
  method: string,
  rawSegments: string[],
  query: URLSearchParams,
  bodyText: string,
  base: string,
): Reply {
  let body: Record<string, unknown> | null = null;
  let bodyError = false;
  if (bodyText.trim() !== '') {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      } else {
        bodyError = true;
      }
    } catch {
      bodyError = true;
    }
  }
  if (bodyError && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    return err(400, 'Problems parsing JSON');
  }
  const segments = rawSegments.map((s) => decodeURIComponent(s));
  const ctx: Ctx = { method, segments, query, body, bodyError, base };
  const reply = route(ctx);
  return {
    ...reply,
    headers: { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) },
  };
}

function route(ctx: Ctx): Reply {
  const { method, segments, query, body } = ctx;
  const b = body ?? {};

  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: { current_user_url: `${ctx.base}/api/v3/user`, meta_url: `${ctx.base}/api/v3/meta` },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: { installed_version: 'coreforge-1.0.0', hooks: [] } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: userJson() };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = listRepos().map(repoJson);
      const { page, perPage, pageNum } = paginate(all, query);
      return { status: 200, json: page, headers: linkHeader(ctx, '/user/repos', all.length, perPage, pageNum) };
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (getRepo(VIEWER.login, name)) {
        return err(422, 'Validation Failed: name already exists on this account');
      }
      const repo = createRepo(name, b.private === true, typeof b.description === 'string' ? b.description : '');
      return { status: 201, json: repoJson(repo) };
    }
  }
  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const repo = getRepo(segments[1], segments[2]);
  if (!repo) return err(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.isPrivate = b.private;
      if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
      if (typeof b.name === 'string' && b.name !== '' && b.name !== repo.name) {
        if (getRepo(repo.owner, b.name)) return err(422, 'Validation Failed: name already exists on this account');
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = b.name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      repo.mutationSeq += 1;
      return { status: 200, json: repoJson(repo) };
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      return { status: 204, raw: Buffer.alloc(0) };
    }
    return err(404, 'Not Found');
  }

  // Contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, path, query.get('ref'));
    if (method === 'PUT') return contentsPut(repo, path, b);
    if (method === 'DELETE') return contentsDelete(repo, path, b);
    return err(404, 'Not Found');
  }

  // Git refs
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const ref = typeof b.ref === 'string' ? b.ref : '';
    const sha = typeof b.sha === 'string' ? b.sha : '';
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return err(422, 'Validation Failed');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: reference already exists');
    repo.refs.set(ref, sha);
    const obj = repo.objects.get(sha)!;
    return { status: 201, json: { ref, object: { sha, type: obj.type } } };
  }

  // Branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
    return { status: 200, json: branches };
  }

  // Commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const start = resolveCommit(repo, query.get('sha'));
    if (!start) return { status: 200, json: [] };
    const seen = new Map<string, number>();
    const queue: string[] = [peel(repo, start)];
    const commits: Array<Record<string, unknown>> = [];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.set(oid, 1);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      commits.push({
        sha: oid,
        commit: {
          message: info.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.timestamp * 1000).toISOString() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.timestamp * 1000).toISOString() },
        },
        parents: info.parents.map((p) => ({ sha: p })),
      });
      queue.push(...info.parents);
    }
    commits.sort((x, y) => {
      const tx = (x.commit as { author: { date: string } }).author.date;
      const ty = (y.commit as { author: { date: string } }).author.date;
      return tx < ty ? 1 : -1;
    });
    const { page } = paginate(commits, query);
    return { status: 200, json: page };
  }

  // Labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, json: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, default: false })) };
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, 'Validation Failed: label already exists');
      repo.labels.set(name, { name, color });
      repo.mutationSeq += 1;
      return { status: 201, json: { name, color, default: false } };
    }
  }

  // Issues
  if (rest[0] === 'issues' && rest.length === 1) {
    if (method === 'POST') {
      const title = typeof b.title === 'string' ? b.title : '';
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Validation Failed: label '${label}' does not exist`);
      }
      const issue = createIssue(repo, title, typeof b.body === 'string' ? b.body : '', labels);
      return { status: 201, json: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      items.sort((x, y) => (direction === 'asc' ? x.number - y.number : y.number - x.number));
      const { page } = paginate(items, query);
      return { status: 200, json: page.map((i) => issueJson(repo, i)) };
    }
  }
  if (rest[0] === 'issues' && rest.length >= 2) {
    const number = Number(rest[1]);
    const issue = repo.issues.get(number);
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (issue) {
          if (issue.cachedJson && issue.cachedJson.seq === repo.mutationSeq) {
            return { status: 200, jsonText: issue.cachedJson.text };
          }
          const text = JSON.stringify(issueJson(repo, issue));
          issue.cachedJson = { seq: repo.mutationSeq, text };
          return { status: 200, jsonText: text };
        }
        if (pull) {
          return {
            status: 200,
            json: {
              id: repo.id * 1000000 + pull.number,
              number: pull.number,
              title: pull.title,
              body: pull.body,
              state: pull.state,
              labels: [],
              user: { login: VIEWER.login, id: VIEWER.id },
              pull_request: { url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
              created_at: seqIso(pull.seq),
              updated_at: seqIso(pull.seq),
            },
          };
        }
        return err(404, 'Not Found');
      }
      if (method === 'PATCH') {
        if (!issue) return err(404, 'Not Found');
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
        if (Array.isArray(b.labels)) {
          issue.labels = b.labels.filter((x): x is string => typeof x === 'string');
        }
        repo.mutationSeq += 1;
        return { status: 200, json: issueJson(repo, issue) };
      }
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue && !pull) return err(404, 'Not Found');
      if (method === 'GET') {
        const comments = issue ? issue.comments : [];
        return {
          status: 200,
          json: comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: seqIso(c.seq),
            updated_at: seqIso(c.seq),
          })),
        };
      }
      if (method === 'POST') {
        if (!issue) return err(404, 'Not Found');
        const comment = { id: allocCommentId(), body: typeof b.body === 'string' ? b.body : '', seq: nextSeq() };
        issue.comments.push(comment);
        repo.mutationSeq += 1;
        return {
          status: 201,
          json: {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: seqIso(comment.seq),
            updated_at: seqIso(comment.seq),
          },
        };
      }
    }
    return err(404, 'Not Found');
  }

  // Pull requests
  if (rest[0] === 'pulls' && rest.length === 1) {
    if (method === 'POST') {
      const title = typeof b.title === 'string' ? b.title : '';
      const head = typeof b.head === 'string' ? b.head.replace(/^[^:]+:/, '') : '';
      const base = typeof b.base === 'string' ? b.base.replace(/^[^:]+:/, '') : '';
      if (title === '' || !repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return err(422, 'Validation Failed: head or base branch does not exist');
      }
      const duplicate = [...repo.pulls.values()].find((p) => p.head === head && p.base === base && p.state === 'open');
      if (duplicate) return err(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
      const pull = createPull(repo, title, typeof b.body === 'string' ? b.body : '', head, base);
      return { status: 201, json: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((x, y) => y.number - x.number);
      const { page } = paginate(items, query);
      return { status: 200, json: page.map((p) => pullJson(repo, p)) };
    }
  }
  if (rest[0] === 'pulls' && rest.length >= 2) {
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (rest.length === 2 && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      return { status: 200, json: pullJson(repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      const files = pullFiles(repo, pull).map((f) => ({
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      }));
      return { status: 200, json: files };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      if (pull.merged || pull.state !== 'open') return err(405, 'Pull Request is not mergeable');
      const method2 = typeof b.merge_method === 'string' ? b.merge_method : 'merge';
      const sha = mergePull(repo, pull, method2);
      if (!sha) return err(405, 'Pull Request is not mergeable');
      return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
