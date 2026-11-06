import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as templates from '../src/client/builder-templates.mjs';
import {validateBuilderDocument} from '../src/shared/builder-document.mjs';
import {validateSlideParts} from '../src/shared/slide-document.mjs';
import {isUuidV7,uuidv7} from '../src/shared/ids.mjs';
import {withOrdinaryMappings,withOrdinaryQuestionSlide} from '../src/shared/ordinary-question.mjs';

test('a new story opens one modern editable slide without question or branch scaffolding',()=>{
  assert.equal(typeof templates.createBuilderStoryStarter,'function');
  const pair=templates.createBuilderStoryStarter(),d=pair.document;
  assert.equal(d.schema_version,3);assert.equal(d.beats.length,1);assert.equal(d.decisions.length,0);
  assert.equal(d.compositions.length,1);assert.equal(d.blocks.length,2);
  assert.equal(d.start_beat_id,d.beats[0].id);
  assert.ok(d.blocks.every(b=>b.paragraphs.every(p=>p.runs.every(r=>r.text===''))));
  assert.ok([...d.beats,...d.surfaces,...d.blocks,...d.compositions].every(x=>isUuidV7(x.id)));
  assert.equal(validateBuilderDocument(d,pair.authoringMetadata,{mode:'preserve',validateSlides:validateSlideParts}).ok,true);
  d.title='A short story';d.summary='A teaching exercise';d.audience='Registrars';d.setting='Tutorial';d.learning_objectives=['Discuss the handover'];
  d.beats[0].title=d.surfaces[0].title='The handover';
  d.blocks[0].paragraphs[0].runs[0].text='The handover';d.blocks[1].paragraphs[0].runs[0].text='Discuss who owns the next task.';
  const checked=validateBuilderDocument(d,pair.authoringMetadata,{mode:'ready',validateSlides:validateSlideParts});
  assert.equal(checked.ok,true,JSON.stringify(checked.errors));
});

test('an ordinary question is ready from its public prompt without blank content blocks or manual title metadata',()=>{
  const pair=templates.createBuilderStoryStarter();let d=pair.document;
  Object.assign(d,{title:'Story',summary:'Discuss a handover',audience:'Registrars',setting:'Tutorial',learning_objectives:['Discuss the next result']});
  d.beats[0].title=d.surfaces[0].title='Discussion';
  d.blocks[0].paragraphs[0].runs[0].text='Discussion';d.blocks[1].paragraphs[0].runs[0].text='Discuss the result.';
  const beat=uuidv7(),surface=uuidv7(),decision=uuidv7(),path=uuidv7(),prompt='Which result will change our management?';
  d.required_capabilities.push('direct_continuation','human_interpretation');
  d.surfaces.push({id:surface,kind:'text',title:''});
  d.beats.unshift({id:beat,kind:'decision',title:'',surface_id:surface,decision_id:decision});
  d.decisions.push({id:decision,prompt,interpretation:'facilitator',interaction:{type:'free_text',max_length:500},fallback_path_id:path,
    paths:[{id:path,label:'Continue',classification:'discussion-prompt',recommended:true,rationale:'Discuss responses, then continue.',cue:'Continue after discussion.',continue_to_next:true,reveal_surface_id:surface,next_beat_id:d.start_beat_id}]});
  d.start_beat_id=beat;d=withOrdinaryMappings(withOrdinaryQuestionSlide(d,beat,decision,uuidv7));
  const composition=d.compositions.find(item=>item.owner.id===beat);
  assert.equal(composition.reading_order.length,1);assert.equal(d.blocks.find(item=>item.id===composition.reading_order[0]).type,'question');
  assert.equal(d.beats[0].title,prompt);assert.equal(d.surfaces.at(-1).title,prompt);
  const ready=validateBuilderDocument(d,pair.authoringMetadata,{mode:'ready',validateSlides:validateSlideParts});assert.equal(ready.ok,true,JSON.stringify(ready.errors));
  d.decisions[0].prompt='A long public question '.repeat(7);const long=withOrdinaryMappings(d);
  assert.equal(long.decisions[0].prompt,d.decisions[0].prompt);assert.ok(long.beats[0].title.length<=120);
  d.decisions[0].prompt='x'.repeat(116)+'🩺'+'y'.repeat(10);const unicode=withOrdinaryMappings(d);
  assert.equal(unicode.decisions[0].prompt,d.decisions[0].prompt);
  assert.equal(validateBuilderDocument(unicode,pair.authoringMetadata,{mode:'ready',validateSlides:validateSlideParts}).ok,true,'derived navigation titles never split a surrogate pair');
  delete d.decisions[0].paths[0].continue_to_next;
  d.decisions[0].paths[0].label='Authored clinical action';
  d.decisions[0].paths.push({...d.decisions[0].paths[0],id:uuidv7(),label:'Alternative action'});
  d.decisions[0].prompt='A revised question after adding branches';const branched=withOrdinaryMappings(d);
  assert.equal(branched.beats[0].title,d.decisions[0].prompt);
  assert.deepEqual(branched.decisions[0].paths,d.decisions[0].paths,'derived question titles never rename clinical branch actions');
});
