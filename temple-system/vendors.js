// 陣頭廠商專區：範例資料（正式版由雲端平台提供、譽昇審核認證）
// 名稱皆為虛構範例，不對應任何真實團體。

const VENDOR_TYPES = ['八家將', '官將首', '宋江陣', '舞龍舞獅', '電音三太子', '神將', '跳鼓陣', '北管', '鼓陣', '花車'];
const VENDOR_REGIONS = ['彰化', '雲林', '嘉義', '台南', '高雄', '屏東', '台中'];

const SAMPLE_VENDORS = [
  { id: 'V001', name: '（範例）溪洲聖武八家將', type: '八家將', region: '彰化', rating: 4.8, reviews: 36, min: 18000, max: 32000, certified: true, size: '12～16 人', note: '可配合遶境整日', since: 1998 },
  { id: 'V002', name: '（範例）南瀛官將首', type: '官將首', region: '台南', rating: 4.6, reviews: 22, min: 15000, max: 26000, certified: true, size: '6～10 人', note: '有開臉老師', since: 2005 },
  { id: 'V003', name: '（範例）鹿野宋江陣', type: '宋江陣', region: '高雄', rating: 4.9, reviews: 41, min: 30000, max: 55000, certified: true, size: '36～72 人', note: '72 人大陣需提前 2 個月預約', since: 1985 },
  { id: 'V004', name: '（範例）福興龍鳳獅', type: '舞龍舞獅', region: '彰化', rating: 4.4, reviews: 18, min: 12000, max: 24000, certified: true, size: '10～20 人', note: '含高樁獅', since: 2010 },
  { id: 'V005', name: '（範例）嘉義炫光三太子', type: '電音三太子', region: '嘉義', rating: 4.2, reviews: 27, min: 8000, max: 16000, certified: false, size: '3～6 尊', note: '含音響車', since: 2012 },
  { id: 'V006', name: '（範例）北港威靈神將會', type: '神將', region: '雲林', rating: 4.7, reviews: 15, min: 10000, max: 20000, certified: true, size: '4～8 尊', note: '千里眼順風耳', since: 1992 },
  { id: 'V007', name: '（範例）屏東和樂跳鼓陣', type: '跳鼓陣', region: '屏東', rating: 4.5, reviews: 12, min: 9000, max: 15000, certified: false, size: '12 人', note: '', since: 2001 },
  { id: 'V008', name: '（範例）員林正音北管', type: '北管', region: '彰化', rating: 4.9, reviews: 29, min: 6000, max: 12000, certified: true, size: '8～12 人', note: '可配合法會科儀', since: 1978 },
  { id: 'V009', name: '（範例）台中雷霆鼓陣', type: '鼓陣', region: '台中', rating: 4.3, reviews: 9, min: 8000, max: 14000, certified: false, size: '10～15 人', note: '', since: 2015 },
  { id: 'V010', name: '（範例）麻豆聖義八家將', type: '八家將', region: '台南', rating: 4.6, reviews: 31, min: 16000, max: 30000, certified: true, size: '12～18 人', note: '', since: 1995 },
  { id: 'V011', name: '（範例）旗山金獅陣', type: '舞龍舞獅', region: '高雄', rating: 3.9, reviews: 7, min: 10000, max: 18000, certified: false, size: '10 人', note: '', since: 2018 },
  { id: 'V012', name: '（範例）西螺花車藝陣', type: '花車', region: '雲林', rating: 4.1, reviews: 11, min: 12000, max: 28000, certified: true, size: '1～3 台', note: 'LED 花車', since: 2008 },
];

// 防外流：把用戶編號藏成零寬字元（複製文字時一起帶走）
function zwEncode(text) {
  const bits = [...new TextEncoder().encode(String(text))].map(b => b.toString(2).padStart(8, '0')).join('');
  return '⁣' + [...bits].map(b => (b === '1' ? '‌' : '​')).join('') + '⁣';
}
function zwDecode(s) {
  const m = String(s).match(/⁣([​‌]+)⁣/);
  if (!m) return null;
  const bits = [...m[1]].map(c => (c === '‌' ? '1' : '0')).join('');
  const bytes = bits.match(/.{8}/g).map(b => parseInt(b, 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// 浮水印圖樣：明顯的斜向文字＋極淡的用戶編號（調高對比才看得到）
function watermarkCSS(label, id) {
  const svg = (txt, op, size, w, h) => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><text x='0' y='${h / 2}' transform='rotate(-24 ${w / 2} ${h / 2})' font-size='${size}' font-family='sans-serif' fill='rgb(140,30,22)' fill-opacity='${op}'>${txt.replace(/[&<>]/g, '')}</text></svg>`)}")`;
  return `${svg(label, 0.22, 15, 420, 200)}, ${svg('#' + id + ' #' + id + ' #' + id, 0.05, 11, 260, 90)}`;
}
