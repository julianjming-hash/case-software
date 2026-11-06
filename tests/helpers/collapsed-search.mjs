// The user-approved search starts as an icon; preserve native typing and server filtering witnesses.
export async function fillSearch(page,name,value){const input=page.getByRole('searchbox',{name,exact:true});if(!await input.isVisible())await page.getByRole('button',{name,exact:true}).click();await input.fill(value);}
