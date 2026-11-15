import { randomUUID } from 'node:crypto';

const fail = code => { const e = new Error(code); e.code=code; throw e; };
const required = ['BEAUTY_PAYPAL_CLIENT_ID','BEAUTY_PAYPAL_CLIENT_SECRET','BEAUTY_PAYPAL_PARTNER_ID','BEAUTY_PAYPAL_BN_CODE'];
const PAYPAL_ISSUE=/^[A-Z][A-Z0-9_]{1,79}$/;
const PAYPAL_DEBUG_ID=/^[a-f0-9]{8,64}$/i;
const SELLER_ERROR=/^[a-z][a-z0-9_]{1,80}$/;
export function paypalPublicDiagnostic(data,httpStatus) {
  const fromDetails=Array.isArray(data?.details)
    ? data.details.find(detail=>PAYPAL_ISSUE.test(detail?.issue || ''))?.issue
    : undefined;
  const fromName=PAYPAL_ISSUE.test(data?.name || '')?data.name:undefined;
  const issue=fromDetails || fromName;
  const debugId=typeof data?.debug_id==='string' && PAYPAL_DEBUG_ID.test(data.debug_id)?data.debug_id:undefined;
  const status=Number.isInteger(httpStatus) && httpStatus>=400 && httpStatus<600?httpStatus:undefined;
  return {httpStatus:status,issue,debugId};
}
export function paypalRequestOperation(method,path) {
  if(method==='POST' && path==='/v2/customer/partner-referrals') return 'partner_referral';
  if(method==='POST' && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) return 'submit';
  if(method==='GET' && /^\/v2\/payments\/refunds\/[^/]+$/.test(path)) return 'lookup';
  return null;
}
export function publicSellerConnectionFailure(error) {
  const code=SELLER_ERROR.test(error?.code || '')?error.code:SELLER_ERROR.test(error?.message || '')?error.message:undefined;
  const operation=typeof error?.operation==='string'?error.operation:undefined;
  const stage=code==='seller_payments_not_configured'?'configuration'
    :code==='seller_connection_missing' || code==='seller_connection_unavailable' || operation==='database'?'database'
    :code==='seller_provider_auth_failed' || operation==='oauth'?'oauth'
    :code==='invalid_seller_setup_link'?'setup_url'
    :code==='seller_identity_mismatch'?'identity'
    :code==='seller_provider_request_failed' && operation==='partner_referral'?'partner_referral'
    :code==='seller_provider_request_failed'?'provider'
    :'unknown';
  const errorCode=stage==='unknown'?'seller_connection_unavailable':code;
  const diagnostic=paypalPublicDiagnostic({
    name:error?.providerIssue || error?.issue,
    debug_id:error?.debugId,
    details:error?.providerIssue || error?.issue?[{issue:error.providerIssue || error.issue}]:undefined,
  },error?.httpStatus);
  return {error:errorCode,stage,
    ...(diagnostic.httpStatus?{httpStatus:diagnostic.httpStatus}:{}),
    ...(diagnostic.issue?{issue:diagnostic.issue}:{}),
    ...(diagnostic.debugId?{debugId:diagnostic.debugId}:{})};
}
// Dedicated marketplace credentials: never reuse or change booking PayPal settings.
export function beautyPaymentConfig(env=process.env) {
  const environment=String(env.BEAUTY_PAYPAL_ENV || 'sandbox').trim();
  const missing=required.filter(k=>!String(env[k] || '').trim());
  const enabled=env.BEAUTY_PAYPAL_ONBOARDING_ENABLED === '1';
  const validEnvironment=['sandbox','live'].includes(environment);
  const config={environment,enabled,missing,configured:enabled && validEnvironment && !missing.length,
    clientId:String(env.BEAUTY_PAYPAL_CLIENT_ID || '').trim(),secret:String(env.BEAUTY_PAYPAL_CLIENT_SECRET || '').trim(),
    partnerId:String(env.BEAUTY_PAYPAL_PARTNER_ID || '').trim(),bnCode:String(env.BEAUTY_PAYPAL_BN_CODE || '').trim()};
  config.apiBase=environment==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
  return config;
}
export function publicBeautyPaymentConfig(config) {
  return {environment:config.environment,enabled:config.enabled,configured:config.configured,missing:config.missing,
    checkoutEnabled:false,requiresPartnerApproval:true,
    clientIdSet:Boolean(config.clientId),clientSecretSet:Boolean(config.secret),
    partnerIdSet:Boolean(config.partnerId),bnCodeSet:Boolean(config.bnCode)};
}
export function sellerConnectionSummary(row) {
  return {status:row?.status || 'not_connected',lastCheckedAt:row?.checked_at || null,
    paymentsReceivable:row?.payments_receivable === true,emailConfirmed:row?.email_confirmed === true,
    permissionsGranted:row?.permissions_granted === true,checkoutEnabled:false};
}
export function verifiedSellerStatus(data,trackingId,config) {
  if (data?.tracking_id!==trackingId || typeof data?.merchant_id!=='string' || !/^[A-Z0-9]{5,32}$/.test(data.merchant_id)) fail('seller_identity_mismatch');
  const integrations=Array.isArray(data.oauth_integrations)?data.oauth_integrations:[];
  const permissionsGranted=integrations.some(i=>i.integration_type==='OAUTH_THIRD_PARTY' &&
    Array.isArray(i.oauth_third_party) && i.oauth_third_party.some(p=>p.partner_client_id===config.clientId &&
      Array.isArray(p.scopes) && p.scopes.includes('https://uri.paypal.com/services/payments/payment/authcapture') &&
      p.scopes.includes('https://uri.paypal.com/services/payments/refund')));
  const paymentsReceivable=data.payments_receivable===true, emailConfirmed=data.primary_email_confirmed===true;
  return {merchantId:data.merchant_id,permissionsGranted,paymentsReceivable,emailConfirmed,
    status:permissionsGranted && paymentsReceivable && emailConfirmed?'account_authorized':'pending'};
}
export function createBeautyPayPalProvider({config=beautyPaymentConfig(),fetchImpl=globalThis.fetch}={}) {
  async function request(path,{method='GET',body,requestId,merchantId}={}) {
    if(!config.configured) fail('seller_payments_not_configured');
    const oauth=await fetchImpl(config.apiBase+'/v1/oauth2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Basic '+Buffer.from(config.clientId+':'+config.secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},
      body:'grant_type=client_credentials'});
    if(!oauth.ok){
      const e=new Error('seller_provider_auth_failed');e.code='seller_provider_auth_failed';e.operation='oauth';
      e.httpStatus=Number.isInteger(oauth.status)?oauth.status:undefined;throw e;
    }
    const token=await oauth.json();if(typeof token.access_token!=='string' || !token.access_token){
      const e=new Error('seller_provider_auth_failed');e.code='seller_provider_auth_failed';e.operation='oauth';throw e;
    }
    const response=await fetchImpl(config.apiBase+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json','PayPal-Partner-Attribution-Id':config.bnCode,Prefer:'return=representation',...(requestId?{'PayPal-Request-Id':requestId}:{}),...(merchantId?{'PayPal-Auth-Assertion':Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:config.clientId,payer_id:merchantId})).toString('base64url')+'.'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const operation=paypalRequestOperation(method,path);
    let data=null;
    if(!response.ok){
      try{data=await response.json();}catch{data=null;}
      const diagnostic=paypalPublicDiagnostic(data,response.status);
      if(config.environment==='sandbox' && operation){
        console.warn('[beauty-sandbox-refund] PayPal response', {
          operation, httpStatus: diagnostic.httpStatus, issue: diagnostic.issue, debugId: diagnostic.debugId,
        });
      }
      if(response.status===404 && operation!=='partner_referral') return null;
      const e=new Error('seller_provider_request_failed');e.code='seller_provider_request_failed';
      if(operation)e.operation=operation;
      e.httpStatus=diagnostic.httpStatus;e.issue=diagnostic.issue;e.debugId=diagnostic.debugId;
      if(response.status===422&&data?.details?.some(d=>d.issue==='PLATFORM_FEE_NOT_ENABLED'))e.providerIssue='PLATFORM_FEE_NOT_ENABLED';
      throw e;
    }
    return response.json();
  }
  return {config,request,
    async start(trackingId) {
      const data=await request('/v2/customer/partner-referrals',{method:'POST',body:{tracking_id:trackingId,
        operations:[{operation:'API_INTEGRATION',api_integration_preference:{rest_api_integration:{integration_method:'PAYPAL',integration_type:'THIRD_PARTY',third_party_details:{features:['PAYMENT','REFUND','PARTNER_FEE']}}}}],
        products:['EXPRESS_CHECKOUT']}});
      // The seller grants consent at PayPal; never assert their consent from a Founder click.
      const link=data?.links?.find(l=>l.rel==='action_url' && l.method==='GET')?.href;
      let url;try {url=new URL(link);}catch {fail('invalid_seller_setup_link');}
      const host=config.environment==='live'?'www.paypal.com':'www.sandbox.paypal.com';
      if(url.protocol!=='https:' || url.hostname!==host || url.username || url.password || url.port) fail('invalid_seller_setup_link');
      return url.href;
    },
    async verify(trackingId) {
      const base='/v1/customer/partners/'+encodeURIComponent(config.partnerId)+'/merchant-integrations';
      const found=await request(base+'?tracking_id='+encodeURIComponent(trackingId));
      if(!found) return null;
      // Support the list wrapper and the direct tracking response. Never accept a client merchant ID.
      const matches=Array.isArray(found.merchant_integrations)?found.merchant_integrations.filter(x=>x.tracking_id===trackingId):[found];
      if(matches.length!==1) fail('seller_identity_mismatch');
      const candidate=matches[0];
      if(candidate.tracking_id!==trackingId || !/^[A-Z0-9]{5,32}$/.test(candidate.merchant_id || '')) fail('seller_identity_mismatch');
      const detail=await request(base+'/'+encodeURIComponent(candidate.merchant_id));
      if(!detail) return null;
      return verifiedSellerStatus(detail,trackingId,config);
    }
  };
}
export function createBeautySellerPaymentStore(query,provider=createBeautyPayPalProvider()) {
  const c=provider.config;
  function assertConfigured(){if(!c.configured)fail('seller_payments_not_configured');}
  const scope=sellerId=>[sellerId,c.environment,c.clientId,c.partnerId];
  async function read(sellerId){
    const r=await query(`SELECT * FROM beauty_seller_payment_accounts WHERE seller_id=$1 AND environment=$2 AND partner_client_id=$3 AND partner_id=$4`,scope(sellerId));
    return r.rows?.[0] || null;
  }
  return {config:c,
    async status(sellerId){return sellerConnectionSummary(await read(sellerId));},
    async start(sellerId,actorId){
      assertConfigured();
      const r=await query(`INSERT INTO beauty_seller_payment_accounts (seller_id,environment,partner_client_id,partner_id,tracking_id,created_by)
        VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid)
        ON CONFLICT (seller_id,environment,partner_client_id,partner_id) DO UPDATE SET seller_id=EXCLUDED.seller_id RETURNING *`,[...scope(sellerId),randomUUID(),actorId]);
      const row=r.rows?.[0];if(!row)fail('seller_connection_unavailable');
      return {setupUrl:await provider.start(row.tracking_id),connection:sellerConnectionSummary(row)};
    },
    async refresh(sellerId,actorId){
      assertConfigured();const row=await read(sellerId);if(!row)fail('seller_connection_missing');
      const state=await provider.verify(row.tracking_id);
      if(row.merchant_id && state && row.merchant_id!==state.merchantId)fail('seller_identity_mismatch');
      const r=await query(`UPDATE beauty_seller_payment_accounts SET merchant_id=COALESCE($5,merchant_id),status=$6,
        payments_receivable=$7,email_confirmed=$8,permissions_granted=$9,checked_at=now(),updated_by=$10::uuid
        WHERE seller_id=$1 AND environment=$2 AND partner_client_id=$3 AND partner_id=$4 RETURNING *`,
      [...scope(sellerId),state?.merchantId || null,state?.status || 'pending',state?.paymentsReceivable || false,state?.emailConfirmed || false,state?.permissionsGranted || false,actorId]);
      return sellerConnectionSummary(r.rows?.[0]);
    }
  };
}
