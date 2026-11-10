// One buyer fee per product checkout; no seller commission on new orders.
export const BEAUTY_PLATFORM_FEE_CENTS = 250;
export const BEAUTY_COMMISSION_BPS = 0;
export const BEAUTY_PRICING_POLICY = 'flat_buyer_fee_v2';
export const BEAUTY_REFUND_POLICY = 'product_subtotal_only_v1';
export function beautyBagTotals(subtotalCents,itemCount){
 if(!Number.isSafeInteger(subtotalCents)||subtotalCents<0||!Number.isSafeInteger(itemCount)||itemCount<0)throw Error('Invalid basket');
 const platformFeeCents=itemCount>0?BEAUTY_PLATFORM_FEE_CENTS:0;
 const totalBeforeTaxShippingCents=subtotalCents+platformFeeCents;
 if(!Number.isSafeInteger(totalBeforeTaxShippingCents))throw Error('Invalid basket');
 return {pricingPolicy:BEAUTY_PRICING_POLICY,refundPolicy:BEAUTY_REFUND_POLICY,commissionPayer:'none',subtotalCents,commissionCents:0,sellerNetCents:subtotalCents,platformRevenueCents:platformFeeCents,platformFeeCents,totalBeforeTaxShippingCents};
}
export function beautyRefundTerms(quote){
 if(quote?.pricingPolicy===BEAUTY_PRICING_POLICY){
  if(quote.refundPolicy!==BEAUTY_REFUND_POLICY||quote.platformFeeCents!==250||quote.commissionCents!==0||quote.commissionPayer!=='none'||!Number.isSafeInteger(quote.subtotalCents)||quote.subtotalCents<=0||quote.totalBeforeTaxShippingCents!==quote.subtotalCents+250)throw Error('refund_policy_invalid');
  return {refundPolicy:BEAUTY_REFUND_POLICY,refundAmountCents:quote.subtotalCents,retainedPlatformFeeCents:250};
 }
 if(quote?.pricingPolicy!=='seller_commission_v1')throw Error('refund_policy_invalid');
 return {refundPolicy:'legacy_full_payment',refundAmountCents:quote.totalBeforeTaxShippingCents,retainedPlatformFeeCents:0};
}
