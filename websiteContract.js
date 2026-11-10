const fail = message => { const e = new Error(message); e.status = 400; throw e; };
const text = (v, max=200) => { if(typeof v!=='string'||v.length>max)fail('invalid_website_content');return v.trim(); };
export const THEMES=['editorial','midnight','studio'];
export const FONTS=['modern','classic','bold'];
export function defaultWebsite(name='Your business') {
 return {name,headline:'Good style starts here.',intro:'A space for great service, personal style, and a fresh perspective.',about:'Welcome to our business. Explore our work and book your next visit.',theme:'editorial',font:'modern',accent:'#b58945',logoId:null,heroId:null,gallery:[],videos:[],promos:[],hours:'Contact us for opening hours.',address:'',phone:''};
}
export function validateWebsite(input) {
 if(!input||typeof input!=='object'||Array.isArray(input))fail('invalid_website_content');
 const d={};for(const [k,max] of Object.entries({name:100,headline:120,intro:600,about:3000,hours:800,address:400,phone:40}))d[k]=text(input[k]??'',max);
 if(!d.name||!d.headline)fail('website_name_and_headline_required');
 if(!THEMES.includes(input.theme)||!FONTS.includes(input.font)||!/^#[0-9a-f]{6}$/i.test(input.accent))fail('invalid_website_theme');
 Object.assign(d,{theme:input.theme,font:input.font,accent:input.accent});
 const asset=v=>{if(v===null||v==='')return null;if(typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))fail('invalid_media');return v;};
 d.logoId=asset(input.logoId??null);d.heroId=asset(input.heroId??null);
 const list=(v,max)=>{if(!Array.isArray(v)||v.length>max)fail('too_many_website_items');return v;};
 d.gallery=list(input.gallery??[],12).map(asset).filter(Boolean);
 d.videos=list(input.videos??[],6).map(v=>({assetId:asset(v.assetId),posterId:asset(v.posterId??null),captionsId:asset(v.captionsId??null),caption:text(v.caption??'',300)}));
 d.promos=list(input.promos??[],6).map(p=>{
  const date=v=>{if(!v)return null;if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))fail('invalid_promo_dates');return new Date(v).toISOString();};
  const item={title:text(p.title,100),body:text(p.body??'',600),startsAt:date(p.startsAt),endsAt:date(p.endsAt)};
  if(!item.title||(item.startsAt&&item.endsAt&&item.startsAt>=item.endsAt))fail('invalid_promo_dates');return item;
 });
 return d;
}
export function websiteAssetIds(d){return [...new Set([d.logoId,d.heroId,...d.gallery,...d.videos.flatMap(v=>[v.assetId,v.posterId,v.captionsId])].filter(Boolean))];}
export function visiblePromos(d,now=Date.now()){return d.promos.filter(p=>(!p.startsAt||Date.parse(p.startsAt)<=now)&&(!p.endsAt||Date.parse(p.endsAt)>now));}
export function sniffWebsiteMedia(buffer,mime){
 if(!Buffer.isBuffer(buffer)||!buffer.length)fail('empty_media');
 const sig=buffer.subarray(0,16);
 if(mime==='image/jpeg'&&sig[0]===255&&sig[1]===216&&sig[2]===255)return 'jpg';
 if(mime==='image/png'&&sig.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(mime==='image/webp'&&sig.toString('ascii',0,4)==='RIFF'&&sig.toString('ascii',8,12)==='WEBP')return 'webp';
 if(mime==='video/mp4'&&sig.toString('ascii',4,8)==='ftyp')return 'mp4';
 if(mime==='video/webm'&&sig.subarray(0,4).equals(Buffer.from([26,69,223,163])))return 'webm';
 if(mime==='text/vtt'&&buffer.toString('utf8').replace(/^\uFEFF/,'').startsWith('WEBVTT')&&!buffer.includes(0))return 'vtt';
 fail('unsupported_media_use_jpg_png_webp_mp4_webm_or_vtt');
}
