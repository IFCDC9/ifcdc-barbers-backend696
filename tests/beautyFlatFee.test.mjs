import test from 'node:test';
import assert from 'node:assert/strict';
import {beautyBagTotals,beautyRefundTerms,BEAUTY_PRICING_POLICY} from '../client/src/lib/beautyOrderPricing.js';
import {quoteBeautyOrder} from '../beautyOrderService.js';
import {sandboxPurchaseUnits,verifySandboxOrder,usd,cents} from '../beautySandboxPaymentContract.js';
import {sandboxRefundTargets,refundRequestBody,verifySandboxRefund} from '../beautySandboxRefundContract.js';
const catalog={sellers:[{id:'a',name:'A',status:'approved'},{id:'b',name:'B',status:'approved'}],products:[{id:'one',sellerId:'a',name:'One',brand:'Test',status:'published',category:'Hair care',priceCents:1000,stock:2,fulfillment:['pickup'],pickupLocation:'Test location'},{id:'two',sellerId:'b',name:'Two',brand:'Test',status:'published',category:'Hair care',priceCents:500,stock:2,fulfillment:['pickup'],pickupLocation:'Test location'}]};
const order=(multi=false)=>({id:'order-id',paypal_order_id:'PAYPAL1',bindings:[{sellerId:'a',merchantId:'SELLER1'},{sellerId:'b',merchantId:'SELLER2'}],quote:quoteBeautyOrder(catalog,[{productId:'one',quantity:1},...(multi?[{productId:'two',quantity:1}]:[])])});
const captures=o=>sandboxPurchaseUnits(o,'PARTNER1').map((u,i)=>({capture_id:'CAPTURE'+i,seller_id:u.reference_id,details:{sellerId:u.reference_id,merchantId:u.payee.merchant_id,grossCents:cents(u.amount),platformFeeCents:u.payment_instruction.platform_fees?cents(u.payment_instruction.platform_fees[0].amount):0}}));
test('one buyer fee, zero commission, and exact retained-fee refund totals',()=>{
 assert.deepEqual(beautyRefundTerms(order().quote),{refundPolicy:'product_subtotal_only_v1',refundAmountCents:1000,retainedPlatformFeeCents:250});
 const q=beautyBagTotals(1000,1);assert.equal(q.totalBeforeTaxShippingCents,1250);assert.equal(q.sellerNetCents,1000);assert.equal(q.commissionCents,0);assert.equal(q.platformRevenueCents,250);
 assert.equal(beautyBagTotals(0,0).platformFeeCents,0);
});
test('multi-seller allocations collect one fee and refund product proceeds only',()=>{
 const o=order(true),units=sandboxPurchaseUnits(o,'PARTNER1'),targets=sandboxRefundTargets(o,captures(o),'PARTNER1');
 assert.equal(units.reduce((n,u)=>n+cents(u.amount),0),1750);
 assert.equal(units.filter(u=>u.payment_instruction.platform_fees).length,1);
 assert.equal(targets.reduce((n,t)=>n+t.amountCents,0),1500);assert.ok(targets.every(t=>t.platformFeeCents===0));
 for(const t of targets)assert.deepEqual(refundRequestBody({amount_cents:t.amountCents,platform_fee_cents:t.platformFeeCents,request_id:'request'}).payment_instruction,{platform_fees:[{amount:usd(0)}]});
});
test('new capture verification accepts a seller with no commission or platform-fee leg',()=>{
 const o=order(true),units=sandboxPurchaseUnits(o,'PARTNER1');
 for(const [i,u] of units.entries()){const fee=u.payment_instruction.platform_fees||[];u.payments={captures:[{id:'CAPTURE'+i,status:'COMPLETED',final_capture:true,amount:u.amount,seller_receivable_breakdown:{gross_amount:u.amount,paypal_fee:usd(25),platform_fees:fee,net_amount:usd(cents(u.amount)-25-(fee[0]?cents(fee[0].amount):0))}}]};}
 const verified=verifySandboxOrder({id:o.paypal_order_id,intent:'CAPTURE',status:'COMPLETED',purchase_units:units},o,'PARTNER1',{captured:true});
 assert.equal(verified.reduce((n,c)=>n+c.platformFeeCents,0),250);assert.equal(verified.reduce((n,c)=>n+c.netCents,0),1450);
});
test('unexpected fee refunds, wrong policy, and mismatched capture cannot be accepted',()=>{
 const o=order();assert.equal(o.quote.pricingPolicy,BEAUTY_PRICING_POLICY);
 for(const change of [{platformFeeCents:150},{commissionCents:20},{refundPolicy:'other'},{totalBeforeTaxShippingCents:1150}])assert.throws(()=>sandboxPurchaseUnits({...o,quote:{...o.quote,...change}},'PARTNER1'));
 const wrong=captures(o);wrong[0].details.grossCents=1150;assert.throws(()=>sandboxRefundTargets(o,wrong,'PARTNER1'));
 const row={capture_id:'CAPTURE0',request_id:'request',amount_cents:1000,platform_fee_cents:0};
 const response={id:'REFUND1',custom_id:'request',status:'COMPLETED',amount:usd(1000),links:[{rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE0'}]};
 assert.equal(verifySandboxRefund(response,row).status,'completed');
 assert.equal(verifySandboxRefund({...response,seller_payable_breakdown:{platform_fees:[{amount:usd(0)}]}},row).status,'completed');
 assert.equal(verifySandboxRefund({...response,seller_payable_breakdown:{platform_fees:[{amount:usd(200)}],net_amount:usd(800)}},row).status,'review_required');
 assert.equal(verifySandboxRefund({...response,seller_payable_breakdown:{platform_fees:[{amount:usd(250)}]}},row).status,'review_required');
 assert.throws(()=>verifySandboxRefund({...response,amount:usd(1250)},row));
});
test('invalid saved refund amounts fail before requesting money',()=>{
 for(const change of [{amount_cents:0},{amount_cents:1000.5},{platform_fee_cents:-1},{platform_fee_cents:1001},{platform_fee_cents:'bad'}])assert.throws(()=>refundRequestBody({amount_cents:1000,platform_fee_cents:0,request_id:'request',...change}),/refund_request_invalid/);
});
test('legacy quotes keep the original full-payment refund and fee-return request',()=>{
 const legacy={pricingPolicy:'seller_commission_v1',totalBeforeTaxShippingCents:1150};
 assert.equal(beautyRefundTerms(legacy).refundAmountCents,1150);assert.equal(beautyRefundTerms(legacy).retainedPlatformFeeCents,0);
 const body=refundRequestBody({request_id:'old-request',amount_cents:1150,platform_fee_cents:170});assert.equal(body.amount.value,'11.50');assert.equal(body.payment_instruction.platform_fees[0].amount.value,'1.70');
});
