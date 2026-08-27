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
//
// EXCEPTION: the `companies` table itself has no company_id column (it
// can't be scoped to itself), so insert('companies', ...) is refused
// below — creating a company goes through a plain env.DB.prepare()
// insert instead (see the signup route, and this file's test). This
// bit us once already in Phase 1 when the exception got lost in a
// re-paste — do not remove this guard or this comment.
export function withCompanyScope(db, companyId) {
  if (!companyId) {
    throw new Error('withCompanyScope requires a companyId');
  }
  return {
    companyId,
    async all(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).all();
    },
    async first(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).first();
    },
    async run(sql, params = []) {
      return db.prepare(sql).bind(companyId, ...params).run();
    },
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
    async insert(table, data) {
      if (table === 'companies') {
        throw new Error(
          "withCompanyScope.insert() cannot be used on the 'companies' table " +
            '— it has no company_id column. Insert companies directly via ' +
            'env.DB.prepare(...).run() instead (see signup route).'
        );
      }
      const row = { ...data, company_id: companyId };
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      return db
        .prepare(sql)
        .bind(...cols.map((c) => row[c]))
        .run();
    },
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
