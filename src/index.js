import fs from 'node:fs';
import path from 'node:path';
import { createAi } from './ai.js';
import { openDb } from './db.js';
import { createApp } from './server.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

const store = openDb(path.join(dataDir, 'closet.db'));
const app = createApp({
  store,
  ai: createAi(),
  uploadDir: path.join(dataDir, 'uploads'),
  password: process.env.APP_PASSWORD || '',
  secret: process.env.SESSION_SECRET || '',
});

if (process.env.TRUST_PROXY) app.set('trust proxy', true);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`👕 내 옷장 서버 실행 중: http://localhost:${port}`);
  if (!process.env.APP_PASSWORD) console.warn('⚠️  APP_PASSWORD가 없어 누구나 접속할 수 있습니다. 인터넷에 공개할 때는 꼭 설정하세요.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY가 없어 AI 기능이 꺼져 있습니다.');
});
