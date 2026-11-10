import {BEAUTY_PRICING_POLICY,beautyRefundTerms} from './client/src/lib/beautyOrderPricing.js';
const invalid=()=>{throw Error('payment_verification_failed');};
export function usd(cents){
  if(!Number.isSafeInteger(cents)||cents<0)invalid();
  return {currency_code:'USD',value:(BigInt(cents)/100n).toString()+'.'+String(cents%100).padStart(2,'0')};
}
export function cents(amount){
  if(amount?.currency_code!=='USD'||typeof amount.value!=='string'||!/^\d+\.\d{2}$/.test(amount.value))invalid();
  const n=Number(BigInt(amount.value.replace('.','')));if(!Number.isSafeInteger(n))invalid();return n;
}
export function sandboxPurchaseUnits(order,partnerId){
  const {quote,bindings}=order;
  const flat=quote.pricingPolicy===BEAUTY_PRICING_POLICY;
  if(flat){try{beautyRefundTerms(quote);}catch{invalid();}}
  else if(quote.pricingPolicy!=='seller_commission_v1'||quote.commissionPayer!=='seller')invalid();
  if(!quote.sellerAllocations?.length||quote.sellerAllocations.length>10||new Set(quote.sellerAllocations.map(a=>a.sellerId)).size!==quote.sellerAllocations.length)invalid();
  if(flat&&(quote.sellerAllocations.some(a=>a.commissionCents!==0||a.netBeforeProcessingCents!==a.grossCents)||quote.sellerAllocations.reduce((n,a)=>n+a.grossCents,0)!==quote.subtotalCents))invalid();
  const units=quote.sellerAllocations.map((a,i)=>{
    const binding=bindings.find(b=>b.sellerId===a.sellerId);if(!binding?.merchantId)invalid();
    const fixed=i===0?quote.platformFeeCents:0,fee=a.commissionCents+fixed;
    return {reference_id:a.sellerId,custom_id:order.id,invoice_id:order.id+'-'+i,
      description:'IFCDC sandbox pickup test — no real goods',payee:{merchant_id:binding.merchantId},
      amount:{...usd(a.grossCents+fixed),breakdown:{item_total:usd(a.grossCents),handling:usd(fixed)}},
      payment_instruction:{disbursement_mode:'INSTANT',...(fee?{platform_fees:[{amount:usd(fee),payee:{merchant_id:partnerId}}]}:{})}};
  });
  if(units.reduce((sum,u)=>sum+cents(u.amount),0)!==quote.totalBeforeTaxShippingCents)invalid();
  return units;
}
export function verifySandboxOrder(remote,order,partnerId,{captured=false}={}){
  if(!remote||remote.id!==order.paypal_order_id||remote.intent!=='CAPTURE')invalid();
  const expected=sandboxPurchaseUnits(order,partnerId), units=remote.purchase_units;
  if(!Array.isArray(units)||units.length!==expected.length)invalid();
  const seen=new Set(),captureIds=new Set(),captures=[];
  for(const e of expected){
    const u=units.find(x=>x.reference_id===e.reference_id);
    if(!u||seen.has(u.reference_id)||u.custom_id!==order.id||u.invoice_id!==e.invoice_id||u.payee?.merchant_id!==e.payee.merchant_id||cents(u.amount)!==cents(e.amount))invalid();
    seen.add(u.reference_id);
    if(!captured){
      const fees=u.payment_instruction?.platform_fees || [], expectedFees=e.payment_instruction.platform_fees || [];
      if(fees.length!==expectedFees.length)invalid();
      if(expectedFees.length && (cents(fees[0].amount)!==cents(expectedFees[0].amount)||
        (fees[0].payee?.merchant_id && fees[0].payee.merchant_id!==partnerId)))invalid();
      continue;
    }
    const cs=u.payments?.captures;
    if(!Array.isArray(cs)||cs.length!==1)invalid();
    const c=cs[0],b=c.seller_receivable_breakdown;
    if(c.status!=='COMPLETED'||c.final_capture!==true||typeof c.id!=='string'||!c.id||captureIds.has(c.id)||cents(c.amount)!==cents(e.amount)||cents(b?.gross_amount)!==cents(e.amount))invalid();
    captureIds.add(c.id);
    const fees=Array.isArray(b.platform_fees)?b.platform_fees:[], expectedFee=e.payment_instruction.platform_fees?.[0];
    if(fees.length!==(expectedFee?1:0))invalid();
    if(expectedFee && (cents(fees[0].amount)!==cents(expectedFee.amount)||
      (fees[0].payee?.merchant_id && fees[0].payee.merchant_id!==partnerId)))invalid();
    const processing=cents(b.paypal_fee),net=cents(b.net_amount),fee=expectedFee?cents(expectedFee.amount):0;
    if(net+processing+fee!==cents(e.amount))invalid();
    captures.push({id:c.id,sellerId:e.reference_id,merchantId:e.payee.merchant_id,grossCents:cents(e.amount),platformFeeCents:fee,processingFeeCents:processing,netCents:net});
  }
  if(captured&&remote.status!=='COMPLETED')invalid();
  return captures;
}
export function safeSandboxApprovalLink(remote){
  const href=remote?.links?.find(l=>l.rel==='approve'||l.rel==='payer-action')?.href;
  let u;try{u=new URL(href);}catch{throw Error('invalid_approval_link');}
  if(u.protocol!=='https:'||!['www.sandbox.paypal.com','sandbox.paypal.com'].includes(u.hostname)||u.username||u.password||u.port)throw Error('invalid_approval_link');
  return u.href;
}
