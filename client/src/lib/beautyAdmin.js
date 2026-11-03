export function decimalToInteger(value, label = 'Amount') {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`${label} must have at most two decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is too large.`);
  return result;
}
export function productFromBeautyForm(form, sellers, existingId) {
  const seller = sellers.find(s => s.id === form.sellerId);
  if (!seller) throw new Error('Choose a seller first.');
  const priceCents = decimalToInteger(form.price, 'Price');
  if (priceCents <= 0) throw new Error('Price must be greater than zero.');
  if (!/^\d+$/.test(String(form.stock)) || !Number.isSafeInteger(Number(form.stock))) throw new Error('Stock must be a whole number of zero or more.');
  const fulfillment = [form.shipping && 'shipping', form.pickup && 'pickup'].filter(Boolean);
  if (!fulfillment.length) throw new Error('Select shipping or pickup.');
  if (form.pickup && !form.pickupLocation.trim()) throw new Error('Enter the public pickup address.');
  if (!form.name.trim() || !form.brand.trim()) throw new Error('Enter a product name and brand.');
  const commissionBps = String(form.commission).trim() === '' ? null : decimalToInteger(form.commission, 'Commission');
  if (commissionBps > 10000) throw new Error('Commission cannot exceed 100%.');
  if (form.status === 'published' && seller.status !== 'approved') throw new Error('Approve the seller before publishing.');
  if (form.status === 'published' && form.revenueModel === 'commission' && commissionBps == null) throw new Error('Enter the agreed commission before publishing.');
  return {id:existingId || `product_${globalThis.crypto.randomUUID()}`,name:form.name.trim(),brand:form.brand.trim(),
    sellerId:seller.id,seller:seller.name,category:form.category,priceCents,stock:Number(form.stock),fulfillment,
    pickupLocation:form.pickup ? form.pickupLocation.trim() : '',independentBrand:form.independentBrand,
    status:form.status,revenueModel:form.revenueModel,commissionBps,
    wholesaleCostCents:String(form.cost).trim()===''?null:decimalToInteger(form.cost,'Wholesale cost')};
}
export function changeBeautySellerStatus(catalog, id, status) {
  return {...catalog,sellers:catalog.sellers.map(s=>s.id===id?{...s,status}:s),
    products:catalog.products.map(p=>p.sellerId===id && status!=='approved' && p.status==='published'?{...p,status:'draft'}:p)};
}
