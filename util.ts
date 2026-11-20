// Shared helpers for the coreforge server: pkt-lines, hashing, encodings.
// Node standard library only.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data as Buffer).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Encode one pkt-line (4-hex length prefix including the prefix itself). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines starting at `offset`. Stops at the first flush (consuming
 * it) or at the end of the buffer. Returns the packets and the offset of the
 * first byte after the packet stream (where a packfile may follow).
 */
export function decodePkts(buf: Buffer, offset = 0): { packets: Pkt[]; end: number } {
  const packets: Pkt[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      return { packets, end: pos };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      return { packets, end: pos };
    }
    if (length < 4 || pos + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

/** Decode a whole buffer of pkt-lines into sectioned packet lists (v2 style). */
export function decodeSections(buf: Buffer): Pkt[][] {
  const sections: Pkt[][] = [];
  let current: Pkt[] = [];
  const { packets } = decodePkts(buf, 0);
  for (const packet of packets) {
    if (packet.kind === 'delim' || packet.kind === 'flush') {
      sections.push(current);
      current = [];
      if (packet.kind === 'flush') break;
    } else {
      current.push(packet);
    }
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

/** Opaque Relay-style global id for an entity, e.g. gid('Repository', '5000'). */
export function gid(type: string, ...parts: Array<string | number>): string {
  return b64encode([type, ...parts.map(String)].join(':'));
}

/** Parse a global id back into [type, ...parts], or null when malformed. */
export function parseGid(id: string): string[] | null {
  try {
    const text = b64decode(id);
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return parts;
  } catch {
    return null;
  }
}

export function isoFromEpoch(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let requestCounter = 0;

/** A unique-ish request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0');
  return `${rand.toUpperCase()}:${requestCounter.toString(16).toUpperCase().padStart(4, '0')}`;
}
