const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.resolve(__dirname, 'attendance.runtime.db');
const outputPath = path.resolve(__dirname, 'course-cleanup-output.txt');

async function main() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(outputPath, `Database file not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new sqlite3.Database(dbPath);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

  const tables = ['subjects', 'divisions', 'semesters', 'courses'];
  const results = { deleted: {}, counts: {} };

  for (const table of tables) {
    try {
      const res = await run(`DELETE FROM ${table}`);
      results.deleted[table] = res.changes || 0;
    } catch (err) {
      results.deleted[table] = `ERROR: ${err.message}`;
    }
  }

  for (const table of [...tables, 'students']) {
    try {
      const row = await get(`SELECT COUNT(*) AS count FROM ${table}`);
      results.counts[table] = row ? row.count : null;
    } catch (err) {
      results.counts[table] = `ERROR: ${err.message}`;
    }
  }

  db.close();
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
}

main().catch((err) => {
  fs.writeFileSync(outputPath, `FATAL ERROR: ${err.message}\n${err.stack}`);
  process.exit(1);
});
