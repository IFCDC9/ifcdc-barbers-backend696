/** Site-wide footer — same copy as home landing; mounted from App.jsx on every route. */
export default function IFCDCGlobalFooter() {
  return (
    <footer className="app-footer ifcdc-global-footer" role="contentinfo">
      <p className="home-footer__text">© 2026 IFCDC • All Rights Reserved</p>
      <p className="home-footer__text home-footer__sub">Powered by IFCDC Productions</p>
    </footer>
  );
}
