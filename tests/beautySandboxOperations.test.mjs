import test from 'node:test';
import assert from 'node:assert/strict';
import {refundRequestBody,verifySandboxRefund} from '../beautySandboxRefundContract.js';
import {verifySandboxWebhook,sandboxWebhookSummary,createSandboxWebhookRouter} from '../beautySandboxWebhooks.js';
import express from 'express';
const row={request_id:'11111111-1111-4111-8111-111111111111',capture_id:'CAPTURE1',amount_cents:'1150',platform_fee_cents:'170'};
const refund=()=>({id:'REFUND1',status:'COMPLETED',custom_id:row.request_id,amount:{currency_code:'USD',value:'11.50'},seller_payable_breakdown:{platform_fees:[{amount:{currency_code:'USD',value:'1.70'}}]},links:[{rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1'}]});
const headers={'paypal-auth-algo':'SHA256withRSA','paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT','paypal-transmission-id':'TRANSMISSION1','paypal-transmission-sig':'signature','paypal-transmission-time':'2026-11-05T15:00:00Z'};
const event={id:'WH-EVENT1',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'CAPTURE1',supplementary_data:{related_ids:{order_id:'ORDER1'}}}};
const provider={config:{configured:true,environment:'sandbox'},request:async()=>({verification_status:'SUCCESS'})};
test('full refund includes the buyer fee and the original platform contribution',()=>{
 const b=refundRequestBody(row);assert.equal(b.amount.value,'11.50');assert.equal(b.payment_instruction.platform_fees[0].amount.value,'1.70');assert.equal(b.custom_id,row.request_id);
 assert.equal(verifySandboxRefund(refund(),row).status,'completed');
});
test('buyer reimbursement without proof of fee return stays in review',()=>{
 const r=refund();delete r.seller_payable_breakdown;const verified=verifySandboxRefund(r,row);assert.equal(verified.status,'review_required');assert.equal(verified.platformFeeCents,null);
 r.status='PENDING';assert.equal(verifySandboxRefund(r,row).status,'pending');
});
test('wrong refund amount, currency, request identity or capture cannot be accepted',()=>{
 for(const mutate of [r=>r.amount.value='10.00',r=>r.amount.currency_code='EUR',r=>r.custom_id='other',r=>r.links[0].href='https://evil.example/v2/payments/captures/CAPTURE1',r=>r.links[0].href='https://api-m.sandbox.paypal.com/v2/payments/captures/OTHER']){const r=refund();mutate(r);assert.throws(()=>verifySandboxRefund(r,row));}
});
test('webhooks require PayPal SUCCESS verification with the configured webhook id',async()=>{
 let body;await verifySandboxWebhook({...provider,request:async(_,o)=>{body=o.body;return {verification_status:'SUCCESS'};}},{BEAUTY_PAYPAL_WEBHOOK_ID:'WEBHOOK1'},headers,event);assert.equal(body.webhook_id,'WEBHOOK1');assert.deepEqual(body.webhook_event,event);
 await assert.rejects(verifySandboxWebhook({...provider,request:async()=>({verification_status:'FAILURE'})},{BEAUTY_PAYPAL_WEBHOOK_ID:'WEBHOOK1'},headers,event),/invalid_webhook_signature/);
 await assert.rejects(verifySandboxWebhook(provider,{},headers,event),/not_configured/);
 await assert.rejects(verifySandboxWebhook(provider,{BEAUTY_PAYPAL_WEBHOOK_ID:'WEBHOOK1'},{...headers,'paypal-cert-url':'https://evil.example/cert'},event),/invalid_webhook/);
});
test('webhook summaries retain identifiers, not customer PII',()=>{
 const s=sandboxWebhookSummary({...event,resource:{...event.resource,payer:{email_address:'private@example.com'},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE1'}]}});
 assert.equal(s.orderId,'ORDER1');assert.equal(s.captureId,'CAPTURE1');assert.equal(JSON.stringify(s).includes('private@example.com'),false);
});
test('an unverified HTTP webhook cannot reach the database',async()=>{
 let touched=false,server;const app=express();
 app.use(createSandboxWebhookRouter({getPool:()=>{touched=true;throw Error('should not run');},provider:{...provider,request:async()=>({verification_status:'FAILURE'})},env:{BEAUTY_PAYPAL_WEBHOOK_ID:'WEBHOOK1'}}));
 try{server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const res=await fetch(`http://127.0.0.1:${server.address().port}/api/beauty/paypal/sandbox-webhook`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(event)});assert.equal(res.status,400);assert.equal(touched,false);}finally{if(server)await new Promise(r=>server.close(r));}
});
