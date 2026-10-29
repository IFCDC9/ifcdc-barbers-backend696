import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {speechPlaybackParts}=require('../auraVoicePlaybackPolicy.cjs');
const {twilioGatherSpeechAttrs}=require('../auraVoiceNoiseControl.cjs');
const source=fs.readFileSync(new URL('../auraVoiceReply.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('function buildVoiceLoopTwiML('),source.indexOf('/** Keep listening without speaking'));
const ctx={speechPlaybackParts,twilioGatherSpeechAttrs,streamingContinueByCall:new Map()};
vm.createContext(ctx); vm.runInContext(block+';this.build=buildVoiceLoopTwiML;',ctx);
for(const enabled of [false,true]) test(`actual phone loop playback protection ${enabled?'enabled':'disabled'}`,()=>{
 const prior=process.env.AURA_VOICE_PROTECT_PLAYBACK;
 try {
 process.env.AURA_VOICE_PROTECT_PLAYBACK=enabled?'1':'0';
 const inner='<Say>Welcome. How may I help?</Say>';
 const xml=ctx.build('/api/aura/voice',{},inner,'<Say>Still here</Say>','test');
 const gather=xml.match(/<Gather[^>]*>([\s\S]*?)<\/Gather>/)[1];
 assert.equal(gather.includes(inner),!enabled);
 assert.equal(xml.split(inner).length-1,1);
 if(enabled) assert.ok(xml.indexOf(inner)<xml.indexOf('<Gather'));
 assert.match(xml,/<Redirect method="POST">\/api\/aura\/voice<\/Redirect>/);
 } finally {if(prior===undefined)delete process.env.AURA_VOICE_PROTECT_PLAYBACK;else process.env.AURA_VOICE_PROTECT_PLAYBACK=prior;}
});
test('continuation path uses the same policy around playback',()=>{
 const continuation=fs.readFileSync(new URL('../auraVoiceboxRoutes.cjs',import.meta.url),'utf8');
 assert.match(continuation,/speechPlaybackParts\(inner\)/);
 assert.match(continuation,/\$\{playback.beforeGather\}[\s\S]*<Gather[\s\S]*\$\{playback.duringGather\}/);
});
