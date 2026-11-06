// Fresh public decisions and explicitly attributed legacy witnesses use distinct namespaces.
export function checkDecisionIndex(text,{prefix='PUB',contiguous=true}={}) {
 const errors=[],seen=new Set();
 const rows=text.split('\n').filter(line=>/^\| (?:PUB|CASE)-/.test(line));
 if(!rows.length)errors.push('Decision index must not be empty');
 rows.forEach((row,i)=>{
  const cells=row.split('|').slice(1,-1).map(x=>x.trim());
  if(!new RegExp('^'+prefix+'-\\d{3}$').test(cells[0]))errors.push('Wrong decision namespace');
  if(contiguous&&cells[0]!==prefix+'-'+String(i+1).padStart(3,'0'))errors.push('Decisions must be append-only and contiguous');
  if(seen.has(cells[0]))errors.push('Duplicate decision ID');seen.add(cells[0]);
  if(cells.length!==4||!/^\d{4}-\d{2}-\d{2}$/.test(cells[1])||!cells[2]||!cells[3])errors.push('Decision needs ID, date, decision and rationale');
 });
 return errors;
}
