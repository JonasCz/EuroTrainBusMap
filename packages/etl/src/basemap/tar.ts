/** Tiny ustar writer / reader (regular files, names < 100 bytes) so thousands of tiles travel as ONE R2 object. */
export function tarEntries(entries: { name: string; data: Uint8Array }[]): Buffer {
  const parts: Buffer[] = [];
  for (const { name, data } of entries) {
    if (Buffer.byteLength(name) >= 100) throw new Error(`tar name too long: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148); // checksum placeholder
    h.write("0", 156);
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, Buffer.from(data.buffer, data.byteOffset, data.length));
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Read the entries of a tar made by `tarEntries` (views into `buf`). */
export function readTar(buf: Buffer): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  let pos = 0;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h[0] === 0) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(h.subarray(124, 135).toString("ascii"), 8);
    pos += 512;
    out.push({ name, data: buf.subarray(pos, pos + size) });
    pos += Math.ceil(size / 512) * 512;
  }
  return out;
}
