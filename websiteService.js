import {readFile} from 'node:fs/promises';
import {defaultWebsite,validateWebsite,websiteAssetIds,visiblePromos} from './websiteContract.js';
const denied=(message='website_access_denied',status=403)=>{const e=Error(message);e.status=status;throw e;};
export function createWebsiteService({query,shopAccess}){
 let ready;
 const ensure=()=>ready||(ready=readFile(new URL('./scripts/migrations/business-websites.sql',import.meta.url),'utf8').then(sql=>query(sql)).catch(e=>{ready=null;throw e;}));
 async function user(id){
  const u=(await query('SELECT id,role,account_status,business_id,barber_id,name FROM app_users WHERE id=$1::uuid',[id])).rows[0];
  if(!u||['disabled','suspended'].includes(String(u.account_status).toLowerCase()))denied();return u;
 }
 const founder=u=>u.role==='super_admin';
 async function allowed(u,row,publish=false){
  if(founder(u))return;
  const own=row.kind==='shop'?u.role==='shop_owner'&&String(u.business_id)===row.subject_id:row.kind==='barber'&&u.role==='barber'&&String(u.barber_id)===row.subject_id;
  if(!own)denied();
  if(publish&&String(u.account_status||'active')!=='active')denied('approval_required');
  if(publish&&!await available(row))denied('website_approval_or_access_required');
 }
 async function available(row){
  if(row.suspended)return false;
  if(row.kind==='platform')return true;
  let businessId=row.subject_id;
  if(row.kind==='barber'){
   const b=(await query('SELECT business_id,verification_status FROM barbers WHERE id::text=$1',[row.subject_id])).rows[0];
   if(!b||!['approved','verified'].includes(String(b.verification_status).toLowerCase()))return false;businessId=b.business_id;
  }
  const a=await shopAccess(businessId);return a.approved===true&&!a.limitedAccess&&a.websiteAccessEnabled!==false;
 }
 async function provision(kind,id,name){
  await ensure();const key=kind==='platform'?'ifcdc':kind+'-'+id;
  await query('INSERT INTO business_websites(site_key,kind,subject_id,draft) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(site_key) DO NOTHING',[key,kind,id==null?null:String(id),JSON.stringify(defaultWebsite(name))]);return key;
 }
 async function row(key){await ensure();const r=(await query('SELECT * FROM business_websites WHERE site_key=$1',[key])).rows[0];if(!r)denied('website_not_found',404);return r;}
 async function owned(id,key){const u=await user(id),r=await row(key);await allowed(u,r);return {u,r};}
 async function media(key){return (await query('SELECT id,mime,bytes FROM business_website_media WHERE site_key=$1 ORDER BY created_at DESC',[key])).rows;}
 async function checkAssets(key,d){
  const ids=websiteAssetIds(d);if(!ids.length)return;
  const rows=(await query('SELECT id,mime FROM business_website_media WHERE site_key=$1 AND id=ANY($2::uuid[])',[key,ids])).rows;
  if(rows.length!==ids.length)denied('media_must_belong_to_this_website',400);
  const types=new Map(rows.map(r=>[String(r.id),r.mime]));
  if([d.logoId,d.heroId,...d.gallery,...d.videos.map(v=>v.posterId)].filter(Boolean).some(id=>!types.get(id)?.startsWith('image/'))||d.videos.some(v=>!types.get(v.assetId)?.startsWith('video/')||(v.captionsId&&types.get(v.captionsId)!=='text/vtt')))denied('incorrect_media_type',400);
 }
 return {ensure,provision,owned,media,
  async mine(id){
   const u=await user(id);await ensure();
   if(founder(u))await provision('platform',null,'IFCDC Barbers');
   else if(u.role==='shop_owner'&&u.business_id!=null){const b=(await query('SELECT name FROM businesses WHERE id::text=$1',[String(u.business_id)])).rows[0];await provision('shop',u.business_id,b?.name||u.name);}
   else if(u.role==='barber'&&u.barber_id!=null)await provision('barber',u.barber_id,u.name);
   else denied();
   const list=founder(u)?(await query('SELECT * FROM business_websites ORDER BY updated_at DESC LIMIT 200')).rows:(await query('SELECT * FROM business_websites WHERE kind=$1 AND subject_id=$2',[u.role==='shop_owner'?'shop':'barber',String(u.role==='shop_owner'?u.business_id:u.barber_id)])).rows;
   return {founder:founder(u),sites:await Promise.all(list.map(async r=>({...r,media:await media(r.site_key)})))};
  },
  async save(id,key,body){const {r}=await owned(id,key);const d=validateWebsite(body.document);await checkAssets(key,d);
   const updated=(await query('UPDATE business_websites SET draft=$3::jsonb,revision=revision+1,updated_at=now() WHERE site_key=$1 AND revision=$2 RETURNING *',[key,body.revision,JSON.stringify(d)])).rows[0];if(!updated)denied('website_changed_reload_before_saving',409);return updated;
  },
  async publish(id,key,revision){const {u,r}=await owned(id,key);await allowed(u,r,true);if(r.suspended)denied('website_suspended');await checkAssets(key,validateWebsite(r.draft));
   const updated=(await query('UPDATE business_websites SET published=draft,published_at=now(),revision=revision+1 WHERE site_key=$1 AND revision=$2 RETURNING *',[key,revision])).rows[0];if(!updated)denied('website_changed_reload_before_publishing',409);return updated;
  },
  async unpublish(id,key){await owned(id,key);await query('UPDATE business_websites SET published=NULL,revision=revision+1 WHERE site_key=$1',[key]);},
  async moderate(id,key,suspended){const u=await user(id);if(!founder(u))denied();await row(key);await query('UPDATE business_websites SET suspended=$2,revision=revision+1 WHERE site_key=$1',[key,Boolean(suspended)]);},
  async publicSite(key){const r=await row(key);if(!r.published||!await available(r))denied('website_not_found',404);
   const d=validateWebsite(r.published);d.promos=visiblePromos(d);let team=[];
   if(r.kind!=='platform')team=(await query("SELECT id,name FROM barbers WHERE "+(r.kind==='shop'?'business_id::text=$1':'id::text=$1')+" AND lower(coalesce(verification_status,'')) IN ('approved','verified') ORDER BY name",[r.subject_id])).rows.map(b=>({id:String(b.id),name:b.name}));
   let services=[];
   if(team.length)services=(await query('SELECT barber_id,name,price,duration_minutes FROM barber_services WHERE barber_id::text=ANY($1::text[]) AND is_active=true ORDER BY name',[team.map(b=>b.id)])).rows.map(s=>({barberId:String(s.barber_id),name:s.name,price:Number(s.price),minutes:s.duration_minutes}));
   return {key:r.site_key,kind:r.kind,document:d,team,services,media:(await media(key)).filter(m=>websiteAssetIds(d).includes(String(m.id)))};
  },
  async directory(){await ensure();const rows=(await query("SELECT site_key FROM business_websites WHERE kind<>'platform' AND published IS NOT NULL AND suspended=false ORDER BY published_at DESC LIMIT 100")).rows;const result=[];for(const r of rows){try{const s=await this.publicSite(r.site_key);result.push({key:s.key,kind:s.kind,document:{name:s.document.name,intro:s.document.intro,address:s.document.address,theme:s.document.theme,accent:s.document.accent,heroId:s.document.heroId,logoId:s.document.logoId},media:s.media.filter(m=>[s.document.heroId,s.document.logoId].includes(String(m.id)))});}catch(e){if(e.status!==404)throw e;}}return result;}
 };
}
