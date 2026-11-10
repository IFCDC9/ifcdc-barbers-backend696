import BeautyCustomerCheckout from '../components/BeautyCustomerCheckout.jsx';
import BeautyOrderReview from './BeautyOrderReview.jsx';
import { beautyBagTotals } from '../lib/beautyOrderPricing.js';
import { getStoredUser } from '../lib/authHeaders.js';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiGet } from '../lib/api.js';
import { BEAUTY_CATEGORIES, beautyText, readBeautyCatalog, filterBeautyProducts, changeBeautyBag } from '../lib/beautyCatalog.js';
import '../styles/beautySupply.css';

const money = cents => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(cents / 100);

export default function BeautySupply() {
  const { t } = useTranslation();
  const user = getStoredUser();
  const canManage = user?.isSuperAdmin === true || user?.role === "super_admin" || user?.isOwner === true;
  const text = (key, fallback) => beautyText(t, key, fallback);
  const [products, setProducts] = useState([]);
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [fulfillment, setFulfillment] = useState('all');
  const [independentOnly, setIndependentOnly] = useState(false);
  const [bag, setBag] = useState({});
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let active = true;
    setStatus('loading');
    apiGet('/api/beauty/catalog').then(payload => {
      const catalog = readBeautyCatalog(payload);
      if (!active) return;
      setProducts(catalog);
      setBag({});
      setStatus('ready');
    }).catch(() => { if (active) setStatus('unavailable'); });
    return () => { active = false; };
  }, [attempt]);

  const visible = useMemo(() => filterBeautyProducts(products, { query, category, fulfillment, independentOnly }), [products, query, category, fulfillment, independentOnly]);
  const bagProducts = products.filter(p => bag[p.id]);
  const bagCount = bagProducts.reduce((sum, p) => sum + bag[p.id], 0);
  const subtotal = bagProducts.reduce((sum, p) => sum + bag[p.id] * p.priceCents, 0);
  const totals = beautyBagTotals(subtotal, bagCount);
  const updateBag = (product, delta) => {
    setBag(current => changeBeautyBag(current, product, delta));
    setAnnouncement(`${product.name}: ${delta > 0 ? text('added', 'added to your bag') : text('removed', 'quantity reduced')}`);
  };

  return <section className="ifcdc-beauty" aria-labelledby="beauty-title">
    <div className="ifcdc-beauty__servicebar">IFCDC BEAUTY SUPPLY <span>Professional tools. Everyday essentials.</span></div>
    <header className="ifcdc-beauty__hero">
      <div><span className="ifcdc-beauty__eyebrow">THE BARBER &amp; BEAUTY STORE</span><h1 id="beauty-title">Tools. Care. Confidence.</h1><p>Discover grooming tools, beauty essentials and independent brands.</p></div>
      <div className="ifcdc-beauty__brand-panel"><img className="ifcdc-beauty__glowing-logo" src="/icon-512.png" alt="IFCDC gold ring logo" width="144" height="144" /><div className="ifcdc-beauty__actions">{canManage && <Link to="/admin/beauty-supply">Manage store</Link>}<a href="#beauty-bag-title">Shopping bag ({bagCount})</a></div></div>
    </header>
    <nav className="ifcdc-beauty__categories" aria-label="Shop by category">{['All', ...BEAUTY_CATEGORIES].map(c=><button type="button" key={c} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c==='All'?'Shop all':c}</button>)}</nav>
    <div className="ifcdc-beauty__banner"><strong>YOUR ROUTINE, UPGRADED.</strong><span>Shop the essentials. Discover your next favorite.</span><span>Pickup &amp; shipping where available</span></div>

    <div className="ifcdc-beauty__layout" id="beauty-collection"><div>
      <h2>{text('collection', 'Shop the collection')}</h2>
      <div className="ifcdc-beauty__filters">
        <label>{text('search', 'Search')}<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={text('placeholder', 'Product, brand or seller')} /></label>
        <label>{text('category', 'Collection')}<select value={category} onChange={e=>setCategory(e.target.value)}><option value="All">{text('all', 'All collections')}</option>{BEAUTY_CATEGORIES.map((c,i)=><option key={c} value={c}>{text(`category${i}`, c)}</option>)}</select></label>
        <label>{text('delivery', 'Delivery')}<select value={fulfillment} onChange={e=>setFulfillment(e.target.value)}><option value="all">{text('either', 'Pickup or shipping')}</option><option value="pickup">{text('pickupOnly', 'Pickup')}</option><option value="shipping">{text('shippingOnly', 'Shipping')}</option></select></label>
      </div>
      <label className="ifcdc-beauty__check"><input type="checkbox" checked={independentOnly} onChange={e=>setIndependentOnly(e.target.checked)} />{text('independentOnly', 'Show independent product lines')}</label>
      {status === 'loading' ? <p role="status">{text('loading', 'Loading the collection…')}</p> : status === 'unavailable' ?
        <div className="ifcdc-beauty__empty" role="status"><h3>{text('unavailable', 'The collection is not available yet')}</h3><p>{text('unavailableDetail', 'Please try again shortly. Orders are not open.')}</p><button type="button" onClick={()=>setAttempt(a=>a+1)}>{text('retry', 'Try again')}</button></div> :
        visible.length ? <><p role="status">{visible.length} {text('products', 'products')}</p><div className="ifcdc-beauty__grid">{visible.map(p=><article key={p.id}>
          <div className="ifcdc-beauty__product-mark">{p.imageUrl ? <img src={p.imageUrl} alt={p.name} loading="lazy" onError={e=>{e.currentTarget.hidden=true;}}/> : <span>{p.category}<small>Product image coming soon</small></span>}</div>
          <small>{p.brand}</small><h3>{p.name}</h3><p>{text('soldBy', 'Sold by')} {p.seller}</p>{p.independentBrand && <span className="ifcdc-beauty__badge">{text('independent', 'Independent brand')}</span>}<strong>{money(p.priceCents)}</strong>
          <p>{p.fulfillment.includes('shipping') && text('shippingOnly', 'Shipping')}{p.fulfillment.length > 1 && ' · '}{p.fulfillment.includes('pickup') && `${text('pickupOnly', 'Pickup')}: ${p.pickupLocation}`}</p>
          <button type="button" disabled={!p.stock || (bag[p.id] || 0) >= p.stock} onClick={()=>updateBag(p, 1)}>{!p.stock ? text('outOfStock', 'Out of stock') : (bag[p.id] || 0) >= p.stock ? text('stockLimit', 'Available quantity added') : text('add', 'Add to bag')}</button>
        </article>)}</div></> : <div className="ifcdc-beauty__empty"><h3>{products.length ? text('noMatches', 'No matching products') : text('preparing', 'Our shelves are opening soon.')}</h3><p>{products.length ? text('changeFilters', 'Try another search, collection or delivery option.') : text('preparingDetail', 'We’re selecting products and confirming availability. Browse our departments above; approved products will appear here.')}</p></div>}
    </div>
    <aside className="ifcdc-beauty__bag" aria-labelledby="beauty-bag-title"><h2 id="beauty-bag-title">{text('bag', 'Your bag')} <span>({bagCount})</span></h2><p className="ifcdc-beauty__sr" aria-live="polite">{announcement}</p>
      {bagProducts.length ? <ul>{bagProducts.map(p=><li key={p.id}><strong>{p.name}</strong><p>{bag[p.id]} × {money(p.priceCents)}</p><button type="button" aria-label={`${text('reduce', 'Reduce quantity')}: ${p.name}`} onClick={()=>updateBag(p,-1)}>{text('removeOne', 'Remove one')}</button></li>)}</ul> : <p>{text('emptyBag', 'Your essentials will appear here.')}</p>}
      <p className="ifcdc-beauty__subtotal">{text('subtotal', 'Product subtotal')} <strong>{money(subtotal)}</strong></p><p className="ifcdc-beauty__subtotal">Platform fee <strong>{money(totals.platformFeeCents)}</strong></p><p className="ifcdc-beauty__subtotal">Total before tax &amp; shipping <strong>{money(totals.totalBeforeTaxShippingCents)}</strong></p><small>One $2.50 buyer platform fee per completed order, including orders with multiple sellers. No seller commission. Product refunds exclude the $2.50 platform fee. </small><small>{text('taxNote', 'Tax and shipping are not included. Your bag is kept for this visit.')}</small>
      <BeautyOrderReview items={bagProducts.map(p=>({productId:p.id,quantity:bag[p.id]}))} />
      <BeautyCustomerCheckout items={bagProducts.map(p=>({productId:p.id,quantity:bag[p.id]}))} />
    </aside></div>
    <footer className="ifcdc-beauty__partners"><div><strong>FOR THE PROFESSIONAL.</strong><p>Clippers, trimmers and essentials for your station.</p></div><div><strong>FOR YOUR EVERYDAY.</strong><p>Hair, beard and beauty care for your routine.</p></div><div><strong>DISCOVER INDEPENDENT.</strong><p>A dedicated place for independent product lines.</p></div></footer>
  </section>;
}
