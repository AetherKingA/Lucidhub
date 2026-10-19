import { describe, expect, it } from "vitest";
import { MmdbReader, addressBytes, isPrivateIp } from "../src/server/geoip.ts";

// A tiny MaxMind DB writer, just enough to build test databases: one network per entry.

function encode(v: unknown): Buffer {
  const head = (type: number, size: number) => {
    const ext = type > 7;
    const ctrl = ((ext ? 0 : type) << 5) | (size < 29 ? size : 29);
    const out = [ctrl];
    if (ext) out.push(type - 7);
    if (size >= 29) out.push(size - 29);
    return Buffer.from(out);
  };
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "number") {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return Buffer.concat([head(6, 4), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([head(11, v.length), ...v.map(encode)]);
  const entries = Object.entries(v as Record<string, unknown>);
  return Buffer.concat([head(7, entries.length), ...entries.flatMap(([k, x]) => [encode(k), encode(x)])]);
}

function buildDb(ipVersion: 4 | 6, networks: { bytes: number[]; prefix: number; data: unknown }[]) {
  // Tree: a chain of nodes per network; unused branches point to "not found" (= node count).
  type Node = [number | { data: number }, number | { data: number }];
  const nodes: Node[] = [[-1, -1]];
  const datas: Buffer[] = [];
  let dataOffset = 0;
  for (const n of networks) {
    const bits = (ipVersion === 6 && n.bytes.length === 4 ? [...Array(12).fill(0), ...n.bytes] : n.bytes).flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
    const prefix = ipVersion === 6 && n.bytes.length === 4 ? n.prefix + 96 : n.prefix;
    const d = encode(n.data);
    let node = 0;
    for (let i = 0; i < prefix; i++) {
      const bit = bits[i]!;
      if (i === prefix - 1) nodes[node]![bit] = { data: dataOffset };
      else {
        if (typeof nodes[node]![bit] !== "number" || nodes[node]![bit] === -1) {
          nodes.push([-1, -1]);
          nodes[node]![bit] = nodes.length - 1;
        }
        node = nodes[node]![bit] as number;
      }
    }
    datas.push(d);
    dataOffset += d.length;
  }
  const count = nodes.length;
  const tree = Buffer.alloc(count * 6);
  nodes.forEach((pair, i) =>
    pair.forEach((r, bit) => {
      const value = r === -1 ? count : typeof r === "number" ? r : count + 16 + r.data;
      tree.writeUIntBE(value, i * 6 + bit * 3, 3);
    }),
  );
  const marker = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);
  const meta = encode({ node_count: count, record_size: 24, ip_version: ipVersion, database_type: "Test" });
  return Buffer.concat([tree, Buffer.alloc(16), ...datas, marker, meta]);
}

const city = (name: string, region: string, country: string, iso: string) => ({
  city: { names: { en: name } },
  subdivisions: [{ names: { en: region } }],
  country: { iso_code: iso, names: { en: country } },
});

describe("MaxMind DB reader", () => {
  it("finds IPv4 networks in an IPv6 database (as DB-IP ships them), and misses what isn't there", () => {
    const db = new MmdbReader(
      buildDb(6, [
        { bytes: [81, 2, 0, 0], prefix: 16, data: city("Lyon", "Auvergne-Rhone-Alpes", "France", "FR") },
        { bytes: [203, 0, 113, 0], prefix: 24, data: city("Sydney", "New South Wales", "Australia", "AU") },
      ]),
    );
    expect(db.get("81.2.69.160")).toMatchObject({ city: { names: { en: "Lyon" } }, country: { iso_code: "FR" } });
    expect(db.get("::ffff:203.0.113.7")).toMatchObject({ subdivisions: [{ names: { en: "New South Wales" } }] });
    expect(db.get("81.3.0.1")).toBeNull();
    expect(db.get("2001:db8::1")).toBeNull();
    expect(db.get("not an ip")).toBeNull();
  });

  it("reads an IPv4-only database", () => {
    const db = new MmdbReader(buildDb(4, [{ bytes: [8, 8, 8, 0], prefix: 24, data: { autonomous_system_organization: "Example Net", autonomous_system_number: 15169 } }]));
    expect(db.get("8.8.8.8")).toEqual({ autonomous_system_organization: "Example Net", autonomous_system_number: 15169 });
    expect(db.get("2001:db8::1")).toBeNull();
  });

  it("rejects files that aren't MaxMind databases", () => {
    expect(() => new MmdbReader(Buffer.from("hello"))).toThrow(/MaxMind/);
  });
});

describe("addresses", () => {
  it("parses IPv4, IPv6 and IPv4-mapped IPv6", () => {
    expect(addressBytes("1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(addressBytes("::ffff:1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(addressBytes("2001:db8::1")).toEqual([0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 1]);
    expect(addressBytes("nope")).toBeNull();
  });

  it("knows private, local and Tailscale addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "100.101.102.103", "::1", "fd7a:115c:a1e0::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:4860::8888"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
});
