// Actual browser PCM delivery/gesture/lifecycle proof on the built local Worker. No listening claim.
import { test, expect } from '@playwright/test';
import { readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homeUrl, sessionUrl, displayPairUrl, apiUrl } from '../src/shared/urls.mjs';
import {initialState,project} from '../src/shared/room-machine.mjs';
import { uuidv7 } from '../src/shared/ids.mjs';
let worker,helper;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  helper = await import('../tests/helpers/local-worker.mjs');
  worker = await helper.startLocalWorker();
});
test.afterAll(async () => { await worker?.stop(); });
const asset = name => `${worker.origin}/assets/${readdirSync(`${worker.assetDir}/assets`).find(file => file.startsWith(`${name}.`) && file.endsWith('.mjs'))}`;
function record(name, data) { if (process.env.CASE_AUDIO_EVIDENCE) { mkdirSync(process.env.CASE_AUDIO_EVIDENCE,{recursive:true});writeFileSync(`${process.env.CASE_AUDIO_EVIDENCE}/${name}.json`,JSON.stringify(data,null,2)); } }
const evidence = page => page.evaluate(() => __audioEvidence);
// CASE-334: the shipped round8 library; durations come from its manifest, never a copy in this spec.
const library = JSON.parse(readFileSync(new URL('../public/audio/room-music/manifest.json', import.meta.url), 'utf8'));
const bed = kind => ({ loop: true, duration: library.tracks.find(t => t.kind === kind).loopS, mp3: true, channels: 2 });
const theme = id => library.tracks.find(t => t.id === id);
const T_OPEN = Date.now();
const decisionView = (trackId = 'atlas-current') => ({ phase: 'decision_open', decision: { decisionId: '01900000-0000-7000-8000-000000000001', status: 'open' },
  timer: null, music: { choice: trackId, intensity: 70, playing: true, volume: 60, effects: true, transport: { trackId, draw: 0, tier: 0, atMs: T_OPEN, originMs: T_OPEN } } });
// decodeAudioData resamples PCM to the native context clock (Web Audio §1.1.2).
// Keep raw duration and frame counts; only the resampler's single-frame quantization is allowed.
function expectPcmStarts(starts, expected, sampleRate, channels = 1) {
  expect(starts).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const actual = starts[i], wanted = expected[i];
    expect(actual.loop).toBe(wanted.loop); expect(actual.channels).toBe(wanted.channels ?? channels);
    expect(Number.isInteger(actual.sampleRate) && actual.sampleRate > 0).toBe(true);
    if (sampleRate) expect(actual.sampleRate).toBe(sampleRate);
    expect(Number.isInteger(actual.frames)).toBe(true);
    // MP3 (CASE-334) decodes within two frames of the manifest duration at either context rate (round8 codec evidence).
    const frames = wanted.duration * actual.sampleRate, slack = wanted.mp3 ? 2 : 1;
    expect(actual.frames).toBeGreaterThanOrEqual(Math.floor(frames) - slack);
    expect(actual.frames).toBeLessThanOrEqual(Math.ceil(frames) + (wanted.mp3 ? slack : 0));
    expect(actual.duration).toBe(actual.frames / actual.sampleRate);
  }
}

async function fixture(browser, { failResume = false, holdDecode = false, width = 1280, theme = 'light', sampleRate } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'no-preference', colorScheme:theme, viewport: {width,height:720} });
  const page = await context.newPage();
  await page.addInitScript(({ failResume, holdDecode, sampleRate }) => {
    window.__audioEvidence = { fetched: [], starts: [], stopped: 0, disconnected: 0, decoded: [], sampleGains: [], ramps: [], tones: 0 };
    const Native = AudioContext, nativeFetch = fetch;
    window.fetch = (url, ...args) => { if (/\.(wav|mp3)$/.test(String(url))) __audioEvidence.fetched.push(String(url).split('/').at(-1)); return nativeFetch(url, ...args); };
    window.AudioContext = failResume ? class { constructor() { throw Error('private cue / participant name'); } } : class extends Native {
      constructor(options) { super(sampleRate ? {...options,sampleRate} : options); }
      async decodeAudioData(...args) { const buffer = await super.decodeAudioData(...args); __audioEvidence.decoded.push({duration:buffer.duration,sampleRate:buffer.sampleRate,channels:buffer.numberOfChannels,bytes:buffer.length*buffer.numberOfChannels*4}); if(holdDecode) await new Promise(resolve=>{window.__releaseAudioDecode=resolve;}); return buffer; }
      createGain() { const gain=super.createGain(),ramp=gain.gain.linearRampToValueAtTime.bind(gain.gain);gain.gain.linearRampToValueAtTime=(value,...args)=>{__audioEvidence.ramps.push(value);return ramp(value,...args);};return gain; }
      createOscillator() { const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator);oscillator.start=(...args)=>{__audioEvidence.tones++;return start(...args);};return oscillator; }
      createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source), stop = source.stop.bind(source), disconnect = source.disconnect.bind(source),connect=source.connect.bind(source);let sourceGain;source.connect=(target,...args)=>{sourceGain=target.gain;return connect(target,...args);};
        source.start = (...args) => { __audioEvidence.sampleGains.push(sourceGain?.value);__audioEvidence.starts.push({loop:source.loop,duration:source.buffer.duration,sampleRate:source.buffer.sampleRate,frames:source.buffer.length,channels:source.buffer.numberOfChannels}); return start(...args); };
        source.stop = (...args) => { __audioEvidence.stopped++; return stop(...args); };
        source.disconnect = (...args) => { __audioEvidence.disconnected++; return disconnect(...args); }; return source; }
    };
  }, { failResume, holdDecode, sampleRate });
  await page.goto(homeUrl(worker.origin));
  await page.getByRole('textbox',{name:'Session code',exact:true}).waitFor();
  await page.evaluate(async url => {
    const { createProjectorSound } = await import(url);
    window.__publicAudioView = {phase:'waiting'};
    document.body.classList.add('projector');
    const main = document.querySelector('main'); main.replaceChildren();
    window.__audioFixture = createProjectorSound({getView:()=>__publicAudioView});
    main.append(__audioFixture.element); __audioFixture.update(__publicAudioView);
  }, asset('projector-sound'));
  return { context, page };
}
async function publish(page, view, baseline = false) { await page.evaluate(({view,baseline})=>{__publicAudioView=view;__audioFixture.update(view,{baseline});},{view,baseline}); }

test('[AS-120] current lobby starts after deliberate gain+local gesture; identical beds continue; End stops all sources',async({browser})=>{
  for (const sampleRate of [44100,48000]) {
  const {context,page}=await fixture(browser,{sampleRate});
  try {
    expect((await evidence(page)).fetched).toEqual([]);
    await expect(page.getByRole('button',{name:'Reload page',exact:true})).toBeHidden();
    // CASE-335: the room's default level plays after this display's own tap; the projector has no sliders.
    await expect(page.getByRole('slider')).toHaveCount(0);
    await page.getByRole('button',{name:'Session sound',exact:true}).click();
    await expect.poll(async()=> (await evidence(page)).starts.length).toBe(1);
    expect((await evidence(page)).fetched).toHaveLength(1); expectPcmStarts((await evidence(page)).starts,[bed('lobby')],sampleRate);
    await publish(page,{phase:'waiting',revision:222,arrivalCount:9});expect((await evidence(page)).starts).toHaveLength(1);
    await publish(page,{phase:'live',surface:{kind:'debrief'}});await expect.poll(async()=> (await evidence(page)).starts.length).toBe(2);
    await publish(page,{phase:'live',surface:{kind:'wrap_up'}});expect((await evidence(page)).starts).toHaveLength(2);
    // CASE-334: the decision theme's three phase-aligned full mixes, from the room's public transport.
    await publish(page,decisionView());await expect.poll(async()=> (await evidence(page)).starts.length).toBe(5);
    const loop={loop:true,duration:theme('atlas-current').loopS,mp3:true,channels:2};
    expectPcmStarts((await evidence(page)).starts,[bed('lobby'),bed('debrief'),loop,loop,loop],sampleRate);
    await publish(page,{phase:'reviewing'});await expect.poll(async()=> (await evidence(page)).stopped).toBeGreaterThanOrEqual(5);
    await publish(page,{phase:'ended',surface:{kind:'debrief'}});await page.waitForTimeout(100);expect((await evidence(page)).starts).toHaveLength(5);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    record(`continuous-pcm-${sampleRate}`,await evidence(page));const decoded=(await evidence(page)).decoded;expect(decoded.every(b=>b.channels===2&&b.bytes>0&&b.duration>0)).toBe(true);
  } finally {await page.evaluate(()=>__audioFixture.close());await context.close();}
  }
});

test('reflection, replay, review and a decision without a public transport stay silent',async({browser})=>{
  const {context,page}=await fixture(browser);
  try {
    await publish(page,{phase:'live',surface:{kind:'reflection'}});await page.getByRole('button',{name:'Session sound',exact:true}).click();
    for(const view of [{phase:'live',replay:true,surface:{kind:'debrief'}},{phase:'reviewing'},{...decisionView(),music:undefined},{...decisionView(),decision:{status:'locked'}}]) await publish(page,view);
    await page.waitForTimeout(300);expect((await evidence(page)).starts).toHaveLength(0);expect((await evidence(page)).fetched).toHaveLength(0);
  } finally {await page.evaluate(()=>__audioFixture.close());await context.close();}
});

test('failed gesture and failed music remain truthful and silent; MP3 MIME/full-body Range behavior is measured',async({browser})=>{
  const failing=await fixture(browser,{failResume:true});
  try {await failing.page.getByRole('button',{name:'Session sound',exact:true}).click();await expect(failing.page.getByRole('button',{name:'Session sound',exact:true})).toHaveText('Retry sound');expect((await evidence(failing.page)).fetched).toEqual([]);await expect(failing.page.locator('main')).not.toContainText('private');}
  finally {await failing.context.close();}
  const r=await fixture(browser);
  try {
    await r.page.route('**/assets/atlas-arrival-low.*.mp3',route=>route.fulfill({status:404,body:''}));await r.page.getByRole('button',{name:'Session sound',exact:true}).click();
    await expect(r.page.getByRole('status')).toContainText('Session music unavailable');expect((await evidence(r.page)).starts).toEqual([]);
    const music=await r.page.evaluate(async url=>(await import(url)).MUSIC_LIBRARY,asset('music-assets'));
    const files=[...new Map(music.tracks.flatMap(t=>[t,...t.boosts]).flatMap(p=>Object.values(p.assets)).map(a=>[a.url,a])).values()];
    expect(music.tracks.map(t=>t.id)).toEqual(library.tracks.map(t=>t.id));expect(files).toHaveLength(42);
    const delivery=[];for(const item of files.slice(0,6)){const response=await r.page.request.get(worker.origin+item.url,{headers:{Range:'bytes=0-43'}}),body=await response.body();expect(response.status()).toBe(200);expect(response.headers()['content-type']).toMatch(/^audio\/mpeg(;|$)/);expect(response.headers()['content-range']).toBeUndefined();expect(body.length).toBe(item.bytes);delivery.push({url:item.url.replace(/\.[a-f0-9]{64}\./,'.'),status:response.status(),contentType:response.headers()['content-type'],receivedBytes:body.length});}record('mp3-delivery',delivery);
  } finally {await r.page.evaluate(()=>__audioFixture.close());await r.context.close();}
});

test('decorative splash motion still runs after twenty seconds; reduced motion cancels it without moving controls',async({browser})=>{
  const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'no-preference'}),page=await context.newPage();
  try {
    await page.goto(homeUrl(worker.origin));const svg=page.locator('.home-art svg');await svg.waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const moving=()=>svg.evaluate(s=>s.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect.target!==s).length);
    await expect.poll(moving).toBeGreaterThan(0); // per-tessera motion (CASE-202): tiles move, never the whole art
    const before=await page.getByRole('textbox',{name:'Session code',exact:true}).boundingBox();await page.waitForTimeout(20_000);
    await expect.poll(moving).toBeGreaterThan(0);
    expect(await svg.evaluate(s=>s.getAnimations().length),'no whole-art breath').toBe(0);
    expect(await page.getByRole('textbox',{name:'Session code',exact:true}).boundingBox()).toEqual(before);
    await page.emulateMedia({reducedMotion:'reduce'});await expect.poll(()=>svg.evaluate(s=>s.getAnimations({subtree:true}).length)).toBe(0);
  } finally {await context.close();}
});


test('selected standard/soft events share one decoded PCM and fallback applies the same user/event gain',async({browser})=>{
  const samples=await fixture(browser);
  // CASE-335: room music plays by default; this test counts event cues only, so the room's music is paused.
  const quiet={phase:'waiting',music:{choice:'auto',intensity:70,playing:false,volume:60,effects:true,transport:null}};
  try {await publish(samples.page,quiet);await samples.page.getByRole('button',{name:'Session sound',exact:true}).click();await samples.page.evaluate(()=>__audioFixture.play('decision_open'));await samples.page.evaluate(()=>__audioFixture.play('reveal'));
    const result=await evidence(samples.page);expect(result.fetched).toHaveLength(1);expect(result.decoded).toHaveLength(1);expect(result.sampleGains).toHaveLength(2);expect(result.sampleGains[0]).toBeCloseTo(.6,7);expect(result.sampleGains[1]).toBeCloseTo(.3,7);record('shared-cue-pcm',result);
  }finally{await samples.page.evaluate(()=>__audioFixture.close());await samples.context.close();}
  const fallback=await fixture(browser);
  try {await fallback.page.route('**/assets/material-revealed.*.wav',route=>route.fulfill({status:404,body:''}));await publish(fallback.page,quiet);await fallback.page.getByRole('button',{name:'Session sound',exact:true}).click();await fallback.page.evaluate(()=>__audioFixture.play('reveal'));
    const result=await evidence(fallback.page);expect(result.tones).toBe(1);expect(result.starts).toEqual([]);expect(result.ramps[0]).toBeCloseTo(.035*.6*.5,12); // CASE-335: the room's Effects level (.6) on this devicerecord('cue-fallback',result);
  }finally{await fallback.page.evaluate(()=>__audioFixture.close());await fallback.context.close();}
});

test('the sound button and its status fit at 320px and desktop in both themes; the levels live on the console (CASE-335)',async({browser})=>{
  for(const theme of ['light','dark'])for(const width of [320,1280]){const r=await fixture(browser,{theme,width});try{await r.page.getByRole('button',{name:'Session sound',exact:true}).click();await expect(r.page.getByRole('button',{name:'Session sound',exact:true})).toHaveAttribute('aria-pressed','true');await expect(r.page.getByRole('slider')).toHaveCount(0);expect(await r.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.CASE_AUDIO_EVIDENCE){mkdirSync(process.env.CASE_AUDIO_EVIDENCE,{recursive:true});await r.page.screenshot({path:`${process.env.CASE_AUDIO_EVIDENCE}/controls-${theme}-${width}.png`,fullPage:true});}
  }finally{await r.page.evaluate(()=>__audioFixture.close());await r.context.close();}}
});


test('End fences native pending fetch and decode before any source starts',async({browser})=>{
  for(const held of ['fetch','decode']){
    const r=await fixture(browser,{holdDecode:held==='decode'});let release,entered;
    const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    try {
      if(held==='fetch')await r.page.route('**/assets/atlas-arrival-low.*.mp3',async route=>{entered();await gate;try{await route.continue();}catch{/* End already aborted request. */}});
      await r.page.getByRole('button',{name:'Session sound',exact:true}).click();
      if(held==='fetch')await started;else await r.page.waitForFunction(()=>typeof __releaseAudioDecode==='function');
      await publish(r.page,{phase:'ended'});
      if(held==='fetch')release();else await r.page.evaluate(()=>__releaseAudioDecode());
      await r.page.waitForTimeout(100);expect((await evidence(r.page)).starts).toEqual([]);record(`end-held-${held}`,await evidence(r.page));
    }finally{release?.();await r.page.evaluate(()=>__audioFixture.close());await r.context.close();}
  }
});


test('actual served projector retains its visible local sound button in each theme; no level sliders (CASE-335)',async({browser})=>{
  const room=await helper.createRoom(worker.origin);const state=initialState({sessionId:room.sessionId,joinCode:room.joinCode,caseDoc:helper.FIXTURE});state.epoch=100;state.revision=1;
  const view=project(state,'display');
  for(const theme of ['light','dark'])for(const width of [320,1280]){
    const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'no-preference',viewport:{width,height:720}}),page=await context.newPage();
    try{
      await page.goto(sessionUrl(room.sessionId,'display',worker.origin)+'?topology=same-pc');await expect(page.locator('body')).toHaveClass(/projector/);
      await page.evaluate(({view,theme})=>{document.documentElement.dataset.theme=theme;const c=new BroadcastChannel('case-room-local');c.postMessage({t:'local_snapshot',view,epoch:view.epoch,revision:view.revision,displayRevision:view.displayRevision});c.close();},{view,theme});
      await expect(page.locator('.joinpanel')).toBeVisible();await page.getByRole('button',{name:'Session sound',exact:true}).click();await expect(page.getByRole('button',{name:'Session sound',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(page.getByRole('slider')).toHaveCount(0);
      const bounds=await page.locator('.sound-cell').boundingBox(),names=await page.locator('footer .names').boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);if(names)expect(bounds.y>=names.y+names.height||bounds.x>=names.x+names.width).toBe(true); // an empty names area has no box to overlap
      const permission=page.getByRole('button',{name:'Session sound',exact:true});
      await expect(permission.locator('svg')).toBeVisible();
      const target=await permission.boundingBox();expect(target.width).toBeGreaterThanOrEqual(44);expect(target.height).toBeGreaterThanOrEqual(44);expect(target.height).toBeLessThanOrEqual(48);
      if(process.env.CASE_AUDIO_EVIDENCE){
        await page.screenshot({path:`${process.env.CASE_AUDIO_EVIDENCE}/served-projector-${theme}-${width}.png`,fullPage:true});
        await permission.evaluate(button=>button.blur());
        await page.locator('.sound-cell').screenshot({path:`${process.env.CASE_AUDIO_EVIDENCE}/sound-control-${theme}-${width}.png`});
      }
    }finally{await context.close();}
  }
});

test('cached music module failure offers a real document reload',async({browser})=>{
  const r=await fixture(browser);let imports=0;
  try{
    await r.page.route('**/assets/room-music.*.mjs',route=>{imports++;return route.abort();});
    await r.page.getByRole('button',{name:'Session sound',exact:true}).click();
    await expect(r.page.getByRole('status')).toContainText('Reload this page');await expect(r.page.getByRole('button',{name:'Reload page',exact:true})).toBeVisible();
    expect((await evidence(r.page)).fetched).toEqual([]);expect(imports).toBe(1);await expect(r.page.getByRole('button',{name:'Session sound',exact:true})).toHaveAttribute('aria-pressed','true');
    await r.page.getByRole('button',{name:'Session sound',exact:true}).click();await r.page.getByRole('button',{name:'Session sound',exact:true}).click();expect(imports).toBe(1);
    await r.page.getByRole('button',{name:'Reload page',exact:true}).click();await expect(r.page.getByRole('textbox',{name:'Session code',exact:true})).toBeVisible();
  }finally{await r.context.close();}
});


// A real projector page on the local Worker whose AudioContext records each source's start in room (wall) time and offset.
async function pairedProjector(browser, room, { sampleRate = 48000, hold = null } = {}) {
  const context=await browser.newContext({reducedMotion:'no-preference',viewport:{width:1280,height:720}}),page=await context.newPage();
  await page.addInitScript(sampleRate=>{
    window.__roomAudio={starts:[],stops:0};const Native=AudioContext;
    window.AudioContext=class extends Native{constructor(){super({sampleRate});}createBufferSource(){const ctx=this,source=super.createBufferSource(),start=source.start.bind(source),stop=source.stop.bind(source);
      source.start=(at=0,offset=0,...rest)=>{__roomAudio.starts.push({loop:source.loop,duration:source.buffer.duration,sampleRate:source.buffer.sampleRate,frames:source.buffer.length,channels:source.buffer.numberOfChannels,
        wall:performance.timeOrigin+performance.now()+(Math.max(at,ctx.currentTime)-ctx.currentTime)*1000,offset:offset+Math.max(0,ctx.currentTime-at)});return start(at,offset,...rest);};
      source.stop=(...args)=>{__roomAudio.stops++;return stop(...args);};return source;}};
  },sampleRate);
  if(hold)await page.route(hold.pattern,async route=>{await new Promise(resolve=>setTimeout(resolve,hold.ms));await route.continue();});
  await page.goto(displayPairUrl('00000000',worker.origin));await expect(page.locator('.pair-code')).toHaveText(/[0-9A-Z]{4} [0-9A-Z]{4}/);
  const code=(await page.locator('.pair-code').textContent()).replace(/\s/g,'');
  const approved=await fetch(apiUrl(worker.origin,'sessions',room.sessionId,'display-pairs','approve'),{method:'POST',headers:{authorization:`Bearer ${room.facilitatorToken}`,'content-type':'application/json'},body:JSON.stringify({code})});expect(approved.ok).toBe(true);
  await expect(page.locator('.joinpanel')).toBeVisible();
  // CASE-335: the room's levels come from the console's player; Effects off here so only music sources are counted.
  expect((await helper.facilitatorCommand(worker.origin,room,'set_music',{effects:false,volume:20})).receipt).toBe('accepted');
  return { context, page, starts: () => page.evaluate(() => __roomAudio.starts), stops: () => page.evaluate(() => __roomAudio.stops) };
}
const openDecision=async room=>{for(let step=0;step<20&&(await helper.serverMirror(worker.origin,room)).phase!=='responses_open';step++)expect((await helper.facilitatorCommand(worker.origin,room,(await helper.serverMirror(worker.origin,room)).phase==='lobby'?'start':'advance')).receipt).toBe('accepted');};

test('[AS-120] real paired projector music follows authoritative lobby, open, lock and End without private playback commands',async({browser})=>{
  for (const sampleRate of [44100,48000]) {
  const room=await helper.createRoom(worker.origin), p=await pairedProjector(browser,room,{sampleRate});
  try{
    expect(await p.starts()).toEqual([]);
    await p.page.getByRole('button',{name:'Session sound',exact:true}).click();
    await expect.poll(async()=>(await p.starts()).length).toBe(1);
    expectPcmStarts(await p.starts(),[bed('lobby')],sampleRate);
    await openDecision(room);
    const transport=(await helper.serverMirror(worker.origin,room)).music.transport;await expect(p.page.locator('.decision')).toBeVisible();
    await expect.poll(async()=>(await p.starts()).filter(x=>x.loop).length).toBe(4);
    const loop={loop:true,duration:theme(transport.trackId).loopS,mp3:true,channels:2};
    expectPcmStarts((await p.starts()).filter(x=>x.loop),[bed('lobby'),loop,loop,loop],sampleRate);
    expect((await helper.facilitatorCommand(worker.origin,room,'lock')).receipt).toBe('accepted');
    await expect.poll(async()=>await p.stops()).toBeGreaterThanOrEqual((await p.starts()).length);
    expect((await helper.facilitatorCommand(worker.origin,room,'end')).receipt).toBe('accepted');await expect(p.page.locator('.endcard')).toBeVisible();
    const after=(await p.starts()).length;await p.page.waitForTimeout(300);expect((await p.starts()).length).toBe(after);
  }finally{await p.context.close();}
  }
});

test('[AS-199] two real projectors play the same theme, profile and loop position; the slow one seeks into the timeline',async({browser})=>{
  test.setTimeout(120_000);
  const room=await helper.createRoom(worker.origin);
  const a=await pairedProjector(browser,room), b=await pairedProjector(browser,room,{hold:{pattern:'**/assets/*-boost-125-*.mp3',ms:2500}});
  try{
    for(const p of [a,b])await p.page.getByRole('button',{name:'Session sound',exact:true}).click();
    expect((await helper.facilitatorCommand(worker.origin,room,'set_music',{intensity:150})).receipt).toBe('accepted');
    await openDecision(room);
    expect((await helper.facilitatorCommand(worker.origin,room,'set_timer',{seconds:20})).receipt).toBe('accepted');
    const transport=(await helper.serverMirror(worker.origin,room)).music.transport, track=theme(transport.trackId);
    await a.page.waitForTimeout(19_000);
    // The latest full-mix start of the fastest profile on each projector, read at one wall-clock instant.
    const fastest=track.boosts[1].loopS, now=Date.now();
    const phaseOf=starts=>{const s=starts.filter(x=>x.loop&&Math.abs(x.duration-fastest)<.06).at(-1);return s?(((now-s.wall)/1000+s.offset)%s.duration+s.duration)%s.duration:null;};
    const pa=phaseOf(await a.starts()), pb=phaseOf(await b.starts());
    expect(pa).not.toBeNull();expect(pb).not.toBeNull();
    const gap=Math.min(Math.abs(pa-pb),fastest-Math.abs(pa-pb));
    record('two-projectors',{trackId:transport.trackId,pa,pb,gapMs:gap*1000});
    expect(gap).toBeLessThan(.04);
  }finally{await a.context.close();await b.context.close();}
});
