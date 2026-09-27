import express from 'express';
import multer from 'multer';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiError } from './ai.js';
import { CATEGORIES, CATEGORY_IDS, SEASONS } from './constants.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const AI_IMAGE_LIMIT = 5 * 1024 * 1024;
const COOKIE = 'closet_session';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // 쉼표로 구분된 문자열
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function readItemFields(body, { partial }) {
  const out = {};
  for (const key of ['name', 'category', 'subcategory', 'color', 'brand', 'size', 'notes']) {
    if (body[key] !== undefined) out[key] = String(body[key]).trim();
  }
  if (body.seasons !== undefined) out.seasons = parseList(body.seasons).filter((s) => SEASONS.includes(s));
  if (body.tags !== undefined) out.tags = parseList(body.tags);
  if (body.favorite !== undefined) out.favorite = body.favorite === true || body.favorite === 'true' || body.favorite === '1';
  if (!partial && !out.name) throw new HttpError(400, '이름을 입력하세요.');
  if (partial && 'name' in out && !out.name) throw new HttpError(400, '이름은 비울 수 없습니다.');
  if (!partial && !out.category) throw new HttpError(400, '카테고리를 선택하세요.');
  if ('category' in out && !CATEGORY_IDS.includes(out.category)) throw new HttpError(400, '알 수 없는 카테고리입니다.');
  return out;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp({ store, ai, uploadDir, password = '', secret = '' }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) =>
      IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'JPG, PNG, WEBP, GIF 이미지만 올릴 수 있어요.')),
  });

  // ---- 인증: APP_PASSWORD가 설정되어 있으면 로그인 필요 ----
  const authRequired = Boolean(password);
  const sessionToken = createHmac('sha256', secret || password || 'closet').update(`session:${password}`).digest('hex');
  const isAuthed = (req) => !authRequired || safeEqual(parseCookies(req.headers.cookie)[COOKIE] || '', sessionToken);

  app.post('/api/login', (req, res) => {
    if (!authRequired) return res.json({ ok: true });
    if (!safeEqual(String(req.body?.password ?? ''), password)) {
      return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
    }
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 180}${secure}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => res.json({ authRequired, authed: isAuthed(req) }));

  app.use(['/api', '/uploads'], (req, res, next) => {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: '로그인이 필요합니다.' });
  });

  app.use('/uploads', express.static(uploadDir, { maxAge: '30d', immutable: true }));

  // ---- 이미지 저장 ----
  const saveImage = (file) => {
    const name = `${randomUUID()}${IMAGE_TYPES[file.mimetype]}`;
    fs.writeFileSync(path.join(uploadDir, name), file.buffer);
    return name;
  };
  const removeImage = (name) => {
    if (!name) return;
    fs.rm(path.join(uploadDir, path.basename(name)), { force: true }, () => {});
  };
  const aiImage = (file) => {
    if (file.size > AI_IMAGE_LIMIT) throw new HttpError(413, 'AI 분석용 이미지는 5MB 이하여야 해요.');
    return { buffer: file.buffer, mediaType: file.mimetype };
  };

  // ---- 메타 ----
  app.get('/api/meta', (_req, res) => {
    const counts = Object.fromEntries(store.stats().map((s) => [s.category, s.count]));
    res.json({ categories: CATEGORIES, seasons: SEASONS, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
  });

  // ---- 옷 ----
  app.get('/api/items', (req, res) => {
    const { category, q } = req.query;
    res.json(store.listItems({ category: category || undefined, q: q ? String(q).trim() : undefined }));
  });

  app.get('/api/items/:id', (req, res) => {
    const item = store.getItem(req.params.id);
    if (!item) throw new HttpError(404, '옷을 찾을 수 없어요.');
    res.json(item);
  });

  app.post('/api/items', upload.single('image'), (req, res) => {
    const fields = readItemFields(req.body, { partial: false });
    if (req.file) fields.image = saveImage(req.file);
    res.status(201).json(store.createItem(fields));
  });

  app.patch('/api/items/:id', upload.single('image'), (req, res) => {
    const existing = store.getItem(req.params.id);
    if (!existing) throw new HttpError(404, '옷을 찾을 수 없어요.');
    const fields = readItemFields(req.body, { partial: true });
    if (req.file) fields.image = saveImage(req.file);
    const updated = store.updateItem(req.params.id, fields);
    if (req.file) removeImage(existing.image);
    res.json(updated);
  });

  app.delete('/api/items/:id', (req, res) => {
    const existing = store.getItem(req.params.id);
    if (!existing) throw new HttpError(404, '옷을 찾을 수 없어요.');
    store.deleteItem(req.params.id);
    removeImage(existing.image);
    res.status(204).end();
  });

  // ---- 저장한 코디 ----
  app.get('/api/outfits', (_req, res) => res.json(store.listOutfits()));

  app.post('/api/outfits', (req, res) => {
    const { title, description, item_ids, occasion } = req.body ?? {};
    const ids = parseList(item_ids).filter((id) => store.getItem(id));
    if (!title || !ids.length) throw new HttpError(400, '코디 이름과 아이템이 필요해요.');
    res.status(201).json(store.createOutfit({ title, description, item_ids: ids, occasion }));
  });

  app.delete('/api/outfits/:id', (req, res) => {
    if (!store.deleteOutfit(req.params.id)) throw new HttpError(404, '코디를 찾을 수 없어요.');
    res.status(204).end();
  });

  // ---- AI ----
  app.post('/api/ai/analyze', upload.single('image'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, '사진을 올려 주세요.');
    res.json(await ai.analyzeItem(aiImage(req.file)));
  }));

  app.post('/api/ai/outfits', wrap(async (req, res) => {
    const items = store.listItems();
    if (items.length < 2) throw new HttpError(400, '코디 추천을 받으려면 옷을 2개 이상 등록하세요.');
    const { occasion, weather, style } = req.body ?? {};
    const count = Math.min(Math.max(Number(req.body?.count) || 3, 1), 6);
    res.json(await ai.recommendOutfits(items, { occasion, weather, style, count }));
  }));

  app.post('/api/ai/shopping', upload.single('image'), wrap(async (req, res) => {
    const description = String(req.body?.description ?? '').trim();
    if (!req.file && !description) throw new HttpError(400, '사진이나 설명 중 하나는 필요해요.');
    res.json(await ai.shoppingCheck(store.listItems(), { image: req.file ? aiImage(req.file) : null, description }));
  }));

  app.post('/api/ai/gaps', wrap(async (req, res) => {
    const items = store.listItems();
    if (!items.length) throw new HttpError(400, '먼저 옷을 등록하세요.');
    res.json(await ai.wardrobeGaps(items, { focus: String(req.body?.focus ?? '').trim() }));
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- 프론트엔드 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- 에러 처리 ----
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError || err instanceof AiError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '이미지가 너무 커요 (최대 15MB).' : err.message;
      return res.status(400).json({ error: msg });
    }
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  });

  return app;
}
