// A D1 binding that counts queries the way the D1 limits do. One `batch` call is one
// query, whatever the number of statements in it. Each `run`, `all`, `first`, or `raw`
// call on a prepared statement is one query. The wrapper passes each call to the real
// binding, so the stores see real D1 behavior.

/** A D1 binding that counts its queries. */
export interface CountingD1 {
  /** The binding to give to the stores. */
  readonly db: D1Database;
  /** The number of queries since the last reset. */
  readonly count: number;
  /** Sets the count to 0. */
  reset(): void;
}

/** A prepared statement that counts its queries and keeps the real statement. */
class CountingStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly tick: () => void,
  ) {}

  bind(...values: unknown[]): CountingStatement {
    return new CountingStatement(this.inner.bind(...values), this.tick);
  }

  run(): Promise<D1Result> {
    this.tick();
    return this.inner.run();
  }

  all(): Promise<D1Result> {
    this.tick();
    return this.inner.all();
  }

  first(column?: string): Promise<unknown> {
    this.tick();
    return column === undefined ? this.inner.first() : this.inner.first(column);
  }

  raw(): Promise<unknown[]> {
    this.tick();
    return this.inner.raw();
  }
}

/** Wraps a real D1 binding. */
export function countingD1(real: D1Database): CountingD1 {
  let count = 0;
  const tick = (): void => {
    count++;
  };
  const db = {
    prepare: (query: string) => new CountingStatement(real.prepare(query), tick),
    batch: (statements: CountingStatement[]) => {
      tick();
      return real.batch(statements.map((statement) => statement.inner));
    },
    exec: (query: string) => {
      tick();
      return real.exec(query);
    },
  };
  return {
    db: db as unknown as D1Database,
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}
