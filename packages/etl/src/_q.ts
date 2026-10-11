import { DuckDBInstance } from '@duckdb/node-api';
const inst = await DuckDBInstance.create(process.env.DB ?? ':memory:');
const c = await inst.connect();
for (const sql of process.argv.slice(2)) {
  const r = await c.runAndReadAll(sql);
  const rows = r.getRowObjectsJS();
  console.table(rows.slice(0, Number(process.env.N ?? 60)));
}
