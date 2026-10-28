/** Level-of-detail rules live in @etbm/shared (the ETL uses them to build map tiles). */
export {
  LEVELS,
  FADE_ZOOM,
  STATION_ZOOM,
  STATION_LEVELS,
  LONG_HOP_KM,
  LONG_HOP_ZOOM,
  levelIndex,
  isLongHop,
  corridorMinZoom,
  cityTierZoom,
  stationLevel,
  isMajorStation,
  SMALL_CITY_STATIONS,
  catWidth,
  haversineKm,
} from "@etbm/shared";
