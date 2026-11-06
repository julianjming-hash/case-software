// Unknown private paths never masquerade as an authorised collection.
import { mountSiteHeader } from './site-header.mjs';
import { homeUrl, casesUrl } from '../shared/urls.mjs';
export function mountUnavailable() {
 const main=document.querySelector('main');main.replaceChildren();main.className='view-unavailable';
 const heading=document.createElement('h1');heading.textContent='View unavailable';
 const copy=document.createElement('p');copy.textContent='This address does not identify an available Case page.';
 const links=document.createElement('div');links.className='row';
 for(const [label,url]of [['Join',homeUrl(location.origin)],['Present',casesUrl(location.origin)]]){const a=document.createElement('a');a.textContent=label;a.href=url;a.className='btn quiet';links.append(a);}
 main.append(heading,copy,links);mountSiteHeader(document.body,{context:'View unavailable'});
}
