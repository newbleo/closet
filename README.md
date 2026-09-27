# 👕 내 옷장 (Closet)

옷장에 있는 옷을 사진으로 찍어 올려 두고, **언제 어디서든 휴대폰으로 확인**하는 웹앱입니다.
Claude AI가 사진을 보고 옷 정보를 자동으로 채워 주고, 코디를 추천하고, 쇼핑할 때 "이 옷 살까?"를 판단해 줍니다.

## 주요 기능

| 탭 | 기능 |
|---|---|
| 👚 **옷장** | 상의·하의·아우터·원피스·신발·모자·양말·가방·악세서리·이너·기타로 분류해 사진 그리드로 보기, 카테고리 필터, 이름/색상/브랜드/태그 검색 |
| ＋ **추가** | 사진을 찍거나 고르면 **AI가 이름·카테고리·색상·계절·태그를 자동 입력**하고, 확인한 뒤 저장. 사진은 업로드 전에 1280px로 줄여서 용량을 아낌 |
| ✨ **코디** | 상황(출근, 데이트…)·날씨·스타일을 적으면 **내 옷장에 있는 옷만으로** 코디 세트를 추천. 마음에 드는 코디는 저장 |
| 🛍️ **쇼핑** | **이 옷 살까?** 매장에서 본 옷 사진을 올리면 이미 가진 비슷한 옷, 어울리는 내 옷, 살지 말지 판단(👍/🤔/✋)을 보여 줌<br>**무엇을 더 살까?** 옷장 전체를 분석해서 코디 가짓수를 늘려 줄 아이템을 우선순위대로 추천 |

- 휴대폰 홈 화면에 추가하면 앱처럼 쓸 수 있습니다 (PWA).
- 라이트/다크 모드를 지원합니다.
- `APP_PASSWORD`를 설정하면 비밀번호로 로그인해야 옷장을 볼 수 있습니다.

## 로컬에서 실행하기

Node.js 22.13 이상이 필요합니다.

```bash
npm install
cp .env.example .env        # ANTHROPIC_API_KEY, APP_PASSWORD 입력
node --env-file=.env --disable-warning=ExperimentalWarning src/index.js
# 또는 환경변수를 직접 넣고: npm start
```

브라우저에서 http://localhost:3000 을 엽니다.
같은 와이파이에 연결된 휴대폰에서는 `http://<컴퓨터 IP>:3000`으로 접속할 수 있습니다.

### 환경변수

| 이름 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com)에서 발급한 API 키. 없으면 AI 기능만 꺼지고 옷장 기능은 그대로 동작 |
| `APP_PASSWORD` | 로그인 비밀번호. **인터넷에 공개할 때는 꼭 설정하세요** |
| `SESSION_SECRET` | 로그인 쿠키 서명용 임의 문자열 (선택) |
| `DATA_DIR` | DB(`closet.db`)와 사진(`uploads/`)을 저장할 폴더. 기본 `./data` |
| `PORT` | 기본 3000 |
| `CLOSET_MODEL` | 사용할 Claude 모델. 기본 `claude-opus-5` |
| `TRUST_PROXY` | 리버스 프록시(HTTPS) 뒤에서 실행할 때 `1` |

## 어디서든 접속하도록 배포하기

모든 데이터는 `DATA_DIR` 한 폴더에 들어가므로, **디스크(볼륨)가 유지되는 곳**에 배포하면 됩니다.

### Docker

```bash
docker build -t closet .
docker run -d -p 3000:3000 -v closet-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=원하는비밀번호 closet
```

### Railway / Fly.io / Render 등

1. 이 저장소를 연결하면 `Dockerfile`로 자동 빌드됩니다.
2. 영구 볼륨을 만들어 `/data`에 마운트합니다. (볼륨이 없으면 재배포할 때 사진이 사라집니다.)
3. 환경변수 `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `TRUST_PROXY=1`을 설정합니다.
4. 발급된 HTTPS 주소를 휴대폰에서 열고 **홈 화면에 추가**하세요.

### 백업

`DATA_DIR` 폴더(`closet.db` + `uploads/`)만 복사해 두면 됩니다.

## 구조

```
src/
  index.js      서버 시작 (환경변수 읽기)
  server.js     Express API + 로그인 + 사진 업로드
  db.js         SQLite 저장소 (node:sqlite, 별도 설치 불필요)
  ai.js         Claude API 호출 (사진 분석, 코디 추천, 쇼핑 판단, 쇼핑 리스트)
  constants.js  카테고리/계절 목록
public/         프론트엔드 (빌드 과정 없는 HTML/CSS/JS)
test/           API 테스트 (AI는 가짜 클라이언트로 대체)
```

- AI 응답은 JSON 스키마(structured outputs)로 받고, AI가 옷장에 없는 아이템 id를 말하면 서버에서 걸러냅니다.
- 옷장 목록은 텍스트로만 보내고(사진은 보내지 않음), 캐시해서 비용을 줄입니다.
- 카테고리를 바꾸려면 `src/constants.js`를 수정하세요.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/items?category=&q=` | 옷 목록 |
| `POST` / `PATCH` / `DELETE` | `/api/items[/:id]` | 옷 추가(멀티파트, `image` 필드)/수정/삭제 |
| `GET` | `/api/meta` | 카테고리와 카테고리별 개수 |
| `POST` | `/api/ai/analyze` | 사진 → 옷 정보 |
| `POST` | `/api/ai/outfits` | `{occasion, weather, style}` → 코디 추천 |
| `POST` | `/api/ai/shopping` | 사진/설명 → 살지 말지 판단 |
| `POST` | `/api/ai/gaps` | `{focus}` → 쇼핑 리스트 |
| `GET` / `POST` / `DELETE` | `/api/outfits[/:id]` | 저장한 코디 |

## 테스트

```bash
npm test
```
