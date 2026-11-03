import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPut } from '../lib/api.js';
import { getBearerAuthHeaders } from '../lib/authHeaders.js';
import { BEAUTY_CATEGORIES } from '../lib/beautyCatalog.js';
import { productFromBeautyForm, changeBeautySellerStatus } from '../lib/beautyAdmin.js';
import '../styles/beautyManage.css';
const blank = () => ({name:'',brand:'',sellerId:'',category:BEAUTY_CATEGORIES[0],price:'',stock:'0',shipping:true,pickup:false,pickupLocation:'',independentBrand:false,status:'draft',revenueModel:'resale',cost:'',commission:''});
const money = cents => (cents / 100).toFixed(2);
export default function BeautyManage() {
  const [catalog,setCatalog]=useState(null),[form,setForm]=useState(blank),[editing,setEditing]=useState(null);
  const [sellerName,setSellerName]=useState(''),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(true),[message,setMessage]=useState(''),[error,setError]=useState('');
  const field = e => setForm(f=>({...f,[e.target.name]:e.target.type==='checkbox'?e.target.checked:e.target.value}));
  async function load() {
    setBusy(true);setError('');
    try {
      const result=await apiGet('/api/beauty/admin/catalog',{headers:getBearerAuthHeaders()});
      if(!Number.isSafeInteger(result.revision)||!Array.isArray(result.products)||!Array.isArray(result.sellers))throw Error('Invalid catalog response.');
      setCatalog(result);setDirty(false);setEditing(null);setForm(blank());setMessage('Catalog loaded.');
    }catch {setError('Unable to load. Sign in with your Founder account and retry.');}
    finally {setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  useEffect(()=>{if(!dirty)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const change = next => {setCatalog(next);setDirty(true);setMessage('Unsaved changes.');};
  async function save() {
    setBusy(true);setError('');
    try {const saved=await apiPut('/api/beauty/admin/catalog',catalog,getBearerAuthHeaders());setCatalog(saved);setDirty(false);setMessage('Catalog saved. Published products are now available in the store.');}
    catch {setError('Save failed. Your changes remain here. If another session saved first, reload the catalog and reapply your changes.');}
    finally {setBusy(false);}
  }
  function addSeller(e) {e.preventDefault();if(!sellerName.trim())return;change({...catalog,sellers:[...catalog.sellers,{id:`seller_${crypto.randomUUID()}`,name:sellerName.trim(),status:'pending'}]});setSellerName('');}
  function addProduct(e) {
    e.preventDefault();setError('');
    try {const product=productFromBeautyForm(form,catalog.sellers,editing);change({...catalog,products:editing?catalog.products.map(p=>p.id===editing?product:p):[...catalog.products,product]});setEditing(null);setForm(blank());}
    catch(e){setError(e.message);}
  }
  function edit(p) {setEditing(p.id);setForm({name:p.name,brand:p.brand,sellerId:p.sellerId,category:p.category,price:money(p.priceCents),stock:String(p.stock),shipping:p.fulfillment.includes('shipping'),pickup:p.fulfillment.includes('pickup'),pickupLocation:p.pickupLocation||'',independentBrand:p.independentBrand,status:p.status,revenueModel:p.revenueModel,cost:p.wholesaleCostCents==null?'':money(p.wholesaleCostCents),commission:p.commissionBps==null?'':money(p.commissionBps)});setMessage('Editing product. Add the changes to the catalog, then save.');}
  return <main className="beauty-manage">
    <header><p className="beauty-manage__eyebrow">FOUNDER • BEAUTY SUPPLY</p><h1>Manage your store</h1><p>Approve brands, set product prices and track stock. Checkout is not open yet.</p><Link to="/beauty-supply">View storefront</Link></header>
    <div role="status" aria-live="polite">{busy?'Working…':message}</div>{error&&<p role="alert" className="beauty-manage__error">{error}</p>}
    <div className="beauty-manage__actions"><button disabled={busy} onClick={()=>{if(!dirty||window.confirm('Discard unsaved catalog changes?'))void load();}}>Reload catalog</button><button disabled={!catalog||!dirty||busy} onClick={save}>Save catalog{dirty?' • unsaved':''}</button></div>
    {catalog&&<fieldset disabled={busy} className="beauty-manage__body">
      <section><h2>Sellers &amp; brands</h2><form onSubmit={addSeller}><label>Public seller name<input required maxLength={200} value={sellerName} onChange={e=>setSellerName(e.target.value)}/></label><button>Add seller</button></form><p>New sellers start pending. Changing an approved seller to pending or suspended also moves their published products to drafts.</p>
      {catalog.sellers.map(s=><div className="beauty-manage__seller" key={s.id}><strong>{s.name}</strong><label>Approval<select value={s.status} onChange={e=>change(changeBeautySellerStatus(catalog,s.id,e.target.value))}><option value="pending">Pending</option><option value="approved">Approved</option><option value="suspended">Suspended</option></select></label></div>)}</section>
      <section><h2>{editing?'Edit product':'Add product'}</h2><form className="beauty-manage__form" onSubmit={addProduct}>
        <label>Product name<input name="name" required maxLength={200} value={form.name} onChange={field}/></label><label>Brand<input name="brand" required maxLength={200} value={form.brand} onChange={field}/></label>
        <label>Seller<select required name="sellerId" value={form.sellerId} onChange={field}><option value="">Choose seller</option>{catalog.sellers.map(s=><option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}</select></label>
        <label>Category<select name="category" value={form.category} onChange={field}>{BEAUTY_CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></label>
        <label>Retail price (USD)<input required name="price" inputMode="decimal" value={form.price} onChange={field}/></label><label>Available stock<input required name="stock" inputMode="numeric" value={form.stock} onChange={field}/></label>
        <label>Revenue model<select name="revenueModel" value={form.revenueModel} onChange={field}><option value="resale">Wholesale resale</option><option value="commission">Seller commission</option></select></label>
        <label>Wholesale cost (USD, private)<input name="cost" inputMode="decimal" value={form.cost} onChange={field}/></label><label>Agreed commission (%, private)<input name="commission" inputMode="decimal" placeholder="Not set" value={form.commission} onChange={field}/></label>
        <label>Publication<select name="status" value={form.status} onChange={field}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label className="beauty-manage__check"><input name="shipping" type="checkbox" checked={form.shipping} onChange={field}/>Shipping</label><label className="beauty-manage__check"><input name="pickup" type="checkbox" checked={form.pickup} onChange={field}/>Local pickup</label>
        {form.pickup&&<label>Public pickup address<input required maxLength={500} name="pickupLocation" value={form.pickupLocation} onChange={field}/></label>}
        <label className="beauty-manage__check"><input name="independentBrand" type="checkbox" checked={form.independentBrand} onChange={field}/>Independent product line</label>
        <button>{editing?'Add edits to catalog':'Add product to catalog'}</button>{editing&&<button type="button" onClick={()=>{setEditing(null);setForm(blank());}}>Cancel product edit</button>}
      </form><p>Adding or editing here prepares your changes. Use Save catalog above to persist them. Commission rates record your agreed terms; payouts are not connected.</p></section>
      <section><h2>Products ({catalog.products.length})</h2>{!catalog.products.length&&<p>No products added yet.</p>}<div className="beauty-manage__products">{catalog.products.map(p=><article key={p.id}><small>{p.status}</small><h3>{p.name}</h3><p>{p.brand} • {catalog.sellers.find(s=>s.id===p.sellerId)?.name}</p><p>${money(p.priceCents)} • {p.stock} in stock</p><button type="button" onClick={()=>edit(p)}>Edit {p.name}</button></article>)}</div></section>
    </fieldset>}
  </main>;
}
