/** Text-only anonymous closed-response labels shared by shipped and prototype displays. */
export function responseSummary(result) {
  const answered = result.total ? `${result.total} answered` : 'No one answered';
  const suffix = !result.total || result.type === 'free_text' ? ''
    : result.type === 'ranking' ? ' · counts by ranking position'
    : result.type === 'multi_select' ? ' · each person could select more than one' : '';
  return {
    heading: 'Responses closed', caption: answered + suffix,
    rows: result.type === 'free_text' ? [] : result.counts.map(row => ({ optionId: row.optionId, label: row.label, count: row.count,
      ...(result.type === 'ranking' ? { positions: row.positionCounts.map((count, index) => ({ rank: index + 1, count, words: `Rank ${index + 1}: ${count}` })) }
        : { words: result.type === 'multi_select' ? `selected by ${row.count}` : String(row.count) }) })),
  };
}
