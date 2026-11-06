// Card 17 design gates: fixtures and exhaustive source coverage (CASE-125).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import { slidePlan } from '../src/client/slide-render.mjs';
import { CALLOUT_TONES, INK_TONES, SLIDE_FILLS } from '../src/shared/slide-text.mjs';
import { resolveColor, contrast, themesFrom, slideThemesFrom, checkPairs, checkLadder, checkStacking, classifyCss, sourceCss, declaredPairs, disabledPairs, lintCss, hairlineViolations, railViolations } from './helpers/design-gates.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const css=readFileSync(new URL('../prototypes/room/lib/tokens.css',import.meta.url),'utf8');
const themes=themesFrom(css);
const scanned=sourceCss(ROOT);

test('[CASE-125] exact color resolution rejects unknown, cyclic and unsupported expressions',()=>{
  const t={ink:'#112233',alias:'var(--ink)',surface:'#ffffff'};
  assert.deepEqual(resolveColor('var(--alias)',t),[17/255,34/255,51/255,1]);
  assert.deepEqual(resolveColor('color-mix(in srgb, var(--ink) 50%, var(--surface))',t),[136/255,144.5/255,153/255,1]);
  for(const v of ['var(--missing)','linear-gradient(red, blue)','color-mix(in oklab, #000000 50%, #ffffff)','var(--cycle)']) assert.throws(()=>resolveColor(v,{...t,cycle:'var(--cycle)'}),/Cannot resolve/);
});

test('[CASE-125] every declared pair resolves and meets its threshold in both themes',()=>{
  assert.throws(()=>checkPairs([{label:'unknown',fg:'var(--absent)',bg:'var(--surface)',min:7}],themes),/Cannot resolve/);
  assert.throws(()=>checkPairs([{label:'bad',fg:'#ffffff',bg:'#ffffff',min:7}],themes),/under/);
  assert.throws(()=>checkPairs(declaredPairs(':root .warning{color:#ffffff;background:#ffffff;}','src/client/fixture.css'),themes),/under/);
  assert.throws(()=>checkPairs(declaredPairs('.x::before{color:#ffffff;background:#ffffff;}','src/client/fixture.css'),themes),/under/);
  assert.throws(()=>checkPairs(declaredPairs('.x{border-color:color-mix(in oklab, var(--line) 30%, pink);}','src/client/fixture.css'),themes),/Cannot resolve/);
  for(const prop of ['color','background-color','border-color','outline-color'])assert.throws(()=>checkPairs(declaredPairs(`.fixture { ${prop}:var(--absent); }`,'src/client/fixture.css'),themes),/Cannot resolve/);
  assert.throws(()=>themesFrom(':root{--ink:#000000;} @media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--ink:#ffffff;}} :root[data-theme="dark"]{--ink:#000000;}'),/dark theme/);
  for(const paint of ['fill','stroke']){assert.throws(()=>checkPairs(declaredPairs(`.icon{${paint}:var(--missing);}`,'src/client/fixture.css'),themes),/Cannot resolve/);assert.throws(()=>checkPairs(declaredPairs(`.icon{${paint}:#ffffff;background:#ffffff;}`,'src/client/fixture.css'),themes),/under/);}
  const fixture=themesFrom(':root { --ink:#000000;--surface:#ffffff; } :root[data-theme="dark"] { --ink:#ffffff;--surface:#ffffff; }');
  assert.throws(()=>checkPairs([{label:'dark only',fg:'var(--ink)',bg:'var(--surface)',min:7}],fixture),/dark.*under/);
  for(const f of scanned) { const text=readFileSync(f.absolute,'utf8'); const own=f.tokens?themesFrom(text):themes;
    const pairs=declaredPairs(text,f.relative); assert.ok(pairs.length || !/\b(color|background|border|outline)\s*:/.test(text),`${f.relative}: colour declarations need contrast coverage`);
    const measured=checkPairs(pairs,own); if(pairs.length) assert.equal(measured.length,pairs.length*2);
  }
});

test('[CASE-125] dark neutral ladder is strictly increasing with minimum luminance step 0.0029',()=>{
  assert.throws(()=>checkLadder({sunken:'#ffffff',ground:'#000000',surface:'#111111'}),/ladder/);
  assert.throws(()=>checkLadder({sunken:'#000000',ground:'#010101',surface:'#ffffff'}),/ladder/);
  for(const f of scanned.filter(f=>f.tokens)) checkLadder(themesFrom(readFileSync(f.absolute,'utf8')).dark);
});

test('[CASE-125] all stacking references and fixed/sticky declarations use valid bands below 1000',()=>{
  for(const bad of ['.x { position: fixed;z-index:9999; }','.x {position:sticky;}','.x {z-index:var(--z-unknown)}','.x {z-index:var(--z-dock,9999)}']) assert.throws(()=>checkStacking(bad,themes.light),/stacking/);
  assert.throws(()=>checkStacking('.x {position:fixed;z-index:var(--z-dock)}',{...themes.light,'z-dock':'1000'}),/stacking/);
  assert.throws(()=>checkStacking('.x{--z-dock:1000;position:fixed;z-index:var(--z-dock)}',themes.light),/stacking/);
  checkStacking('.x {position:sticky;z-index:var(--z-sticky)}',themes.light);
  for(const f of scanned) checkStacking(readFileSync(f.absolute,'utf8'),f.tokens?themesFrom(readFileSync(f.absolute,'utf8')).light:themes.light);
});

test('[CASE-125] every repository stylesheet is scanned or explicitly classified with a reason',()=>{
  assert.equal(classifyCss('src/client/future/nested.css').kind,'scan');
  assert.equal(classifyCss('dist/assets/hashed.css').kind,'generated');
  assert.equal(classifyCss('prototypes/design/builder-slide.css').kind,'scan');
  assert.equal(classifyCss('prototypes/design/studio.css').kind,'scan');
  assert.ok(scanned.some(f=>f.relative==='prototypes/design/studio.css'));
  assert.equal(classifyCss('prototypes/design/case-card.css').kind,'scan');
  assert.ok(scanned.some(f=>f.relative==='prototypes/design/case-card.css'));
  assert.equal(classifyCss('prototypes/design/slide-stage.css').kind,'scan');
  assert.ok(scanned.some(f=>f.relative==='prototypes/design/slide-stage.css'));
  assert.ok(scanned.some(f=>f.relative==='prototypes/design/builder-slide.css'));
  assert.equal(classifyCss('prototypes/sound-stage/stage.css').kind,'scan');
  assert.ok(scanned.some(f=>f.relative==='prototypes/sound-stage/stage.css'));
  assert.throws(()=>classifyCss('prototypes/forgotten.css'),/Unclassified/);
  const scratch=mkdtempSync(join(tmpdir(),'case-design-'));
  try{mkdirSync(join(scratch,'unexpected'));writeFileSync(join(scratch,'unexpected','uncovered.css'),'.x{color:red}');assert.throws(()=>sourceCss(scratch),/Unclassified/);}finally{rmSync(scratch,{recursive:true,force:true});}
  assert.ok(scanned.some(f=>f.relative==='prototypes/room/lib/tokens.css'));
});

test('[CASE-125] disabled buttons meet 4.5 after group-opacity compositing in both themes',()=>{
  const pairs=disabledPairs(css);
  assert.equal(pairs.length,8);
  for(const f of scanned.filter(f=>f.tokens)){const text=readFileSync(f.absolute,'utf8');checkPairs(disabledPairs(text),themesFrom(text));}
  assert.throws(()=>checkPairs(disabledPairs(css+'\n.btn:disabled{opacity:.55;}'),themes),/under/);
  const scratch=mkdtempSync(join(tmpdir(),'case-disabled-'));
  try{mkdirSync(join(scratch,'src/client'),{recursive:true});writeFileSync(join(scratch,'src/client/tokens.css'),css.replace('opacity: 1;','opacity: .55;'));assert.throws(()=>{for(const f of sourceCss(scratch).filter(f=>f.tokens)){const text=readFileSync(f.absolute,'utf8');checkPairs(disabledPairs(text),themesFrom(text));}},/under/);}finally{rmSync(scratch,{recursive:true,force:true});}
  assert.throws(()=>checkPairs(disabledPairs(css.replace(/button:disabled \{[^}]+\}/,'button:disabled {opacity:.55;}')),themes),/under/);
});

test('[CASE-125] stylelint errors on important, unknown properties, imports and non-token hex',async()=>{
  for(const [input,rule] of [['.x{color:red!important}','declaration-no-important'],['.x{colro:red}','property-no-unknown'],['@import "x.css";','at-rule-disallowed-list'],['.x{color:#ffffff}','color-no-hex']]){
    const result=await lintCss(input,'src/client/fixture.css'); assert.equal(result.errored,true,rule); assert.ok(result.results[0].warnings.some(w=>w.rule===rule && w.severity==='error'),rule);
  }
  assert.equal((await lintCss('.unrelated{opacity:1!important}','prototypes/room/lib/tokens.css')).errored,true);
  const allowed=await lintCss('@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}}','prototypes/room/lib/tokens.css');assert.equal(allowed.errored,false);
  for(const f of scanned) { const result=await lintCss(readFileSync(f.absolute,'utf8'),f.relative);assert.equal(result.errored,false,JSON.stringify(result.results[0].warnings)); }
  assert.ok(stylelint.lint);
});

test('[CASE-163] hairline gate: --line borders are decorative on containers and fail on controls and fields',()=>{
  for(const sel of ['input','select','textarea','button','[role=button]','input[type=text]','button.btn:hover','.btn','.input'])
    for(const decl of ['border:1px solid var(--line)','border-color:var(--line)','border-bottom:1px solid var(--nav-line)','border:1px solid color-mix(in srgb, var(--ink) 20%, var(--line))']){
      assert.ok(hairlineViolations(`${sel}{${decl}}`,'src/client/fixture.css').length,`${sel} { ${decl} }`);
      assert.throws(()=>checkPairs(declaredPairs(`${sel}{${decl}}`,'src/client/fixture.css'),themes),/under|Cannot resolve/,`${sel} still fails 3:1`);
    }
  for(const ok of ['.panel{border-top:1px solid var(--line)}','.card{border:1px solid var(--line)}','.table td{border-bottom:1px solid var(--line)}','header{border-bottom:1px solid var(--nav-line)}','input{border:1px solid var(--field-line)}','button{border:1px solid var(--field-line)}']){
    assert.deepEqual(hairlineViolations(ok,'src/client/fixture.css'),[],ok);
  }
  checkPairs(declaredPairs('.panel{border-top:1px solid var(--line)}','src/client/fixture.css'),themes);
  assert.throws(()=>checkPairs(declaredPairs('.panel{border-top:1px solid var(--ink-muted);background:var(--surface)}','src/client/fixture.css').concat([{label:'x',fg:'var(--line)',bg:'var(--surface)',min:3}]),themes),/under/);
  for(const f of scanned)assert.deepEqual(hairlineViolations(readFileSync(f.absolute,'utf8'),f.relative),[],f.relative);
});

test('[CASE-163] rail sweep: no side or top accent rail wider than 1px in a phase, status or private colour',()=>{
  const bad=['.a{border-left:3px solid var(--ph-open)}','.a{border-top:4px solid var(--ph, var(--petrol))}','.a{border-left-width:4px;border-left-color:var(--alert)}','.a{border-inline-start:3px solid var(--private)}','.a{box-shadow:inset 4px 0 0 var(--ph-consequence), var(--shadow-1)}','.a{box-shadow:inset 0 6px 0 var(--ph-reveal)}','.a{border-left:3px solid var(--manual)}','.a{border-left:3px solid var(--ok)}'];
  for(const css of bad)assert.ok(railViolations(css,'src/client/fixture.css').length,css);
  for(const ok of ['.a{border-left:1px solid var(--ph-open)}','.a{border-left:3px solid var(--field-line)}','.a{border-bottom:3px solid var(--petrol)}','.a{box-shadow:inset 0 0 0 2px var(--ph-open)}','.a{box-shadow:var(--shadow-1)}','.a{border-top:1px solid var(--line)}'])assert.deepEqual(railViolations(ok,'src/client/fixture.css'),[],ok);
  for(const f of scanned)assert.deepEqual(railViolations(readFileSync(f.absolute,'utf8'),f.relative),[],f.relative);
});

test('[CASE-163] a fill is excused only by a visible stroke (a transparent, none or zero-width stroke excuses nothing)',()=>{
  for(const bad of ['.m{fill:var(--line);stroke:transparent}','.m{fill:var(--line);stroke:none}','.m{fill:var(--line);stroke:var(--ink);stroke-width:0}','.m{fill:var(--line);stroke:var(--ink);stroke-width:0px}'])
    assert.throws(()=>checkPairs(declaredPairs(bad,'src/client/fixture.css'),themes),/under/,bad);
  checkPairs(declaredPairs('.m{fill:var(--line);stroke:var(--ink);stroke-width:1.5}','src/client/fixture.css'),themes);
  checkPairs(declaredPairs('.m{fill:var(--mark-yellow);stroke:var(--mark-yellow-edge)}','src/client/fixture.css'),themes);
});

test('[CASE-163] hairline gate covers every control-like subject: summary, details, a, label, .field, ARIA widget roles, any tag case',()=>{
  for(const sel of ['summary','details','details.ctx','.phone-app details.ctx','a','A','BUTTON','Label','label.field','.field','.field > input','[role=tab]','[role="radio"]','[role=checkbox]','[role=option]','[role=switch]','[ROLE=button]','.x:hover > Summary','.admin-nav button:focus-visible'])
    assert.ok(hairlineViolations(`${sel}{border:1px solid var(--line)}`,'src/client/fixture.css').length,sel);
  for(const sel of ['details.info .info-body','.panel','.zone-label','article','nav ul','.label','.summary'])
    assert.deepEqual(hairlineViolations(`${sel}{border:1px solid var(--line)}`,'src/client/fixture.css'),[],sel);
});

test('[CASE-163] an empty content declaration excuses only a ::before or ::after rule',()=>{
  assert.throws(()=>checkPairs(declaredPairs('.banner{content:"";background:var(--petrol-ink)}','src/client/fixture.css'),themes),/under/);
  assert.throws(()=>checkPairs(declaredPairs(".banner{content:'';background:var(--petrol-ink)}",'src/client/fixture.css'),themes),/under/);
  for(const sel of ['.x::before','.x::after','.x:before','.x:after','.x:hover::after'])checkPairs(declaredPairs(`${sel}{content:"";background:var(--petrol);width:8px;height:8px}`,'src/client/fixture.css'),themes);
});

test('[CASE-163] rail sweep resolves sides, shorthands, units, custom properties, shadows and pseudo bars',()=>{
  const bad=[
    '.a{border-right:4px solid var(--ph-open)}',
    '.a{border-inline-start:4px solid var(--ok)}',
    '.a{border-inline-end:4px solid var(--alert)}',
    '.a{border-block-start:4px solid var(--manual)}',
    '.a{border-width:0 0 0 4px;border-style:solid;border-color:var(--ph-locked)}',
    '.a{border-width:4px 0 0;border-color:var(--private)}',
    '.a{border:1px solid var(--line);border-left-width:4px;border-left-color:var(--ph-open)}',
    '.a{border:1px solid var(--line);border-left-width:4px;border-color:var(--ph-open)}',
    '.a{border-left:.25rem solid var(--ph-open)}',
    '.a{border-left:.25em solid var(--ph-open)}',
    '.a{border-left:thick solid var(--ph-open)}',
    '.a{border-right-width:medium;border-right-style:solid;border-right-color:var(--petrol)}',
    '.a{box-shadow:inset 4px 0 0 var(--ph-open)}',
    '.a{box-shadow:inset 4px 0 1px var(--ph-open)}',
    '.a{box-shadow:inset -4px 0 0 0 var(--ph-open)}',
    '.a{box-shadow:inset 0 4px 0 0 var(--ph-open),var(--shadow-1)}',
    '.a{box-shadow:-4px 0 0 var(--ph-open)}',
    '.a{--rail:var(--ph-open);border-left:4px solid var(--rail)}',
    '.a{--w:4px;--c:var(--alert);border-left:var(--w) solid var(--c)}',
    '.a::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--ph-open)}',
    '.a::after{content:"";position:absolute;inset:0 auto 0 0;width:.25rem;background-color:var(--alert)}',
    '.a:before{content:"";position:absolute;top:0;left:0;height:100%;width:3px;background:var(--petrol)}',
  ];
  for(const css of bad)assert.ok(railViolations(css,'src/client/fixture.css').length,css);
  const ok=[
    '.a{border-bottom:3px solid var(--petrol)}','.a{border-bottom-width:4px;border-bottom-color:var(--ph-open)}',
    '.a{border:2px solid var(--petrol)}','.a{border:2px solid var(--ph-open);border-radius:8px}','.a{border-width:2px;border-color:var(--ph-open)}',
    '.a{border-left:4px solid var(--field-line)}','.a{border-left:1px solid var(--ph-open)}','.a{border-left:.0625rem solid var(--ph-open)}',
    '.a{box-shadow:inset 0 0 0 2px var(--ph-open)}','.a{box-shadow:inset 4px 0 12px var(--ink)}','.a{box-shadow:0 12px 32px var(--ink)}',
    '.a::before{content:"";width:8px;height:8px;background:var(--ph-open)}',
    '.a::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:3px;background:var(--petrol)}',
    '.a::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--line)}',
    '.a{--rail:var(--field-line);border-left:4px solid var(--rail)}',
  ];
  for(const css of ok)assert.deepEqual(railViolations(css,'src/client/fixture.css'),[],css);
});

test('[CASE-163] round 3: rail bypasses (one visible side, logical pairs, calc, upper-case var, hard-stop stripes)',()=>{
  const bad=[
    '.a{border-left:4px solid var(--ph-open);border-right:4px solid transparent}',
    '.a{border-left:4px solid var(--ph-open);border-right:4px solid var(--line)}',
    '.a{border-left:4px solid var(--ph-open);border-right:0}',
    '.a{border-inline:4px solid var(--ph-open)}',
    '.a{border-block:4px solid var(--alert)}',
    '.a{border-inline-width:4px;border-inline-style:solid;border-inline-color:var(--ph-open)}',
    '.a{border-left:calc(2px * 2) solid var(--ph-open)}',
    '.a{border-left:calc(.25rem) solid VAR(--ph-open)}',
    '.a{border-left:4px solid Var(--ph-open)}',
    '.a{background-image:linear-gradient(to right, var(--ph-open) 4px, transparent 4px)}',
    '.a{background:linear-gradient(to bottom, var(--alert) 4px, transparent 4px)}',
    '.a{background-image:linear-gradient(to left,var(--petrol) .25rem,transparent .25rem)}',
  ];
  for(const css of bad)assert.ok(railViolations(css,'src/client/fixture.css').length,css);
  for(const ok of ['.a{border:2px solid var(--petrol)}','.a{border-top:2px solid var(--petrol);border-right:2px solid var(--petrol);border-bottom:2px solid var(--petrol);border-left:2px solid var(--petrol)}','.a{background-image:repeating-linear-gradient(90deg, var(--mk) 0 calc(var(--tile) - 2px), transparent calc(var(--tile) - 2px) var(--tile))}','.a{background-image:linear-gradient(to right, var(--line) 4px, transparent 4px)}'])
    assert.deepEqual(railViolations(ok,'src/client/fixture.css'),[],ok);
});

test('[CASE-163] round 3: a fill is not excused by a zero-length or invisible stroke in any spelling',()=>{
  for(const extra of ['stroke-width:0.0','stroke-width:0%','stroke-width:.0px','stroke-width:0.00rem','stroke-opacity:0','stroke-opacity:0%','stroke-opacity:0.0'])
    assert.throws(()=>checkPairs(declaredPairs(`.m{fill:var(--line);stroke:var(--ink);${extra}}`,'src/client/fixture.css'),themes),/under/,extra);
  checkPairs(declaredPairs('.m{fill:var(--line);stroke:var(--ink);stroke-width:1.5;stroke-opacity:.8}','src/client/fixture.css'),themes);
});

test('[CASE-163] round 3: hairline subjects inside :is/:where, more ARIA roles and contenteditable; :not is not a control',()=>{
  for(const sel of [':is(button, .y)','.a :is(button,.y)','.x:where(button)','.x:is(.a, [role=tab])','div:is(:hover, [role=menuitem])','[role=menuitem]','[role=textbox]','[role=combobox]','[role=slider]','[role=spinbutton]','[role=searchbox]','[contenteditable]','[contenteditable=true]','div[contenteditable]'])
    assert.ok(hairlineViolations(`${sel}{border:1px solid var(--line)}`,'src/client/fixture.css').length,sel);
  for(const sel of [':not(button)','.x:not([role=button])','.card:not(.a, input)','div:is(.a,.b)'])
    assert.deepEqual(hairlineViolations(`${sel}{border:1px solid var(--line)}`,'src/client/fixture.css'),[],sel);
});

test('[CASE-227] every presentation theme keeps slide text at 7:1 (muted text at 4.5:1) over both room themes', () => {
  const slideThemes = slideThemesFrom(css);
  assert.deepEqual(Object.keys(slideThemes).sort(), ['clinic', 'night', 'print']);
  const tones = ['blue', 'teal', 'green', 'purple', 'coral', 'orange', 'amber', 'grey'];
  const pairs = [
    { label: 'slide ink on its ground', fg: 'var(--ink)', bg: 'var(--surface)', min: 7 },
    { label: 'slide muted ink on its ground', fg: 'var(--ink-muted)', bg: 'var(--surface)', min: 4.5 },
    { label: 'slide ink on the soft fill', fg: 'var(--ink)', bg: 'var(--slide-fill-soft)', min: 7 },
    ...tones.flatMap(tone => [
      { label: `slide ink on the ${tone} fill`, fg: 'var(--ink)', bg: `var(--slide-fill-${tone})`, min: 7 },
      { label: `${tone} text on the slide ground`, fg: `var(--slide-ink-${tone})`, bg: 'var(--surface)', min: 7 },
    ]),
  ];
  // The slide rules as shipped: every colour pair a slide selector declares, in every theme.
  for (const f of scanned.filter(file => /(projector|phone|builder-slides)\.css$/.test(file.relative))) {
    // A themed slide paints its own ground (var(--surface), asserted below), so its text is measured on that ground and
    // on the slide's own fills, never on the room's page grounds.
    for (const pair of declaredPairs(readFileSync(f.absolute, 'utf8'), f.relative)) if (/\.slide-/.test(pair.label) && !/--(ground|sunken|nav-bg)\b/.test(pair.bg)) pairs.push(pair);
  }
  for (const [name, contexts] of Object.entries(slideThemes)) {
    const measured = checkPairs(pairs, { [`${name}-light`]: contexts.light, [`${name}-dark`]: contexts.dark });
    assert.equal(measured.length, pairs.length * 2);
  }
  assert.throws(() => slideThemesFrom(':root{--ink:#000000;} :root[data-theme="dark"]{--ink:#ffffff;}'), /No slide themes/);
  // Every place a slide is drawn paints the themed ground behind it, or the slide's own fill when it has one (CASE-312).
  for (const file of ['src/client/projector.css', 'src/client/phone.css', 'src/client/builder-slides.css'])
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /slide-canvas[^{]*\{[^}]*background: var\(--slide-ground, var\(--surface\)\)/, `${file} paints the slide ground`);
  // Round 24 P1: these pairs assume a table inherits the slide's ink. The Run preview draws the projector in quirks-mode
  // frames, where a table takes the root's colour and type instead, so the projector's table rule restores inheritance.
  assert.match(readFileSync(new URL('../src/client/projector.css', import.meta.url), 'utf8'), /\.slide-table-grid \{[^}]*color: inherit;[^}]*font: inherit;/, 'projector slide tables inherit the slide ink and type');
});

test('[CASE-244] a text colour that shows on a fill keeps 7:1, and muted ink keeps 4.5:1 on every fill and banded row, in every slide theme and room', () => {
  // Case follows the room's light or dark; the other slide themes are measured over both rooms too.
  const slideThemes = { case: themes, ...slideThemesFrom(css) };
  const fills = Object.keys(CALLOUT_TONES).filter(name => name !== 'plain');
  const table = { columns: [{ label: 'Gas', align: 'start', unit: 'kPa' }], rows: [{ cells: ['8'] }], header_row: true };
  const block = type => ({ id: 'b', type, ...(type === 'table' ? table : { paragraphs: [{ style: 'p', runs: [{ text: 'x' }] }] }) });
  // What reaches the screen is decided by the renderer: a text colour on a ground only if it carries its ink class.
  const shows = (type, style, ink) => /\bslide-ink-/.test(slidePlan({ blocks: [block(type)], composition: { reading_order: ['b'], placements: [{ block_id: 'b', col: 1, row: 1, w: 12, h: 12 }], styles: [{ block_id: 'b', ...style, ink }] } }).root.children[0].cls);
  const grounds = [
    ...fills.map(fill => ({ name: `the ${fill} fill`, bg: `var(--slide-fill-${fill})`, type: 'text', style: { tone: fill } })),
    { name: 'a soft background', bg: 'var(--quiet)', type: 'text', style: { background: 'soft' } },
    { name: 'banded rows', bg: 'var(--quiet)', type: 'table', style: { banded: true } },
    { name: 'a callout', bg: 'var(--quiet)', type: 'callout', style: {} },
  ];
  let shown = 0, refused = 0;
  for (const [name, contexts] of Object.entries(slideThemes)) {
    const rooms = { [`${name}-light`]: contexts.light, [`${name}-dark`]: contexts.dark };
    for (const ground of grounds) {
      checkPairs([{ label: `muted ink on ${ground.name}`, fg: 'var(--ink-muted)', bg: ground.bg, min: 4.5 }], rooms);
      for (const ink of INK_TONES) {
        const pair = { label: `${ink} text on ${ground.name}`, fg: `var(--slide-ink-${ink})`, bg: ground.bg, min: 7 };
        if (shows(ground.type, ground.style, ink)) { checkPairs([pair], rooms); shown++; } else refused++;
      }
    }
  }
  assert.equal(shown + refused, Object.keys(slideThemes).length * grounds.length * INK_TONES.length);
  // On a plain ground the colour is the author's to choose, and it shows.
  for (const type of ['text', 'table']) assert.ok(shows(type, {}, 'blue'), type);
});

test('[CASE-312] a slide fill keeps every slide text colour at its threshold, in every slide theme and room, and turns author ink off', () => {
  const shipped = readFileSync(new URL('../src/client/tokens.css', import.meta.url), 'utf8');
  // Each fill names its own light and dark token, and nothing else sets the slide's ground.
  const grounds = [...shipped.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^}]*--slide-ground:\s*([^;}]+)/g)].map(m => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(grounds, SLIDE_FILLS.map(fill => [`.slide-fill-${fill}`, `var(--slide-fill-${fill})`]));
  const slideThemes = { case: themes, ...slideThemesFrom(css) };
  // The slide's own text pairs as shipped, judged on each fill instead of the room's grounds. A pair with its own fill keeps it.
  const own = scanned.filter(file => /(projector|phone|builder-slides|client\/tokens)\.css$/.test(file.relative))
    .flatMap(f => declaredPairs(readFileSync(f.absolute, 'utf8'), f.relative))
    .filter(pair => /\.slide-/.test(pair.label) && !/\.slide-ink-/.test(pair.label) && !/\.slide-fill-/.test(pair.label) && / text$/.test(pair.label));
  const neutral = /^var\(--(ground|surface|sunken|nav-bg)\)$/;
  const pairs = SLIDE_FILLS.flatMap(fill => [
    { label: `ink on the ${fill} slide`, fg: 'var(--ink)', bg: `var(--slide-fill-${fill})`, min: 7 },
    { label: `muted ink on the ${fill} slide`, fg: 'var(--ink-muted)', bg: `var(--slide-fill-${fill})`, min: 4.5 },
    ...own.filter(pair => neutral.test(pair.bg)).map(pair => ({ ...pair, label: `${pair.label} on the ${fill} slide`, bg: `var(--slide-fill-${fill})` })),
  ]);
  assert.ok(own.some(pair => /slide-gas/.test(pair.label)), 'the gas report text is measured on fills');
  for (const [name, contexts] of Object.entries(slideThemes))
    assert.equal(checkPairs(pairs, { [`${name}-light`]: contexts.light, [`${name}-dark`]: contexts.dark }).length, pairs.length * 2);
  // Author ink is measured on the room's ground, not on fills, so a filled slide draws its text in the slide's own ink.
  const plan = fill => slidePlan({ blocks: [{ id: 'b', type: 'text', paragraphs: [{ style: 'p', runs: [{ text: 'x' }] }] }], composition: { ...(fill ? { fill } : {}), reading_order: ['b'], placements: [{ block_id: 'b', col: 1, row: 1, w: 12, h: 12 }], styles: [{ block_id: 'b', ink: 'blue' }] } });
  assert.match(plan(null).root.children[0].cls, /\bslide-ink-blue\b/);
  for (const fill of SLIDE_FILLS) {
    const { root } = plan(fill);
    assert.match(root.cls, new RegExp(`\\bslide-filled\\b.*\\bslide-fill-${fill}\\b`));
    assert.doesNotMatch(root.children[0].cls, /\bslide-ink-/);
  }
});
