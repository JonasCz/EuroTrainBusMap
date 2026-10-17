/** Gzipped static files: inflated in the browser unless the host already decoded them (Content-Encoding). */
export async function inflate(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf; // already decoded (host sent Content-Encoding)
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Fetch a gzipped file and inflate it. */
export async function fetchGzBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${url}`);
  return new Uint8Array(await inflate(await res.arrayBuffer()));
}
