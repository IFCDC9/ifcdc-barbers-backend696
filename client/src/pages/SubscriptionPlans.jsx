import { Link } from "react-router-dom";
export default function SubscriptionPlans() {
  return <main style={{background:'#050505',color:'#f5f5f5',minHeight:'70vh',padding:'2rem'}}>
    <h1 style={{color:'#d4af37'}}>IFCDC Barbers — free to use</h1>
    <p>No recurring plan is required for customers, barbers or shops. Account permissions still apply.</p>
    <p>The app download/access purchase and booking platform fees remain separate.</p>
    <p>Buyers pay one $1.50 platform fee per product order, before tax and shipping. The 2% product commission is deducted from seller proceeds.</p>
    <p>Have an existing subscription? Check its renewal status with your original billing provider.</p>
    <a href="https://apps.apple.com/account/subscriptions">Manage Apple subscriptions</a>{' · '}
    <a href="https://play.google.com/store/account/subscriptions">Manage Google subscriptions</a>
    <p><Link to="/profile">Back to profile</Link></p>
  </main>;
}
