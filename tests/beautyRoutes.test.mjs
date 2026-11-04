import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';
// Isolate server boot/dependencies; exercise the actual router with injected auth and DB.
test('HTTP catalog routes enforce authentication, current Founder role and conflicts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beauty-route-'));
 let server;
 try {
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  await mkdir(join(dir,'client/src/lib'),{recursive:true});
  for(const file of ['beautyRoutes.js','beautyCatalogService.js','beautyOrderService.js','client/src/lib/beautyOrderPricing.js','client/src/lib/beautyCatalog.js'])
   await copyFile(new URL('../'+file,import.meta.url),join(dir,file));
  await writeFile(join(dir,'db.js'),'export const dbQuery = () => {throw Error("unexpected live database access")};');
  await writeFile(join(dir,'authRoutes.js'),'export const resolveAuthPayload = () => null;');
  await writeFile(join(dir,'authPlatformJwt.js'),'export const isJwtGlobalSuperScope = u => u?.isSuperAdmin === true;');
  const require=createRequire(import.meta.url);
  const expressDir=dirname(require.resolve('express/package.json'));
  await mkdir(join(dir,'node_modules'));await symlink(expressDir,join(dir,'node_modules/express'));
  const {createBeautyRouter}=await import(pathToFileURL(join(dir,'beautyRoutes.js')));
  let role='super_admin', queries=0;
  const query=async sql=>{
   queries++;
   if(sql.includes('FROM app_users'))return {rows:[{role,account_status:'active'}]};
   if(sql.includes('SELECT revision, catalog'))return {rows:[{revision:0,catalog:{sellers:[],products:[]}}]};
   return {rows:[]};
  };
  const app=express();
  app.use(createBeautyRouter({query,resolveToken:t=>t==='founder'?{id:'user-id',isSuperAdmin:true}:t==='manager'?{id:'manager'}:null}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const request=(path,token,init={})=>fetch(url+path,{...init,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...init.headers}});
  let res=await request('/api/beauty/catalog');assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.deepEqual((await res.json()).products,[]);
  const before=queries;
  assert.equal((await request('/api/beauty/admin/catalog')).status,401);
  assert.equal((await request('/api/beauty/admin/catalog','manager')).status,403);assert.equal(queries,before);
  assert.equal((await request('/api/beauty/admin/catalog','founder')).status,200);
  role='user';assert.equal((await request('/api/beauty/admin/catalog','founder')).status,403);
  role='super_admin';
  assert.equal((await request('/api/beauty/admin/catalog','founder',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,sellers:[],products:[]})})).status,409);
  assert.equal((await request('/api/beauty/admin/catalog','founder',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,sellers:[],products:[{}]})})).status,400);
 } finally {if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
