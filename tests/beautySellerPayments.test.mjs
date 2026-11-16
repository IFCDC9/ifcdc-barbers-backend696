import test from 'node:test';
import assert from 'node:assert/strict';
import {beautyPaymentConfig,publicBeautyPaymentConfig,createBeautyPayPalProvider,verifiedSellerStatus,createBeautySellerPaymentStore,publicSellerConnectionFailure} from '../beautySellerPayments.js';
const env={BEAUTY_PAYPAL_ONBOARDING_ENABLED:'1',BEAUTY_PAYPAL_ENV:'sandbox',BEAUTY_PAYPAL_CLIENT_ID:'partner-app',BEAUTY_PAYPAL_CLIENT_SECRET:'secret',BEAUTY_PAYPAL_PARTNER_ID:'PARTNER1',BEAUTY_PAYPAL_BN_CODE:'IFCDC_CODE'};
const config=beautyPaymentConfig(env), tracking='tracking-server-generated';
const valid=()=>({merchant_id:'MERCHANT1',tracking_id:tracking,payments_receivable:true,primary_email_confirmed:true,
 oauth_integrations:[{integration_type:'OAUTH_THIRD_PARTY',oauth_third_party:[{partner_client_id:config.clientId,scopes:['https://uri.paypal.com/services/payments/payment/authcapture','https://uri.paypal.com/services/payments/refund']}]}]});
test('marketplace config is separate, disabled by default and never exposes credentials',()=>{
 assert.equal(beautyPaymentConfig({PAYPAL_CLIENT_ID:'booking',PAYPAL_CLIENT_SECRET:'booking-secret'}).configured,false);
 assert.equal(beautyPaymentConfig({...env,BEAUTY_PAYPAL_ENV:'typo'}).configured,false);
 const p=publicBeautyPaymentConfig(config);assert.equal(p.configured,true);assert.equal(p.checkoutEnabled,false);
 assert.equal(JSON.stringify(p).includes('secret'),false);assert.equal('clientId' in p,false);
});
test('seller authorization requires verified identity, current app scopes and confirmed email',()=>{
 assert.equal(verifiedSellerStatus(valid(),tracking,config).status,'account_authorized');
 for(const field of ['payments_receivable','primary_email_confirmed']){const d=valid();d[field]='true';assert.equal(verifiedSellerStatus(d,tracking,config).status,'pending');}
 const d=valid();d.oauth_integrations[0].oauth_third_party[0].partner_client_id='wrong';assert.equal(verifiedSellerStatus(d,tracking,config).status,'pending');
 assert.throws(()=>verifiedSellerStatus({...valid(),tracking_id:'other'},tracking,config),/identity_mismatch/);
});
test('setup requests partner fee permission without claiming seller consent; rejects unsafe URLs',async()=>{
 let body;const calls=[];
 const fetchImpl=async(url,init)=>{calls.push(url);if(url.endsWith('/token'))return {ok:true,json:async()=>({access_token:'token'})};body=JSON.parse(init.body);return {ok:true,json:async()=>({links:[{rel:'action_url',method:'GET',href:'https://www.sandbox.paypal.com/setup'}]})};};
 const p=createBeautyPayPalProvider({config,fetchImpl});assert.equal(await p.start(tracking),'https://www.sandbox.paypal.com/setup');
 assert.equal(body.tracking_id,tracking);assert.equal('legal_consents' in body,false);assert.ok(body.operations[0].api_integration_preference.rest_api_integration.third_party_details.features.includes('PARTNER_FEE'));
 assert.ok(calls.every(u=>u.startsWith('https://api-m.sandbox.paypal.com/')));
 for(const href of ['https://evil.example/setup','javascript:alert(1)','https://www.paypal.com/setup']){
 const p=createBeautyPayPalProvider({config,fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'token'}:{links:[{rel:'action_url',method:'GET',href}]}})});
 await assert.rejects(p.start(tracking),/invalid_seller_setup_link/);
 }
});
test('provider verifies merchant through tracking lookup and authenticated detail request',async()=>{
 const urls=[];const p=createBeautyPayPalProvider({config,fetchImpl:async url=>{urls.push(url);return {ok:true,json:async()=>url.endsWith('/token')?{access_token:'token'}:valid()};}});
 assert.equal((await p.verify(tracking)).merchantId,'MERCHANT1');assert.ok(urls.some(u=>u.includes('?tracking_id='+tracking)));assert.ok(urls.some(u=>u.endsWith('/MERCHANT1')));
});
test('refresh clears stale authorization when seller is no longer found; uses bound environment/account scope',async()=>{
 const calls=[];const row={tracking_id:tracking,merchant_id:'MERCHANT1',status:'account_authorized'};
 const query=async(sql,args)=>{calls.push({sql,args});return {rows:[sql.startsWith('UPDATE')?{status:args[5],payments_receivable:args[6],email_confirmed:args[7],permissions_granted:args[8]}:row]};};
 const store=createBeautySellerPaymentStore(query,{config,verify:async()=>null});
 const result=await store.refresh('seller','founder');assert.equal(result.status,'pending');assert.equal(result.permissionsGranted,false);
 assert.deepEqual(calls[1].args.slice(0,4),['seller','sandbox','partner-app','PARTNER1']);
});
test('an existing account cannot silently be rebound to a different merchant',async()=>{
 const store=createBeautySellerPaymentStore(async()=>({rows:[{tracking_id:tracking,merchant_id:'ORIGINAL1'}]}),{config,verify:async()=>({merchantId:'OTHER1'})});
 await assert.rejects(store.refresh('seller','founder'),/seller_identity_mismatch/);
});
function paypalFetch({oauthStatus=200,token='token',status=200,payload}){
 return async url=>{
  if(String(url).endsWith('/token')){
   return {ok:oauthStatus>=200&&oauthStatus<300,status:oauthStatus,json:async()=>(token?{access_token:token}:{})};
  }
  const response={ok:status>=200&&status<300,status,json:async()=>payload};
  response.clone=()=>response;return response;
 };
}
test('seller connection failures classify oauth, referral, setup URL and database without leaking secrets',async()=>{
 const missing=createBeautyPayPalProvider({config:beautyPaymentConfig({BEAUTY_PAYPAL_ENV:'sandbox'})});
 await assert.rejects(missing.start(tracking),e=>{
  assert.equal(publicSellerConnectionFailure(e).error,'seller_payments_not_configured');
  assert.equal(publicSellerConnectionFailure(e).stage,'configuration');return true;
 });
 const oauth=createBeautyPayPalProvider({config,fetchImpl:paypalFetch({oauthStatus:401,payload:{error:'invalid_client',access_token:'leak'}})});
 await assert.rejects(oauth.start(tracking),e=>{
  const body=publicSellerConnectionFailure(e);
  assert.equal(body.error,'seller_provider_auth_failed');assert.equal(body.stage,'oauth');assert.equal(body.httpStatus,401);
  assert.equal(JSON.stringify(body).includes('leak'),false);assert.equal(JSON.stringify(e).includes('leak'),false);return true;
 });
 const referral=createBeautyPayPalProvider({config,fetchImpl:paypalFetch({status:422,payload:{name:'UNPROCESSABLE_ENTITY',debug_id:'abcdef12',details:[{issue:'PLATFORM_FEE_NOT_ENABLED'}],private:'secret customer data'}})});
 await assert.rejects(referral.start(tracking),e=>{
  const body=publicSellerConnectionFailure(e);
  assert.equal(body.error,'seller_provider_request_failed');assert.equal(body.stage,'partner_referral');
  assert.equal(body.httpStatus,422);assert.equal(body.issue,'PLATFORM_FEE_NOT_ENABLED');assert.equal(body.debugId,'abcdef12');
  assert.equal(JSON.stringify(body).includes('secret'),false);return true;
 });
 const badUrl=createBeautyPayPalProvider({config,fetchImpl:paypalFetch({payload:{links:[{rel:'action_url',method:'GET',href:'https://evil.example/setup'}]}})});
 await assert.rejects(badUrl.start(tracking),e=>{
  const body=publicSellerConnectionFailure(e);
  assert.equal(body.error,'invalid_seller_setup_link');assert.equal(body.stage,'setup_url');return true;
 });
 const store=createBeautySellerPaymentStore(async()=>({rows:[]}),{config,start:async()=>'https://www.sandbox.paypal.com/setup'});
 await assert.rejects(store.start('seller','11111111-1111-1111-1111-111111111111'),e=>{
  const body=publicSellerConnectionFailure(e);
  assert.equal(body.error,'seller_connection_unavailable');assert.equal(body.stage,'database');return true;
 });
});
