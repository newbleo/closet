import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const ITEM_FIELDS = ['name', 'category', 'subcategory', 'color', 'brand', 'size', 'seasons', 'tags', 'notes', 'favorite', 'image'];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '',
      seasons TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outfits (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      item_ids TEXT NOT NULL,
      occasion TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  return new Store(db);
}

function rowToItem(row) {
  if (!row) return null;
  return {
    ...row,
    seasons: JSON.parse(row.seasons),
    tags: JSON.parse(row.tags),
    favorite: Boolean(row.favorite),
  };
}

function rowToOutfit(row) {
  if (!row) return null;
  return { ...row, item_ids: JSON.parse(row.item_ids) };
}

function toColumns(data) {
  const out = {};
  for (const key of ITEM_FIELDS) {
    if (!(key in data)) continue;
    let v = data[key];
    if (key === 'seasons' || key === 'tags') v = JSON.stringify(Array.isArray(v) ? v : []);
    else if (key === 'favorite') v = v ? 1 : 0;
    else if (key === 'image') v = v ?? null;
    else v = String(v ?? '').trim();
    out[key] = v;
  }
  return out;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  listItems({ category, q } = {}) {
    let sql = 'SELECT * FROM items WHERE 1=1';
    const params = [];
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (q) {
      // %, _ 는 LIKE 와일드카드라서 검색어에 들어 있으면 글자 그대로 찾도록 이스케이프한다.
      const cols = ['name', 'color', 'brand', 'subcategory', 'tags', 'notes'];
      sql += ` AND (${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(...cols.map(() => like));
    }
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params).map(rowToItem);
  }

  getItem(id) {
    return rowToItem(this.db.prepare('SELECT * FROM items WHERE id = ?').get(id));
  }

  createItem(data) {
    const now = new Date().toISOString();
    const cols = { seasons: '[]', tags: '[]', ...toColumns(data), id: randomUUID(), created_at: now, updated_at: now };
    const keys = Object.keys(cols);
    this.db
      .prepare(`INSERT INTO items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => cols[k]));
    return this.getItem(cols.id);
  }

  updateItem(id, data) {
    const cols = toColumns(data);
    const keys = Object.keys(cols);
    if (keys.length) {
      this.db
        .prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => cols[k]), new Date().toISOString(), id);
    }
    return this.getItem(id);
  }

  deleteItem(id) {
    const deleted = this.db.prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0;
    if (deleted) {
      // 저장한 코디에서도 빼고, 남은 아이템이 없는 코디는 지운다.
      for (const outfit of this.listOutfits()) {
        if (!outfit.item_ids.includes(id)) continue;
        const rest = outfit.item_ids.filter((i) => i !== id);
        if (rest.length) this.db.prepare('UPDATE outfits SET item_ids = ? WHERE id = ?').run(JSON.stringify(rest), outfit.id);
        else this.deleteOutfit(outfit.id);
      }
    }
    return deleted;
  }

  stats() {
    return this.db.prepare('SELECT category, COUNT(*) AS count FROM items GROUP BY category').all();
  }

  listOutfits() {
    return this.db.prepare('SELECT * FROM outfits ORDER BY created_at DESC').all().map(rowToOutfit);
  }

  createOutfit({ title, description = '', item_ids, occasion = '' }) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO outfits (id, title, description, item_ids, occasion, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, String(title), String(description), JSON.stringify(item_ids), String(occasion), new Date().toISOString());
    return rowToOutfit(this.db.prepare('SELECT * FROM outfits WHERE id = ?').get(id));
  }

  deleteOutfit(id) {
    return this.db.prepare('DELETE FROM outfits WHERE id = ?').run(id).changes > 0;
  }
}
