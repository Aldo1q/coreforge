// The forge's data store: one viewer account, repositories with an in-memory
// git object database, issues and pull requests sharing one number sequence,
// labels and comments. Everything lives in Maps; ids are stable counters.

import { createHash } from 'node:crypto';
import { isoFromEpoch } from './util.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  /** Serialized GET response cache, valid while repo.mutationSeq is unchanged. */
  cachedJson?: { seq: number; text: string };
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  labels: Map<string, { name: string; color: string }>;
  seq: number;
  /** Object ids whose full closure is known present in `objects` (prunes re-verification). */
  verifiedClosure: Set<string>;
  /** Bumped on every mutation that can change a serialized issue or label view. */
  mutationSeq: number;
}

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

export const VIEWER: Viewer = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const SCENARIO_EPOCH = 1735689600;

let seqCounter = 0;
/** A monotonically increasing sequence number; timestamps derive from it. */
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export function seqTimestamp(seq: number): number {
  return SCENARIO_EPOCH + seq;
}

export function seqIso(seq: number): string {
  return isoFromEpoch(seqTimestamp(seq));
}

export const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextCommentId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER.login,
    isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    labels: new Map(),
    seq: nextSeq(),
    verifiedClosure: new Set(),
    mutationSeq: 0,
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function allocCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function makeBlob(repo: Repo, content: Buffer): string {
  return putObject(repo, 'blob', content);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree ordering: names compared byte-wise, directories as name + '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = a.mode === '40000' ? `${a.name}/` : a.name;
  const kb = b.mode === '40000' ? `${b.name}/` : b.name;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function makeTree(repo: Repo, entries: TreeEntry[]): string {
  return putObject(repo, 'tree', serializeTree(entries));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let timestamp = SCENARIO_EPOCH;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) timestamp = Number(match[1]);
    }
  }
  return { tree, parents, message, timestamp };
}

export function makeCommit(
  repo: Repo,
  tree: string,
  parents: string[],
  message: string,
  seq: number = nextSeq(),
): string {
  const ts = seqTimestamp(seq);
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

export function parseTag(data: Buffer): { target: string; targetType: string } {
  const text = data.toString('utf8');
  let target = '';
  let targetType = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
    else if (line === '') break;
  }
  return { target, targetType };
}

/** Follow tag objects until a non-tag object; returns that object's id. */
export function peel(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).target;
  }
  return current;
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(
  repo: Repo,
  treeOid: string | null,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  if (treeOid === null) return out;
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (or rebuild) a tree hierarchy from a flat path -> blob map. */
export function treeFromFlat(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { files: [], dirs: new Map() });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push({ mode: file.mode, name: parts[parts.length - 1], oid: file.oid });
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return makeTree(repo, entries);
  };
  return build(root);
}

/** The tree oid a ref points at (through its commit), or null when unborn. */
export function refTree(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  const commitOid = peel(repo, oid);
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

/** All ancestors of a commit (including itself), breadth-first. */
export function ancestors(repo: Repo, start: string): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [[peel(repo, start), 0]];
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (dist.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    dist.set(oid, depth);
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, depth + 1]);
  }
  return dist;
}

export function isAncestor(repo: Repo, maybeAncestor: string, of: string): boolean {
  return ancestors(repo, of).has(peel(repo, maybeAncestor));
}

/**
 * Whether `ancestor` is reachable from `descendant` through parent links,
 * stopping the moment it is found. A fast-forward push finds its old tip one
 * step down, so this stays O(1) where the full ancestor walk is O(history).
 */
export function hasAncestor(repo: Repo, descendant: string, ancestor: string): boolean {
  const target = peel(repo, ancestor);
  const seen = new Set<string>();
  const stack = [peel(repo, descendant)];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = ancestors(repo, a);
  const ancB = ancestors(repo, b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, depthA] of ancA) {
    const depthB = ancB.get(oid);
    if (depthB !== undefined && depthA + depthB < bestScore) {
      best = oid;
      bestScore = depthA + depthB;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// File diffs and three-way merges over flattened trees
// ---------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts via an LCS over lines (files in this forge are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = saved;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj ? obj.data.toString('utf8') : '';
}

export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileDiff[] {
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      const lines = blobText(repo, after.oid);
      const count = lines === '' ? 0 : lines.split('\n').length;
      diffs.push({ path, status: 'added', additions: count, deletions: 0, changes: count });
    } else if (before && !after) {
      const lines = blobText(repo, before.oid);
      const count = lines === '' ? 0 : lines.split('\n').length;
      diffs.push({ path, status: 'removed', additions: 0, deletions: count, changes: count });
    } else if (before && after) {
      const { additions, deletions } = lineDiff(blobText(repo, before.oid), blobText(repo, after.oid));
      diffs.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/**
 * Three-way merge of flattened trees. Returns the merged flat map, or the
 * first conflicting path when both sides changed the same file differently.
 */
export function mergeFlat(
  base: Map<string, { oid: string; mode: string }>,
  ours: Map<string, { oid: string; mode: string }>,
  theirs: Map<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }> } | { conflict: string } {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOid = (x?: { oid: string }, y?: { oid: string }) => x?.oid === y?.oid;
    if (sameOid(o, t)) {
      if (o) merged.set(path, o);
    } else if (sameOid(b, o)) {
      if (t) merged.set(path, t);
    } else if (sameOid(b, t)) {
      if (o) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}
