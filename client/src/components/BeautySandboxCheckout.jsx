import { useRef,useState } from 'react';
import { apiUrl,fetchWithTimeout } from '../lib/api.js';
import { getBearerAuthHeaders,getStoredToken } from '../lib/authHeaders.js';
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
export default function BeautySandboxCheckout({catalog,disabled}){
  const [quantities,setQuantities]=useState({}),[orders,setOrders]=useState([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const request=useRef(null);
  const products=catalog.products.filter(p=>p.status==='published'&&p.stock>0&&p.fulfillment.includes('pickup')&&catalog.sellers.some(s=>s.id===p.sellerId&&s.status==='approved'));
  async function run(action,id){
    const token=getStoredToken();if(!token){setOrders([]);setMessage('Sign in again with your Founder account.');return;}
    setBusy(true);setMessage('Working with sandbox payments. Please wait…');
    try{
      const items=Object.entries(quantities).filter(([,q])=>Number(q)>0).map(([productId,q])=>({productId,quantity:Number(q)})).sort((a,b)=>a.productId.localeCompare(b.productId));
      if(action==='reserve'){
        if(!items.length)throw Error('Choose at least one pickup product.');
        const fingerprint=token+JSON.stringify(items);
        if(request.current?.fingerprint!==fingerprint)request.current={fingerprint,key:crypto.randomUUID()};
      }
      const method=action==='list'?'GET':'POST';
      const url='/api/beauty/admin/sandbox-checkout'+(id?'/'+id+'/'+action:'');
      const r=await fetchWithTimeout(apiUrl(url),{method,timeoutMs:90000,headers:{...getBearerAuthHeaders(),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(action==='reserve'?{items,requestKey:request.current.key}:{})}:{})});
      const data=await r.json();if(!r.ok)throw Error(data.error||'sandbox_checkout_unavailable');
      if(token!==getStoredToken()){setOrders([]);setMessage('Your sign-in changed. Reload after signing in.');return;}
      if(data.orders)setOrders(data.orders);else setOrders(old=>[data.order,...old.filter(o=>o.id!==data.order.id)]);
      setMessage(data.order?.status==='paid'?'Sandbox payment verified and recorded. No real payment was collected.':data.order?.status==='review_required'?'Payment needs review. Keep stock reserved and use Recheck payment; do not create another order.':'Sandbox order updated.');
    }catch(e){
      const reasons={'Choose at least one pickup product.':'Choose at least one pickup product.',seller_provider_request_failed:'PayPal rejected this sandbox request. Reload the saved order before retrying.',seller_provider_auth_failed:'PayPal could not authenticate the dedicated sandbox marketplace credentials.',payment_verification_failed:'The PayPal amounts, payees or fees did not match the saved order. Do not pay again; reload and review the order.',sandbox_checkout_disabled:'Sandbox checkout is disabled. Set BEAUTY_SANDBOX_CHECKOUT_ENABLED=1 with marketplace credentials still in sandbox.',sandbox_limit_100_usd:'Keep the complete sandbox order below $100.',seller_not_authorized:'Verify each seller with PayPal and confirm the seller and products are approved/published.',sandbox_order_expired:'This reservation expired. Release it and create a new test order.',paypal_approval_required:'Open PayPal and approve the test payment first.',sandbox_checkout_unavailable:'Unable to complete this step. Reload test orders and recheck the existing payment before retrying.',capture_must_be_reconciled:'A capture may have started. Recheck payment before taking any further action.'};
      setMessage(reasons[e.message]||'The request did not finish. Reload test orders to recover the saved order. Do not create a duplicate payment.');
    }finally{setBusy(false);}
  }
  return <section><h2>Founder sandbox checkout trial</h2>
    <p>Test accounts only. Pickup orders under $100 including the $1.50 buyer fee. The 2% commission comes from seller proceeds. Tax and shipping are simulated as zero; this does not configure live tax treatment.</p>
    <p>Save catalog changes first. Stock is reserved until a verified payment or explicit release. Expired reservations are not automatically released.</p>
    <fieldset disabled={disabled||busy}><legend>Choose pickup products</legend>
      {!products.length&&<p>Add and publish a stocked pickup product for your authorized test seller, then save the catalog.</p>}
      {products.map(p=><label key={p.id} style={{display:'block'}}>{p.name} · {money(p.priceCents)} · stock {p.stock}{' '}<input aria-label={'Test quantity for '+p.name} type="number" min="0" max={p.stock} step="1" value={quantities[p.id]||0} onChange={e=>setQuantities(q=>({...q,[p.id]:e.target.value}))}/></label>)}
      <button type="button" onClick={()=>run('reserve')}>Reserve sandbox order</button>{' '}<button type="button" onClick={()=>run('list')}>Reload test orders</button>
      {orders.map(o=><article key={o.id}><h3>Sandbox order {o.id.slice(0,8)} · {o.status}</h3>
        <ul>{o.quote.lines.map(l=><li key={l.productId}>{l.name} × {l.quantity}</li>)}</ul>
        <p>Products {money(o.quote.subtotalCents)} · buyer fee {money(o.quote.platformFeeCents)} · test total {money(o.quote.totalBeforeTaxShippingCents)}</p>
        <p>Seller commission {money(o.quote.commissionCents)} · IFCDC fees {money(o.quote.platformRevenueCents)}</p>
        <p>Reservation deadline: {new Date(o.expiresAt).toLocaleString()}</p>
        {o.status==='reserved'&&<button type="button" onClick={()=>run('prepare',o.id)}>Create PayPal test payment</button>}
        {o.approvalUrl&&<p><a href={o.approvalUrl} target="_blank" rel="noopener noreferrer">Approve with a separate sandbox buyer account</a></p>}
        {o.status==='paypal_created'&&<button type="button" onClick={()=>run('capture',o.id)}>Capture approved test payment</button>}
        {['capture_pending','review_required'].includes(o.status)&&<><button type="button" onClick={()=>run('reconcile',o.id)}>Recheck payment</button>{' '}<button type="button" onClick={()=>run('retryCapture',o.id)}>Retry same PayPal capture</button></>}
        {['reserved','paypal_created'].includes(o.status)&&<button type="button" onClick={()=>run('cancel',o.id)}>Release unpaid reservation</button>}
      </article>)}
    </fieldset><p role="status">{message}</p>
  </section>;
}
