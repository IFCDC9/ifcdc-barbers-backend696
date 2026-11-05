import test from 'node:test';
import assert from 'node:assert/strict';
import { entitlementsEnforceEnabled, entitlementsLockShopsEnabled, entitlementsMode } from '../entitlementFlags.js';
import { tierAllowsAura, tierAllowsDeposits, barberAuraEffective, barberDepositsEffective, platformFeeUsdForTier } from '../subscriptionTier.js';
import { catalogPublic, planFromAppleProductId } from '../monetizationCatalog.js';
import { beautyBagTotals } from '../client/src/lib/beautyOrderPricing.js';
test('free policy overrides stale subscription gate configuration',()=>{
 const old=[process.env.ENTITLEMENTS_ENFORCE,process.env.ENTITLEMENTS_LOCK_SHOPS];
 try {process.env.ENTITLEMENTS_ENFORCE='1';process.env.ENTITLEMENTS_LOCK_SHOPS='1';
 assert.equal(entitlementsEnforceEnabled(),false);assert.equal(entitlementsLockShopsEnabled(),false);assert.equal(entitlementsMode(),'free_access');
 } finally {for(const [i,k] of ['ENTITLEMENTS_ENFORCE','ENTITLEMENTS_LOCK_SHOPS'].entries()) old[i]===undefined?delete process.env[k]:process.env[k]=old[i];}
});
test('features do not require a paid tier; barber feature toggles still apply',()=>{
 assert.equal(tierAllowsAura('free'),true);assert.equal(tierAllowsDeposits('free'),true);
 assert.equal(barberAuraEffective({subscription_tier:'free',aura_enabled:false}),false);
 assert.equal(barberDepositsEffective({subscription_tier:'free',booking_deposit_enabled:true}),true);
 assert.equal(platformFeeUsdForTier('free'),platformFeeUsdForTier('elite'));
});
test('public catalog retires recurring offers and keeps one-time access and historical receipt lookup',()=>{
 const c=catalogPublic();assert.deepEqual(c.apple.products,[]);assert.deepEqual(c.google.products,[]);
 assert.ok(c.google.access.productId);assert.ok(planFromAppleProductId('ifcdc.barbers.individual.monthly'));
});
test('commission rounds once at order level and empty baskets have no fees',()=>{
 assert.equal(beautyBagTotals(10000,5).commissionCents,200);
 assert.equal(beautyBagTotals(10000,5).totalBeforeTaxShippingCents,10350);
 assert.equal(beautyBagTotals(24,1).commissionCents,0);
 assert.equal(beautyBagTotals(25,1).commissionCents,1);
 assert.equal(beautyBagTotals(0,0).totalBeforeTaxShippingCents,0);
 assert.throws(()=>beautyBagTotals(Number.MAX_SAFE_INTEGER,1));
});
