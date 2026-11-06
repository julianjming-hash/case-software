// CI load gate (CASE-161): runs only in the `load-gates` job (`npm run test:load-gates`), never in
// `npm test`, so the 1 s p95 budget measures its own runner and not the unit suite's. Budget unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSimulation,runSimulatedRooms}from '../../scripts/simulated-rooms.mjs';
for(const rooms of [1,5])test(`[AS-097] ${rooms} concurrent local rooms with 25 phones complete the MVC with loss recovery and isolated receipts`,{timeout:180000},async()=>{
 const report=await runSimulatedRooms(parseSimulation(['--rooms',String(rooms),'--stagger',rooms===1?'0':'4']));
 assert.equal(report.total.expected_votes,rooms*75);assert.equal(report.total.receipted_votes,rooms*75);
 assert.equal(report.total.lost_votes,0);assert.equal(report.total.duplicate_votes,0);
 assert.equal(report.total.join_recoveries,rooms);assert.equal(report.rooms.length,rooms);
 for(const room of report.rooms){assert.equal(room.participants,25);assert.equal(room.decisions,3);assert.equal(room.ended,true);assert.ok(room.public_payloads>0);assert.ok(room.acknowledgement_ms.p95<1000);assert.deepEqual(Object.keys(room.transport_modes).sort(),['long-poll','poll','ws']);}
 console.log(JSON.stringify(report.total));
});
