import express from 'express';
import {randomUUID} from 'node:crypto';
import {sniffWebsiteMedia} from './websiteContract.js';
const BUCKET='business-website-media';
export function createWebsiteRouter({service,query,auth,storageClient}){
 const router=express.Router();let bucketReady;
 const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
 async function storage(){const client=storageClient();if(!client){const e=Error('website_storage_not_configured');e.status=503;throw e;}return client.storage;}
 async function bucket(){return bucketReady||(bucketReady=(async()=>{const s=await storage();const {data,error}=await s.getBucket(BUCKET);if(error){const made=await s.createBucket(BUCKET,{public:false,fileSizeLimit:50*1024*1024,allowedMimeTypes:['image/jpeg','image/png','image/webp','video/mp4','video/webm','text/vtt']});if(made.error&&!/already exists/i.test(made.error.message))throw Error('website_storage_unavailable');}else if(data.public)throw Error('website_storage_must_be_private');})().catch(e=>{bucketReady=null;throw e;}));}
 async function withUrls(site){
  if(!site.media?.length)return site;const s=await storage();const ids=site.media.map(m=>m.id);
  const rows=(await query('SELECT id,storage_path FROM business_website_media WHERE site_key=$1 AND id=ANY($2::uuid[])',[site.key||site.site_key,ids])).rows;
  const urls=new Map();await Promise.all(rows.map(async r=>{const signed=await s.from(BUCKET).createSignedUrl(r.storage_path,3600);if(signed.error)throw Error('website_media_unavailable');urls.set(String(r.id),signed.data.signedUrl);}));
  return {...site,media:site.media.map(m=>({...m,url:urls.get(String(m.id))}))};
 }
 router.get('/api/websites/directory',wrap(async(req,res)=>{res.set('Cache-Control','no-store').json({sites:await Promise.all((await service.directory()).map(withUrls))});}));
 router.get('/api/websites/public/:key',wrap(async(req,res)=>{res.set('Cache-Control','no-store').json(await withUrls(await service.publicSite(req.params.key)));}));
 router.get('/api/websites/mine',auth,wrap(async(req,res)=>{const data=await service.mine(req.user.id);data.sites=await Promise.all(data.sites.map(withUrls));res.set('Cache-Control','no-store').json(data);}));
 router.put('/api/websites/:key',auth,wrap(async(req,res)=>res.json(await service.save(req.user.id,req.params.key,req.body))));
 router.post('/api/websites/:key/publish',auth,wrap(async(req,res)=>res.json(await service.publish(req.user.id,req.params.key,req.body.revision))));
 router.post('/api/websites/:key/unpublish',auth,wrap(async(req,res)=>{await service.unpublish(req.user.id,req.params.key);res.json({ok:true});}));
 router.post('/api/websites/:key/moderate',auth,wrap(async(req,res)=>{if(typeof req.body.suspended!=='boolean')return res.status(400).json({error:'invalid_moderation_action'});await service.moderate(req.user.id,req.params.key,req.body.suspended);res.json({ok:true});}));
 // Direct binary upload avoids base64 expansion and never writes to Render's ephemeral disk.
 router.post('/api/websites/:key/media',auth,(req,res,next)=>service.owned(req.user.id,req.params.key).then(()=>next(),next),express.raw({type:()=>true,limit:'50mb'}),wrap(async(req,res)=>{
  const key=req.params.key,mime=String(req.get('Content-Type')||'').split(';')[0];const ext=sniffWebsiteMedia(req.body,mime);
  if((mime.startsWith('image/')&&req.body.length>8*1024*1024)||(mime==='text/vtt'&&req.body.length>1024*1024))return res.status(413).json({error:'image_limit_8mb_captions_limit_1mb'});
  const usage=(await query('SELECT count(*)::int AS count,coalesce(sum(bytes),0) AS bytes FROM business_website_media WHERE site_key=$1',[key])).rows[0];
  if(Number(usage.count)>=100||Number(usage.bytes)+req.body.length>500*1024*1024)return res.status(413).json({error:'website_media_quota_reached'});
  await bucket();const s=await storage(),id=randomUUID(),path=key+'/'+id+'.'+ext;
  const uploaded=await s.from(BUCKET).upload(path,req.body,{contentType:mime,upsert:false});if(uploaded.error)throw Error('website_upload_failed');
  try{await query('INSERT INTO business_website_media(id,site_key,storage_path,mime,bytes) VALUES($1::uuid,$2,$3,$4,$5)',[id,key,path,mime,req.body.length]);}catch(e){await s.from(BUCKET).remove([path]);throw e;}
  const {data,error}=await s.from(BUCKET).createSignedUrl(path,3600);if(error)throw Error('website_media_unavailable');res.status(201).json({id,mime,bytes:req.body.length,url:data.signedUrl});
 }));
 router.use('/api/websites',(err,req,res,next)=>{if(res.headersSent)return next(err);console.warn('[websites]',err.message);res.status(err.status||500).json({error:err.status&&err.status<500?err.message:'website_request_failed'});});
 return router;
}
