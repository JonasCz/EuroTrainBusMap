import { describe, expect, it } from "vitest";
import { decodePolyline, encodePolyline, expandNetwork, packNetwork, type NetworkFile } from "@etbm/shared";

describe("polyline", () => {
  it("round-trips at 1e-5 precision", () => {
    const c: [number, number][] = [[13.40495, 52.52001], [-0.12574, 51.50853], [28.94966, 41.01384]];
    expect(encodePolyline([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]])).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline(encodePolyline(c))).toEqual(c);
  });
});

describe("packNetwork", () => {
  it("round-trips the network", () => {
    const net: NetworkFile = {
      schema: 1,
      build: "x",
      timezones: ["Europe/Berlin"],
      cities: [
        { id: 0, name: "Berlin", country: "DE", lon: 13.41053, lat: 52.52437, population: 3426354, importance: 1, cats: 7, stations: [0, 1], tz: 0, shard: 3 },
        { id: 1, name: "Potsdam", country: "DE", lon: 13.06566, lat: 52.39886, population: 184754, importance: 0.5, cats: 2, stations: [2], tz: 0 },
      ],
      stations: [
        { id: 0, city: 0, name: "Berlin Hbf", lon: 13.36955, lat: 52.52508, cats: 7, tpd: 812.4 },
        { id: 1, city: 0, name: "Zoo", lon: 13.33295, lat: 52.50675, cats: 2 },
        { id: 2, city: 1, name: "Potsdam Hbf", lon: 13.06664, lat: 52.39176, cats: 2 },
      ],
      corridors: [
        { id: 0, a: 0, b: 2, coords: [[13.41053, 52.52437], [13.06566, 52.39886]], cats: 3, tpd: { 2: 120.5 }, snapped: true },
      ],
    };
    const packed: NetworkFile = { ...net, cities: [], stations: [], corridors: [], packed: packNetwork(net) };
    const back = expandNetwork(JSON.parse(JSON.stringify(packed)) as NetworkFile);
    expect(back.cities).toEqual(net.cities);
    expect(back.stations).toEqual(net.stations);
    expect(back.corridors).toEqual(net.corridors);
    expect(back.packed).toBeUndefined();
  });
});

describe("packNetwork v2 (segments)", () => {
  it("round-trips segments and rebuilds corridor geometry from them", () => {
    const cities = [
      { id: 0, name: "A", country: "DE", lon: 10, lat: 50, population: 1, importance: 1, cats: 1, stations: [0], tz: 0 },
      { id: 1, name: "B", country: "DE", lon: 10.1, lat: 50, population: 1, importance: 1, cats: 1, stations: [1], tz: 0 },
      { id: 2, name: "C", country: "DE", lon: 10.2, lat: 50.1, population: 1, importance: 1, cats: 1, stations: [2], tz: 0 },
    ];
    const stations = cities.map((c) => ({ id: c.id, city: c.id, name: c.name, lon: c.lon, lat: c.lat, cats: 1 }));
    const segments = [
      { id: 0, coords: [[10, 50], [10.05, 50.01], [10.1, 50]] as [number, number][], cats: 3, tpd: { 1: 3, 2: 10 }, snapped: true },
      { id: 1, coords: [[10.2, 50.1], [10.1, 50]] as [number, number][], cats: 1, tpd: { 1: 3 }, snapped: true },
    ];
    const corridors = [
      { id: 0, a: 0, b: 1, coords: segments[0]!.coords, cats: 3, tpd: { 2: 10 }, snapped: true, segs: [0] },
      { id: 1, a: 0, b: 2, coords: [[10, 50], [10.05, 50.01], [10.1, 50], [10.2, 50.1]] as [number, number][], cats: 1, tpd: { 1: 3 }, snapped: true, segs: [0, -2] },
      { id: 2, a: 1, b: 2, coords: [[10.1, 50], [10.2, 50.1]] as [number, number][], cats: 1, tpd: { 1: 1 }, snapped: false },
    ];
    const net: NetworkFile = { schema: 1, build: "x", timezones: ["UTC"], cities, stations, corridors, segments };
    const packed = packNetwork(net);
    expect(packed.v).toBe(2);
    const back = expandNetwork(JSON.parse(JSON.stringify({ ...net, cities: [], stations: [], corridors: [], segments: undefined, packed })) as NetworkFile);
    expect(back.segments).toEqual(segments);
    expect(back.corridors).toEqual(corridors);
  });
});
