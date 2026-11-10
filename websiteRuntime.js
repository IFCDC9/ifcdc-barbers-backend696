import {dbQuery} from './db.js';
import {getShopAccess} from './shopAccessPolicy.js';
import {createWebsiteService} from './websiteService.js';
export const websiteService=createWebsiteService({query:dbQuery,shopAccess:getShopAccess});
