import {BEAUTY_PRICING_POLICY} from '../lib/beautyOrderPricing.js';
import { useRef,useState } from 'react';
import { apiUrl,fetchWithTimeout } from '../lib/api.js';
import { getBearerAuthHeaders,getStoredToken } from '../lib/authHeaders.js';
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
export default function BeautySandboxCheckout({catalog,disabled}){
  const [quantities,setQuantities]=useState({}),[orders,setOrders]=useState([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const request=useRef(null);
  const [webhooks,setWebhooks]=useState([]);
  const products=catalog.products.filter(p=>p.status==='published'&&p.stock>0&&p.fulfillment.includes('pickup')&&catalog.sellers.some(s=>s.id===p.sellerId&&s.status==='approved'));
  async function run(action,id){
    const token=getStoredToken();if(!token){setOrders([]);setMessage('Sign in again with your Founder account.');return;}
    setBusy(true);setMessage('Working with sandbox payments. Please wait…');
    try{
      const items=Object.entries(quantities).filter(([,q])=>Number(q)>0).map(([productId,q])=>({productId,quantity:Number(q)})).sort((a,b)=>a.productId.localeCompare(b.productId));
      if(action==='reserve'){
        if(!window.confirm('Reserve a sandbox order with one $2.50 buyer fee and no seller commission? Product refunds retain the $2.50 fee.')){setMessage('Reservation cancelled.');return;}
        if(!items.length)throw Error('Choose at least one pickup product.');
        const fingerprint=token+BEAUTY_PRICING_POLICY+JSON.stringify(items);
        if(request.current?.fingerprint!==fingerprint)request.current={fingerprint,key:crypto.randomUUID()};
      }
      const method=['list','webhooks'].includes(action)?'GET':'POST';
      const url='/api/beauty/admin/sandbox-checkout'+(action==='webhooks'?'/webhooks':action==='retryWebhook'?'/webhooks/'+encodeURIComponent(id)+'/retry':id?'/'+id+'/'+action:'');
      const r=await fetchWithTimeout(apiUrl(url),{method,timeoutMs:90000,headers:{...getBearerAuthHeaders(),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(action==='reserve'?{items,requestKey:request.current.key,pricingPolicy:BEAUTY_PRICING_POLICY,acceptFeePolicy:true}:{})}:{})});
      const data=await r.json();if(!r.ok)throw Error(data.error||'sandbox_checkout_unavailable');
      if(token!==getStoredToken()){setOrders([]);setMessage('Your sign-in changed. Reload after signing in.');return;}
      if(data.webhooks)setWebhooks(data.webhooks);else if(data.orders)setOrders(data.orders);else if(data.order)setOrders(old=>[data.order,...old.filter(o=>o.id!==data.order.id)]);
      setMessage(data.order?.refundIssue==='PLATFORM_FEE_NOT_ENABLED'?'PayPal rejected the platform-fee refund because this capability is not enabled. Contact PayPal support; repeated retries will not enable it.':data.order?.refundStatus==='completed'?'The refund was verified under this order’s saved policy. Stock has not been automatically restored.':data.order?.refundStatus&&data.order.refundStatus!=='none'?'Refund pending or under review. Use Recheck refund before retrying; pickup is blocked.':data.order?.status==='paid'?'Sandbox payment verified and recorded. No real payment was collected.':data.order?.status==='review_required'?'Payment needs review. Keep stock reserved and use Recheck payment; do not create another order.':'Sandbox order updated.');
    }catch(e){
      const reasons={fee_policy_acceptance_required:'Reload this page to review the current platform-fee policy.',sandbox_refunds_disabled:'Sandbox refunds are disabled. Enable BEAUTY_SANDBOX_REFUNDS_ENABLED=1 only for the refund trial.',verified_payment_required:'A verified, unflagged payment with no refund in progress is required for this action.',verified_full_refund_required:'Verify the complete refund before restocking returned items.',invalid_fulfillment_transition:'Mark the paid order ready before marking it collected.',refund_not_requested:'Request the full sandbox refund first.','Choose at least one pickup product.':'Choose at least one pickup product.',seller_provider_request_failed:'PayPal rejected this sandbox request. Reload the saved order before retrying.',seller_provider_auth_failed:'PayPal could not authenticate the dedicated sandbox marketplace credentials.',payment_verification_failed:'The PayPal amounts, payees or fees did not match the saved order. Do not pay again; reload and review the order.',sandbox_checkout_disabled:'Sandbox checkout is disabled. Set BEAUTY_SANDBOX_CHECKOUT_ENABLED=1 with marketplace credentials still in sandbox.',sandbox_limit_100_usd:'Keep the complete sandbox order below $100.',seller_not_authorized:'Verify each seller with PayPal and confirm the seller and products are approved/published.',sandbox_order_expired:'This reservation expired. Release it and create a new test order.',paypal_approval_required:'Open PayPal and approve the test payment first.',sandbox_checkout_unavailable:'Unable to complete this step. Reload test orders and recheck the existing payment before retrying.',capture_must_be_reconciled:'A capture may have started. Recheck payment before taking any further action.'};
      setMessage(reasons[e.message]||'The request did not finish. Reload test orders to recover the saved order. Do not create a duplicate payment.');
    }finally{setBusy(false);}
  }
  return <section><h2>Founder sandbox checkout trial</h2>
    <p>Test accounts only. Pickup orders at or below $100 including one $2.50 buyer platform fee. No seller commission. Product refunds retain that fee. Existing orders keep their original terms. Tax and shipping are simulated as zero; this does not configure live tax treatment.</p>
    <p>Save catalog changes first. Stock is reserved until a verified payment or explicit release. Expired reservations are not automatically released.</p>
    <fieldset disabled={disabled||busy}><legend>Choose pickup products</legend>
      {!products.length&&<p>Add and publish a stocked pickup product for your authorized test seller, then save the catalog.</p>}
      {products.map(p=><label key={p.id} style={{display:'block'}}>{p.name} · {money(p.priceCents)} · stock {p.stock}{' '}<input aria-label={'Test quantity for '+p.name} type="number" min="0" max={p.stock} step="1" value={quantities[p.id]||0} onChange={e=>setQuantities(q=>({...q,[p.id]:e.target.value}))}/></label>)}
      <button type="button" onClick={()=>run('reserve')}>Reserve sandbox order</button>{' '}<button type="button" onClick={()=>run('list')}>Reload test orders</button>
      {orders.map(o=><article key={o.id}><h3>Sandbox order {o.id.slice(0,8)} · {o.status}</h3><p>Pickup: {o.fulfillmentStatus||'processing'} · Refund: {o.refundStatus||'none'}</p>{o.paymentReview&&<p>Payment review required. Do not fulfill this order.</p>}
        {o.refundIssue==='PLATFORM_FEE_NOT_ENABLED'&&<p role="alert">Refund blocked: PayPal has not enabled platform-fee refunds. Pickup remains halted. Contact PayPal support before retrying.</p>}
        <ul>{o.quote.lines.map(l=><li key={l.productId}>{l.name} × {l.quantity}</li>)}</ul>
        <p>Products {money(o.quote.subtotalCents)} · buyer fee {money(o.quote.platformFeeCents)} · test total {money(o.quote.totalBeforeTaxShippingCents)}</p>
        <p>{o.quote.pricingPolicy===BEAUTY_PRICING_POLICY?"Seller commission: $0.00":"Historical seller commission: "+money(o.quote.commissionCents)} · IFCDC fees {money(o.quote.platformRevenueCents)}</p><p>Refund amount: {money(o.refundAmountCents ?? o.quote.totalBeforeTaxShippingCents)} · retained platform fee: {money(o.retainedPlatformFeeCents || 0)}</p>
        <p>Reservation deadline: {new Date(o.expiresAt).toLocaleString()}</p>
        {o.status==='reserved'&&<button type="button" onClick={()=>run('prepare',o.id)}>Create PayPal test payment</button>}
        {o.approvalUrl&&<p><a href={o.approvalUrl} target="_blank" rel="noopener noreferrer">Approve with a separate sandbox buyer account</a></p>}
        {o.status==='paypal_created'&&<button type="button" onClick={()=>run('capture',o.id)}>Capture approved test payment</button>}
        {['capture_pending','review_required'].includes(o.status)&&<><button type="button" onClick={()=>run('reconcile',o.id)}>Recheck payment</button>{' '}<button type="button" onClick={()=>run('retryCapture',o.id)}>Retry same PayPal capture</button></>}
        {['reserved','paypal_created'].includes(o.status)&&<button type="button" onClick={()=>run('cancel',o.id)}>Release unpaid reservation</button>}
        {o.status==='paid'&&(o.refundStatus||'none')==='none'&&!o.paymentReview&&<>
          {(o.fulfillmentStatus||'processing')==='processing'&&<button type="button" onClick={()=>run('ready',o.id)}>Mark sandbox pickup ready</button>}
          {o.fulfillmentStatus==='ready'&&<button type="button" onClick={()=>run('collected',o.id)}>Mark sandbox pickup collected</button>}{' '}
          <button type="button" onClick={()=>{if(window.confirm('Refund '+money(o.refundAmountCents ?? o.quote.totalBeforeTaxShippingCents)+' under this order’s saved policy? '+(o.retainedPlatformFeeCents?'The '+money(o.retainedPlatformFeeCents)+' platform fee is retained.':'This historical order includes return of the buyer fee and IFCDC commission.')))void run('refund',o.id);}}>{o.retainedPlatformFeeCents?"Refund sandbox products":"Refund original sandbox payment"}</button>
        </>}
        {o.refundStatus&& !['none','completed'].includes(o.refundStatus)&&<><button type="button" onClick={()=>run('refundCheck',o.id)}>Recheck refund</button>{' '}
          {o.refundStatus!=='external_review'&&<button type="button" onClick={()=>run('refundRetry',o.id)}>Retry same refund request</button>}</>}
        {o.refundStatus==='completed'&&!o.inventoryRestocked&&<button type="button" onClick={()=>{if(window.confirm('Confirm the test items are available to return to stock. This restores inventory once.'))void run('restock',o.id);}}>Restock returned test items</button>}
        {o.inventoryRestocked&&<p>Returned items have been restocked.</p>}
      </article>)}
      <h3>Verified webhook deliveries</h3><button type="button" onClick={()=>run('webhooks')}>Load webhook delivery log</button>
      {webhooks.map(e=><p key={e.event_id}>{e.event_type} · {e.status} · attempts {e.attempts}{' '}{e.status!=='processed'&&<button type="button" onClick={()=>run('retryWebhook',e.event_id)}>Retry verified event</button>}</p>)}
    </fieldset><p role="status">{message}</p>
  </section>;
}
