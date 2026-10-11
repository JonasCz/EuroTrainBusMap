declare module "vt-pbf" {
  const vtpbf: { fromGeojsonVt(layers: Record<string, unknown>, opts?: { version?: number; extent?: number }): Uint8Array };
  export default vtpbf;
}
