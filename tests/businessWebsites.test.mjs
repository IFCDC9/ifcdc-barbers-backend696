import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteService} from '../websiteService.js';
import {defaultWebsite,validateWebsite,visiblePromos,sniffWebsiteMedia} from '../websiteContract.js';
test('website content is bounded, theme controlled, and contains no executable markup fields',()=>{
 const d=defaultWebsite('Shop');assert.equal(validateWebsite({...d,html:'<script>bad</script>'}).html,undefined);
 for(const change of [{accent:'red; background:url(bad)'},{theme:'injected'},{name:'x'.repeat(101)},{gallery:Array(13).fill(null)},{promos:[{title:'Offer',startsAt:'2027-01-02',endsAt:'2027-01-01'}]}])assert.throws(()=>validateWebsite({...d,...change}));
 assert.equal(visiblePromos({...d,promos:[{title:'A',startsAt:'2026-01-01',endsAt:'2026-02-01'},{title:'B',startsAt:null,endsAt:null}]},Date.parse('2026-03-01')).length,1);
});
test('uploads require matching supported magic bytes; HTML and SVG cannot masquerade as images',()=>{
 assert.throws(()=>sniffWebsiteMedia(Buffer.from('<script>alert(1)</script>'),'image/jpeg'));
 assert.throws(()=>sniffWebsiteMedia(Buffer.from('<svg/>'),'image/svg+xml'));
 assert.equal(sniffWebsiteMedia(Buffer.from([255,216,255,0]),'image/jpeg'),'jpg');
 assert.equal(sniffWebsiteMedia(Buffer.from('WEBVTT\n\n'),'text/vtt'),'vtt');
 assert.equal(sniffWebsiteMedia(Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109]),'video/mp4'),'mp4');
});
test('PostgreSQL website isolation, approval, publication, revisions, media and moderation',{skip:process.env.WEBSITE_DB_TESTS!=='1'},async t=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const db=new PGlite();const q=(sql,params)=>sql.startsWith('CREATE TABLE IF NOT EXISTS')?db.exec(sql):db.query(sql,params),owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',founder='33333333-3333-4333-8333-333333333333',barber='44444444-4444-4444-8444-444444444444';let approved=true;
 const service=createWebsiteService({query:q,shopAccess:async()=>({approved,limitedAccess:!approved,websiteAccessEnabled:approved})});
 try{
  await db.exec('CREATE TABLE app_users(id uuid PRIMARY KEY,role text,account_status text,business_id bigint,barber_id text,name text);CREATE TABLE businesses(id bigint PRIMARY KEY,name text);CREATE TABLE barbers(id text PRIMARY KEY,business_id bigint,name text,verification_status text);CREATE TABLE barber_services(barber_id text,name text,price numeric,duration_minutes integer,is_active boolean);');
  for(const [id,role,bid,bid2,name] of [[owner,'shop_owner',1,'11','One'],[other,'shop_owner',2,'22','Two'],[founder,'super_admin',null,null,'Founder'],[barber,'barber',1,'33','Solo']])await q("INSERT INTO app_users VALUES($1::uuid,$2,'active',$3,$4,$5)",[id,role,bid,bid2,name]);
  await db.exec("INSERT INTO businesses VALUES(1,'First shop'),(2,'Second shop');INSERT INTO barbers VALUES('11',1,'One','approved'),('22',2,'Two','approved'),('33',1,'Solo','verified');");
  await t.test('existing owners get persistent distinct draft sites; barber gets a separate site',async()=>{assert.equal((await service.mine(owner)).sites[0].site_key,'shop-1');assert.equal((await service.mine(other)).sites[0].site_key,'shop-2');assert.equal((await service.mine(barber)).sites[0].site_key,'barber-33');await assert.rejects(service.publicSite('shop-1'),/not_found/);});
  await t.test('tenant and stale JWT role claims cannot grant write access',async()=>{await assert.rejects(service.save(other,'shop-1',{revision:1,document:defaultWebsite()}),/access_denied/);await q("UPDATE app_users SET role='user' WHERE id=$1::uuid",[owner]);await assert.rejects(service.save(owner,'shop-1',{revision:1,document:defaultWebsite()}));await q("UPDATE app_users SET role='shop_owner' WHERE id=$1::uuid",[owner]);});
  await t.test('draft edits stay private and stale writes cannot replace them',async()=>{await service.save(owner,'shop-1',{revision:1,document:defaultWebsite('New identity')});await assert.rejects(service.save(owner,'shop-1',{revision:1,document:defaultWebsite('Stale')}),/changed_reload/);await assert.rejects(service.publicSite('shop-1'));});
  await t.test('pending business can design but cannot publish',async()=>{approved=false;await assert.rejects(service.publish(owner,'shop-1',2),/approval_or_access/);approved=true;await service.publish(owner,'shop-1',2);assert.equal((await service.publicSite('shop-1')).document.name,'New identity');assert.equal((await service.publicSite('shop-1')).team.length,2);});
  await t.test('public snapshot is independent of new drafts, and unpublished schedules do not leak',async()=>{await service.save(owner,'shop-1',{revision:3,document:{...defaultWebsite('Private draft'),promos:[{title:'Future',body:'',startsAt:'2099-01-01',endsAt:null}]}});assert.equal((await service.publicSite('shop-1')).document.name,'New identity');await service.publish(owner,'shop-1',4);assert.equal((await service.publicSite('shop-1')).document.promos.length,0);});
  await t.test('cross-tenant media and incorrect video types cannot be published',async()=>{const id='55555555-5555-4555-8555-555555555555';await q("INSERT INTO business_website_media VALUES($1,'shop-2','other/file.jpg','image/jpeg',5,now())",[id]);await assert.rejects(service.save(owner,'shop-1',{revision:5,document:{...defaultWebsite(),heroId:id}}),/belong_to/);await q("UPDATE business_website_media SET site_key='shop-1' WHERE id=$1",[id]);await assert.rejects(service.save(owner,'shop-1',{revision:5,document:{...defaultWebsite(),videos:[{assetId:id,caption:''}]}}),/incorrect_media/);});
  await t.test('only fresh Founder role can moderate; suspension and account access immediately hide public site',async()=>{await assert.rejects(service.moderate(other,'shop-1',true));await service.moderate(founder,'shop-1',true);await assert.rejects(service.publicSite('shop-1'));await service.moderate(founder,'shop-1',false);assert.equal((await service.publicSite('shop-1')).document.name,'Private draft');approved=false;await assert.rejects(service.publicSite('shop-1'));approved=true;});
  await t.test('unpublish removes discovery and public page while preserving the draft',async()=>{await service.unpublish(owner,'shop-1');await assert.rejects(service.publicSite('shop-1'));assert.equal((await service.directory()).length,0);assert.equal((await service.mine(owner)).sites[0].draft.name,'Private draft');});
 }finally{await db.close();}
});
