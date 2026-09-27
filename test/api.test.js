import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAi, wardrobeToText } from '../src/ai.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Anthropic 클라이언트를 흉내 낸다. 요청을 기록하고 준비된 JSON을 돌려준다.
function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(params);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(responder(params)) }] };
        },
      },
    },
  };
}

let server, base, dir, client, cookie;
const responses = {};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closet-'));
  client = fakeClient((p) => {
    const text = JSON.stringify(p.messages[0].content);
    if (text.includes('옷장에 등록하려고')) return responses.analyze;
    if (text.includes('코디 세트')) return responses.outfits;
    if (text.includes('쇼핑 중')) return responses.shopping;
    return responses.gaps;
  });
  const app = createApp({
    store: openDb(path.join(dir, 'test.db')),
    ai: createAi({ client, model: 'test-model' }),
    uploadDir: path.join(dir, 'uploads'),
    password: 'secret-pw',
  });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function req(pathname, { method = 'GET', json, form, auth = true } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  let body;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(base + pathname, { method, headers, body });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data, res };
}

function itemForm(fields, withImage = false) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (withImage) fd.append('image', new Blob([PNG], { type: 'image/png' }), 'a.png');
  return fd;
}

test('로그인 전에는 API와 사진에 접근할 수 없다', async () => {
  assert.equal((await req('/api/items', { auth: false })).status, 401);
  assert.equal((await req('/uploads/x.jpg', { auth: false })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', json: { password: 'nope' } })).status, 401);
  const session = await req('/api/session', { auth: false });
  assert.deepEqual(session.data, { authRequired: true, authed: false });
});

test('로그인하면 쿠키로 인증된다', async () => {
  const { status, res } = await req('/api/login', { method: 'POST', json: { password: 'secret-pw' } });
  assert.equal(status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/session')).data.authed, true);
});

let shirt, pants;
test('사진과 함께 옷을 등록하고 조회/검색한다', async () => {
  const created = await req('/api/items', {
    method: 'POST',
    form: itemForm({ name: '흰색 옥스포드 셔츠', category: 'top', color: '화이트', seasons: ['봄', '가을', '없는계절'], tags: '셔츠, 베이직' }, true),
  });
  assert.equal(created.status, 201);
  shirt = created.data;
  assert.deepEqual(shirt.seasons, ['봄', '가을']);
  assert.deepEqual(shirt.tags, ['셔츠', '베이직']);
  assert.ok(shirt.image);
  const img = await fetch(`${base}/uploads/${shirt.image}`, { headers: { cookie } });
  assert.equal(img.status, 200);

  pants = (await req('/api/items', { method: 'POST', form: itemForm({ name: '베이지 치노', category: 'bottom' }) })).data;

  assert.equal((await req('/api/items')).data.length, 2);
  assert.equal((await req('/api/items?category=bottom')).data[0].id, pants.id);
  assert.equal((await req(`/api/items?q=${encodeURIComponent('베이직')}`)).data[0].id, shirt.id);

  const meta = (await req('/api/meta')).data;
  assert.equal(meta.total, 2);
  assert.equal(meta.counts.top, 1);
});

test('잘못된 입력은 400을 돌려준다', async () => {
  assert.equal((await req('/api/items', { method: 'POST', form: itemForm({ category: 'top' }) })).status, 400);
  assert.equal((await req('/api/items', { method: 'POST', form: itemForm({ name: 'x', category: 'spaceship' }) })).status, 400);
  const bad = new FormData();
  bad.append('name', 'x');
  bad.append('category', 'top');
  bad.append('image', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await req('/api/items', { method: 'POST', form: bad })).status, 400);
});

test('옷 정보를 수정하고 사진을 교체한다', async () => {
  const oldImage = shirt.image;
  const res = await req(`/api/items/${shirt.id}`, { method: 'PATCH', form: itemForm({ brand: '유니클로', favorite: 'true' }, true) });
  assert.equal(res.status, 200);
  assert.equal(res.data.brand, '유니클로');
  assert.equal(res.data.favorite, true);
  assert.equal(res.data.name, '흰색 옥스포드 셔츠');
  assert.notEqual(res.data.image, oldImage);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, 'uploads', oldImage)), false);
  shirt = res.data;
});

test('AI 사진 분석은 이미지와 JSON 스키마를 함께 보낸다', async () => {
  responses.analyze = { name: '데님 자켓', category: 'outer', subcategory: '자켓', color: '블루', brand: '', seasons: ['봄'], tags: ['캐주얼'], notes: '' };
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'a.png');
  const res = await req('/api/ai/analyze', { method: 'POST', form: fd });
  assert.equal(res.status, 200);
  assert.equal(res.data.category, 'outer');
  const call = client.calls.at(-1);
  assert.equal(call.model, 'test-model');
  assert.equal(call.output_config.format.type, 'json_schema');
  assert.equal(call.messages[0].content[0].type, 'image');
  assert.equal(call.messages[0].content[0].source.media_type, 'image/png');
});

test('코디 추천은 옷장에 없는 id를 걸러낸다', async () => {
  responses.outfits = {
    outfits: [
      { title: '깔끔 출근룩', description: '...', item_ids: [shirt.id, pants.id, 'ghost-id'], tip: '' },
      { title: '없는 옷만', description: '', item_ids: ['ghost'], tip: '' },
    ],
    missing_note: '',
  };
  const res = await req('/api/ai/outfits', { method: 'POST', json: { occasion: '출근' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.outfits.length, 1);
  assert.deepEqual(res.data.outfits[0].item_ids, [shirt.id, pants.id]);
  const system = client.calls.at(-1).system;
  assert.ok(system[1].text.includes(shirt.id));
});

test('쇼핑 도우미와 쇼핑 리스트', async () => {
  responses.shopping = {
    verdict: 'skip',
    headline: '비슷한 셔츠가 있어요',
    detected: { name: '흰 셔츠', category: 'top', color: '화이트' },
    similar_items: [{ id: shirt.id, reason: '거의 같음' }, { id: 'nope', reason: '' }],
    pairs_with: [{ id: pants.id, reason: '잘 어울림' }],
    reasoning: '...',
  };
  assert.equal((await req('/api/ai/shopping', { method: 'POST', form: new FormData() })).status, 400);
  const fd = new FormData();
  fd.append('description', '흰 셔츠');
  const res = await req('/api/ai/shopping', { method: 'POST', form: fd });
  assert.equal(res.status, 200);
  assert.equal(res.data.similar_items.length, 1);

  responses.gaps = { summary: '...', suggestions: [{ item: '네이비 블레이저', category: 'outer', priority: 'high', reason: '...', pairs_with: [shirt.id, 'x'] }] };
  const gaps = await req('/api/ai/gaps', { method: 'POST', json: {} });
  assert.deepEqual(gaps.data.suggestions[0].pairs_with, [shirt.id]);
});

test('AI가 거절하면 알기 쉬운 오류를 돌려준다', async () => {
  const ai = createAi({
    client: { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } },
  });
  await assert.rejects(ai.wardrobeGaps([]), /처리할 수 없다/);
});

test('코디를 저장하고 삭제한다', async () => {
  const created = await req('/api/outfits', { method: 'POST', json: { title: '주말룩', item_ids: [shirt.id, 'ghost'] } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.item_ids, [shirt.id]);
  assert.equal((await req('/api/outfits')).data.length, 1);
  assert.equal((await req(`/api/outfits/${created.data.id}`, { method: 'DELETE' })).status, 204);
});

test('옷을 삭제하면 사진 파일도 지운다', async () => {
  assert.equal((await req(`/api/items/${shirt.id}`, { method: 'DELETE' })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, 'uploads', shirt.image)), false);
  assert.equal((await req(`/api/items/${shirt.id}`)).status, 404);
});

test('wardrobeToText는 빈 필드를 생략한다', () => {
  const text = wardrobeToText([{ id: 'a', name: '셔츠', category: 'top', color: '', seasons: [], tags: [] }]);
  assert.ok(text.includes('"id":"a"'));
  assert.ok(!text.includes('color'));
});
