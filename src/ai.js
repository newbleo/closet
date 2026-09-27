import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES, CATEGORY_IDS, SEASONS } from './constants.js';

export const DEFAULT_MODEL = process.env.CLOSET_MODEL || 'claude-opus-5';

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const CATEGORY_GUIDE = CATEGORIES.map((c) => `${c.id}=${c.label}`).join(', ');

const BASE_SYSTEM = `당신은 사용자의 개인 옷장을 관리해 주는 패션 스타일리스트입니다.
모든 답변은 자연스러운 한국어로 작성하세요.
카테고리 코드: ${CATEGORY_GUIDE}.
옷장 아이템을 언급할 때는 반드시 옷장 목록에 실제로 있는 id만 사용하고, 없는 아이템을 지어내지 마세요.`;

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const ITEM_SCHEMA = obj({
  name: str,
  category: { type: 'string', enum: CATEGORY_IDS },
  subcategory: str,
  color: str,
  brand: str,
  seasons: { type: 'array', items: { type: 'string', enum: SEASONS } },
  tags: strArr,
  notes: str,
});

const OUTFITS_SCHEMA = obj({
  outfits: {
    type: 'array',
    items: obj({ title: str, description: str, item_ids: strArr, tip: str }),
  },
  missing_note: str,
});

const REF = { type: 'array', items: obj({ id: str, reason: str }) };

const SHOPPING_SCHEMA = obj({
  verdict: { type: 'string', enum: ['buy', 'consider', 'skip'] },
  headline: str,
  detected: obj({ name: str, category: { type: 'string', enum: CATEGORY_IDS }, color: str }),
  similar_items: REF,
  pairs_with: REF,
  reasoning: str,
});

const GAPS_SCHEMA = obj({
  summary: str,
  suggestions: {
    type: 'array',
    items: obj({
      item: str,
      category: { type: 'string', enum: CATEGORY_IDS },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: str,
      pairs_with: strArr,
    }),
  },
});

// 옷장 목록을 AI에게 전달할 간결한 텍스트로 변환한다. (이미지는 비용 때문에 보내지 않음)
export function wardrobeToText(items) {
  if (!items.length) return '옷장 목록: (비어 있음)';
  const lines = items.map((i) =>
    JSON.stringify({
      id: i.id,
      name: i.name,
      category: i.category,
      subcategory: i.subcategory || undefined,
      color: i.color || undefined,
      brand: i.brand || undefined,
      seasons: i.seasons?.length ? i.seasons : undefined,
      tags: i.tags?.length ? i.tags : undefined,
      notes: i.notes || undefined,
    }),
  );
  return `옷장 목록 (${items.length}개, JSON Lines):\n${lines.join('\n')}`;
}

function imageBlock(image) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.buffer.toString('base64') },
  };
}

export function createAi({ client, model = DEFAULT_MODEL } = {}) {
  let anthropic = client;
  const getClient = () => {
    if (!anthropic) {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new AiError('AI 기능을 쓰려면 서버에 ANTHROPIC_API_KEY 환경변수를 설정하세요.', 503);
      }
      anthropic = new Anthropic();
    }
    return anthropic;
  };

  async function callJson({ system, content, schema, effort = 'high' }) {
    let response;
    try {
      response = await getClient().beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content }],
      });
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AiError('Anthropic API 키가 올바르지 않습니다.', 503);
      if (err instanceof Anthropic.RateLimitError) throw new AiError('AI 요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
      if (err instanceof Anthropic.BadRequestError) throw new AiError(`AI 요청 오류: ${err.message}`, 400);
      if (err instanceof Anthropic.APIError) throw new AiError(`AI 서버 오류 (${err.status ?? '연결 실패'})`);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new AiError('AI가 이 요청을 처리할 수 없다고 답했습니다.', 422);
    if (response.stop_reason === 'max_tokens') throw new AiError('AI 응답이 너무 길어 잘렸습니다. 다시 시도해 주세요.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.');
    }
  }

  // 옷장 목록은 요청 간 동일하므로 캐시 가능한 system 블록에 둔다.
  const systemWith = (items) => [
    { type: 'text', text: BASE_SYSTEM },
    { type: 'text', text: wardrobeToText(items), cache_control: { type: 'ephemeral' } },
  ];

  const onlyKnownIds = (ids, items) => {
    const known = new Set(items.map((i) => i.id));
    return ids.filter((id) => known.has(id));
  };

  return {
    // 사진 한 장을 보고 옷 정보를 자동으로 채운다.
    async analyzeItem(image) {
      return callJson({
        system: BASE_SYSTEM,
        effort: 'medium',
        schema: ITEM_SCHEMA,
        content: [
          imageBlock(image),
          {
            type: 'text',
            text: `사진 속 옷(또는 패션 소품) 하나를 옷장에 등록하려고 합니다. 가장 눈에 띄는 한 아이템을 기준으로 정보를 채워 주세요.
- name: "네이비 울 니트 스웨터"처럼 색상+소재/특징+종류로 짧게
- subcategory: 세부 종류 (예: 셔츠, 슬랙스, 스니커즈, 비니)
- color: 주된 색상 (한국어)
- brand: 로고/라벨로 확실히 보이는 경우만, 아니면 빈 문자열
- seasons: 착용하기 좋은 계절
- tags: 스타일/소재/핏 키워드 3~6개 (예: 캐주얼, 미니멀, 오버핏, 린넨)
- notes: 코디 팁이나 특징 한 문장`,
          },
        ],
      });
    },

    async recommendOutfits(items, { occasion = '', weather = '', style = '', count = 3 } = {}) {
      const result = await callJson({
        system: systemWith(items),
        schema: OUTFITS_SCHEMA,
        content: `옷장 아이템만으로 코디 세트 ${count}개를 추천해 주세요.
상황: ${occasion || '일상'}
날씨/계절: ${weather || '특별히 지정 없음'}
원하는 스타일: ${style || '자유'}

규칙:
- 각 코디는 item_ids에 옷장 아이템 id를 2개 이상 넣습니다 (상의+하의 또는 원피스가 기본, 어울리면 아우터/신발/모자/가방/악세서리 추가).
- title은 코디 이름, description은 왜 어울리는지 2~3문장, tip은 착용 팁 한 문장.
- 옷장에 부족해서 좋은 코디가 어렵다면 missing_note에 무엇이 있으면 좋을지 적고, 아니면 빈 문자열.`,
      });
      result.outfits = result.outfits
        .map((o) => ({ ...o, item_ids: onlyKnownIds(o.item_ids, items) }))
        .filter((o) => o.item_ids.length > 0);
      return result;
    },

    // 매장에서 본 옷을 살지 말지 옷장과 비교해 판단한다.
    async shoppingCheck(items, { image, description = '' }) {
      const content = [];
      if (image) content.push(imageBlock(image));
      content.push({
        type: 'text',
        text: `지금 쇼핑 중인데 ${image ? '사진 속 옷' : '아래 설명의 옷'}을 살지 고민 중입니다.
${description ? `설명/메모: ${description}\n` : ''}
내 옷장과 비교해서 알려 주세요.
- detected: 이 옷이 무엇인지 (name, category, color)
- similar_items: 이미 가진 비슷한 옷 (id + 얼마나 비슷한지)
- pairs_with: 이 옷과 잘 어울릴 내 옷 (id + 이유), 최대 6개
- verdict: buy(옷장에 없는 역할이고 활용도가 높음) / consider(애매함) / skip(거의 같은 옷이 이미 있음)
- headline: 한 줄 결론, reasoning: 3~4문장 근거`,
      });
      const result = await callJson({ system: systemWith(items), schema: SHOPPING_SCHEMA, content });
      const known = new Set(items.map((i) => i.id));
      result.similar_items = result.similar_items.filter((r) => known.has(r.id));
      result.pairs_with = result.pairs_with.filter((r) => known.has(r.id));
      return result;
    },

    // 옷장 전체를 보고 무엇을 더 사면 좋을지 제안한다.
    async wardrobeGaps(items, { focus = '' } = {}) {
      const result = await callJson({
        system: systemWith(items),
        schema: GAPS_SCHEMA,
        content: `내 옷장을 분석해서 앞으로 사면 좋을 아이템을 우선순위대로 5~8개 제안해 주세요.
${focus ? `특히 고려할 점: ${focus}\n` : ''}
- 이미 비슷한 옷이 있는 아이템은 제안하지 마세요.
- 기존 옷과 조합했을 때 코디 가짓수가 크게 늘어나는 아이템을 우선하세요.
- pairs_with에는 함께 입기 좋은 기존 옷장 아이템 id를 넣으세요.
- summary는 현재 옷장의 특징과 부족한 점을 2~3문장으로.`,
      });
      result.suggestions = result.suggestions.map((s) => ({ ...s, pairs_with: onlyKnownIds(s.pairs_with, items) }));
      return result;
    },
  };
}
