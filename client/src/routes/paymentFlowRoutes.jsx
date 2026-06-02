/**
 * React Router adapters for payment/booking pages that expect a `navigate` prop.
 * Visual shell stays in App.jsx (Render baseline); logic lives in page components.
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import { checkoutParamsFromQuery } from "../routing/hashRouter.js";
import Checkout from "../pages/Checkout.jsx";
import PaymentPage from "../pages/PaymentPage.jsx";
import Confirmation from "../pages/Confirmation.jsx";

function useLegacyNavigate() {
  const navigate = useNavigate();
  return (to) => {
    const raw = String(to || "/").trim();
    if (raw.startsWith("#")) {
      navigate(raw.slice(1) || "/");
      return;
    }
    navigate(raw.startsWith("/") ? raw : `/${raw}`);
  };
}

export function CheckoutRoute() {
  const navigate = useLegacyNavigate();
  const [searchParams] = useSearchParams();
  const params = checkoutParamsFromQuery(searchParams);
  return <Checkout navigate={navigate} {...params} />;
}

export function PaymentRoute() {
  const navigate = useLegacyNavigate();
  const [searchParams] = useSearchParams();
  const params = checkoutParamsFromQuery(searchParams);
  return <PaymentPage navigate={navigate} {...params} />;
}

export function ConfirmationRoute() {
  const navigate = useLegacyNavigate();
  const [searchParams] = useSearchParams();
  return (
    <Confirmation
      navigate={navigate}
      barberName={searchParams.get("barber") || ""}
      date={searchParams.get("date") || ""}
      time={searchParams.get("time") || ""}
      orderId={searchParams.get("orderId") || ""}
    />
  );
}
