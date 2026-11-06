import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {uuidv7} from '../src/shared/ids.mjs';
import {acceptAdminResponse} from '../src/client/admin-schema.mjs';
const stamp='2026-10-03T00:00:00.000Z';
test('Card21b facilitator schema permits sparse paging and null invited profile but rejects private extras and duplicate identities',()=>{
  const user={id:randomUUID(),email:'user@example.invalid',invitedAt:stamp,confirmedAt:null,bannedUntil:null,createdAt:stamp,profile:null,label:null,access:null};
  assert.deepEqual(acceptAdminResponse('facilitators_search',{users:[],nextPage:3}),{users:[],nextPage:3});
  assert.ok(acceptAdminResponse('facilitators_list',{users:[user],nextPage:null}));
  assert.ok(acceptAdminResponse('facilitators_list',{users:[{...user,createdAt:null}],nextPage:null}),'actual GoTrue metadata permits an unknown creation time');
  for(const users of [[{...user,refresh_token:'private'}],[user,user],[{...user,profile:{admin_revision:0}}],[(({access,...rest})=>rest)(user)]])assert.equal(acceptAdminResponse('facilitators_list',{users,nextPage:null}),null);
  // P-41: the Name & role beside each account, exactly three fields.
  assert.ok(acceptAdminResponse('facilitators_list',{users:[{...user,label:{name:'Sam Lee',role:'Registrar',confirmed:false}}],nextPage:null}));
  assert.ok(acceptAdminResponse('facilitators_list',{users:[{...user,label:{name:'Facilitator',role:null,confirmed:false}}],nextPage:null}));
  for(const label of [{name:'Sam',role:'R'},{name:'Sam',role:'R',confirmed:'yes'},{name:'Sam',role:'R',confirmed:true,email:'x@y.z'},{name:'x'.repeat(81),role:'R',confirmed:true}])
    assert.equal(acceptAdminResponse('facilitators_list',{users:[{...user,label}],nextPage:null}),null);
  const edited={userId:user.id,adminRevision:5,name:'Sam Lee',role:'Registrar',confirmed:false};
  assert.ok(acceptAdminResponse('facilitators_label',{label:edited}));
  for(const label of [{...edited,adminRevision:-1},{...edited,role:''},{...edited,extra:1}])assert.equal(acceptAdminResponse('facilitators_label',{label}),null);
});
test('Card21b the cases and audit list responses have no client schema any more (A5 removed their dead paths)',()=>{
  for(const operation of ['cases_list','audit_list'])assert.equal(acceptAdminResponse(operation,{versions:[],events:[],nextCursor:null}),null,operation);
  // The mutation answers the workbench still reads keep their exact shape.
  assert.ok(acceptAdminResponse('cases_publish',{version:{version_id:uuidv7(),status:'published',admin_revision:3}}));
  assert.equal(acceptAdminResponse('versions_withdraw',{version:{version_id:uuidv7(),status:'draft',admin_revision:3}}),null);
});
test('Card21b People access: roles and grants are exact, or null when the Worker could not read them',()=>{
  const user={id:randomUUID(),email:'user@example.invalid',invitedAt:stamp,confirmedAt:null,bannedUntil:null,createdAt:stamp,profile:null,label:null};
  const ws=uuidv7(),access={memberships:[{workspaceId:ws,workspaceName:'Northern ICU',role:'author'}],grants:[{caseId:uuidv7(),caseTitle:'Every Breath You Take',workspaceId:ws,workspaceName:'Northern ICU',level:'run'}]};
  assert.ok(acceptAdminResponse('facilitators_list',{users:[{...user,access}],nextPage:null}));
  assert.ok(acceptAdminResponse('facilitators_list',{users:[{...user,access:{memberships:[],grants:[]}}],nextPage:null}));
  for(const bad of [{...access,extra:1},{memberships:[{...access.memberships[0],role:'admin'}],grants:[]},{memberships:[],grants:[{...access.grants[0],level:'manage'}]},{memberships:[{...access.memberships[0],note:'x'}],grants:[]},{memberships:'none',grants:[]}])
    assert.equal(acceptAdminResponse('facilitators_list',{users:[{...user,access:bad}],nextPage:null}),null);
});
test('Card21b live-room schema has only coarse authoritative fields and honestly unknown registration or owner',()=>{
  const room={code:'7K3QX9',sessionId:uuidv7(),registeredAt:null,expiresAt:stamp,ownerEmail:null,phase:'terminal_teaching',participantCount:2};
  assert.ok(acceptAdminResponse('rooms_list',{rooms:[room],nextCursor:'7:7K3QX9'}));
  for(const row of [{...room,names:['private']},{...room,participantCount:-1},{...room,phase:'invented'}])assert.equal(acceptAdminResponse('rooms_list',{rooms:[row],nextCursor:null}),null);
});
test('Card21b consumes actual server epoch elevation expiry and PostgreSQL offset timestamps with exact room-count bounds',()=>{
  const elevation=randomBytes(24).toString('hex');
  // R-a: the elevation lasts the sign-in session, so the response carries no expiry.
  assert.ok(acceptAdminResponse('stepup_verify',{elevation}));
  const room={code:'7K3QX9',sessionId:uuidv7(),registeredAt:'2026-10-03T00:00:00+00:00',expiresAt:'2026-10-03T01:00:00+00:00',ownerEmail:null,phase:'consequence_revealed',participantCount:300};
  assert.ok(acceptAdminResponse('rooms_list',{rooms:[room],nextCursor:null}));
  assert.equal(acceptAdminResponse('rooms_list',{rooms:[{...room,participantCount:301}],nextCursor:null}),null);
  for(const expiresAt of ['2026-10-03T00:00:00.000Z',Infinity,-1,Date.now()+300000])assert.equal(acceptAdminResponse('stepup_verify',{elevation,expiresAt}),null);
  assert.equal(acceptAdminResponse('stepup_verify',{elevation:''}),null);
});
