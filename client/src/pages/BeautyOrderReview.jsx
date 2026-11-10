import { useRef, useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { getStoredToken, getBearerAuthHeaders } from '../lib/authHeaders.js';
import { BEAUTY_PRICING_POLICY } from '../lib/beautyOrderPricing.js';
const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
export default function BeautyOrderReview({items}) {
  const [orders,setOrders]=useState([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const request=useRef(null);
  async function run(create) {
    const token=getStoredToken();
    if(!token){setOrders([]);setMessage('Sign in to review and save an order.');return;}
    setBusy(true);setMessage('');
    try {
      if(create) {
        const fingerprint=BEAUTY_PRICING_POLICY+JSON.stringify(items);
        if(request.current?.fingerprint!==fingerprint || request.current?.token!==token) request.current={fingerprint,token,key:crypto.randomUUID()};
        const result=await apiPost('/api/beauty/orders',{items,requestKey:request.current.key},getBearerAuthHeaders());
        if(getStoredToken()!==token){setOrders([]);return;}
        setOrders([result.order]);setMessage('Order draft saved. No payment taken and stock is not reserved.');
      } else {
        const result=await apiGet('/api/beauty/orders',{headers:getBearerAuthHeaders()});
        if(getStoredToken()!==token){setOrders([]);return;}
        setOrders(result.orders);setMessage(result.orders.length?'Your recent order drafts.':'No saved order drafts yet.');
      }
    } catch {setOrders([]);setMessage('Unable to load or save this order. Check your sign-in and try again; product availability may have changed.');}
    finally {setBusy(false);}
  }
  return <div className="ifcdc-beauty__order-review">
    <button type="button" disabled={busy || !items.length} onClick={()=>run(true)}>{busy?'Please wait…':'Review & save order draft'}</button>
    <button type="button" disabled={busy} onClick={()=>run(false)}>My order drafts</button>
    <p role="status">{message}</p>
    {orders.map(o=><article key={o.id}><h3>Order {o.id.slice(0,8)}</h3><p>{new Date(o.expires_at)<=new Date()?'Expired draft':'Draft · not paid'}</p>
      <ul>{o.quote.lines.map(l=><li key={l.productId}>{l.name} · {l.quantity} × {money(l.unitPriceCents)}</li>)}</ul>
      <p>Product subtotal: {money(o.quote.subtotalCents)}</p><p>Platform fee: {money(o.quote.platformFeeCents)}</p>
      <p>{o.quote.pricingPolicy === 'flat_buyer_fee_v2' ? 'No seller commission. If products are refunded, the $2.50 buyer platform fee is retained.' : 'This saved draft uses previous pricing. It is preserved as originally quoted. Start a new draft for the current $2.50 fee and no seller commission.'}</p>
      <strong>Before tax &amp; shipping: {money(o.quote.totalBeforeTaxShippingCents)}</strong>
      <p>Quote expires {new Date(o.expires_at).toLocaleString()}. Price and availability must be checked again before payment.</p>
    </article>)}
  </div>;
}
