// Approximate location and network for an IP, from offline DB-IP Lite databases in data/geoip/
// (dbip-city-lite-*.mmdb and dbip-asn-lite-*.mmdb, CC BY 4.0). Lookups never leave this PC; without
// the files, locations are simply left out.
//
// The files use the MaxMind DB format: a binary search tree over the address bits, then a data section
// of typed values. This is a small reader for it, so the hub needs no extra package.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { IpLocation } from "../shared/protocol.ts";
import { ROOT } from "./config.ts";

export const GEOIP_DIR = resolve(ROOT, "data/geoip");

const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);

export class MmdbReader {
  private buf: Buffer;
  private nodeCount: number;
  private recordSize: number;
  private treeSize: number;
  private dataStart: number;
  private ipv4Start = 0;
  readonly ipVersion: number;

  constructor(buf: Buffer) {
    this.buf = buf;
    const at = buf.lastIndexOf(METADATA_MARKER);
    if (at < 0) throw new Error("Not a MaxMind DB file (no metadata)");
    const meta = this.decode(at + METADATA_MARKER.length, at + METADATA_MARKER.length).value as Record<string, unknown>;
    this.nodeCount = Number(meta.node_count);
    this.recordSize = Number(meta.record_size);
    this.ipVersion = Number(meta.ip_version);
    if (![24, 28, 32].includes(this.recordSize)) throw new Error(`Unsupported record size ${this.recordSize}`);
    this.treeSize = (this.recordSize / 4) * this.nodeCount;
    this.dataStart = this.treeSize + 16;
    // IPv4 addresses live under 96 zero bits in an IPv6 tree.
    if (this.ipVersion === 6) {
      let node = 0;
      for (let i = 0; i < 96 && node < this.nodeCount; i++) node = this.record(node, 0);
      this.ipv4Start = node;
    }
  }

  /** The record for an address, or null when the database has nothing for it. */
  get(ip: string): unknown {
    const bytes = addressBytes(ip);
    if (!bytes) return null;
    if (bytes.length === 16 && this.ipVersion === 4) return null;
    let node = bytes.length === 4 ? this.ipv4Start : 0;
    for (let i = 0; i < bytes.length * 8 && node < this.nodeCount; i++) node = this.record(node, (bytes[i >> 3]! >> (7 - (i & 7))) & 1);
    if (node <= this.nodeCount) return null;
    return this.decode(node - this.nodeCount + this.treeSize, this.dataStart).value;
  }

  private record(node: number, bit: number): number {
    const b = this.buf;
    const size = this.recordSize;
    const off = node * (size / 4);
    if (size === 24) {
      const o = off + bit * 3;
      return (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
    }
    if (size === 28) {
      if (bit === 0) return (((b[off + 3]! & 0xf0) << 20) | (b[off]! << 16) | (b[off + 1]! << 8) | b[off + 2]!) >>> 0;
      return (((b[off + 3]! & 0x0f) << 24) | (b[off + 4]! << 16) | (b[off + 5]! << 8) | b[off + 6]!) >>> 0;
    }
    return b.readUInt32BE(off + bit * 4);
  }

  /** Decodes one value at `offset`; pointers are relative to `base` (the data section start). */
  private decode(offset: number, base: number): { value: unknown; next: number } {
    const b = this.buf;
    const ctrl = b[offset++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      const ss = (ctrl >> 3) & 3;
      const vvv = ctrl & 7;
      let p: number;
      if (ss === 0) p = (vvv << 8) | b[offset]!;
      else if (ss === 1) p = ((vvv << 16) | b.readUInt16BE(offset)) + 2048;
      else if (ss === 2) p = ((vvv << 24) | (b[offset]! << 16) | b.readUInt16BE(offset + 1)) + 526336;
      else p = b.readUInt32BE(offset);
      return { value: this.decode(base + p, base).value, next: offset + ss + 1 };
    }
    if (type === 0) type = 7 + b[offset++]!;
    let size = ctrl & 0x1f;
    if (size === 29) {
      size = 29 + b[offset]!;
      offset += 1;
    } else if (size === 30) {
      size = 285 + b.readUInt16BE(offset);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + ((b[offset]! << 16) | b.readUInt16BE(offset + 1));
      offset += 3;
    }

    switch (type) {
      case 2:
        return { value: b.toString("utf8", offset, offset + size), next: offset + size };
      case 3:
        return { value: b.readDoubleBE(offset), next: offset + 8 };
      case 4:
        return { value: b.subarray(offset, offset + size), next: offset + size };
      case 5:
      case 6:
      case 8:
      case 9:
      case 10: {
        let n = 0n;
        for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(b[offset + i]!);
        const value = type === 8 && size === 4 ? Number(BigInt.asIntN(32, n)) : n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
        return { value, next: offset + size };
      }
      case 7: {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < size; i++) {
          const k = this.decode(offset, base);
          const v = this.decode(k.next, base);
          out[String(k.value)] = v.value;
          offset = v.next;
        }
        return { value: out, next: offset };
      }
      case 11: {
        const out: unknown[] = [];
        for (let i = 0; i < size; i++) {
          const v = this.decode(offset, base);
          out.push(v.value);
          offset = v.next;
        }
        return { value: out, next: offset };
      }
      case 14:
        return { value: size !== 0, next: offset };
      case 15:
        return { value: b.readFloatBE(offset), next: offset + 4 };
      default:
        throw new Error(`Unsupported MaxMind DB data type ${type}`);
    }
  }
}

/** An address as bytes (4 for IPv4, 16 for IPv6); IPv4-mapped IPv6 becomes IPv4. */
export function addressBytes(ip: string): number[] | null {
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const kind = isIP(plain);
  if (kind === 4) return plain.split(".").map(Number);
  if (kind !== 6) return null;
  const [head = "", tail = ""] = plain.split("::");
  const parse = (s: string) => {
    if (!s) return [] as number[];
    const parts = s.split(":");
    const last = parts.at(-1)!;
    const words = parts.slice(0, last.includes(".") ? -1 : undefined).map((w) => parseInt(w, 16));
    if (last.includes(".")) {
      const [a, b, c, d] = last.split(".").map(Number) as [number, number, number, number];
      words.push((a << 8) | b, (c << 8) | d);
    }
    return words;
  };
  const h = parse(head);
  const t = parse(tail);
  const words = plain.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h;
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/** Addresses that never reach a location database: this PC, home networks, Tailscale. */
export function isPrivateIp(ip: string): boolean {
  const b = addressBytes(ip);
  if (!b) return false;
  if (b.length === 4) {
    const [a, c] = b as [number, number];
    return a === 10 || a === 127 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127) || (a === 169 && c === 254);
  }
  return b.every((x, i) => (i < 15 ? x === 0 : x === 1)) || (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80);
}

// ---------------------------------------------------------------- the databases on disk

type Loaded = { city: MmdbReader | null; asn: MmdbReader | null; files: string };
let loaded: Loaded | null = null;
let checkedAt = 0;

/** Newest file in data/geoip/ whose name starts with `prefix`. */
function newest(files: string[], prefix: string) {
  return files.filter((f) => f.startsWith(prefix) && f.endsWith(".mmdb")).sort().at(-1) ?? null;
}

/** Opens the databases, picking up newer files dropped in (checked at most once a minute). */
function databases(dir = GEOIP_DIR): Loaded {
  if (loaded && Date.now() - checkedAt < 60_000) return loaded;
  checkedAt = Date.now();
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const city = newest(files, "dbip-city");
  const asn = newest(files, "dbip-asn");
  const key = `${city}|${asn}`;
  if (loaded?.files === key) return loaded;
  const open = (f: string | null) => {
    if (!f) return null;
    try {
      return new MmdbReader(readFileSync(resolve(dir, f)));
    } catch (err) {
      console.warn(`[geoip] Could not open ${f}:`, (err as Error).message);
      return null;
    }
  };
  loaded = { city: open(city), asn: open(asn), files: key };
  if (loaded.city || loaded.asn) console.log(`[geoip] Using ${[city, asn].filter(Boolean).join(" and ")}`);
  return loaded;
}

/** True when there's a location database to look addresses up in. */
export function geoipAvailable() {
  const d = databases();
  return Boolean(d.city || d.asn);
}

type Names = { names?: Record<string, string> };
const en = (x: unknown) => ((x as Names | undefined)?.names?.en ?? null) as string | null;

const cache = new Map<string, IpLocation | null>();

/** Where an address is, roughly. Null when there's no database or nothing is known about it. */
export function locate(ip: string): IpLocation | null {
  if (isPrivateIp(ip)) return { city: null, region: null, country: null, countryCode: null, network: null, local: true };
  if (cache.has(ip)) return cache.get(ip)!;
  const { city, asn } = databases();
  if (!city && !asn) return null;
  let out: IpLocation | null = null;
  try {
    const c = city?.get(ip) as { city?: Names; subdivisions?: Names[]; country?: Names & { iso_code?: string } } | null;
    const a = asn?.get(ip) as { autonomous_system_organization?: string } | null;
    if (c || a)
      out = {
        city: en(c?.city),
        region: en(c?.subdivisions?.[0]),
        country: en(c?.country),
        countryCode: c?.country?.iso_code ?? null,
        network: a?.autonomous_system_organization ?? null,
      };
  } catch (err) {
    console.warn(`[geoip] Lookup failed for an address:`, (err as Error).message);
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(ip, out);
  return out;
}

/** For tests: forget the opened databases and cached lookups. */
export function resetGeoip() {
  loaded = null;
  checkedAt = 0;
  cache.clear();
}
