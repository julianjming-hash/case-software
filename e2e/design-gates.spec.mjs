// Card 17: actual Chromium system colours and composited disabled text (CASE-125).
import { test,expect,joinPhone,startCase } from '../tests/playwright-harness.mjs';
import { contrast } from '../tests/helpers/design-gates.mjs';

test('[CASE-125] forced colours preserve labels, icons and keyboard focus on all three room surfaces',async({lab})=>{
  await lab.page.emulateMedia({forcedColors:'active'});
  await joinPhone(lab,'A','Alex');await startCase(lab);
  for(const [role,frame]of [['console',lab.facilitator],['projector',lab.display],['phone',lab.phone('A')]]){
    await expect(frame.locator('h1').first()).toBeVisible();
    const target=frame.locator('button:not(:disabled):visible,a[href]:visible,input:not(:disabled):visible,[tabindex="0"]:visible').first();
    await target.focus();await lab.page.keyboard.press('Shift+Tab');await lab.page.keyboard.press('Tab');
    const evidence=await frame.evaluate(()=>{
      const visible=el=>Boolean(el.getClientRects().length)&&getComputedStyle(el).visibility==='visible';
      const background=el=>{for(let p=el;p;p=p.parentElement){const bg=getComputedStyle(p).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)'&&bg!=='transparent')return bg;}return 'rgb(255, 255, 255)';};
      const labels=[...document.querySelectorAll('h1,.btn,.pill')].filter(visible).map(el=>({text:el.textContent.trim(),adjust:getComputedStyle(el).forcedColorAdjust,color:getComputedStyle(el).color,background:background(el)}));
      const icons=[...document.querySelectorAll('svg')].filter(visible).map(el=>{const painted=[el,...el.querySelectorAll('path,circle,rect,line,polyline,polygon')].find(n=>getComputedStyle(n).stroke!=='none'||getComputedStyle(n).fill!=='none');const s=painted?getComputedStyle(painted):null;return{paint:s?(s.stroke!=='none'?s.stroke:s.fill):'none',background:background(el)};});
      const control=[...document.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].find(visible);
      if(control){const s=getComputedStyle(control);return{labels,icons,focus:{active:document.activeElement===control,style:s.outlineStyle,width:parseFloat(s.outlineWidth),color:s.outlineColor,background:background(control.parentElement)}};}
      return{labels,icons,focus:null};
    });
    const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255);
    expect(evidence.labels.length,role).toBeGreaterThan(0);
    for(const label of evidence.labels){expect(label.text,role).not.toBe('');expect(label.adjust,`${role} ${label.text}: system colours`).toBe('auto');expect(contrast(rgb(label.color),rgb(label.background)),`${role} ${label.text}`).toBeGreaterThanOrEqual(4.5);}
    expect(evidence.icons.length,role).toBeGreaterThan(0);
    for(const icon of evidence.icons){expect(icon.paint,role).not.toBe('none');expect(contrast(rgb(icon.paint),rgb(icon.background)),`${role} icon`).toBeGreaterThanOrEqual(3);}
    expect(evidence.focus,role).not.toBeNull();expect(evidence.focus.active,role).toBe(true);expect(evidence.focus.style,role).not.toBe('none');expect(evidence.focus.width,role).toBeGreaterThanOrEqual(2);expect(contrast(rgb(evidence.focus.color),rgb(evidence.focus.background)),`${role} focus`).toBeGreaterThanOrEqual(3);
  }
});

test('[CASE-125] rendered disabled button variants meet 4.5 in light and dark on all three room surfaces',async({lab})=>{
  for(const colorScheme of ['light','dark']){
    await lab.page.emulateMedia({colorScheme});
    for(const [role,frame]of [['console',lab.facilitator],['projector',lab.display],['phone',lab.phone('A')]]){
      const measurements=await frame.evaluate(()=>{
        const panel=document.createElement('div');panel.className='card';document.body.append(panel);
        const rows=[];
        for(const cls of ['btn','btn primary','btn tertiary','btn danger']){
          const button=document.createElement('button');button.className=cls;button.disabled=true;button.textContent='Unavailable';panel.append(button);
          const b=getComputedStyle(button),p=getComputedStyle(panel);const rgb=v=>v.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255);
          rows.push({cls,foreground:rgb(b.color),background:rgb(b.backgroundColor),parent:rgb(p.backgroundColor),opacity:Number(b.opacity)});
        }
        panel.remove();return rows;
      });
      for(const m of measurements){const blend=v=>v.map((n,i)=>n*m.opacity+m.parent[i]*(1-m.opacity));expect(contrast(blend(m.foreground),blend(m.background)),`${role} ${colorScheme} ${m.cls}`).toBeGreaterThanOrEqual(4.5);}
    }
  }
});
