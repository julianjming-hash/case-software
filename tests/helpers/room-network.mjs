// Playwright network control: real sockets and HTTP are cut; only a missing browser lifecycle hint is emulated.
import { socketNetwork } from './socket-network.mjs';
export async function roomNetwork(context) {
  const sockets=socketNetwork();
  await context.addInitScript(()=>{window.__caseOfflineEvents=0;window.__caseOnlineEvents=0;addEventListener('offline',()=>window.__caseOfflineEvents++);addEventListener('online',()=>window.__caseOnlineEvents++);});
  await context.routeWebSocket(url=>new URL(url).pathname.endsWith('/ws'),socket=>sockets.route(socket));
  await context.route('**/api/v1/**',async route=>{
    const generation=sockets.generation;
    const cut=()=>sockets.offline||sockets.generation!==generation;
    const closed=()=>{try{return route.request().frame().page().isClosed()}catch{return context.pages().length===0}};
    if(cut()){await route.abort('failed');return;}
    try {
      const response=await route.fetch();
      if(cut()){await route.abort('failed');return;}
      await route.fulfill({response});
    } catch(error) {
      if(cut()||closed()){await route.abort('failed').catch(()=>{});return;}
      throw error;
    }
  });
  return {
    async offline(page) {
      const before=await page.evaluate(()=>window.__caseOfflineEvents);
      await sockets.setOffline(true);
      await context.setOffline(true);
      const after=await page.evaluate(()=>({events:window.__caseOfflineEvents,online:navigator.onLine}));
      if(after.online!==false)throw new Error('Browser context did not enter offline mode');
      if(after.events===before)await page.evaluate(()=>dispatchEvent(new Event('offline')));
    },
    async online() {
      const pages=context.pages().filter(page=>!page.isClosed());
      const before=await Promise.all(pages.map(page=>page.evaluate(()=>window.__caseOnlineEvents??0)));
      await sockets.setOffline(false);await context.setOffline(false);
      for(const [i,page]of pages.entries())if(!page.isClosed()){
        const count=await page.evaluate(()=>window.__caseOnlineEvents??0);
        if(count===before[i])await page.evaluate(()=>dispatchEvent(new Event('online')));
      }
    },
  };
}
