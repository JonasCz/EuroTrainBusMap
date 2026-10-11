import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { writeFile, rm } from "node:fs/promises";

export type Row = Record<string, unknown>;

function toJs(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "items" in (v as object)) return ((v as { items: unknown[] }).items).map(toJs);
  return v;
}

export class Db {
  private constructor(
    readonly inst: DuckDBInstance,
    readonly con: DuckDBConnection,
  ) {}

  static async open(path: string, opts: { threads?: number; memoryLimit?: string; tempDir?: string } = {}): Promise<Db> {
    const inst = await DuckDBInstance.create(path);
    const con = await inst.connect();
    const db = new Db(inst, con);
    if (opts.threads) await db.run(`SET threads = ${opts.threads}`);
    if (opts.memoryLimit) await db.run(`SET memory_limit = '${opts.memoryLimit}'`);
    if (opts.tempDir) await db.run(`SET temp_directory = '${opts.tempDir}'`);
    await db.run(`SET preserve_insertion_order = false`);
    return db;
  }

  async run(sql: string): Promise<void> {
    try {
      await this.con.run(sql);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n  in SQL: ${sql.slice(0, 600)}`);
    }
  }

  async all<T = Row>(sql: string): Promise<T[]> {
    let r;
    try {
      r = await this.con.runAndReadAll(sql);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n  in SQL: ${sql.slice(0, 600)}`);
    }
    const names = r.columnNames();
    const rows = r.getRows();
    return rows.map((row) => {
      const o: Row = {};
      names.forEach((n, i) => (o[n] = toJs(row[i])));
      return o as T;
    });
  }

  async one<T = Row>(sql: string): Promise<T> {
    const rows = await this.all<T>(sql);
    return rows[0]!;
  }

  async scalar(sql: string): Promise<number> {
    const r = await this.all(sql);
    const v = r[0] ? Object.values(r[0])[0] : null;
    return v == null ? 0 : Number(v);
  }

  /** Stream a query chunk by chunk as column arrays (BIGINTs converted to numbers). */
  async stream(sql: string, onChunk: (cols: unknown[][], n: number) => void | Promise<void>): Promise<number> {
    const res = await this.con.stream(sql);
    let total = 0;
    for await (const chunk of res) {
      const n = chunk.rowCount;
      if (!n) continue;
      const cols = chunk.getColumns().map((c) => c.map(toJs));
      total += n;
      await onChunk(cols, n);
    }
    return total;
  }

  /** Bulk insert rows into a (new or existing) table via a temporary CSV file. */
  async insertRows(table: string, columns: { name: string; type: string }[], rows: Iterable<unknown[]>, tmpPath: string): Promise<void> {
    const esc = (v: unknown) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const parts: string[] = [];
    let buf = "";
    for (const r of rows) {
      buf += r.map(esc).join(",") + "\n";
      if (buf.length > 1 << 24) {
        parts.push(buf);
        buf = "";
      }
    }
    parts.push(buf);
    await writeFile(tmpPath, parts.join(""));
    const colSpec = columns.map((c) => `'${c.name}': '${c.type}'`).join(", ");
    await this.run(`CREATE TABLE IF NOT EXISTS ${table} (${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
    await this.run(
      `INSERT INTO ${table} SELECT * FROM read_csv('${tmpPath}', header=false, columns={${colSpec}}, quote='"', escape='"', nullstr='', auto_detect=false)`,
    );
    await rm(tmpPath, { force: true });
  }

  private closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.con.closeSync();
    this.inst.closeSync();
  }
}

export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
