/**
 * Local (within-city) transport layer – a display layer next to the intercity network: metro, tram and
 * city bus lines with their stops, as vector tiles of their own (`<build>/urban/{rail,bus}/{z}/{x}/{y}.pbf.gz`).
 * Tile layers:
 *   `ul` lines   m mode (0 bus 1 tram 2 metro 3 cable), n short name, c colour (hex, optional), a agency, d description,
 *                t trips per day (peak direction), z first zoom, g geometry quality (absent = feed shape, 1 rail, 2 road, 3 stop to stop)
 *   `us` stops   n name, m mode bit mask (1 << mode), l line names, i importance (log), k number of lines, z first zoom,
 *                x 1 = at an intercity station (no dot of its own)
 * Metro / tram lines (and the stops of rail-bound stations) live in the `rail` source, bus lines and bus-only stops in `bus`.
 */
export const URBAN_VERSION = 1;
export const URBAN_LAYERS = { line: "ul", stop: "us" } as const;
export const UMODE = { Bus: 0, Tram: 1, Metro: 2, Cable: 3 } as const;

export interface UrbanSourceInfo {
  /** The only zoom the tiles are stored at (MapLibre overzooms them). */
  zoom: number;
  /** x,y pairs of the tiles that exist */
  tiles: number[];
  url: string;
}

export interface UrbanInfo {
  version: number;
  rail: UrbanSourceInfo;
  bus: UrbanSourceInfo;
}

/** Tile keys "z/x/y" of an urban source. */
export function urbanTileSet(s: UrbanSourceInfo): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.tiles.length; i += 2) out.add(`${s.zoom}/${s.tiles[i]}/${s.tiles[i + 1]}`);
  return out;
}
