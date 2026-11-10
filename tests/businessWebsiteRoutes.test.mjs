import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createWebsiteRouter} from '../websiteRoutes.js';
test('HTTP editor authorization precedes uploads; validated uploads remain scoped and private',async()=>{
 let stored=false,inserted=false,created=false;const statements=[];
 const service={owned:async(id,key)=>{if(key!=='shop-1'){const e=Error('website_access_denied');e.status=403;throw e;}},mine:async()=>({sites:[]}),directory:async()=>[],save:async()=>({revision:2})};
 const query=async(sql,params)=>{statements.push({sql,params});if(sql.startsWith('SELECT count'))return {rows:[{count:0,bytes:0}]};if(sql.startsWith('INSERT'))inserted=true;return {rows:[]};};
 const storageClient=()=>({storage:{getBucket:async()=>({error:{message:'not found'}}),createBucket:async(name,opts)=>{created=true;assert.equal(opts.public,false);return {};},from:()=>({upload:async(path,body,options)=>{stored=true;assert.ok(path.startsWith('shop-1/'));assert.equal(options.upsert,false);return {};},createSignedUrl:async(path,expiry)=>{assert.equal(expiry,3600);return {data:{signedUrl:'https://storage.example/signed'}};},remove:async()=>({})})}});
 const app=express();app.use(express.json());app.use(createWebsiteRouter({service,query,storageClient,auth:(req,res,next)=>{if(req.get('Authorization')!=='Bearer test')return res.sendStatus(401);req.user={id:'owner'};next();}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const req=(key,body,auth=true)=>fetch(base+'/api/websites/'+key+'/media',{method:'POST',headers:{'Content-Type':'image/jpeg',...(auth?{Authorization:'Bearer test'}:{})},body});
  assert.equal((await req('shop-1',Buffer.from([255,216,255]),false)).status,401);assert.equal(stored,false);
  assert.equal((await req('shop-2',Buffer.from([255,216,255]))).status,403);assert.equal(stored,false);
  assert.equal((await req('shop-1',Buffer.from('<html>bad</html>'))).status,400);assert.equal(stored,false);
  const uploaded=await req('shop-1',Buffer.from([255,216,255,0]));assert.equal(uploaded.status,201);const data=await uploaded.json();assert.equal(data.mime,'image/jpeg');assert.equal(data.url,'https://storage.example/signed');assert.equal(created,true);assert.equal(stored,true);assert.equal(inserted,true);
  assert.ok(statements.find(s=>s.sql.startsWith('INSERT')).params.includes('shop-1'));
 }finally{await new Promise(r=>server.close(r));}
});
