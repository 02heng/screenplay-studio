export interface DetectedChapter {
  index: number;
  title: string;
  startOffset: number;
  endOffset: number;
  charCount: number;
  preview: string;
}

const CHAPTER_PATTERNS: RegExp[] = [
  /^第[零一二三四五六七八九十百千\d]+[章节回篇卷幕]\s*.*/,
  /^Chapter\s+\d+/i,
  /^卷[零一二三四五六七八九十百千\d]+\s*.*/,
  /^序[章幕篇]?\s*[:：]?\s*.*/,
  /^尾声\s*[:：]?\s*.*/,
  /^楔子\s*[:：]?\s*.*/,
  /^引子\s*[:：]?\s*.*/,
  /^番外\s*[:：]?\s*.*/,
  /^(?:前言|后记|附录)\s*[:：]?\s*.*/,
];

const NUMERIC_TITLE = /^\d{1,4}[.、\s]\s*.+/;

function isChapterHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (CHAPTER_PATTERNS.some((re) => re.test(trimmed))) return true;
  if (NUMERIC_TITLE.test(trimmed) && trimmed.length < 40) return true;
  return false;
}

export function detectChapters(text: string): DetectedChapter[] {
  const lines = text.split(/\r?\n/);
  const headings: { lineIdx: number; title: string; offset: number }[] = [];

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isChapterHeading(line)) {
      headings.push({ lineIdx: i, title: line.trim(), offset });
    }
    offset += line.length + 1;
  }

  if (headings.length < 2) return [];

  const chapters: DetectedChapter[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const startOffset = h.offset;
    const endOffset = i + 1 < headings.length ? headings[i + 1].offset : text.length;
    const body = text.slice(startOffset, endOffset);
    const charCount = body.replace(/\s/g, '').length;
    const bodyLines = body.split(/\r?\n/).slice(1);
    const previewText = bodyLines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');

    chapters.push({
      index: i,
      title: h.title,
      startOffset,
      endOffset,
      charCount,
      preview: previewText.slice(0, 120) + (previewText.length > 120 ? '…' : ''),
    });
  }

  return chapters;
}

export function extractChapterText(fullText: string, chapter: DetectedChapter): string {
  return fullText.slice(chapter.startOffset, chapter.endOffset).trim();
}
