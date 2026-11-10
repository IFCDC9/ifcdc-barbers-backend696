import test from 'node:test';
import assert from 'node:assert/strict';
import {createBeautyPayPalProvider,beautyPaymentConfig} from '../beautySellerPayments.js';
import {publicSandboxOrder} from '../beautySandboxCheckout.js';
const config=beautyPaymentConfig({BEAUTY_PAYPAL_ONBOARDING_ENABLED:'1',BEAUTY_PAYPAL_ENV:'sandbox',BEAUTY_PAYPAL_CLIENT_ID:'app',BEAUTY_PAYPAL_CLIENT_SECRET:'secret',BEAUTY_PAYPAL_PARTNER_ID:'partner',BEAUTY_PAYPAL_BN_CODE:'code'});
test('known platform-fee denial is retained without exposing arbitrary provider data',async()=>{
 for(const [status,issue,expected] of [[422,'PLATFORM_FEE_NOT_ENABLED','PLATFORM_FEE_NOT_ENABLED'],[500,'PLATFORM_FEE_NOT_ENABLED',undefined],[422,'OTHER',undefined]]){
 const p=createBeautyPayPalProvider({config,fetchImpl:async url=>url.endsWith('/token')?{ok:true,json:async()=>({access_token:'token'})}:{ok:false,status,json:async()=>({details:[{issue}],private:'secret customer data'})}});
 await assert.rejects(p.request('/v2/payments/captures/CAPTURE/refund',{method:'POST'}),e=>{assert.equal(e.message,'seller_provider_request_failed');assert.equal(e.providerIssue,expected);assert.ok(!JSON.stringify(e).includes('secret customer'));return true;});
 }
});
test('public order exposes only the allowlisted refund diagnostic',()=>{
 assert.equal(publicSandboxOrder({refund_issue:'PLATFORM_FEE_NOT_ENABLED'}).refundIssue,'PLATFORM_FEE_NOT_ENABLED');
 assert.equal(publicSandboxOrder({refund_issue:'private provider response'}).refundIssue,null);
});
