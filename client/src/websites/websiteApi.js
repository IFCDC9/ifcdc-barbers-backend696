import {apiUrl} from '../lib/api.js';
import {getBearerAuthHeaders} from '../lib/authHeaders.js';
export async function websiteApi(path,{method='GET',body,headers={},signal}={}){
 const binary=body instanceof File||body instanceof Blob;
 const res=await fetch(apiUrl('/api/websites'+path),{method,signal,headers:{...getBearerAuthHeaders(),...(!binary&&body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:binary?body:JSON.stringify(body)}:{})});
 const data=await res.json();if(!res.ok)throw Error(data.error||'website_request_failed');return data;
}
