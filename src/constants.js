// 옷장 카테고리. id는 DB에 저장되는 값이고 label은 화면에 보이는 이름이다.
export const CATEGORIES = [
  { id: 'top', label: '상의', emoji: '👕' },
  { id: 'bottom', label: '하의', emoji: '👖' },
  { id: 'outer', label: '아우터', emoji: '🧥' },
  { id: 'dress', label: '원피스/세트', emoji: '👗' },
  { id: 'shoes', label: '신발', emoji: '👟' },
  { id: 'hat', label: '모자', emoji: '🧢' },
  { id: 'socks', label: '양말', emoji: '🧦' },
  { id: 'bag', label: '가방', emoji: '👜' },
  { id: 'accessory', label: '악세서리', emoji: '💍' },
  { id: 'underwear', label: '이너/속옷', emoji: '🩲' },
  { id: 'etc', label: '기타', emoji: '📦' },
];

export const SEASONS = ['봄', '여름', '가을', '겨울'];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
