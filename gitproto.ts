// Git smart-HTTP protocol: advertisements, ls-refs, fetch (protocol v0 and
// v2, including shallow deepen) and receive-pack pushes. Packfiles are parsed
// and written in-process with node:zlib; deltas (OFS/REF) are resolved on
// ingest, and packs we send are always self-contained full objects.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pktLine, PKT_FLUSH, PKT_DELIM, decodePkts, ZERO_OID, isOid } from './util.ts';
import type { Pkt } from './util.ts';
import { parseCommit, parseTree, parseTag, peel, ancestors } from './store.ts';
import type { Repo, GitObjectType } from './store.ts';

const AGENT = 'coreforge/1.0';
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType | 'ofs' | 'ref'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs',
  7: 'ref',
};

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

/** Inflate the zlib stream starting at `pos`; it must yield `expected` bytes. */
function inflateExact(buf: Buffer, pos: number, expected: number): { data: Buffer; next: number } {
  const trySlice = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, end));
      return out.length === expected ? out : null;
    } catch {
      return null;
    }
  };
  let hi = Math.min(buf.length, pos + Math.max(64, expected + 32));
  let found = trySlice(hi);
  while (found === null && hi < buf.length) {
    hi = Math.min(buf.length, pos + (hi - pos) * 2 + 16);
    found = trySlice(hi);
  }
  if (found === null) throw new Error('corrupt pack: bad zlib stream');
  // Binary-search the minimal working end: that is the stream's true end.
  let lo = pos + 1;
  let hiEnd = hi;
  while (lo < hiEnd) {
    const mid = Math.floor((lo + hiEnd) / 2);
    if (trySlice(mid) !== null) hiEnd = mid;
    else lo = mid + 1;
  }
  const data = trySlice(lo);
  if (data === null) throw new Error('corrupt pack: bad zlib stream');
  return { data, next: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  start: number;
  type: GitObjectType | 'ofs' | 'ref';
  basePos: number;
  baseOid: string;
  data: Buffer;
}

/** Parse a packfile into the repo's object store. Throws on malformed input. */
export function ingestPack(repo: Repo, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: RawEntry[] = [];
  const byStart = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const type = CODE_TYPES[(byte >> 4) & 7];
    if (type === undefined) throw new Error('bad pack object type');
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let basePos = -1;
    let baseOid = '';
    if (type === 'ofs') {
      let c = pack[pos];
      pos += 1;
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      basePos = start - offset;
    } else if (type === 'ref') {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, next } = inflateExact(pack, pos, size);
    pos = next;
    const entry: RawEntry = { start, type, basePos, baseOid, data };
    entries.push(entry);
    byStart.set(start, entry);
  }
  // Resolve entries (deltas may chain) and store every object.
  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(entry.start);
    if (cached) return cached;
    let out: { type: GitObjectType; data: Buffer };
    if (entry.type === 'ofs' || entry.type === 'ref') {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.type === 'ofs') {
        const baseEntry = byStart.get(entry.basePos);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        const existing = repo.objects.get(entry.baseOid);
        if (existing) base = existing;
        else {
          const baseEntry = entries.find((e) => e.type !== 'ofs' && e.type !== 'ref' && hashOf(e.type, e.data) === entry.baseOid);
          if (!baseEntry) throw new Error('ref-delta base missing');
          base = resolve(baseEntry);
        }
      }
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      out = { type: entry.type, data: entry.data };
    }
    resolved.set(entry.start, out);
    return out;
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    const oid = hashOf(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  return entries.length;
}

function hashOf(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

// ---------------------------------------------------------------------------
// Pack writing
// ---------------------------------------------------------------------------

export function writePack(repo: Repo, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) throw new Error(`object ${oid} missing for pack`);
    const code = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = (code << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    const bytes: number[] = [];
    if (size === 0) {
      bytes.push(first);
    } else {
      bytes.push(first | 0x80);
      while (size > 0) {
        let b = size & 0x7f;
        size = Math.floor(size / 128);
        if (size > 0) b |= 0x80;
        bytes.push(b);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Object selection for fetch
// ---------------------------------------------------------------------------

/** Every object reachable from a commit: itself, its tree closure, parents. */
function fullClosure(repo: Repo, tip: string, into: Set<string>): void {
  const start = peel(repo, tip);
  const stack: string[] = [start];
  const commitsSeen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid) || commitsSeen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      commitsSeen.add(oid);
      into.add(oid);
      const info = parseCommit(obj.data);
      addTreeClosure(repo, info.tree, into);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      into.add(oid);
      stack.push(parseTag(obj.data).target);
    }
  }
}

function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

/** A shallow commit's own objects: the commit and its tree closure only. */
function shallowClosure(repo: Repo, tip: string, into: Set<string>): void {
  const commitOid = peel(repo, tip);
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return;
  into.add(commitOid);
  addTreeClosure(repo, parseCommit(obj.data).tree, into);
}

interface FetchSelection {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowDeclared: string[],
  deepen: number | null,
  deepenRelative = false,
  deepenSince: number | null = null,
): FetchSelection {
  const shallowSet = new Set<string>();
  const exclusion = new Set<string>();
  for (const declared of shallowDeclared) {
    if (repo.objects.has(declared)) {
      shallowClosure(repo, declared, exclusion);
      shallowSet.add(peel(repo, declared));
    }
  }
  const haveFull = new Set<string>();
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (shallowSet.has(peel(repo, have))) {
      // A have that is also a declared shallow boundary: the client holds
      // only the commit and its trees, NOT its ancestors — treating it as a
      // full have would wrongly exclude the very history a deepen asks for.
      shallowClosure(repo, have, haveFull);
    } else {
      fullClosure(repo, have, haveFull);
    }
  }
  for (const oid of haveFull) exclusion.add(oid);
  const send = new Set<string>();
  const sentCommits = new Set<string>();
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const relative = deepenRelative && deepen !== null && shallowSet.size > 0;
  for (const want of wants) {
    const commitOid = peel(repo, want);
    if (want !== commitOid && !exclusion.has(want)) send.add(want); // tag object itself
    queue.push([commitOid, 0]);
  }
  if (relative) {
    for (const boundaryOid of shallowSet) queue.push([boundaryOid, 0]);
  }
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (dist.has(oid)) continue;
    dist.set(oid, depth);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (exclusion.has(oid) && !shallowSet.has(oid)) continue; // a full have: stop
    const info = parseCommit(obj.data);
    // Whether this commit is part of the pack, per the request's mode:
    //   full:      everything reachable that is not excluded
    //   absolute:  distance < deepen from the wants
    //   relative:  1..deepen generations below a held shallow boundary
    //              (a want the client does not hold at all is sent too)
    //   since:     commit timestamp newer than deepen-since
    let included: boolean;
    if (deepenSince !== null) included = info.timestamp > deepenSince;
    else if (relative) included = !exclusion.has(oid) && (depth >= 1 || !shallowSet.has(oid));
    else if (deepen !== null) included = depth < deepen;
    else included = true;
    if (!exclusion.has(oid) && included) {
      send.add(oid);
      sentCommits.add(oid);
      addTreeClosure(repo, info.tree, send);
    }
    let descend: boolean;
    if (deepenSince !== null) descend = included;
    else if (relative) descend = depth < deepen!;
    else if (deepen !== null) descend = depth + 1 < deepen;
    else descend = !shallowSet.has(oid);
    if (descend) {
      for (const parent of info.parents) {
        if (repo.objects.has(parent)) queue.push([parent, depth + 1]);
      }
    }
  }
  // Shallow cuts: a sent commit whose parent exists in the store but was
  // not sent and is not fully held as a have.
  const boundary = new Set<string>();
  if (deepen !== null || deepenSince !== null || shallowSet.size > 0) {
    for (const oid of sentCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (repo.objects.has(parent) && !sentCommits.has(parent) && !haveFull.has(parent)) {
          boundary.add(oid);
        }
      }
    }
  }
  // Unshallow: declared boundary commits whose parents are all sent now.
  const unshallow: string[] = [];
  for (const boundaryOid of shallowSet) {
    const obj = repo.objects.get(boundaryOid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => sentCommits.has(p))) unshallow.push(boundaryOid);
    boundary.delete(boundaryOid);
  }
  for (const oid of exclusion) {
    if (!sentCommits.has(oid)) send.delete(oid);
  }
  return { oids: [...send], shallow: [...boundary], unshallow };
}

/** Check that every object referenced from a tip is present in the store. */
export function closureComplete(repo: Repo, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return false;
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).target);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function uploadPackAdvertisement(repo: Repo, protocolV2: boolean): Buffer {
  if (protocolV2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const caps = `side-band-64k ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0][1];
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') parts.push(pktLine(`${peel(repo, oid)} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [name, oid] of refs) {
      if (first) {
        parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') parts.push(pktLine(`${peel(repo, oid)} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function lsRefs(repo: Repo, sections: Pkt[][]): Buffer {
  const args: string[] = [];
  for (const section of sections.slice(1)) {
    for (const packet of section) {
      if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(wantSymrefs ? `${headOid} HEAD symref-target:${headRef}` : `${headOid} HEAD`);
    } else if (repo.refs.size === 0) {
      if (wantUnborn) lines.push(`unborn HEAD symref-target:${headRef}`);
      else lines.push(wantSymrefs ? `${ZERO_OID} HEAD symref-target:${headRef}` : `${ZERO_OID} HEAD`);
    } else if (wantSymrefs) {
      lines.push(`${ZERO_OID} HEAD symref-target:${headRef}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (wantPeel && obj && obj.type === 'tag') line += ` peeled:${peel(repo, oid)}`;
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return parts;
  }
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(pos, pos + CHUNK)])));
  }
  return parts;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const out: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenRelative: false,
    deepenSince: null,
    done: false,
  };
  for (const line of lines) {
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.deepen = Number(line.slice(7).trim());
    else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line.startsWith('deepen-since ')) out.deepenSince = Number(line.slice('deepen-since '.length).trim());
    else if (line === 'done') out.done = true;
  }
  return out;
}

function commonAck(repo: Repo, haves: string[]): string | null {
  for (const have of haves) {
    if (repo.objects.has(have)) return have;
  }
  return null;
}

export function fetchV2(repo: Repo, sections: Pkt[][]): Buffer {
  const argLines: string[] = [];
  for (const section of sections.slice(1)) {
    for (const packet of section) {
      if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const args = parseFetchArgs(argLines);
  const ack = commonAck(repo, args.haves);
  if (!args.done && !ack) {
    // Negotiation round with no common base yet: NAK and wait for more
    // haves. (With a common base, git reads `ready` as "the packfile
    // follows in this response"; with `done` sent, git expects the
    // packfile sections directly and rejects an acknowledgments section.)
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
  }
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.deepen, args.deepenRelative, args.deepenSince);
  const pack = writePack(repo, selection.oids);
  const parts: Buffer[] = [];
  if (!args.done && ack) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (args.deepen !== null || args.shallow.length > 0 || selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function fetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePkts(body, 0);
  const lines = packets
    .filter((p) => p.kind === 'data')
    .map((p) => (p as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''));
  // The first want line may carry capabilities after the oid.
  const cleaned = lines.map((line) => (line.startsWith('want ') ? `want ${line.slice(5).split(' ')[0]}` : line));
  const args = parseFetchArgs(cleaned);
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.deepen, args.deepenRelative, args.deepenSince);
  const pack = writePack(repo, selection.oids);
  const ack = commonAck(repo, args.haves);
  const parts: Buffer[] = [pktLine(ack ? `ACK ${ack}\n` : 'NAK\n')];
  if (args.deepen !== null || args.shallow.length > 0) {
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, end } = decodePkts(body, 0);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const fields = text.split(' ');
    if (fields.length >= 3 && isOid(fields[0]) && isOid(fields[1])) {
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(end);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      ingestPack(repo, Buffer.from(packBytes));
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const fail = (reason: string) => results.push({ ref: command.ref, ok: false, reason });
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) fail('reference not found');
      else if (current !== command.oldOid && command.oldOid !== ZERO_OID) fail('stale info');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      fail('missing objects');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        fail('reference already exists');
        continue;
      }
    } else if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = peel(repo, command.oldOid);
      const newCommit = peel(repo, command.newOid);
      const oldObj = repo.objects.get(oldCommit);
      const newObj = repo.objects.get(newCommit);
      if (oldObj?.type === 'commit' && newObj?.type === 'commit') {
        if (!ancestors(repo, newCommit).has(oldCommit)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    if (!closureComplete(repo, command.newOid)) {
      fail('missing objects');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  // Build the report-status stream, then wrap it in sideband packets.
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const outer: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let pos = 0; pos < innerBytes.length; pos += CHUNK) {
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), innerBytes.subarray(pos, pos + CHUNK)])));
  }
  outer.push(PKT_FLUSH);
  return Buffer.concat(outer);
}
