// Card 68 (SURFACE-05): one compact row for a record in a list, shared by History/Account and Administration. The row is one
// button named by its title; the distinguishing metadata (version, date, state, actor) sits on the same line and describes it.
import { node } from './auth-ui.mjs';
let ids = 0;
export function recordRow(title, meta, open) {
  const item = node('li'), row = node('button', null, 'record-row'), name = node('span', title, 'record-title'), note = node('span', meta, 'record-meta');
  row.type = 'button'; name.id = `record-title-${++ids}`; note.id = `record-meta-${ids}`;
  row.setAttribute('aria-labelledby', name.id); row.setAttribute('aria-describedby', note.id);
  row.append(name, note); row.onclick = open; item.append(row);
  return { item, row };
}
