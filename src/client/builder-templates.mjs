// Empty authored teaching scaffold. It carries structure, not clinical wording or a recommended answer.
import { uuidv7 } from '../shared/ids.mjs';
import { FREE_TEXT_MAX } from '../shared/content-limits.mjs';
import { blankSlide } from '../shared/blank-slide.mjs';

// Shipped since CASE-214/57: builder_slide_drafts/review SQL admit schema 3,
// builder-api grants slide_composition, and RoomDO injects validateSlideParts.
export function createBuilderStoryStarter(createId = uuidv7) {
  const surfaceId=createId(),beatId=createId();
  const document={schema_version:3,required_capabilities:['slide_composition'],title:'',summary:'',audience:'',setting:'',duration_min:15,learning_objectives:[],flags:[],
    surfaces:[{id:surfaceId,kind:'text',title:''}],beats:[{id:beatId,kind:'debrief',title:'',surface_id:surfaceId}],
    start_beat_id:beatId,decisions:[],clarifications:[],blocks:[],compositions:[]};
  return {document:{...document,...blankSlide(beatId,createId)},authoringMetadata:{metadata_version:1}};
}

export const BUILDER_INTERACTIONS = Object.freeze([
  ['single_choice', 'Single choice'],
  ['multi_select', 'Select all that apply'],
  ['ranking', 'Rank in order'],
  ['free_text', 'Free text'],
]);

export function createBuilderStarter(type = 'single_choice', createId = uuidv7) {
  if (!BUILDER_INTERACTIONS.some(([value]) => value === type)) throw new TypeError('Choose a supported response type.');
  const ids = Object.fromEntries(['openingSurface', 'questionSurface', 'endSurface', 'openingBeat', 'questionBeat', 'endBeat', 'decision', 'optionA', 'optionB', 'pathA', 'pathB']
    .map(key => [key, createId()]));
  const options = type === 'free_text' ? undefined : [
    { id: ids.optionA, label: '' }, { id: ids.optionB, label: '' },
  ];
  const paths = [
    { id: ids.pathA, label: '', classification: 'sound', recommended: true, rationale: '', cue: '', reveal_surface_id: ids.endSurface, next_beat_id: ids.endBeat,
      ...(type === 'single_choice' ? { option_ids: [ids.optionA] } : {}) },
    { id: ids.pathB, label: '', classification: 'defensible', rationale: '', cue: '', reveal_surface_id: ids.endSurface, next_beat_id: ids.endBeat,
      ...(type === 'single_choice' ? { option_ids: [ids.optionB] } : {}) },
  ];
  const decision = {
    id: ids.decision, prompt: '', interpretation: type === 'single_choice' ? 'rules' : 'facilitator',
    interaction: { type, ...(options ? { options } : { max_length: FREE_TEXT_MAX }), ...(type === 'ranking' ? { rank_count: 2 } : {}) },
    fallback_path_id: ids.pathA, paths,
  };
  return {
    document: {
      schema_version: 2, required_capabilities: type === 'single_choice' ? [] : ['human_interpretation'], title: '', summary: '', audience: '', setting: '', duration_min: 15, learning_objectives: [], flags: [],
      surfaces: [
        { id: ids.openingSurface, kind: 'handover', title: 'Opening', points: [] },
        { id: ids.questionSurface, kind: 'update', title: 'Decision context', points: [] },
        { id: ids.endSurface, kind: 'debrief', title: 'Reassessment', points: [] },
      ],
      beats: [
        { id: ids.openingBeat, kind: 'surface', title: 'Opening', surface_id: ids.openingSurface, next_beat_id: ids.questionBeat },
        { id: ids.questionBeat, kind: 'decision', title: 'Decision', surface_id: ids.questionSurface, decision_id: ids.decision },
        { id: ids.endBeat, kind: 'debrief', title: 'Reassessment', surface_id: ids.endSurface },
      ],
      start_beat_id: ids.openingBeat, decisions: [decision], clarifications: [],
    },
    authoringMetadata: { metadata_version: 1, preparation_requirements: '' },
  };
}

export function builderTemplates(createId = uuidv7) {
  return BUILDER_INTERACTIONS.map(([id, label]) => ({ id, label, create: () => createBuilderStarter(id, createId) }));
}
