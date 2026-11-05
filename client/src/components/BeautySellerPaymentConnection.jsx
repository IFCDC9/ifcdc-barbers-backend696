import { useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { getBearerAuthHeaders, getStoredToken } from '../lib/authHeaders.js';
export default function BeautySellerPaymentConnection({seller,disabled}) {
  const [state,setState]=useState(null),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function run(action){
    const token=getStoredToken();if(!token)return;
    setBusy(true);setMessage('');setLink('');
    try{
      const base='/api/beauty/admin/seller-payments/'+encodeURIComponent(seller.id)+'/'+action;
      const result=action==='status'?await apiGet(base,{headers:getBearerAuthHeaders()}):await apiPost(base,{},getBearerAuthHeaders());
      if(token!==getStoredToken()){setState(null);return;}
      setState(result.connection);if(result.setupUrl)setLink(result.setupUrl);
      setMessage(action==='start'?'Give this private setup link to the seller so they can authorize their own PayPal account.':action==='refresh'?'Status checked with PayPal.':'Last saved status loaded.');
    }catch{setMessage('Unable to connect. Save and approve the seller first, and confirm marketplace payment settings are configured.');}
    finally{setBusy(false);}
  }
  return <div>
    <p>Payment account: {state?.status==='account_authorized'?'Account authorized':state?.status==='pending'?'Setup pending':'Not checked'}</p>
    {state?.lastCheckedAt && <small>Last verified: {new Date(state.lastCheckedAt).toLocaleString()}</small>}
    <div><button type="button" disabled={disabled||busy} onClick={()=>run('status')}>View payment status</button>{' '}
    <button type="button" disabled={disabled||busy||seller.status!=='approved'} onClick={()=>run('start')}>Create seller setup link</button>{' '}
    <button type="button" disabled={disabled||busy||seller.status!=='approved'} onClick={()=>run('refresh')}>Verify with PayPal</button></div>
    {link&&<p><a href={link} target="_blank" rel="noopener noreferrer">Seller PayPal setup — private link</a></p>}
    <p role="status">{message}</p>
    <small>Account authorization does not open checkout or move money. The seller completes setup on PayPal.</small>
  </div>;
}
