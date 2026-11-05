import { useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { getBearerAuthHeaders, getStoredToken } from '../lib/authHeaders.js';
export default function BeautySellerPaymentConnection({seller,disabled,hasUnsavedChanges=false,onSave}) {
  const [state,setState]=useState(null),[link,setLink]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function run(action){
    const token=getStoredToken();
    if(!token){setState(null);setLink('');setMessage('Your sign-in is missing. Sign in again with your Founder account.');return;}
    setBusy(true);setMessage(action==='start'?'Creating your seller setup link…':action==='refresh'?'Checking this seller with PayPal…':'Loading payment status…');setLink('');
    try{
      const base='/api/beauty/admin/seller-payments/'+encodeURIComponent(seller.id)+'/'+action;
      const result=action==='status'?await apiGet(base,{headers:getBearerAuthHeaders()}):await apiPost(base,{},getBearerAuthHeaders());
      if(token!==getStoredToken()){setState(null);setLink('');setMessage('Your sign-in changed. Sign in again and retry.');return;}
      setState(result.connection);if(result.setupUrl)setLink(result.setupUrl);
      setMessage(action==='start'?'Give this private setup link to the seller so they can authorize their own PayPal account.':action==='refresh'?'Status checked with PayPal.':'Last saved status loaded.');
    }catch(e){
      const reasons={seller_payments_not_configured:'Marketplace payment settings are incomplete. Check the BEAUTY_PAYPAL variables in Render.',
        authentication_required:'Sign in again with your Founder account.',founder_required:'This action requires your current Founder account.',
        approved_seller_required:'Approve this seller and save the catalog before connecting payments.',
        seller_connection_missing:'Create a seller setup link before checking PayPal authorization.',
        seller_connection_unavailable:'The server could not complete the seller connection. Check the server connection and PayPal settings.'};
      setMessage(reasons[e?.message] || 'Unable to reach the seller connection service. Check your sign-in and server connection, then retry.');
    }
    finally{setBusy(false);}
  }
  return <div>
    <p>Payment account: {state?.status==='account_authorized'?'Account authorized':state?.status==='pending'?'Setup pending':'Not checked'}</p>
    {state?.lastCheckedAt && <small>Last verified: {new Date(state.lastCheckedAt).toLocaleString()}</small>}
    {hasUnsavedChanges && <div role="status"><p>Save your catalog changes to enable seller payment setup.</p>
      <button type="button" disabled={disabled||busy} onClick={onSave}>Save catalog to enable payment setup</button></div>}
    {seller.status!=='approved' && <p>Set this seller to Approved, then save the catalog to connect their payment account.</p>}
    <div><button type="button" disabled={disabled||busy||hasUnsavedChanges} onClick={()=>run('status')}>View payment status</button>{' '}
    <button type="button" disabled={disabled||busy||hasUnsavedChanges||seller.status!=='approved'} onClick={()=>run('start')}>Create seller setup link</button>{' '}
    <button type="button" disabled={disabled||busy||hasUnsavedChanges||seller.status!=='approved'} onClick={()=>run('refresh')}>Verify with PayPal</button></div>
    {link&&<p><a href={link} target="_blank" rel="noopener noreferrer">Seller PayPal setup — private link</a></p>}
    <p role="status">{message}</p>
    <small>Account authorization does not open checkout or move money. The seller completes setup on PayPal.</small>
  </div>;
}
