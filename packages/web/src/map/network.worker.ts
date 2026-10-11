/**
 * Builds the large base-network GeoJSON (≈80k features) off the main thread
 * and hands it back as JSON bytes, which the main thread wraps in a blob URL
 * for MapLibre's own workers to fetch and parse.
 */
import type { CorridorExt } from "../data/net.ts";
import { fetchNetwork } from "../data/load.ts";
import type { Filters } from "../logic/filters.ts";
import { baseCityData, baseCorridorData, buildNetIndex, netSegments, type MapNet, type NetIndex } from "./features.ts";

export interface BaseRequest {
  id: number;
  type: "base";
  dataUrl: string;
  filters: Filters;
}
export interface BaseResponse {
  id: number;
  error?: string;
  /** JSON-encoded FeatureCollections */
  lines?: ArrayBuffer;
  casing?: ArrayBuffer;
  hops?: ArrayBuffer;
  cities?: ArrayBuffer;
  counts?: { lines: number; ms: number };
}

let ready: Promise<{ net: MapNet; idx: NetIndex }> | null = null;

function init(dataUrl: string) {
  ready ??= fetchNetwork((p) => dataUrl + p).then((file) => {
    const corridors = file.corridors as CorridorExt[];
    const net: MapNet = { cities: file.cities, corridors, segments: netSegments(file), hasDtCats: corridors.some((c) => c.dtCats !== undefined), file };
    return { net, idx: buildNetIndex(net) };
  });
  return ready;
}

const enc = new TextEncoder();
const bytes = (x: unknown) => enc.encode(JSON.stringify(x)).buffer as ArrayBuffer;

(self as unknown as Worker).onmessage = async (e: MessageEvent<BaseRequest>) => {
  const req = e.data;
  try {
    const { net, idx } = await init(req.dataUrl);
    const t0 = performance.now();
    const bd = baseCorridorData(net, idx, req.filters);
    const res: BaseResponse = {
      id: req.id,
      lines: bytes(bd.lines),
      casing: bytes(bd.casing),
      hops: bytes(bd.hops),
      cities: bytes(baseCityData(net, bd)),
      counts: { lines: bd.lines.features.length, ms: Math.round(performance.now() - t0) },
    };
    (self as unknown as Worker).postMessage(res, [res.lines!, res.casing!, res.hops!, res.cities!]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: req.id, error: String(err) } satisfies BaseResponse);
  }
};
