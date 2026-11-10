import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {apiUrl,fetchWithTimeout} from '../lib/api.js';
import {getStoredToken,getStoredUser,getBearerAuthHeaders} from '../lib/authHeaders.js';
import '../styles/beautyCustomerCheckout.css';
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const labels={reserved:'Reserved · not paid',paypal_created:'Awaiting payment approval',capture_pending:'Verifying payment',review_required:'Payment needs review',paid:'Test payment verified',cancelled:'Cancelled'};
const errors={authentication_required:'Sign in again to access your orders.',active_account_required:'An active account is required.',customer_trial_not_enabled:'This account is not enabled for the sandbox checkout trial.',sandbox_checkout_disabled:'The sandbox trial is paused. No new payment was submitted.',sandbox_active_order_limit:'You have three unfinished test orders. View your orders and resolve them before reserving more.',sandbox_order_expired:'This reservation expired. Cancel the unpaid order before starting another.',sandbox_pickup_only:'Choose products available for pickup. Shipping is not included in this trial.',sandbox_limit_100_usd:'Keep the test total at or below $100, including the $1.50 fee.',paypal_approval_required:'Open PayPal, approve with a separate sandbox buyer account, then verify payment here.',seller_not_authorized:'The seller is not ready for this payment. Contact the store.',order_not_found:'This order is not available to your account.',capture_must_be_reconciled:'Payment may have started. Check payment status before doing anything else.',order_key_conflict:'This saved request belongs to a different bag. Reload your orders before continuing.','Invalid basket':'Availability changed. Refresh the store and review your bag.'};
export default function BeautyCustomerCheckout({items}){
 const token=getStoredToken();
 const [eligible,setEligible]=useState(false),[orders,setOrders]=useState([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const pending=useRef(null),mounted=useRef(true);
 async function request(path,method='GET',body){
  const started=getStoredToken();if(!started)throw Error('authentication_required');
  const res=await fetchWithTimeout(apiUrl('/api/beauty/customer-sandbox'+path),{method,timeoutMs:90000,headers:{...getBearerAuthHeaders(),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body||{})}:{})});
  const data=await res.json();if(started!==getStoredToken()||!mounted.current)throw Error('session_changed');
  if(!res.ok)throw Error(data.error||'checkout_unavailable');return data;
 }
 useEffect(()=>{
  mounted.current=true;setOrders([]);setEligible(false);setMessage('');pending.current=null;
  let active=true;
  if(token)request('/config').then(async config=>{
   if(!active)return;setEligible(config.eligible===true);
   const data=await request('/orders');if(active)setOrders(data.orders);
   if(active&&new URLSearchParams(window.location.search).has('beautySandbox'))setMessage('Returned from PayPal. Your payment is confirmed only when your order shows Test payment verified.');
  }).catch(()=>{if(active)setMessage('Checkout trial unavailable. Real customer payments are not open.');});
  return()=>{active=false;mounted.current=false;};
 },[token]);
 async function run(action,id){
  if(busy)return;setBusy(true);setMessage('Updating your test order…');
  try{
   let data;
   if(action==='reserve'){
    if(!items.length)throw Error('Choose a pickup product first.');
    const sorted=items.map(x=>({productId:x.productId,quantity:x.quantity})).sort((a,b)=>a.productId.localeCompare(b.productId));
    const user=getStoredUser();if(!user?.id)throw Error('authentication_required');
    const key='ifcdc.beauty.sandbox.request.'+user.id;
    const fingerprint=JSON.stringify(sorted);
    if(!pending.current){try{pending.current=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}}
    if(pending.current&&pending.current.fingerprint!==fingerprint)throw Error('Finish or cancel your saved test order before changing this checkout request.');
    if(!pending.current){pending.current={fingerprint,requestKey:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(pending.current));}
    data=await request('/orders','POST',{items:sorted,requestKey:pending.current.requestKey});
   }else data=await request(action==='list'?'/orders':'/orders/'+id+'/'+action,action==='list'?'GET':'POST');
   if(data.orders)setOrders(data.orders);else if(data.order)setOrders(old=>[data.order,...old.filter(o=>o.id!==data.order.id)]);
   setMessage(data.order?.status==='paid'?'Test payment verified. Check your pickup status below.':data.order?.status==='capture_pending'||data.order?.status==='review_required'?'Payment is being checked. Keep this order and check its status; do not pay again.':action==='list'?'Your test orders are up to date.':'Test order updated.');
  }catch(e){setMessage(errors[e.message]||(['Choose a pickup product first.','Finish or cancel your saved test order before changing this checkout request.'].includes(e.message)?e.message:'This request could not be confirmed. Reload your orders before retrying; do not create a duplicate payment.'));}
  finally{if(mounted.current)setBusy(false);}
 }
 function startAnother(){
  if(!window.confirm('Start a separate sandbox order? Check that your previous order is paid or cancelled first.'))return;
  try{sessionStorage.removeItem('ifcdc.beauty.sandbox.request.'+getStoredUser()?.id);}catch{}
  pending.current=null;setMessage('Ready for a separate test order. Review your bag before reserving.');
 }
 return <section className="beauty-customer-checkout" aria-label="Checkout and my orders">
  <h3>Checkout &amp; my orders</h3>
  <p>Real customer payments are not open yet.</p>
  {!token?<p><Link to="/login">Sign in</Link> to view your orders.</p>:<>
   {eligible&&<div className="beauty-customer-checkout__notice"><strong>Sandbox trial · test money only</strong><p>Pickup only. Maximum $100 including one $1.50 buyer fee. Tax and shipping are simulated as zero. Use a separate PayPal sandbox buyer account. Your app sign-in stays the same.</p><p>Reserving holds stock for this order. An expired reservation must be explicitly cancelled before stock is released.</p></div>}
   <fieldset disabled={busy}>
    {eligible&&<button type="button" disabled={!items.length} onClick={()=>run('reserve')}>Reserve test order from bag</button>}
    <button type="button" onClick={()=>run('list')}>Refresh my test orders</button>
    {orders.map(o=><article key={o.id}>
     <h4>Test order {o.id.slice(0,8)}</h4><p>{labels[o.status]||'Status unavailable'} · Pickup: {o.pickupStatus} · Refund: {o.refundStatus}</p>
     {(o.reviewRequired||o.refundStatus!=='none'||o.pickupStatus==='halted')&&<p>Order on hold. Contact the store before pickup.</p>}
     <ul>{o.quote.lines.map(l=><li key={l.productId}>{l.name} × {l.quantity}<br/>Pickup location: {l.pickupLocation||'Confirm with the store'}</li>)}</ul>
     <p>Products {money(o.quote.subtotalCents)} · buyer fee {money(o.quote.platformFeeCents)}</p><strong>Test total {money(o.quote.totalCents)}</strong>
     {['reserved','paypal_created'].includes(o.status)&&<p>Reservation expires {new Date(o.expiresAt).toLocaleString()}</p>}
     {eligible&&o.status==='reserved'&&<button type="button" onClick={()=>run('prepare',o.id)}>Continue to test payment</button>}
     {eligible&&o.status==='paypal_created'&&<>{o.approvalUrl&&<p><a href={o.approvalUrl}>Approve test payment on PayPal</a></p>}<button type="button" onClick={()=>run('capture',o.id)}>Verify and complete test payment</button></>}
     {['capture_pending','review_required'].includes(o.status)&&<><button type="button" onClick={()=>run('reconcile',o.id)}>Check payment status</button>{eligible&&<button type="button" onClick={()=>run('retryCapture',o.id)}>Retry existing payment verification</button>}</>}
     {['reserved','paypal_created'].includes(o.status)&&<button type="button" onClick={()=>{if(window.confirm('Cancel this unpaid test reservation? Payment state is checked before stock is released.'))run('cancel',o.id);}}>Cancel unpaid test order</button>}
     {o.status==='paid'&&o.refundStatus==='none'&&!o.reviewRequired&&o.pickupStatus!=='halted'&&<p>{o.pickupStatus==='collected'?'Pickup recorded as collected.':o.pickupStatus==='ready'?'Ready for pickup at the listed location.':'The store is preparing your pickup.'}</p>}
    </article>)}
    {eligible&&orders.some(o=>['paid','cancelled'].includes(o.status))&&<button type="button" onClick={startAnother}>Start a separate test order</button>}
   </fieldset>
  </>}
  <p role="status" aria-live="polite">{busy?'Please wait…':message}</p>
 </section>;
}
