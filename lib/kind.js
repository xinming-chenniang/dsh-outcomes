/**
 * 成果类型：按扩展名归类（不做内容嗅探 —— 判类型只影响图标与预览方式，
 * 猜错的代价远大于收益）。
 *
 * 七个类型是刻意的：它们在 UI 上的**可预览性**不同（html/pdf 页内预览、img 缩略图、
 * 其余下载），合并类型就等于丢掉这个区别。
 */

/** 扩展名 → 类型。未知扩展名一律 `other`。 */
const BY_EXTENSION = new Map(Object.entries({
  html: 'html', htm: 'html',
  pdf: 'pdf',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', bmp: 'img', svg: 'img', ico: 'img', avif: 'img',
  md: 'doc', markdown: 'doc', docx: 'doc', doc: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc',
  xlsx: 'data', xls: 'data', csv: 'data', tsv: 'data', ods: 'data', json: 'data', jsonl: 'data', parquet: 'data', sqlite: 'data', db: 'data',
}))

const OTHER_TEXT = new Set(['log', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sh', 'ps1', 'mjs', 'js', 'ts', 'py', 'sql', 'srt', 'vtt'])

/** 可预览性：`preview` ∈ inline | thumbnail | download —— 前端据此决定怎么展示。 */
const PREVIEW_OF_KIND = {
  html: 'inline',
  pdf: 'inline',
  img: 'thumbnail',
  doc: 'download',
  data: 'download',
  text: 'download',
  other: 'download',
}

/** @param {string} file 绝对或相对路径 @returns {'html'|'pdf'|'img'|'doc'|'data'|'text'|'other'} */
export function kindOf(file) {
  const name = String(file ?? '')
  const at = name.lastIndexOf('.')
  if (at === -1 || at === name.length - 1) return 'other'
  const ext = name.slice(at + 1).toLowerCase()
  return BY_EXTENSION.get(ext) ?? (OTHER_TEXT.has(ext) ? 'text' : 'other')
}

export function previewOf(kind) {
  return PREVIEW_OF_KIND[kind] ?? 'download'
}

/** 页面与 CLI 用的双语标签。key 与 `kindOf` 的返回值一一对应。 */
export const KIND_LABELS = {
  html: { en: 'Web page', zh: '网页' },
  pdf: { en: 'PDF', zh: 'PDF' },
  img: { en: 'Image', zh: '图片' },
  doc: { en: 'Document', zh: '文档' },
  data: { en: 'Data', zh: '数据表' },
  text: { en: 'Text', zh: '文本' },
  other: { en: 'File', zh: '文件' },
}

export const KINDS = Object.keys(KIND_LABELS)

/** 一句话标签，`lang` 缺省 en；未知类型回落到 other。 */
export function kindLabel(kind, lang = 'en') {
  const entry = KIND_LABELS[kind] ?? KIND_LABELS.other
  return entry[lang === 'zh' ? 'zh' : 'en']
}
