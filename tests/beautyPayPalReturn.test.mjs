import test from 'node:test';
import assert from 'node:assert/strict';
import {isNonPayPalTokenPath,looksLikePasswordResetToken} from '../client/src/lib/queryTokenRoutes.js';
test('product PayPal return paths are excluded from the global booking bridge',()=>{
 for(const path of ['/admin/beauty-supply','/admin/beauty-supply/','/beauty-supply','/ADMIN/BEAUTY-SUPPLY'])assert.equal(isNonPayPalTokenPath(path),true);
});
test('booking and root PayPal returns remain eligible for their existing handler',()=>{
 for(const path of ['/','/booking','/home'])assert.equal(isNonPayPalTokenPath(path),false);
});
test('password reset, login, invite and mobile returns remain protected',()=>{
 for(const path of ['/reset-password','/forgot-password','/invite','/login','/register','/paypal-booking'])assert.equal(isNonPayPalTokenPath(path),true);
 assert.equal(looksLikePasswordResetToken('a'.repeat(64)),true);
 assert.equal(looksLikePasswordResetToken('PAYPALORDER123'),false);
});
