import {Link} from 'react-router-dom';
export function WebsiteView({site,preview=false}){
 const d=site.document||site.draft,media=new Map((site.media||[]).map(m=>[String(m.id),m.url]));
 const rgb=[1,3,5].map(i=>parseInt(d.accent.slice(i,i+2),16));
 const ink=rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>160?'#182018':'#ffffff';
 const promos=d.promos.filter(p=>(!p.startsAt||Date.parse(p.startsAt)<=Date.now())&&(!p.endsAt||Date.parse(p.endsAt)>Date.now()));
 const book=site.kind==='barber'&&site.team?.[0]?'/booking?barberId='+encodeURIComponent(site.team[0].id):'#team';
 const image=(id,alt,cls)=>id&&media.get(id)?<img className={cls} src={media.get(id)} alt={alt} loading="lazy"/>:null;
 return <div className={'ws-business ws-theme-'+d.theme+' ws-font-'+d.font} style={{'--ws-accent':d.accent,'--ws-button-text':ink}}>
  {preview&&<div className="ws-preview-banner">Draft preview · Save and publish when you’re ready</div>}
  <header className="ws-business-nav"><a href="#top" className="ws-wordmark">{image(d.logoId,d.name,'ws-logo')}{d.name}</a><nav aria-label="Business navigation"><a href="#about">About</a><a href="#work">Our work</a><a href="#team">Book a visit</a></nav></header>
  <main id="top">
   <section className="ws-business-hero"><div><p className="ws-eyebrow">Your next great experience</p><h1>{d.headline}</h1><p>{d.intro}</p><a className="ws-button" href={book}>Book an appointment <span aria-hidden>↗</span></a></div><div className="ws-business-visual">{image(d.heroId,'Inside '+d.name,'ws-cover')||<div className="ws-monogram" aria-hidden>{d.name.slice(0,1)}</div>}</div></section>
   {promos.length>0&&<section className="ws-promos" aria-label="Current promotions">{promos.map((p,i)=><article key={i}><span className="ws-eyebrow">In the spotlight</span><h2>{p.title}</h2><p>{p.body}</p><a href={book}>Book your visit ↗</a></article>)}</section>}
   <section id="about" className="ws-about ws-section"><p className="ws-eyebrow">The story behind the style</p><h2>Welcome to {d.name}.</h2><p className="ws-long-copy">{d.about}</p></section>
   {(d.gallery.length>0||d.videos.length>0)&&<section id="work" className="ws-section"><div className="ws-section-heading"><div><p className="ws-eyebrow">A closer look</p><h2>Made to stand out.</h2></div></div><div className="ws-gallery">{d.gallery.map(id=><figure key={id}>{image(id,'Work by '+d.name,'ws-cover')}</figure>)}</div><div className="ws-video-grid">{d.videos.map((v,i)=><figure key={i}><video crossOrigin="anonymous" controls playsInline preload="none" poster={media.get(v.posterId)} src={media.get(v.assetId)}>{v.captionsId&&<track kind="captions" src={media.get(v.captionsId)} srcLang="en" label="Captions" default/>}</video>{v.caption&&<figcaption>{v.caption}</figcaption>}</figure>)}</div></section>}
   <section id="team" className="ws-section"><p className="ws-eyebrow">Make time for yourself</p><h2>Find your chair.</h2><p>Choose your professional to see services, prices, and available appointments.</p><div className="ws-service-list">{site.services?.map((s,i)=><div className="ws-team-member" key={i}><span>{s.name}</span><span>${s.price.toFixed(2)} · {s.minutes} min</span></div>)}</div><div className="ws-team">{site.team?.map(b=><Link className="ws-team-member" key={b.id} to={'/booking?barberId='+encodeURIComponent(b.id)}><span>{b.name}</span><span>Services & booking ↗</span></Link>)}</div>{!site.team?.length&&<p>Contact us to arrange your visit.</p>}</section>
   <section className="ws-contact ws-section"><div><p className="ws-eyebrow">Come through</p><h2>We’ll see you soon.</h2></div><div>{d.address&&<p>{d.address}</p>}<p className="ws-long-copy">{d.hours}</p>{d.phone&&<a href={'tel:'+d.phone.replace(/[^+0-9]/g,'')}>{d.phone}</a>}</div></section>
  </main>
  <footer className="ws-business-footer"><span>© {new Date().getFullYear()} {d.name}</span><span>Booking powered by <Link to="/">IFCDC</Link></span><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></footer>
 </div>;
}
