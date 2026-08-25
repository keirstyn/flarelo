// The only sanctioned way route handlers touch the database. D1 has no
// Row-Level Security, so this helper exists to make it structurally
// hard to write a route that leaks another company's data — every
// method here takes a company_id up front and threads it through every
// query it runs.
//
// No route handler should ever call env.DB directly. If a query can't
// be expressed through one of these methods, add a method here rather
// than reaching for env.DB.prepare() in a handler — per the working
// agreement in docs/flarelo-build-prompt.md.

export function withCompanyScope(db, companyId) {
  if (!companyId) {
    throw new Error('withCompanyScope requires a companyId');
  }

  return {
    companyId,

    // Run an arbitrary scoped SELECT. `sql` must reserve its first `?`
    // placeholder for company_id — this always binds that one first,
    // then any additional params in order.
    async all(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).all();
    },

    async first(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).first();
    },

    async run(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).run();
    },

    // `table` and `orderBy` below are always developer-supplied
    // literals in route code, never end-user input — do not pass a
    // user-controlled string into either.

    // Fetch one row by id from any table with `id` + `company_id`
    // columns — returns null if the id belongs to another company or
    // doesn't exist. Route handlers should turn that null into a 404,
    // never a 500.
    async findById(table, id) {
      return db
        .prepare(`SELECT * FROM ${table} WHERE company_id = ? AND id = ?`)
        .bind(companyId, id)
        .first();
    },

    async findAll(table, orderBy = null) {
      const order = orderBy ? ` ORDER BY ${orderBy}` : '';
      return db
        .prepare(`SELECT * FROM ${table} WHERE company_id = ?${order}`)
        .bind(companyId)
        .all();
    },

    // Inserts `data` into `table`, forcing company_id to this scope's
    // value regardless of what (if anything) the caller passed in —
    // so a route handler can never accidentally insert a row into the
    // wrong company by forgetting the field.
    async insert(table, data) {
      const row = { ...data, company_id: companyId };
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      return db
        .prepare(sql)
        .bind(...cols.map((c) => row[c]))
        .run();
    },

    // Updates a row by id, scoped to company_id in the WHERE clause —
    // a row belonging to another company simply won't match, so this
    // is a no-op (changes: 0) rather than a cross-company write.
    async update(table, id, data) {
      const cols = Object.keys(data);
      const setClause = cols.map((c) => `${c} = ?`).join(', ');
      const sql = `UPDATE ${table} SET ${setClause} WHERE id = ? AND company_id = ?`;
      return db
        .prepare(sql)
        .bind(...cols.map((c) => data[c]), id, companyId)
        .run();
    },

    async remove(table, id) {
      return db
        .prepare(`DELETE FROM ${table} WHERE id = ? AND company_id = ?`)
        .bind(id, companyId)
        .run();
    },
  };
}
