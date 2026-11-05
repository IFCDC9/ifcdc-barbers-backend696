import {cents,usd} from './beautySandboxPaymentContract.js';
export function refundRequestBody(row){
 const amount=Number(row.amount_cents),fee=Number(row.platform_fee_cents);
 return {amount:usd(amount),custom_id:row.request_id,invoice_id:row.request_id,
   note_to_payer:'IFCDC sandbox test full refund',...(fee?{payment_instruction:{platform_fees:[{amount:usd(fee)}]}}:{})};
}
export function verifySandboxRefund(data,row){
 const invalid=()=>{throw Error('refund_verification_failed');};
 if(!data||typeof data.id!=='string'||!/^[A-Z0-9]{5,64}$/.test(data.id)||data.custom_id!==row.request_id||cents(data.amount)!==Number(row.amount_cents))invalid();
 if(row.provider_refund_id&&row.provider_refund_id!==data.id)invalid();
 const up=data.links?.find(l=>l.rel==='up'&&l.method==='GET')?.href;
 let u;try{u=new URL(up);}catch{invalid();}
 if(u.protocol!=='https:'||!['api-m.sandbox.paypal.com','api.sandbox.paypal.com'].includes(u.hostname)||u.username||u.password||u.port||u.pathname!=='/v2/payments/captures/'+row.capture_id)invalid();
 const fee=Number(row.platform_fee_cents),fees=data.seller_payable_breakdown?.platform_fees || [];
 const feeVerified=fee===0?fees.length===0:fees.length===1&&cents(fees[0].amount)===fee;
 return {id:data.id,providerStatus:data.status,amountCents:cents(data.amount),platformFeeCents:feeVerified?fee:null,
   status:data.status==='COMPLETED'&&feeVerified?'completed':data.status==='PENDING'?'pending':'review_required'};
}
