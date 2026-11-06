/** Blank modern content shared by new-case and in-editor insertion. IDs come from the caller's UUIDv7 factory. */
export function blankSlide(owner, createId, decisionId = null) {
  const title = { id: createId(), type: 'text', paragraphs: [{ style: 'h1', runs: [{ text: '' }] }] };
  const body = { id: createId(), type: 'text', paragraphs: [{ style: 'p', runs: [{ text: '' }] }] };
  const question = decisionId ? { id: createId(), type: 'question', decision_id: decisionId } : null;
  const blocks = [title, body, ...(question ? [question] : [])];
  const placements = [{ block_id: title.id, col: 1, row: 1, w: 12, h: 2 },
    { block_id: body.id, col: 1, row: 3, w: question ? 7 : 12, h: 10 },
    ...(question ? [{ block_id: question.id, col: 8, row: 3, w: 5, h: 10 }] : [])];
  const ids = blocks.map(block => block.id);
  return { blocks, compositions: [{ id: createId(), owner: typeof owner === 'string' ? { kind: 'beat', id: owner } : { ...owner },
    template: question ? 'columns' : 'title_text', placements, reading_order: ids, steps: [{ id: createId(), block_ids: [...ids] }], styles: [] }] };
}
