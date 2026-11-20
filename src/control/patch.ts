/** Literal edits all refer to the approved original text, never to earlier replacement output. */
export interface LiteralEdit { oldText: string; newText: string }
export function applyLiteralEdits(content: string, edits: LiteralEdit[]): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('Expected 1–100 literal edits');
  const ranges = edits.map(edit => {
    if (!edit || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') throw new Error('Expected nonempty oldText and string newText');
    const start = content.indexOf(edit.oldText);
    if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0) throw new Error('Patch oldText must match exactly once; include more unchanged context');
    return { start, end: start + edit.oldText.length, text: edit.newText };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error('Patch edits overlap');
  for (const range of ranges.reverse()) content = content.slice(0, range.start) + range.text + content.slice(range.end);
  return content;
}
